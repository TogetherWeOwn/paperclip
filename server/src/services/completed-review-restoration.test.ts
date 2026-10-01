import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  type Db, activityLog, agentWakeupRequests, heartbeatRuns, issueApprovals,
  issueComments, issueRecoveryActions, issueRelations, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { buildCompletedReviewEvidence } from "./completed-review-reconciliation-evidence.js";
import { completedReviewRestorationService, type CompletedReviewRestorationInput } from "./completed-review-restoration.js";
import { forbidden } from "../errors.js";

const mocks = vi.hoisted(() => ({
  context: vi.fn(), update: vi.fn(), log: vi.fn(), publish: vi.fn(), actions: vi.fn(), blocker: vi.fn(), hold: vi.fn(),
}));
vi.mock("./completed-review-receipt.js", () => ({ readCompletedReviewEvidenceContext: mocks.context }));
vi.mock("./issues.js", () => ({ issueService: () => ({ updateForCompany: mocks.update }), executeIssuePostCommitActions: mocks.actions }));
vi.mock("./activity-log.js", () => ({ logActivity: mocks.log, publishActivity: mocks.publish }));
vi.mock("./execution-blocker.js", () => ({ getExecutionBlocker: mocks.blocker }));
vi.mock("./issue-tree-control.js", () => ({ issueTreeControlService: () => ({ getActivePauseHoldGate: mocks.hold }) }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, second));

function fixture(agent = false) {
  const scope = { companyId: id(1), issueId: id(2) };
  const state = {
    status: "completed", completedStageIds: [id(4)], lastDecisionId: id(7), lastDecisionOutcome: "approved",
    currentStageId: null, currentStageIndex: null, currentStageType: null, currentParticipant: null,
    returnAssignee: { type: "agent", agentId: id(3), userId: null }, changesRequestedCount: 0, reviewRequest: null, monitor: null,
  };
  const policy = { executionPolicy: { mode: "normal", commentRequired: true,
    stages: [{ id: id(4), type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: id(6), userId: null }] }] } };
  const delivery = { workProducts: [{ id: id(90), status: "merged" }] };
  const decisions = [{ ...scope, id: id(7), stageId: id(4), stageType: "review", actorAgentId: id(6), actorUserId: null,
    createdByRunId: id(8), outcome: "approved", createdAt: at(2), updatedAt: at(2) }];
  const issue = { id: scope.issueId, companyId: scope.companyId, status: "todo", executionState: null as unknown,
    hiddenAt: null, conversationAgentId: null, monitorNextCheckAt: null, assigneeAgentId: id(6), assigneeUserId: null,
    checkoutRunId: null as string | null, executionRunId: null as string | null };
  const completion = { id: id(10), companyId: scope.companyId, entityType: "issue", entityId: scope.issueId,
    actorType: "agent", actorId: id(6), runId: id(8), action: "issue.updated", createdAt: at(3), details: {
      status: "done", executionState: state, completionCommentId: id(11),
      completedReviewEvidence: buildCompletedReviewEvidence({ ...scope, policy, delivery, decisionIds: [id(7)] }),
    } as Record<string, unknown> };
  const commentActivity = { ...completion, id: id(12), action: "issue.comment_added", createdAt: at(4), details: { commentId: id(11) } };
  const reopen = { ...completion, id: id(13), actorType: "system", actorId: "heartbeat", createdAt: at(5), details: {
    status: "todo", reopened: true, reopenedFrom: "done", source: "deferred_comment_wake",
  } };
  const activities = [completion, commentActivity, reopen];
  const comments = [{ ...scope, id: id(11), authorAgentId: id(6), authorUserId: null, createdByRunId: id(8),
    deletedAt: null, createdAt: at(3), updatedAt: at(3) },
  { ...scope, id: id(14), authorAgentId: id(20), authorUserId: null, createdByRunId: id(21),
    deletedAt: null, createdAt: at(1), updatedAt: at(1) }];
  const wake = { ...scope, id: id(15), agentId: id(6), reason: "issue_execution_promoted", runId: id(16),
    requestedAt: at(1), payload: { issueId: scope.issueId, _paperclipWakeContext: {
      issueId: scope.issueId, wakeReason: "issue_commented", wakeCommentIds: [id(14)],
    } as Record<string, unknown> } };
  const promoted = { id: id(16), companyId: scope.companyId, agentId: id(6), wakeupRequestId: wake.id, status: "succeeded",
    contextSnapshot: { issueId: scope.issueId, wakeReason: "issue_commented", wakeCommentIds: [id(14)] } as Record<string, unknown> };
  const caller = { ...promoted, id: id(17), status: "running", contextSnapshot: { issueId: scope.issueId } as Record<string, unknown> };
  const input: CompletedReviewRestorationInput = { ...scope, completionActivityId: completion.id, wakeupRequestId: wake.id,
    actor: agent ? { actorType: "agent", actorId: id(6), agentId: id(6), runId: caller.id }
      : { actorType: "user", actorId: "existing-board-user", agentId: null, runId: null } };
  const byTable = new Map<unknown, unknown[]>([
    [issues, [issue]], [activityLog, activities], [issueComments, comments], [issueThreadInteractions, []],
    [issueRecoveryActions, []], [issueApprovals, []], [issueRelations, []],
  ]);
  const heartbeatResults = agent ? [[caller], [promoted], []] : [[promoted], []];
  const wakeResults = [[wake], []];
  const conditions: Array<{ table: unknown; condition: unknown }> = [];
  const locks: unknown[] = [];
  const tx = { execute: vi.fn(async () => []), insert: vi.fn(), select: vi.fn(() => ({ from(table: unknown) {
    const rows = table === heartbeatRuns ? heartbeatResults.shift() ?? []
      : table === agentWakeupRequests ? wakeResults.shift() ?? [] : byTable.get(table) ?? [];
    const query = {
      where(condition: unknown) { conditions.push({ table, condition }); return query; },
      innerJoin: () => query, orderBy: () => query,
      for: vi.fn(() => { locks.push(table); return query; }),
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  } })) } as unknown as Db;
  const events: string[] = [];
  const transaction = vi.fn(async (work: (tx: Db) => Promise<unknown>) => {
    const result = await work(tx); events.push("commit"); return result;
  });
  const db = { transaction } as unknown as Db;
  mocks.context.mockResolvedValue({ policy, delivery, decisions });
  mocks.update.mockImplementation(async (_id, _companyId, update) => { Object.assign(issue, update); return { ...issue }; });
  mocks.log.mockImplementation(async (_tx, log, publications) => {
    activities.push({ ...log, id: id(30), createdAt: at(6) });
    publications.push({ companyId: scope.companyId });
    events.push("audit");
    return { id: id(30) };
  });
  mocks.publish.mockImplementation(() => events.push("publish"));
  const authorize = vi.fn(async () => {});
  return { db, tx, transaction, issue, state, scope, completion, activities, commentActivity, reopen, comments, wake,
    promoted, caller, input, byTable, heartbeatResults, wakeResults, conditions, locks, events, authorize, policy, delivery, decisions };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.blocker.mockResolvedValue(null);
  mocks.hold.mockResolvedValue(null);
});

describe("completed review restoration transaction (mock DB only)", () => {
  it("restores persisted facts and audits original references before publishing, without inserting decisions", async () => {
    const f = fixture();
    const originalDecisions = structuredClone(f.decisions);
    const result = await completedReviewRestorationService(f.db).restore(f.input, f.authorize);
    expect(result).toMatchObject({ outcome: "restore", completionActivityId: f.completion.id,
      issue: { status: "done", executionState: f.state, assigneeAgentId: id(3), assigneeUserId: null } });
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "serializable" });
    expect(f.authorize).toHaveBeenCalledWith(f.tx, f.issue);
    expect(f.locks).toEqual([issues, agentWakeupRequests, heartbeatRuns]);
    expect(mocks.update).toHaveBeenCalledWith(f.scope.issueId, f.scope.companyId, expect.objectContaining({ status: "done" }),
      f.tx, expect.any(Array), expect.any(Array));
    expect(mocks.log).toHaveBeenCalledWith(f.tx, expect.objectContaining({ action: "issue.completed_review_restored",
      details: expect.objectContaining({ completionActivityId: id(10), decisionIds: [id(7)], wakeupRequestId: id(15), commentIds: [id(14)] }) }), expect.any(Array));
    expect(f.events).toEqual(["audit", "commit", "publish"]);
    expect(f.tx.insert).not.toHaveBeenCalled();
    expect(f.decisions).toEqual(originalDecisions);
    const dialect = new PgDialect();
    for (const { condition } of f.conditions) {
      const { params } = dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
      expect(params).toContain(f.scope.companyId);
    }
  });

  it("is idempotent only for the same persisted receipt, wake and unchanged projection", async () => {
    const f = fixture();
    const service = completedReviewRestorationService(f.db);
    await service.restore(f.input, f.authorize);
    f.wakeResults.push([f.wake], []);
    f.heartbeatResults.push([f.promoted], []);
    expect(await service.restore(f.input, f.authorize)).toMatchObject({ outcome: "already_restored" });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledTimes(1);
    f.issue.assigneeAgentId = id(99);
    f.wakeResults.push([f.wake], []);
    f.heartbeatResults.push([f.promoted], []);
    await expect(service.restore(f.input, f.authorize)).rejects.toMatchObject({ status: 409, details: { reason: "restoration_drifted" } });
  });

  it("propagates the locked authorization denial before any update or audit", async () => {
    const f = fixture();
    f.authorize.mockRejectedValue(forbidden("Denied"));
    await expect(completedReviewRestorationService(f.db).restore(f.input, f.authorize)).rejects.toMatchObject({ status: 403 });
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("requires an active persisted same-company/agent/issue run, not just a supplied run id", async () => {
    const f = fixture(true);
    f.caller.contextSnapshot.issueId = id(99);
    await expect(completedReviewRestorationService(f.db).restore(f.input, f.authorize)).rejects.toMatchObject({ status: 403 });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["missing receipt", (f) => { delete f.completion.details.completedReviewEvidence; }],
    ["client-like missing completion comment", (f) => { delete f.completion.details.completionCommentId; }],
    ["completion comment edited", (f) => { f.comments[0].updatedAt = at(7); }],
    ["completion comment from another reviewer", (f) => { f.commentActivity.actorId = id(99); }],
    ["explicit resume in queued context", (f) => { f.wake.payload._paperclipWakeContext.resumeIntent = true; }],
    ["independent interaction", (f) => { f.promoted.contextSnapshot.interactionId = id(99); }],
    ["mixed comment batch", (f) => { f.promoted.contextSnapshot.wakeCommentIds = [id(99)]; }],
    ["promoted run for another issue", (f) => { f.promoted.contextSnapshot.issueId = id(99); }],
    ["newer comment", (f) => { f.comments[1].createdAt = at(7); }],
    ["comment edited since approval", (f) => { f.comments[1].updatedAt = at(7); }],
    ["newer policy", (f) => { f.policy.executionPolicy.commentRequired = false; }],
    ["changed delivery", (f) => { f.delivery.workProducts[0].status = "draft"; }],
    ["new adverse decision", (f) => { f.decisions[0].outcome = "rejected"; }],
    ["pending governance", (f) => { f.byTable.set(issueThreadInteractions, [{ status: "pending" }]); }],
    ["recovery action", (f) => { f.byTable.set(issueRecoveryActions, [{ status: "active" }]); }],
    ["active sibling run", (f) => { f.heartbeatResults[1].push({ ...f.promoted, id: id(99), status: "running" }); }],
    ["newer wake", (f) => { f.wakeResults[1].push({ ...f.wake, id: id(99) }); }],
    ["unresolved blocker", (f) => { f.byTable.set(issueRelations, [{ issues: { status: "todo" } }]); }],
    ["execution hold", () => { mocks.blocker.mockResolvedValue({ cause: "uncertain_work" }); }],
    ["tree hold", () => { mocks.hold.mockResolvedValue({ holdId: id(99) }); }],
    ["active continuation monitor", (f) => { Object.assign(f.issue, { monitorNextCheckAt: at(20) }); }],
    ["later intentional activity", (f) => { f.activities.push({ ...f.reopen, id: id(99), createdAt: at(7), details: { status: "in_progress" } }); }],
  ];
  it.each(refusals)("refuses %s without a projection/decision write", async (_name, mutate) => {
    const f = fixture(); mutate(f);
    await expect(completedReviewRestorationService(f.db).restore(f.input, f.authorize)).rejects.toMatchObject({ status: 409 });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(f.tx.insert).not.toHaveBeenCalled();
  });

  it.each(["40001", "40P01", "55P03", "57014"])("refuses fence failure %s without retry or publication", async (code) => {
    const f = fixture();
    f.transaction.mockRejectedValueOnce(Object.assign(new Error("Fence refused"), { code }));
    await expect(completedReviewRestorationService(f.db).restore(f.input, f.authorize)).rejects.toMatchObject({ status: 409,
      details: { reason: "concurrent_change_or_timeout" } });
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.actions).not.toHaveBeenCalled();
  });

  it("does not publish a transaction whose audit insertion fails", async () => {
    const f = fixture();
    mocks.log.mockRejectedValueOnce(new Error("Audit unavailable"));
    await expect(completedReviewRestorationService(f.db).restore(f.input, f.authorize)).rejects.toThrow("Audit unavailable");
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(f.events).not.toContain("commit");
  });
});
