import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, projects } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { issueRoutes } from "../routes/issues.js";
import { budgetService } from "../services/budgets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping manual project pause tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId,
    runId: randomUUID(),
    source: "agent_key",
  } as Express.Request["actor"];
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", projectRoutes(db));
  app.use("/api", issueRoutes(db, {} as never));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("manual project pause and resume", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-manual-pause-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pause Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Parked Project",
      status: "in_progress",
    });
    return { companyId, agentId, projectId };
  }

  it("pauses with a manual reason and resumes", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const paused = await request(app)
      .post(`/api/projects/${projectId}/pause`)
      .send({ reason: "Parking legacy work" });
    expect(paused.status).toBe(200);
    expect(paused.body.pauseReason).toBe("manual");
    expect(paused.body.pausedAt).toBeTruthy();

    const pausedAgain = await request(app).post(`/api/projects/${projectId}/pause`).send({});
    expect(pausedAgain.status).toBe(409);

    const resumed = await request(app).post(`/api/projects/${projectId}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.pauseReason).toBeNull();
    expect(resumed.body.pausedAt).toBeNull();

    const resumedAgain = await request(app).post(`/api/projects/${projectId}/resume`);
    expect(resumedAgain.status).toBe(200);
  });

  it("refuses to overwrite or clear a budget pause", async () => {
    const { companyId, projectId } = await seed();
    await db
      .update(projects)
      .set({ pauseReason: "budget", pausedAt: new Date() })
      .where(eq(projects.id, projectId));
    const app = createApp(db, boardActor(companyId));

    const pause = await request(app).post(`/api/projects/${projectId}/pause`).send({});
    expect(pause.status).toBe(409);

    const resume = await request(app).post(`/api/projects/${projectId}/resume`);
    expect(resume.status).toBe(409);
    expect(resume.body.error).toMatch(/budget/i);

    const [row] = await db.select().from(projects);
    expect(row?.pauseReason).toBe("budget");
  });

  it("blocks invocation for any paused project and restores dispatch on resume", async () => {
    const { companyId, agentId, projectId } = await seed();
    const service = budgetService(db);

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();

    await db
      .update(projects)
      .set({ pauseReason: "manual", pausedAt: new Date() })
      .where(eq(projects.id, projectId));

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toEqual({
      scopeType: "project",
      scopeId: projectId,
      scopeName: "Parked Project",
      reason:
        "Project is paused and cannot start new work. Resume the project to start new work.",
    });

    await db
      .update(projects)
      .set({ pauseReason: null, pausedAt: null })
      .where(eq(projects.id, projectId));
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();
  });

  it("rejects checkout on a manually paused project and allows it after resume", async () => {
    const { companyId, agentId, projectId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Parked task",
      status: "todo",
      assigneeAgentId: agentId,
    });

    await db
      .update(projects)
      .set({ pauseReason: "manual", pausedAt: new Date() })
      .where(eq(projects.id, projectId));

    const blockedApp = createApp(db, agentActor(companyId, agentId));
    const blocked = await request(blockedApp)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("Project is paused");

    await db
      .update(projects)
      .set({ pauseReason: null, pausedAt: null })
      .where(eq(projects.id, projectId));

    // Board checkout carries no run id, so no heartbeat run row is needed.
    const openApp = createApp(db, boardActor(companyId));
    const checkedOut = await request(openApp)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });
    expect(checkedOut.status).toBe(200);
  });
});
