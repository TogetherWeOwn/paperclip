import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  nativeSiblingLivenessResponseSchema,
  type AgentApiKeyScope,
} from "@paperclipai/shared";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { evaluateNativeSiblingLiveness } from "../services/native-sibling-liveness.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres sibling-liveness route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;

type Fixture = {
  company: CompanyRow;
  agent: AgentRow;
  issue: IssueRow;
  run: RunRow;
};

function createApp(db: Db, actor?: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  if (actor) {
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
  } else {
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
  }
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

async function seedCompany(db: Db): Promise<CompanyRow> {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `Sibling Liveness ${nonce}`,
    issuePrefix: `SL${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(
  db: Db,
  companyId: string,
  permissions: Record<string, unknown> = {},
): Promise<AgentRow> {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions,
  }).returning();
  return agent!;
}

async function seedIssue(
  db: Db,
  companyId: string,
  agentId: string,
  overrides: Partial<typeof issues.$inferInsert> = {},
): Promise<IssueRow> {
  const [issue] = await db.insert(issues).values({
    companyId,
    title: `Current issue ${randomUUID().slice(0, 6)}`,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: agentId,
    responsibleUserId: "board-user",
    ...overrides,
  }).returning();
  return issue!;
}

async function seedRun(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    runtimeMode?: string | null;
    nativeIssueId?: string | null;
    /** The durable `heartbeat_runs.issue_id` binding; unset by default like a native run. */
    boundIssueId?: string | null;
    contextIssueId?: unknown;
    omitContextIssueId?: boolean;
    contextTaskId?: unknown;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    executionPolicy?: unknown;
    errorCode?: string | null;
    nativePhase?: string | null;
    resultJson?: Record<string, unknown> | null;
  },
): Promise<RunRow> {
  const status = input.status ?? "running";
  const contextSnapshot: Record<string, unknown> = { executionPolicy: input.executionPolicy ?? {} };
  if (!input.omitContextIssueId) {
    contextSnapshot.issueId = input.contextIssueId === undefined ? input.issueId : input.contextIssueId;
  }
  if (input.contextTaskId !== undefined) contextSnapshot.taskId = input.contextTaskId;
  const [run] = await db.insert(heartbeatRuns).values({
    companyId: input.companyId,
    agentId: input.agentId,
    status,
    // A database trigger derives the durable issue binding and scope from the other
    // columns, as it does for production runs.
    issueId: input.boundIssueId ?? null,
    runtimeMode: input.runtimeMode === undefined ? "native" : input.runtimeMode,
    nativeIssueId: input.nativeIssueId === undefined ? input.issueId : input.nativeIssueId,
    startedAt: input.startedAt === undefined
      ? (status === "running" ? new Date() : null)
      : input.startedAt,
    finishedAt: input.finishedAt ?? null,
    errorCode: input.errorCode ?? null,
    nativePhase: input.nativePhase ?? null,
    resultJson: input.resultJson ?? null,
    contextSnapshot,
  }).returning();
  return run!;
}

async function seedFixture(
  db: Db,
  options: {
    agentPermissions?: Record<string, unknown>;
    issueOverrides?: Partial<typeof issues.$inferInsert>;
  } = {},
): Promise<Fixture> {
  const company = await seedCompany(db);
  const agent = await seedAgent(db, company.id, options.agentPermissions);
  const issue = await seedIssue(db, company.id, agent.id, options.issueOverrides);
  const run = await seedRun(db, {
    companyId: company.id,
    agentId: agent.id,
    issueId: issue.id,
  });
  const [updatedIssue] = await db.update(issues).set({
    checkoutRunId: run.id,
    executionRunId: run.id,
  }).where(eq(issues.id, issue.id)).returning();
  return { company, agent, issue: updatedIssue!, run };
}

function makeJwt(fixture: Fixture, keyScope?: AgentApiKeyScope): string {
  const token = createLocalAgentJwt(
    fixture.agent.id,
    fixture.company.id,
    fixture.agent.adapterType,
    fixture.run.id,
    null,
    keyScope,
  );
  if (!token) throw new Error("JWT test secret was not configured");
  return token;
}

function getIssueRoute(app: express.Express, fixture: Fixture, token = makeJwt(fixture)) {
  return request(app)
    .get(`/api/issues/${fixture.issue.id}/sibling-liveness`)
    .set("Authorization", `Bearer ${token}`);
}

type PeerInput = {
  status: "queued" | "running" | "scheduled_retry";
  agentId?: string;
  nativeIssueId?: string | null;
  boundIssueId?: string | null;
  contextIssueId?: unknown;
  omitContextIssueId?: boolean;
  contextTaskId?: unknown;
  runtimeMode?: string | null;
};

async function insertPeerRun(db: Db, fixture: Fixture, input: PeerInput) {
  return seedRun(db, {
    companyId: fixture.company.id,
    agentId: input.agentId ?? fixture.agent.id,
    issueId: fixture.issue.id,
    status: input.status,
    nativeIssueId: input.nativeIssueId === undefined ? fixture.issue.id : input.nativeIssueId,
    boundIssueId: input.boundIssueId,
    contextIssueId: input.contextIssueId,
    omitContextIssueId: input.omitContextIssueId,
    contextTaskId: input.contextTaskId,
    runtimeMode: input.runtimeMode,
  });
}

/** Whole-row copies of the issue and run tables, to prove a read writes nothing. */
async function snapshotRows(db: Db) {
  return {
    issues: await db.select().from(issues),
    runs: await db.select().from(heartbeatRuns),
  };
}

describeEmbeddedPostgres("native sibling liveness route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let originalSecret: string | undefined;
  let originalTtl: string | undefined;

  beforeAll(async () => {
    originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = `sibling-liveness-test-${randomUUID()}`;
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-sibling-liveness-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
  });

  it("returns a fresh, exact CLEAR DTO through the mounted route and real run-JWT middleware", async () => {
    const fixture = await seedFixture(db);
    const before = await snapshotRows(db);
    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await snapshotRows(db)).toEqual(before);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.etag).toBeUndefined();
    expect(nativeSiblingLivenessResponseSchema.parse(res.body)).toEqual(res.body);
    expect(Object.keys(res.body).sort()).toEqual([
      "expiresAt",
      "issueId",
      "observedAt",
      "runId",
      "schema",
      "verdict",
    ]);
    expect(res.body).toMatchObject({
      schema: "paperclip.native-sibling-liveness.v1",
      issueId: fixture.issue.id,
      runId: fixture.run.id,
      verdict: "clear",
    });
    const observedAt = Date.parse(res.body.observedAt);
    const expiresAt = Date.parse(res.body.expiresAt);
    expect(Number.isFinite(observedAt)).toBe(true);
    expect(expiresAt - observedAt).toBe(3_000);
    expect(JSON.stringify(res.body)).not.toContain("contextSnapshot");
    expect(JSON.stringify(res.body)).not.toContain("agentId");
    expect(JSON.stringify(res.body)).not.toContain("companyId");
  });

  it.each(["queued", "running"] as const)("counts a same-agent %s run as a sibling", async (status) => {
    const fixture = await seedFixture(db);
    await insertPeerRun(db, fixture, { status });

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("sibling");
    expect(Object.keys(res.body)).toHaveLength(6);
  });

  it("counts a peer attributed by its issue snapshot", async () => {
    const fixture = await seedFixture(db);
    await insertPeerRun(db, fixture, {
      status: "running",
      nativeIssueId: null,
      contextIssueId: fixture.issue.id,
    });

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("sibling");
  });

  it.each([
    ["the durable issue binding", (issueId: string): PeerInput => ({
      status: "queued", nativeIssueId: null, omitContextIssueId: true, boundIssueId: issueId,
    })],
    ["the task id in its snapshot", (issueId: string): PeerInput => ({
      status: "queued", nativeIssueId: null, omitContextIssueId: true, contextTaskId: issueId,
    })],
  ])("counts a peer bound by %s", async (_label, peer) => {
    const fixture = await seedFixture(db);
    await insertPeerRun(db, fixture, peer(fixture.issue.id));

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("sibling");
  });

  it.each([
    ["a native owner naming another issue", (_issueId: string, otherId: string): PeerInput => ({
      status: "running", nativeIssueId: otherId, boundIssueId: otherId,
    })],
    ["a snapshot task id for another issue", (_issueId: string, otherId: string): PeerInput => ({
      status: "running", contextTaskId: otherId,
    })],
    ["a snapshot task id naming this issue beside another owner", (issueId: string, otherId: string): PeerInput => ({
      status: "running", nativeIssueId: otherId, contextIssueId: otherId, contextTaskId: issueId,
    })],
    ["a non-string snapshot issue id beside a matching binding", (issueId: string): PeerInput => ({
      status: "running", nativeIssueId: null, boundIssueId: issueId, contextIssueId: { id: "x" },
    })],
  ])("returns unknown for a peer with %s", async (_label, peer) => {
    const fixture = await seedFixture(db);
    const other = await seedIssue(db, fixture.company.id, fixture.agent.id);
    await insertPeerRun(db, fixture, peer(fixture.issue.id, other.id));

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("unknown");
  });

  it("ignores any number of finished historical rows when deciding a complete CLEAR", async () => {
    const fixture = await seedFixture(db);
    const historical = Array.from({ length: 75 }, () => ({
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: fixture.issue.id,
      startedAt: new Date(Date.now() - 10_000),
      finishedAt: new Date(Date.now() - 5_000),
      contextSnapshot: { issueId: fixture.issue.id, executionPolicy: {} },
    }));
    await db.insert(heartbeatRuns).values(historical);

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("clear");
  });

  it("examines more than fifty exact-issue active rows without pagination", async () => {
    const fixture = await seedFixture(db);
    const peers = Array.from({ length: 65 }, (_, index) => ({
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      status: index % 2 === 0 ? "queued" : "running",
      runtimeMode: "native",
      nativeIssueId: fixture.issue.id,
      startedAt: index % 2 === 0 ? null : new Date(),
      finishedAt: null,
      contextSnapshot: { issueId: fixture.issue.id, executionPolicy: {} },
    }));
    await db.insert(heartbeatRuns).values(peers);

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("sibling");
  });

  it("returns unknown for contradictory or incomplete active-run state", async () => {
    const fixture = await seedFixture(db);
    await insertPeerRun(db, fixture, {
      status: "running",
      contextIssueId: randomUUID(),
    });

    const contradictory = await getIssueRoute(createApp(db), fixture);
    expect(contradictory.status, JSON.stringify(contradictory.body)).toBe(200);
    expect(contradictory.body.verdict).toBe("unknown");

    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.company.id));
    const replacement = await seedRun(db, {
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      issueId: fixture.issue.id,
    });
    await db.update(issues).set({ checkoutRunId: replacement.id, executionRunId: replacement.id })
      .where(eq(issues.id, fixture.issue.id));
    const incomplete = await insertPeerRun(db, fixture, {
      status: "scheduled_retry",
      contextIssueId: fixture.issue.id,
    });
    expect(incomplete.status).toBe("scheduled_retry");

    const incompleteResponse = await getIssueRoute(createApp(db), {
      ...fixture,
      run: replacement,
      issue: { ...fixture.issue, executionRunId: replacement.id, checkoutRunId: replacement.id },
    });
    expect(incompleteResponse.status, JSON.stringify(incompleteResponse.body)).toBe(200);
    expect(incompleteResponse.body.verdict).toBe("unknown");
  });

  it("rejects a foreign-company issue without disclosing its state", async () => {
    const fixture = await seedFixture(db);
    const foreignCompany = await seedCompany(db);
    const foreignAgent = await seedAgent(db, foreignCompany.id);
    const foreignIssue = await seedIssue(db, foreignCompany.id, foreignAgent.id);

    const res = await request(createApp(db))
      .get(`/api/issues/${foreignIssue.id}/sibling-liveness`)
      .set("Authorization", `Bearer ${makeJwt(fixture)}`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
    expect(JSON.stringify(res.body)).not.toContain(foreignIssue.id);
  });

  it("rejects a different agent's run for the target issue", async () => {
    const fixture = await seedFixture(db);
    const otherAgent = await seedAgent(db, fixture.company.id);
    const otherIssue = await seedIssue(db, fixture.company.id, otherAgent.id);
    const otherRun = await seedRun(db, {
      companyId: fixture.company.id,
      agentId: otherAgent.id,
      issueId: otherIssue.id,
    });
    await db.update(issues).set({
      checkoutRunId: otherRun.id,
      executionRunId: otherRun.id,
    }).where(eq(issues.id, otherIssue.id));
    const token = createLocalAgentJwt(
      otherAgent.id,
      fixture.company.id,
      otherAgent.adapterType,
      otherRun.id,
    )!;

    const res = await request(createApp(db))
      .get(`/api/issues/${fixture.issue.id}/sibling-liveness`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });

  it("rejects missing, invalid, and expired JWTs before returning a verdict", async () => {
    const fixture = await seedFixture(db);
    const app = createApp(db);
    const missing = await request(app).get(`/api/issues/${fixture.issue.id}/sibling-liveness`);
    const invalid = await request(app)
      .get(`/api/issues/${fixture.issue.id}/sibling-liveness`)
      .set("Authorization", "Bearer invalid.jwt.token");

    const oldTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "1";
    const issuedAt = Date.now();
    const expired = makeJwt(fixture);
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = oldTtl ?? "3600";
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(issuedAt + 2_000);
    let expiredResponse;
    try {
      expiredResponse = await request(app)
        .get(`/api/issues/${fixture.issue.id}/sibling-liveness`)
        .set("Authorization", `Bearer ${expired}`);
    } finally {
      dateSpy.mockRestore();
    }

    expect(missing.status).toBe(403);
    expect(invalid.status).toBe(401);
    expect(expiredResponse!.status).toBe(401);
  });

  it.each([
    ["skill_test", (issueId: string): AgentApiKeyScope => ({ kind: "skill_test", issueId })],
    ["task_bridge", (issueId: string): AgentApiKeyScope => ({ kind: "task_bridge", parentIssueId: issueId })],
  ] as const)("rejects restricted %s run credentials", async (_kind, makeScope) => {
    const fixture = await seedFixture(db);
    const token = makeJwt(fixture, makeScope(fixture.issue.id));

    const res = await getIssueRoute(createApp(db), fixture, token);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("rejects skill-test issue execution even with a standard JWT", async () => {
    const fixture = await seedFixture(db, {
      issueOverrides: { workMode: "skill_test", harnessKind: "skill_test" },
    });

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it.each([
    ["agent permissions", async (db: Db) => seedFixture(db, { agentPermissions: { trustPreset: "low_trust_review" } })],
    ["the issue execution policy", async (db: Db) => seedFixture(db, {
      issueOverrides: { executionPolicy: { trustPreset: "low_trust_review" } as never },
    })],
    ["the run execution policy", async (db: Db) => {
      const fixture = await seedFixture(db);
      await db.update(heartbeatRuns)
        .set({ contextSnapshot: { issueId: fixture.issue.id, executionPolicy: { trustPreset: "low_trust_review" } } })
        .where(eq(heartbeatRuns.id, fixture.run.id));
      return fixture;
    }],
    ["the project workspace policy", async (db: Db) => {
      const fixture = await seedFixture(db);
      const [project] = await db.insert(projects).values({
        companyId: fixture.company.id,
        name: "Low trust project",
        executionWorkspacePolicy: { trustPreset: "low_trust_review" },
      }).returning();
      await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, fixture.issue.id));
      return fixture;
    }],
  ])("rejects low-trust callers marked by %s", async (_source, build) => {
    const fixture = await build(db);

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.verdict).toBeUndefined();
  });

  it.each([
    ["has ended", (f: Fixture) => db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.run.id))],
    ["was stopped through an adapter", (f: Fixture) => db.update(heartbeatRuns)
      .set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.run.id))],
    ["has a native Stop fence", (f: Fixture) => db.update(heartbeatRuns)
      .set({ resultJson: { cancellation: { reason: "stop" }, startupCancellation: { requestedAt: new Date().toISOString() } } })
      .where(eq(heartbeatRuns.id, f.run.id))],
    ["has a startup Stop fence only", (f: Fixture) => db.update(heartbeatRuns)
      .set({ resultJson: { startupCancellation: { requestedAt: new Date().toISOString() } } })
      .where(eq(heartbeatRuns.id, f.run.id))],
    ["has a native cancellation intent", (f: Fixture) => db.update(heartbeatRuns)
      .set({ resultJson: { nativeCancellation: { intent: "stop" } } }).where(eq(heartbeatRuns.id, f.run.id))],
    ["is a held native runner", (f: Fixture) => db.update(heartbeatRuns)
      .set({ errorCode: "native_execution_ownership_unverified", nativePhase: "terminal_failure" })
      .where(eq(heartbeatRuns.id, f.run.id))],
    ["is an adopted runner that never authenticated", (f: Fixture) => db.update(heartbeatRuns)
      .set({ errorCode: "native_adopted_runner_authentication_timeout" }).where(eq(heartbeatRuns.id, f.run.id))],
  ])("rejects a caller whose run %s", async (_state, change) => {
    const fixture = await seedFixture(db);
    await change(fixture);

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.verdict).toBeUndefined();
  });

  it("rejects a run that lost its assignment", async () => {
    const reassigned = await seedFixture(db);
    const otherAgent = await seedAgent(db, reassigned.company.id);
    await db.update(issues).set({ assigneeAgentId: otherAgent.id })
      .where(eq(issues.id, reassigned.issue.id));
    const assignmentResponse = await getIssueRoute(createApp(db), reassigned);

    expect(assignmentResponse.status).toBe(404);
  });

  it.each(["paused", "terminated", "pending_approval"])("rejects a run whose agent is %s", async (status) => {
    const fixture = await seedFixture(db);
    await db.update(agents).set({ status }).where(eq(agents.id, fixture.agent.id));

    const res = await getIssueRoute(createApp(db), fixture);

    // Terminated and pending agents are refused earlier by authentication.
    expect([401, 409]).toContain(res.status);
    expect(res.body.verdict).toBeUndefined();
  });

  it("still serves an agent in the error status that holds a live run", async () => {
    const fixture = await seedFixture(db);
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, fixture.agent.id));

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("clear");
  });

  it("rejects the caller's own run asking about a different issue", async () => {
    const fixture = await seedFixture(db);
    const otherIssue = await seedIssue(db, fixture.company.id, fixture.agent.id);

    const res = await request(createApp(db))
      .get(`/api/issues/${otherIssue.id}/sibling-liveness`)
      .set("Authorization", `Bearer ${makeJwt(fixture)}`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.verdict).toBeUndefined();
  });

  const callerInput = (fixture: Fixture) => ({
    companyId: fixture.company.id,
    agentId: fixture.agent.id,
    runId: fixture.run.id,
    issueId: fixture.issue.id,
  });

  it.each([
    ["the assignment changes", "not_found", (f: Fixture) => db.update(issues)
      .set({ assigneeAgentId: null }).where(eq(issues.id, f.issue.id))],
    ["the run ends", "conflict", (f: Fixture) => db.update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id))],
    ["the run is stopped", "conflict", (f: Fixture) => db.update(heartbeatRuns)
      .set({ resultJson: { cancellation: { reason: "stop" } } }).where(eq(heartbeatRuns.id, f.run.id))],
    ["trust is revoked", "forbidden", (f: Fixture) => db.update(agents)
      .set({ permissions: { trustPreset: "low_trust_review" } }).where(eq(agents.id, f.agent.id))],
  ] as const)("never returns a verdict when %s after the snapshot is read", async (_change, expected, change) => {
    const fixture = await seedFixture(db);

    const result = await evaluateNativeSiblingLiveness(db, callerInput(fixture), {
      afterSnapshot: async () => { await change(fixture); },
    });

    expect(result).toEqual({ kind: expected });
  });

  it("sees a peer that starts between the two reads", async () => {
    const fixture = await seedFixture(db);

    const result = await evaluateNativeSiblingLiveness(db, callerInput(fixture), {
      afterSnapshot: async () => { await insertPeerRun(db, fixture, { status: "queued" }); },
    });

    expect(result.kind === "response" && result.response.verdict).toBe("sibling");
  });

  it("keeps the less reassuring verdict when a peer finishes between the two reads", async () => {
    const fixture = await seedFixture(db);
    const peer = await insertPeerRun(db, fixture, { status: "running" });

    const result = await evaluateNativeSiblingLiveness(db, callerInput(fixture), {
      afterSnapshot: async () => {
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, peer.id));
      },
    });

    expect(result.kind === "response" && result.response.verdict).toBe("sibling");
  });

  it("does not send a verdict whose validity window has already closed", async () => {
    const fixture = await seedFixture(db);

    const result = await evaluateNativeSiblingLiveness(db, callerInput(fixture), {
      afterSnapshot: async () => { await new Promise((resolve) => setTimeout(resolve, 3_100)); },
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("fails closed when the second read fails", async () => {
    const fixture = await seedFixture(db);

    const result = await evaluateNativeSiblingLiveness(db, callerInput(fixture), {
      afterSnapshot: async () => { throw new Error("connection lost"); },
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("is not blocked by an uncommitted writer of the caller's rows", async () => {
    const fixture = await seedFixture(db);
    let release!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.update(issues).set({ title: "held" }).where(eq(issues.id, fixture.issue.id));
      await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.run.id));
      await tx.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, fixture.agent.id));
      locked();
      await hold;
    });
    await lockReady;
    try {
      const result = await evaluateNativeSiblingLiveness(db, callerInput(fixture));
      expect(result.kind === "response" && result.response.verdict).toBe("clear");
    } finally {
      release();
      await writer;
    }
  });

  it("takes no row locks", () => {
    const source = readFileSync(
      new URL("../services/native-sibling-liveness.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\.for\(|\bfor\s+(?:no\s+key\s+)?(?:update|share)\b|\bfor\s+key\s+share\b/i);
  });

  it("fails closed when the snapshot exceeds its statement timeout", async () => {
    const fixture = await seedFixture(db);

    const result = await evaluateNativeSiblingLiveness(db, callerInput(fixture), {
      afterTimeoutSet: async (tx) => { await tx.execute(sql`select pg_sleep(1.5)`); },
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("runs the snapshot read-only", async () => {
    const fixture = await seedFixture(db);

    const result = await evaluateNativeSiblingLiveness(db, callerInput(fixture), {
      afterTimeoutSet: async (tx) => {
        await tx.update(issues).set({ title: "written" }).where(eq(issues.id, fixture.issue.id));
      },
    });

    expect(result).toEqual({ kind: "unavailable" });
    const [row] = await db.select({ title: issues.title }).from(issues).where(eq(issues.id, fixture.issue.id));
    expect(row!.title).toBe(fixture.issue.title);
  });

  it("returns unavailable when the database read fails outright", async () => {
    const fixture = await seedFixture(db);
    const failing = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("connection lost"));
    try {
      const res = await getIssueRoute(createApp(db), fixture);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.verdict).toBeUndefined();
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      failing.mockRestore();
    }
  });

  it.each([
    ["an agent key", { type: "agent", source: "agent_key", keyScope: { kind: "standard" } }],
    ["a board session", { type: "board", source: "session", userId: "board-user", isInstanceAdmin: true }],
    ["a board key", { type: "board", source: "board_key", userId: "board-user", isInstanceAdmin: true }],
    ["an implicit local board", { type: "board", source: "local_implicit", userId: "board-user", isInstanceAdmin: true }],
  ] as const)("rejects %s even with a matching run credential in the request", async (_name, partial) => {
    const fixture = await seedFixture(db);
    const actor = {
      ...partial,
      agentId: fixture.agent.id,
      companyId: fixture.company.id,
      runId: fixture.run.id,
    } as unknown as Express.Request["actor"];

    const res = await getIssueRoute(createApp(db, actor), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.verdict).toBeUndefined();
  });

  it("requires strict run authority, not a legacy-compatible token", async () => {
    const fixture = await seedFixture(db);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      sub: fixture.agent.id,
      company_id: fixture.company.id,
      adapter_type: fixture.agent.adapterType,
      run_id: fixture.run.id,
      iat: now,
      exp: now + 600,
    })}`;
    const legacy = `${signingInput}.${createHmac("sha256", process.env.PAPERCLIP_AGENT_JWT_SECRET!)
      .update(signingInput).digest("base64url")}`;
    expect(verifyLocalAgentJwt(legacy)).not.toBeNull();
    expect(verifyLocalAgentJwt(legacy, { strictRunAuthority: true })).toBeNull();

    const res = await getIssueRoute(createApp(db), fixture, legacy);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.verdict).toBeUndefined();
  });

  it("never lets a path variant escape the no-store policy", async () => {
    const fixture = await seedFixture(db);

    const res = await request(createApp(db))
      .get(`/api/issues/${fixture.issue.id}/Sibling-Liveness/`)
      .set("Authorization", `Bearer ${makeJwt(fixture)}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.etag).toBeUndefined();
  });

  it.each(["not-an-issue", "%20{id}", "{id}%20", "{id}x"])("answers the malformed issue id %s as not found, not as an outage", async (template) => {
    const fixture = await seedFixture(db);

    const res = await request(createApp(db))
      .get(`/api/issues/${template.replace("{id}", fixture.issue.id)}/sibling-liveness`)
      .set("Authorization", `Bearer ${makeJwt(fixture)}`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it.each([
    ["the issue is no longer in progress", async (f: Fixture) => {
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, f.issue.id));
    }, 409],
    ["the issue names a different execution run", async (f: Fixture) => {
      const other = await seedRun(db, { companyId: f.company.id, agentId: f.agent.id, issueId: f.issue.id });
      await db.update(issues).set({ executionRunId: other.id }).where(eq(issues.id, f.issue.id));
    }, 404],
    ["the run is not a native run", async (f: Fixture) => {
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, f.run.id));
    }, 409],
    ["the run never started", async (f: Fixture) => {
      await db.update(heartbeatRuns).set({ startedAt: null }).where(eq(heartbeatRuns.id, f.run.id));
    }, 409],
    ["the run is finished but still marked running", async (f: Fixture) => {
      await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    }, 409],
  ])("rejects a caller when %s", async (_state, change, expected) => {
    const fixture = await seedFixture(db);
    await change(fixture);

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    expect(res.body.verdict).toBeUndefined();
  });

  it.each([
    ["a queued peer that already started", { status: "queued" as const }, { startedAt: new Date() }],
    ["a running peer that never started", { status: "running" as const }, { startedAt: null }],
    ["a running peer that already finished", { status: "running" as const }, { finishedAt: new Date() }],
  ])("returns unknown for %s", async (_label, peer, change) => {
    const fixture = await seedFixture(db);
    const inserted = await insertPeerRun(db, fixture, peer);
    await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, inserted.id));

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("unknown");
  });

  it("counts a peer owned by a different agent", async () => {
    const fixture = await seedFixture(db);
    const otherAgent = await seedAgent(db, fixture.company.id);
    await insertPeerRun(db, fixture, { status: "running", agentId: otherAgent.id });

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("sibling");
  });

  it.each([
    ["a peer whose snapshot was later retargeted at this issue", "issueId"],
    ["a peer whose snapshot task id was later retargeted at this issue", "taskId"],
  ] as const)("returns unknown for %s", async (_label, key) => {
    const fixture = await seedFixture(db);
    const other = await seedIssue(db, fixture.company.id, fixture.agent.id);
    const peer = await insertPeerRun(db, fixture, {
      status: "running",
      nativeIssueId: other.id,
      contextIssueId: other.id,
    });
    // The binding trigger derives the durable issue only on insert, so a later context edit
    // is the one way a peer is reachable through its snapshot alone.
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: other.id, [key]: fixture.issue.id, executionPolicy: {} } })
      .where(eq(heartbeatRuns.id, peer.id));

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("unknown");
  });

  it.each([
    ["an uninterpretable issue policy", async (f: Fixture) => {
      await db.update(issues).set({ executionPolicy: [] as never }).where(eq(issues.id, f.issue.id));
    }],
    ["an uninterpretable agent policy", async (f: Fixture) => {
      await db.update(agents).set({ permissions: [] as never }).where(eq(agents.id, f.agent.id));
    }],
    ["an uninterpretable run policy", async (f: Fixture) => {
      await db.update(heartbeatRuns)
        .set({ contextSnapshot: { issueId: f.issue.id, executionPolicy: [] } })
        .where(eq(heartbeatRuns.id, f.run.id));
    }],
    ["a missing run snapshot", async (f: Fixture) => {
      await db.update(heartbeatRuns).set({ contextSnapshot: null }).where(eq(heartbeatRuns.id, f.run.id));
    }],
    ["an uninterpretable project policy", async (f: Fixture) => {
      const [project] = await db.insert(projects).values({
        companyId: f.company.id,
        name: "Odd project",
        executionWorkspacePolicy: [] as never,
      }).returning();
      await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, f.issue.id));
    }],
  ])("never clears with %s", async (_label, change) => {
    const fixture = await seedFixture(db);
    await change(fixture);

    const res = await getIssueRoute(createApp(db), fixture);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.verdict).toBe("unknown");
  });

  it("answers a conditional request with a full uncached verdict", async () => {
    const fixture = await seedFixture(db);
    const app = createApp(db);
    const first = await getIssueRoute(app, fixture);

    const second = await request(app)
      .get(`/api/issues/${fixture.issue.id}/sibling-liveness`)
      .set("Authorization", `Bearer ${makeJwt(fixture)}`)
      .set("If-None-Match", String(first.headers.etag ?? "W/\"x\""))
      .set("If-Modified-Since", new Date(Date.now() + 60_000).toUTCString());

    expect(second.status).toBe(200);
    expect(second.headers["cache-control"]).toBe("no-store");
    expect(second.body.verdict).toBe("clear");
  });

  it.each(["post", "put", "patch", "delete"] as const)("does not expose a %s method", async (method) => {
    const fixture = await seedFixture(db);
    const before = await snapshotRows(db);

    const res = await request(createApp(db))[method](`/api/issues/${fixture.issue.id}/sibling-liveness`)
      .set("Authorization", `Bearer ${makeJwt(fixture)}`);

    expect(res.status).toBe(404);
    expect(await snapshotRows(db)).toEqual(before);
  });
});
