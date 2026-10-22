import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentApiKeys, applyPendingMigrations, closeRegisteredClients,
  companies, companyMemberships, createDb, issues, heartbeatRuns, agentWakeupRequests,
} from "@paperclipai/db";
import { issueEventWaitCoverage } from "../../../packages/db/src/schema/issue_event_wait_coverage.js";
import { issueWaitCoverageRoutes } from "../routes/issue-wait-coverage.js";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { patchInstanceExperimentalSettingsSchema } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";
import { EXTERNAL_REF, HOUR, NOW } from "./fixtures/durable-wait-contract.js";

// Real Postgres integration. Never read DATABASE_URL or silently skip missing prerequisites.
// Provision an EMPTY disposable DB; the suite refuses a nonempty database before migration.
function testDatabaseUrl() {
  const value = process.env.PAPERCLIP_DURABLE_WAIT_TEST_DATABASE_URL;
  if (!value) throw new Error("Set PAPERCLIP_DURABLE_WAIT_TEST_DATABASE_URL to an empty paperclip_durable_wait_test_* database on agent-testdb (or CI PostgreSQL)");
  const url = new URL(value);
  const allowedHost = url.hostname === "agent-testdb" || (process.env.CI === "true" && ["localhost", "127.0.0.1", "postgres"].includes(url.hostname));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !allowedHost || !/^\/paperclip_durable_wait_test_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error("Refusing non-test durable-wait database; require agent-testdb and paperclip_durable_wait_test_* (CI local PostgreSQL also allowed)");
  }
  return value;
}

let db: ReturnType<typeof createDb>;
let databaseUrl: string;
let fixture: { companyId: string; otherCompanyId: string; issueId: string; otherIssueId: string; agentId: string; otherAgentId: string; userId: string; outsiderId: string; viewerId: string; inactiveId: string; token: string };

function app(userId: string | null) {
  const server = express();
  server.use(express.json());
  server.use(actorMiddleware(db, {
    deploymentMode: "authenticated",
    resolveSession: async () => userId ? {
      session: { id: `session-${userId}`, userId },
      user: { id: userId, name: "Fixture member", email: `${userId}@example.test` },
    } : null,
  }));
  server.use(boardMutationGuard());
  server.use("/api", issueWaitCoverageRoutes(db));
  server.use(errorHandler);
  return server;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    serviceName: "github-pr-controller", externalRef: EXTERNAL_REF, sourceKind: "github_pr",
    eventRevision: "head-a:pending", armedRevision: "head-a:pending", observationStatus: "ok",
    observedAt: new Date(NOW - HOUR).toISOString(), armedAssigneeAgentId: fixture.agentId,
    armedStatus: "in_review", fallbackAt: new Date(NOW + HOUR).toISOString(),
    ...overrides,
  };
}

function register(payload = body(), userId: string | null = fixture.userId, companyId = fixture.companyId, issueId = fixture.issueId) {
  return request(app(userId)).post(`/api/companies/${companyId}/issues/${issueId}/wait-coverage`)
    .set("Origin", "http://localhost:3100").send(payload);
}

async function rows() {
  return db.select().from(issueEventWaitCoverage).where(eq(issueEventWaitCoverage.companyId, fixture.companyId));
}

async function receipt() {
  const result = await register(); expect([200, 201]).toContain(result.status);
  const stored = await rows(); expect(stored).toHaveLength(1); return stored[0]!;
}

beforeAll(async () => {
  databaseUrl = testDatabaseUrl();
  const preflight = createDb(databaseUrl);
  try {
    const tables = await preflight.execute(sql`select tablename from pg_tables where schemaname not in ('pg_catalog', 'information_schema')`);
    if (tables.length) throw new Error("Refusing a nonempty test database; provision a fresh disposable database for each run");
  } finally { await closeRegisteredClients(databaseUrl); }
  await applyPendingMigrations(databaseUrl);
  db = createDb(databaseUrl);
}, 120_000);

afterAll(async () => { if (databaseUrl) await closeRegisteredClients(databaseUrl); });
afterEach(() => vi.useRealTimers());
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
  const issueId = randomUUID(), otherIssueId = randomUUID();
  const userId = randomUUID(), outsiderId = randomUUID(), viewerId = randomUUID(), inactiveId = randomUUID();
  const token = `fixture-only-${randomUUID()}`;
  fixture = { companyId, otherCompanyId, agentId, otherAgentId, issueId, otherIssueId, userId, outsiderId, viewerId, inactiveId, token };
  await db.insert(companies).values([
    { id: companyId, name: "Wait fixture", issuePrefix: `A${companyId.slice(0, 6)}` },
    { id: otherCompanyId, name: "Other fixture", issuePrefix: `B${otherCompanyId.slice(0, 6)}` },
  ]);
  await db.insert(agents).values([
    { id: agentId, companyId, name: "Fixture worker", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
    { id: otherAgentId, companyId: otherCompanyId, name: "Other worker", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
  ]);
  await db.insert(agentApiKeys).values({ agentId, companyId, name: "Fixture only", keyHash: createHash("sha256").update(token).digest("hex") });
  await db.insert(companyMemberships).values([
    { companyId, principalType: "user", principalId: userId, membershipRole: "member", status: "active" },
    { companyId: otherCompanyId, principalType: "user", principalId: outsiderId, membershipRole: "member", status: "active" },
    { companyId, principalType: "user", principalId: viewerId, membershipRole: "viewer", status: "active" },
    { companyId, principalType: "user", principalId: inactiveId, membershipRole: "member", status: "inactive" },
  ]);
  await db.insert(issues).values([
    { id: issueId, companyId, title: "Wait", status: "in_review", assigneeAgentId: agentId, monitorNextCheckAt: new Date(NOW + HOUR), monitorAttemptCount: 0, monitorScheduledBy: "assignee", executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: { kind: "external_service", serviceName: "github-pr-controller", externalRef: EXTERNAL_REF, nextCheckAt: new Date(NOW + HOUR).toISOString(), scheduledBy: "assignee", maxAttempts: 3, timeoutAt: null } } },
    { id: otherIssueId, companyId: otherCompanyId, title: "Other", status: "in_review", assigneeAgentId: otherAgentId },
  ]);
});

describe("authenticated wait-coverage registration (real isolated PostgreSQL)", () => {
  it("persists a company-scoped observation and mandatory activity receipt", async () => {
    const row = await receipt();
    expect(row).toMatchObject({ companyId: fixture.companyId, issueId: fixture.issueId, serviceName: "github-pr-controller", externalRef: EXTERNAL_REF, sourceKind: "github_pr", eventRevision: "head-a:pending", armedRevision: "head-a:pending", armedAssigneeAgentId: fixture.agentId, armedStatus: "in_review", observationStatus: "ok", unresolvedActionableEventAt: null });
    expect(row.observedAt.getTime()).toBe(NOW - HOUR);
    expect(row.expiresAt.getTime()).toBe(NOW + 12 * HOUR);
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, fixture.companyId), eq(activityLog.action, "issue.wait_coverage_registered")));
    expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ actorType: "user", actorId: fixture.userId, entityType: "issue", entityId: fixture.issueId });
    expect(JSON.stringify(row.registeredByActor)).toContain(fixture.userId);
  });

  it("anonymous actors cannot register", async () => { expect((await register(body(), null)).status).toBe(401); expect(await rows()).toHaveLength(0); });

  it("real agent API keys cannot self-assert board/system identity", async () => {
    const result = await request(app(null)).post(`/api/companies/${fixture.companyId}/issues/${fixture.issueId}/wait-coverage`)
      .set("Authorization", `Bearer ${fixture.token}`).send(body({ actor: { type: "system" }, registeredByActor: { type: "board", id: fixture.userId } }));
    expect(result.status).toBe(403); expect(await rows()).toHaveLength(0);
  });

  it.each(["outsiderId", "viewerId", "inactiveId"] as const)("denies %s using DB-derived membership", async (key) => {
    expect((await register(body(), fixture[key])).status).toBe(403); expect(await rows()).toHaveLength(0);
  });

  it("member cannot register across a company boundary", async () => {
    expect((await register(body(), fixture.userId, fixture.otherCompanyId, fixture.otherIssueId)).status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it("cross-company issue is indistinguishable from a missing issue", async () => {
    const cross = await register(body(), fixture.userId, fixture.companyId, fixture.otherIssueId);
    const missing = await register(body(), fixture.userId, fixture.companyId, randomUUID());
    expect(cross.status).toBe(404); expect(missing.status).toBe(404); expect(await rows()).toHaveLength(0);
  });

  it("rejects cross-company armed assignee spoofing", async () => {
    expect([400, 403, 404, 422]).toContain((await register(body({ armedAssigneeAgentId: fixture.otherAgentId }))).status);
    expect(await rows()).toHaveLength(0);
  });

  it("body actor/company/issue fields never override authenticated scope", async () => {
    const result = await register(body({ companyId: fixture.otherCompanyId, issueId: fixture.otherIssueId, registeredByActor: { type: "system", id: "forged-system" }, actor: { type: "system", id: "forged-system" } }));
    if ([400, 422].includes(result.status)) { expect(await rows()).toHaveLength(0); return; }
    expect([200, 201]).toContain(result.status);
    const [row] = await rows(); expect(row).toMatchObject({ companyId: fixture.companyId, issueId: fixture.issueId });
    expect(JSON.stringify(row!.registeredByActor)).toContain(fixture.userId);
    expect(JSON.stringify(row!.registeredByActor)).not.toContain("forged-system");
    expect(await db.select().from(issueEventWaitCoverage).where(eq(issueEventWaitCoverage.companyId, fixture.otherCompanyId))).toHaveLength(0);
  });

  it("idempotent upsert retains one row and updates the observation", async () => {
    const first = await receipt();
    for (let n = 0; n < 2; n++) expect([200, 201]).toContain((await register(body({ eventRevision: "head-b:red", observationStatus: "error" }))).status);
    const stored = await rows(); expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ id: first.id, eventRevision: "head-b:red", observationStatus: "error" });
    expect(stored[0]!.observedAt.getTime()).toBe(NOW - HOUR);
  });

  it("database uniqueness rejects a duplicate natural key without relying on route dedup", async () => {
    const row = await receipt(); const { id: _id, ...duplicate } = row;
    await expect(db.insert(issueEventWaitCoverage).values(duplicate)).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
    expect(await rows()).toHaveLength(1);
  });

  it("concurrent registrations converge to a single natural-key row", async () => {
    const results = await Promise.all([register(), register()]);
    for (const result of results) expect([200, 201]).toContain(result.status);
    expect(await rows()).toHaveLength(1);
  });

  it("distinct service/reference tuples do not overwrite one another", async () => {
    await receipt();
    expect([200, 201]).toContain((await register(body({ externalRef: "https://github.com/example/project/pull/43" }))).status);
    expect([200, 201]).toContain((await register(body({ serviceName: "other-controller" }))).status);
    expect(await rows()).toHaveLength(3);
  });

  it.each([HOUR, 12 * HOUR, 13 * HOUR])("server expiry is min(registration+12h, monitor timeout %s)", async (timeout) => {
    await db.update(issues).set({ executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: { kind: "external_service", serviceName: "github-pr-controller", externalRef: EXTERNAL_REF, nextCheckAt: new Date(NOW + HOUR).toISOString(), scheduledBy: "assignee", timeoutAt: new Date(NOW + timeout).toISOString(), maxAttempts: 3 } } }).where(eq(issues.id, fixture.issueId));
    const row = await receipt(); expect(row.expiresAt.getTime()).toBe(NOW + Math.min(12 * HOUR, timeout));
  });

  it("a client cannot extend expiry or spoof server registration time", async () => {
    const result = await register(body({ expiresAt: new Date(NOW + 30 * HOUR).toISOString(), updatedAt: new Date(NOW + 30 * HOUR).toISOString(), registeredAt: new Date(NOW + 30 * HOUR).toISOString() }));
    if ([400, 422].includes(result.status)) { expect(await rows()).toHaveLength(0); return; }
    expect([200, 201]).toContain(result.status); const [row] = await rows();
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(NOW + 12 * HOUR);
    expect(row!.updatedAt.getTime()).toBeLessThanOrEqual(NOW);
  });

  it.each([
    ["serviceName", ""], ["externalRef", ""], ["sourceKind", "unknown"], ["observationStatus", "unknown"],
    ["observedAt", "invalid"], ["observedAt", new Date(NOW + 1).toISOString()], ["eventRevision", ""],
    ["armedRevision", ""], ["armedAssigneeAgentId", "not-a-uuid"], ["armedStatus", "unknown"], ["fallbackAt", "invalid"],
  ])("validates %s=%j without persisting or auditing a success", async (key, value) => {
    const result = await register(body({ [key]: value })); expect([400, 422]).toContain(result.status); expect(await rows()).toHaveLength(0);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, fixture.companyId), eq(activityLog.action, "issue.wait_coverage_registered")))).toHaveLength(0);
  });

  it("registration never silently refreshes a stale observation timestamp", async () => {
    const observedAt = new Date(NOW - 2 * HOUR).toISOString();
    const result = await register(body({ observedAt }));
    if ([400, 422].includes(result.status)) { expect(await rows()).toHaveLength(0); return; }
    expect([200, 201]).toContain(result.status); expect((await rows())[0]!.observedAt.toISOString()).toBe(observedAt);
  });

  it.each(["off", "shadow", "enforce"])("registration in %s mode does not mutate the issue, claim a monitor or create execution work", async (mode) => {
    await instanceSettingsService(db).updateExperimental(patchInstanceExperimentalSettingsSchema.parse({ eventBackedWaitMode: mode }));
    const before = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const runsBefore = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.companyId));
    const wakesBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId));
    await receipt();
    expect(await db.select().from(issues).where(eq(issues.id, fixture.issueId))).toEqual(before);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, fixture.companyId))).toEqual(runsBefore);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, fixture.companyId))).toEqual(wakesBefore);
  });
});
