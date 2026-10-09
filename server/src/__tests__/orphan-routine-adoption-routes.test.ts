import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ROUTINE_ID = "9cf0f09c-62d5-4193-b699-3268a3c17561";
const FINGERPRINT = "259c2d3e1d0a20184c022ea9d069a06a4f3bd938a6ddaa41ec09d237090cfb8a";

describeEmbeddedPostgres("PATCH orphaned routine firing adoption maps slot collision to 409", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-routine-adopt-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("returns 409 (not 500) when closing an orphaned firing while a sibling holds the execution slot", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const currentRunId = randomUUID();
    const currentIssueId = randomUUID();
    const orphanIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Planner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: currentRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: currentIssueId,
      companyId,
      title: "Current routine firing",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: ROUTINE_ID,
      originFingerprint: FINGERPRINT,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionLockedAt: new Date(),
    });
    await db.insert(issues).values({
      id: orphanIssueId,
      companyId,
      title: "Orphaned older routine firing",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: ROUTINE_ID,
      originFingerprint: FINGERPRINT,
      checkoutRunId: null,
      executionRunId: null,
    });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: orphanIssueId } })
      .where(eq(heartbeatRuns.id, currentRunId));

    const res = await request(
      createApp({
        type: "agent",
        agentId,
        companyId,
        runId: currentRunId,
        source: "agent_jwt",
      }),
    )
      .patch(`/api/issues/${orphanIssueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, orphanIssueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      checkoutRunId: null,
      executionRunId: null,
    });
  });
});
