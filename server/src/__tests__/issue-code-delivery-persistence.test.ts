import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, codeDeliveryDecisions, codeDeliveryDiscoveries, codeDeliveryObligations,
  codeDeliveryOwnershipEvents, codeDeliveryReadinessReceipts, codeDeliveryReceiptConsumptions, companies, companyMemberships,
  createDb, executionWorkspaces, heartbeatRuns, issueCodeDeliveryIntents, issueComments, issueExecutionDecisions,
  issueThreadInteractions, issues, projects, projectWorkspaces, statusDecisions, type Db } from "@paperclipai/db";
import { issueService, type IssuePostCommitAction } from "../services/issues.js";
import type { ActivityPublication } from "../services/activity-log.js";
import { codeDeliveryReadinessService, type PreparedCodeDeliveryReadiness } from "../services/code-delivery-readiness.js";
import { codeDeliveryDecisionService } from "../services/code-delivery-decisions.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../services/code-delivery-github.js", () => ({ createCodeDeliveryGitHubReader: () => provider.read }));
const actor: AuthorizationActor = { type: "board", userId: "reviewer", source: "local_implicit", isInstanceAdmin: true };
const head = "a".repeat(40), merge = "b".repeat(40);
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("common issue-service code-delivery persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-common-delivery-denial-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "reviewer", name: "Reviewer", email: "common-delivery-reviewer@example.invalid",
      createdAt: new Date(), updatedAt: new Date() });
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(() => { provider.read.mockReset(); });

  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const stageId = randomUUID(), participantId = randomUUID(), priorStageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Delivery boundary", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "reviewer", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending independent review", status: "in_review",
      assigneeAgentId: agentId, createdByAgentId: agentId,
      executionPolicy: { mode: "normal", stages: [
        { id: priorStageId, type: "review", participants: [{ id: randomUUID(), type: "user", userId: "security" }], approvalsNeeded: 1 },
        { id: stageId, type: "review", participants: [{ id: participantId, type: "user", userId: "reviewer" }], approvalsNeeded: 1 },
      ], commentRequired: true },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 1, currentStageType: "review",
        currentParticipant: { type: "user", userId: "reviewer" }, returnAssignee: { type: "agent", agentId },
        completedStageIds: [priorStageId], changesRequestedCount: 1, lastDecisionId: randomUUID(),
        lastDecisionOutcome: "changes_requested", reviewRequest: null },
    }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "running" });
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "request_confirmation", sourceRunId: runId,
      createdByAgentId: agentId, payload: { version: 1, prompt: "Independent acceptance" } });
    return { companyId, issueId, issue, agentId, runId };
  }

  async function snapshot(companyId: string) {
    return Promise.all([issues, heartbeatRuns, issueThreadInteractions, issueExecutionDecisions, statusDecisions,
      issueComments, activityLog, executionWorkspaces, issueCodeDeliveryIntents, codeDeliveryDecisions, codeDeliveryDiscoveries,
      codeDeliveryObligations, codeDeliveryOwnershipEvents, codeDeliveryReadinessReceipts, codeDeliveryReceiptConsumptions].map(async table => {
      const rows = await db.select().from(table).where(eq(table.companyId, companyId));
      return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }));
  }

  async function classify(f: Awaited<ReturnType<typeof seed>>, kind: "classify_code" | "classify_non_code") {
    const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    return codeDeliveryDecisionService(db).decide(f.companyId, f.issueId, actor, { kind,
      expectedIssueRevision: current!.codeDeliveryRevision, reason: "Independent final-stage classification", idempotencyKey: randomUUID() });
  }

  async function mergedDelivery(f: Awaited<ReturnType<typeof seed>>) {
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Source" }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project!.id,
      name: "Source", repoUrl: "https://github.com/fixture/source" }).returning();
    await db.update(issues).set({ projectId: project!.id, projectWorkspaceId: workspace!.id }).where(eq(issues.id, f.issueId));
    await classify(f, "classify_code");
    const [obligation] = await db.insert(codeDeliveryObligations).values({ companyId: f.companyId, ownerIssueId: f.issueId,
      sourceIssueId: f.issueId, sourceProjectId: project!.id, sourceWorkspaceId: workspace!.id,
      repositoryId: "42", repository: "fixture/source", pullRequestNumber: 1, baseRef: "main", proposedHeadSha: head,
      provenance: { kind: "test_registration" } }).returning();
    provider.read.mockImplementation(async () => ({ status: "observed", pullRequests: [{ repository: "fixture/source", repositoryId: "42",
      number: 1, baseRef: "main", headSha: head, draft: false, state: "merged", mergedAt: new Date(Date.now() - 1000).toISOString(),
      mergeCommitSha: merge, observedAt: new Date().toISOString() }] }));
    const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await codeDeliveryDecisionService(db).decide(f.companyId, f.issueId, actor, { kind: "accept_head", obligationId: obligation!.id,
      expectedObligationRevision: obligation!.revision, expectedIssueRevision: current!.codeDeliveryRevision, headSha: head,
      reason: "Independently reviewed the exact delivered head", idempotencyKey: randomUUID() });
    return obligation!;
  }

  it.each(["done", "cancelled"])("consumes independently classified non-code proof for common-service %s", async status => {
    const f = await seed();
    await classify(f, "classify_non_code");
    const prepared = await codeDeliveryReadinessService(db).prepare(f.companyId, f.issueId, status, actor);
    const publications: ActivityPublication[] = [], actions: IssuePostCommitAction[] = [];
    const updated = await db.transaction(tx => issueService(db).update(f.issueId, { status, actorUserId: "reviewer" },
      tx, publications, actions, { codeDelivery: { actor, prepared } }));
    expect(updated?.status).toBe(status);
    const [receipt] = await db.select().from(codeDeliveryReadinessReceipts).where(eq(codeDeliveryReadinessReceipts.issueId, f.issueId));
    const [consumption] = await db.select().from(codeDeliveryReceiptConsumptions).where(eq(codeDeliveryReceiptConsumptions.issueId, f.issueId));
    expect(receipt).toMatchObject({ terminalStatus: status, actorType: "user", actorId: "reviewer", evidence: { intent: { kind: "non_code" } } });
    expect(consumption).toMatchObject({ receiptId: receipt!.id, terminalStatus: status,
      issueRevision: receipt!.issueRevision + 1, transactionId: receipt!.transactionId });
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved?.codeDeliveryRevision).toBe(consumption!.issueRevision);
    expect(updated?.codeDeliveryRevision).toBe(consumption!.issueRevision);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId)))
      .toMatchObject([{ status: "expired", result: { outcome: "issue_closed" } }]);
    expect(provider.read).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]?.status).toBe("running");
  });

  it("commits the exact merged proof through the common service, not a raw SQL callback", async () => {
    const f = await seed(), obligation = await mergedDelivery(f);
    const service = codeDeliveryReadinessService(db);
    const prepared = await service.prepare(f.companyId, f.issueId, "done", actor);
    provider.read.mockClear();
    const updated = await db.transaction(tx => issueService(db).update(f.issueId, { status: "done", actorUserId: "reviewer" },
      tx, [], [], { codeDelivery: { actor, prepared } }));
    expect(updated).toMatchObject({ status: "done", completedAt: expect.any(Date) });
    const [receipt] = await db.select().from(codeDeliveryReadinessReceipts).where(eq(codeDeliveryReadinessReceipts.issueId, f.issueId));
    expect(receipt?.evidence).toMatchObject({ pullRequests: [{ obligationId: obligation.id, obligationRevision: 2,
      outcome: "merged", observation: { headSha: head, mergeCommitSha: merge, mergedAt: expect.any(String) } }] });
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("serializes competing prepared common-service completions into one consumed receipt", async () => {
    const f = await seed();
    await mergedDelivery(f);
    const service = codeDeliveryReadinessService(db);
    const tokens = await Promise.all([service.prepare(f.companyId, f.issueId, "done", actor),
      service.prepare(f.companyId, f.issueId, "done", actor)]);
    const outcomes = await Promise.allSettled(tokens.map(prepared => db.transaction(tx => issueService(db).update(f.issueId,
      { status: "done", actorUserId: "reviewer" }, tx, [], [], { codeDelivery: { actor, prepared } }))));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(codeDeliveryReadinessReceipts).where(eq(codeDeliveryReadinessReceipts.issueId, f.issueId))).toHaveLength(1);
    expect(await db.select().from(codeDeliveryReceiptConsumptions).where(eq(codeDeliveryReceiptConsumptions.issueId, f.issueId))).toHaveLength(1);
  });

  it("rolls back terminal status, receipt, consumption and audit when the caller's outer transaction fails", async () => {
    const f = await seed();
    await mergedDelivery(f);
    const prepared = await codeDeliveryReadinessService(db).prepare(f.companyId, f.issueId, "done", actor);
    const before = await snapshot(f.companyId);
    await expect(db.transaction(async tx => {
      await issueService(db).update(f.issueId, { status: "done", actorUserId: "reviewer" }, tx, [], [], { codeDelivery: { actor, prepared } });
      throw new Error("outer transaction rejected");
    })).rejects.toThrow("outer transaction rejected");
    expect(await snapshot(f.companyId)).toEqual(before);
  });

  it("rejects changed review rounds after preparation with all denial-side rows and caller buffers unchanged", async () => {
    const f = await seed();
    await mergedDelivery(f);
    const prepared = await codeDeliveryReadinessService(db).prepare(f.companyId, f.issueId, "done", actor);
    await db.update(issues).set({ executionState: { ...f.issue!.executionState, changesRequestedCount: 2 } }).where(eq(issues.id, f.issueId));
    const before = await snapshot(f.companyId), publications: ActivityPublication[] = [], actions: IssuePostCommitAction[] = [];
    await expect(db.transaction(tx => issueService(db).update(f.issueId, { status: "done", actorUserId: "reviewer" }, tx,
      publications, actions, { codeDelivery: { actor, prepared } }))).rejects.toMatchObject({ details: { code: "code_delivery_revision_conflict" } });
    expect(await snapshot(f.companyId)).toEqual(before);
    expect(publications).toEqual([]);
    expect(actions).toEqual([]);
  });

  it.each(["done", "cancelled"])("rejects direct effective %s with every saved review/run/interaction row unchanged", async status => {
    const f = await seed(), before = await snapshot(f.companyId);
    await expect(issueService(db).update(f.issueId, { status, actorUserId: "reviewer", companyGuard: f.companyId }))
      .rejects.toMatchObject({ status: 409, details: { code: "code_delivery_not_ready", reason: "preparation_required" } });
    expect(await snapshot(f.companyId)).toEqual(before);
  });

  it("refuses a fabricated receipt at the real common-service boundary and preserves the caller's transaction", async () => {
    const f = await seed(), before = await snapshot(f.companyId);
    const publications: ActivityPublication[] = [], actions: IssuePostCommitAction[] = [];
    await db.transaction(async tx => {
      await expect(issueService(db).update(f.issueId, { status: "done", actorUserId: "reviewer" }, tx, publications, actions,
        { codeDelivery: { actor: { type: "board", userId: "reviewer", source: "session" }, prepared: {} as PreparedCodeDeliveryReadiness } }))
        .rejects.toMatchObject({ status: 409, details: { reason: "preparation_required" } });
      expect(await tx.select().from(issues).where(eq(issues.id, f.issueId))).toEqual([f.issue]);
    });
    expect(publications).toEqual([]);
    expect(actions).toEqual([]);
    expect(await snapshot(f.companyId)).toEqual(before);
  });

  it("does not borrow an actor or ambient GitHub access for a system completion", async () => {
    const f = await seed(), before = await snapshot(f.companyId);
    await expect(issueService(db).update(f.issueId, { status: "done", actorAgentId: null, actorUserId: null }))
      .rejects.toMatchObject({ status: 409, details: { reason: "preparation_required" } });
    expect(await snapshot(f.companyId)).toEqual(before);
  });

  it("rejects a terminal timestamp without status at the real common-service boundary", async () => {
    const f = await seed(), before = await snapshot(f.companyId);
    await expect(issueService(db).update(f.issueId, { completedAt: new Date(), actorUserId: "reviewer" }))
      .rejects.toMatchObject({ status: 409, details: { reason: "terminal_timestamp_requires_status" } });
    expect(await snapshot(f.companyId)).toEqual(before);
  });
});
