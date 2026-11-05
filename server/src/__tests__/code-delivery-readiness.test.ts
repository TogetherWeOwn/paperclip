import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, codeDeliveryDecisions, codeDeliveryDiscoveries, codeDeliveryObligations, codeDeliveryOwnershipEvents,
  codeDeliveryReadinessReceipts, codeDeliveryReceiptConsumptions, issueCodeDeliveryIntents, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { codeDeliveryReadinessService, type DeliveryTransaction, type PreparedCodeDeliveryReadiness } from "../services/code-delivery-readiness.js";
import type { AuthorizationActor } from "../services/authorization.js";

const boundaries = vi.hoisted(() => ({ read: vi.fn(), issue: vi.fn(), lock: vi.fn(), authority: vi.fn(), destination: vi.fn() }));
vi.mock("../services/code-delivery-github.js", () => ({ createCodeDeliveryGitHubReader: () => boundaries.read }));
vi.mock("../services/code-delivery-authority.js", () => ({ readDeliveryIssue: boundaries.issue, lockDeliveryIssues: boundaries.lock,
  assertDeliveryAdjudicator: boundaries.authority, deliveryActor: (actor: AuthorizationActor) => ({ type: "user", id: actor.userId, runId: null }) }));
vi.mock("../services/code-delivery-transfer.js", () => ({ assertDeliveryTransferDestination: boundaries.destination }));
const actor: AuthorizationActor = { type: "board", userId: "reviewer", source: "session" };
const head = "a".repeat(40), merge = "b".repeat(40);

function harness(intent = "code") {
  const issue = { id: "issue", companyId: "company", status: "in_review", codeDeliveryRevision: 4,
    executionPolicy: { stages: [{ id: "qa", participants: [{ type: "user", userId: "reviewer" }] }] },
    executionState: { status: "pending", currentStageId: "qa", currentParticipant: { type: "user", userId: "reviewer" },
      completedStageIds: ["security"], changesRequestedCount: 1, returnAssignee: { type: "agent", agentId: "author" },
      lastDecisionId: "earlier-decision", monitor: { status: "scheduled", nextCheckAt: "2099-01-01T00:00:00Z" } } };
  const obligation = { id: "obligation", companyId: "company", ownerIssueId: "issue", sourceIssueId: "issue", provider: "github",
    sourceProjectId: "project", sourceWorkspaceId: "workspace", repositoryId: "42", repository: "fixture/source", pullRequestNumber: 1,
    baseRef: "main", proposedHeadSha: head, reviewedHeadSha: head, headDecisionId: "acceptance", revision: 2 };
  const datasets = new Map<unknown, unknown[]>([
    [issues, [issue]], [issueCodeDeliveryIntents, [{ issueId: "issue", companyId: "company", intent, revision: 2 }]],
    [codeDeliveryOwnershipEvents, []], [codeDeliveryObligations, intent === "non_code" ? [] : [obligation]], [codeDeliveryDiscoveries, []],
    [codeDeliveryReceiptConsumptions, []],
    [codeDeliveryDecisions, intent === "non_code" ? [] : [{ id: "acceptance", companyId: "company", issueId: "issue", obligationId: "obligation",
      kind: "accept_head", actorType: "user", actorId: "reviewer", obligationRevision: 1, payload: { headSha: head }, authority: { kind: "final_stage" } }]],
    [projects, [{ id: "project", companyId: "company", gitAuthorizationGrantId: "grant" }]],
    [projectWorkspaces, [{ id: "workspace", companyId: "company", projectId: "project", repoUrl: "https://github.com/fixture/source" }]],
  ]);
  const writes: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const savepoints = vi.fn(async (callback: (tx: DeliveryTransaction) => Promise<unknown>) => {
    const before = structuredClone(issue), writeCount = writes.length;
    const consumption = structuredClone(datasets.get(codeDeliveryReceiptConsumptions));
    try { return await callback(db as unknown as DeliveryTransaction); }
    catch (error) {
      Object.assign(issue, before);
      writes.splice(writeCount);
      datasets.set(codeDeliveryReceiptConsumptions, consumption ?? []);
      throw error;
    }
  });
  const db = {
    transaction: savepoints,
    select: (projection?: Record<string, unknown>) => ({ from: (table: unknown) => {
      const rows = () => table === issues && projection ? [{ revision: issue.codeDeliveryRevision }] : structuredClone(datasets.get(table) ?? []);
      const query = { where: () => query, orderBy: () => query, limit: () => query, for: () => query,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve) };
      return query;
    } }),
    insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
      writes.push({ table, value: structuredClone(value) });
      const query = { returning: async () => [{ id: "receipt", transactionId: "42", ...value }],
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
      return query;
    } }),
  } as unknown as Db;
  const mutate = vi.fn(async (_tx: DeliveryTransaction) => {
    const receipt = writes.find(row => row.table === codeDeliveryReadinessReceipts)?.value;
    issue.status = String(receipt?.terminalStatus ?? "in_review");
    issue.codeDeliveryRevision += 1;
    if (receipt) datasets.set(codeDeliveryReceiptConsumptions, [{ receiptId: "receipt", companyId: "company", issueId: "issue",
      issueRevision: issue.codeDeliveryRevision, terminalStatus: issue.status, transactionId: "42" }]);
    return "updated";
  });
  boundaries.issue.mockImplementation(async () => structuredClone(issue));
  boundaries.lock.mockImplementation(async () => [structuredClone(issue)]);
  boundaries.authority.mockResolvedValue({ kind: "final_stage" });
  const observe = () => ({ status: "observed", pullRequests: [{ repositoryId: "42", repository: "fixture/source", number: 1,
    baseRef: "main", headSha: head, state: "merged", draft: false, mergedAt: new Date(Date.now() - 1000).toISOString(),
    mergeCommitSha: merge, observedAt: new Date().toISOString() }] });
  boundaries.read.mockImplementation(async () => observe());
  const service = codeDeliveryReadinessService(db), tx = db as unknown as DeliveryTransaction;
  const apply = (token: PreparedCodeDeliveryReadiness | null, callback = mutate) => service.apply(tx, "company", "issue", "done", actor, token, callback);
  return { db, tx, issue, obligation, datasets, writes, observe, service, mutate, savepoints, apply };
}

beforeEach(() => { vi.useRealTimers(); Object.values(boundaries).forEach(mock => mock.mockReset()); });
describe("prepared code-delivery readiness boundary", () => {
  it("does not read delivery state for an earlier approval whose effective result is in_review", async () => {
    const f = harness();
    expect(await f.service.prepare("company", "issue", "in_review", actor)).toBeNull();
    expect(await f.service.apply(f.tx, "company", "issue", "in_review", actor, null, f.mutate)).toEqual({ receipt: null, result: "updated" });
    expect(f.mutate).toHaveBeenCalledWith(f.tx);
    expect(boundaries.issue).not.toHaveBeenCalled();
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(boundaries.read).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it.each(["done", "cancelled"])("requires a process-local prepared token for effective %s", async status => {
    const f = harness();
    for (const token of [null, {}, { receipt: { terminalStatus: status, mergeCommitSha: merge } }]) {
      await expect(f.service.apply(f.tx, "company", "issue", status, actor, token as PreparedCodeDeliveryReadiness | null, f.mutate))
        .rejects.toMatchObject({ status: 409, details: { code: "code_delivery_not_ready", reason: "preparation_required" } });
    }
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(f.mutate).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it.each(["done", "cancelled"])("skips GitHub for genuine non-code %s and saves nothing during preparation", async status => {
    const f = harness("non_code");
    const token = await f.service.prepare("company", "issue", status, actor);
    expect(token).toBeDefined();
    expect(Object.keys(token!)).toEqual([]);
    expect(f.writes).toEqual([]);
    expect(boundaries.read).not.toHaveBeenCalled();
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(await f.service.apply(f.tx, "company", "issue", status, actor, token, f.mutate))
      .toMatchObject({ receipt: { evidence: { intent: { kind: "non_code" }, pullRequests: [] } }, result: "updated" });
  });
  it("observes outside locks and binds exact merge evidence to the accepted terminal mutation", async () => {
    const f = harness();
    boundaries.read.mockImplementation(async () => {
      expect(boundaries.lock).not.toHaveBeenCalled();
      expect(f.savepoints).not.toHaveBeenCalled();
      return f.observe();
    });
    const token = await f.service.prepare("company", "issue", "done", actor);
    expect(f.writes).toEqual([]);
    const result = await f.apply(token);
    expect(result).toMatchObject({ receipt: { companyId: "company", issueId: "issue", issueRevision: 4, terminalStatus: "done",
      evidence: { version: 1, pullRequests: [{ obligationId: "obligation", obligationRevision: 2, decisionId: "acceptance",
        outcome: "merged", observation: { repositoryId: "42", headSha: head, mergeCommitSha: merge } }] } }, result: "updated" });
    expect(f.issue).toMatchObject({ status: "done", codeDeliveryRevision: 5 });
    expect(f.writes.map(row => row.table)).toEqual([codeDeliveryReadinessReceipts, activityLog]);
    expect(f.writes[1].value).toMatchObject({ details: { receiptId: "receipt", issueRevision: 4, terminalRevision: 5 } });
    expect(f.mutate).toHaveBeenCalledTimes(1);
    expect(boundaries.read).toHaveBeenCalledTimes(1);
  });
  it.each(["company", "issue", "status", "actor", "serialized"])("cannot replay preparation with another %s", async fault => {
    const f = harness(), token = await f.service.prepare("company", "issue", "done", actor);
    await expect(f.service.apply(f.tx, fault === "company" ? "other-company" : "company", fault === "issue" ? "other-issue" : "issue",
      fault === "status" ? "cancelled" : "done", fault === "actor" ? { ...actor, userId: "other" } : actor,
      fault === "serialized" ? JSON.parse(JSON.stringify(token)) : token, f.mutate)).rejects.toMatchObject({ status: 409 });
    expect(f.writes).toEqual([]);
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(f.mutate).not.toHaveBeenCalled();
  });
  it.each(["issue_revision", "round", "participant", "obligation", "discovery", "source", "authority"])("rejects a concurrent %s change before mutation", async fault => {
    const f = harness(), token = await f.service.prepare("company", "issue", "done", actor);
    if (fault === "issue_revision") f.issue.codeDeliveryRevision += 2;
    if (fault === "round") f.issue.executionState.changesRequestedCount += 1;
    if (fault === "participant") f.issue.executionState.currentParticipant.userId = "other";
    if (fault === "obligation") f.obligation.reviewedHeadSha = "c".repeat(40);
    if (fault === "discovery") f.datasets.set(codeDeliveryDiscoveries, [{ id: "late", companyId: "company", issueId: "issue", snapshot: {} }]);
    if (fault === "source") f.datasets.set(projectWorkspaces, [{ id: "workspace", repoUrl: "https://github.com/fixture/other" }]);
    if (fault === "authority") boundaries.authority.mockResolvedValue({ kind: "technical_authority", authorityRevision: 2 });
    const before = structuredClone(f.issue);
    await expect(f.apply(token)).rejects.toMatchObject({ status: 409 });
    expect(boundaries.lock).toHaveBeenCalledTimes(1);
    expect(f.mutate).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    expect(f.issue).toEqual(before);
  });
  it.each(["provider_unavailable", "authorization_unavailable", "deadline_exceeded", "invalid_response"])("discards the whole attempt on %s", async reason => {
    const f = harness(), before = structuredClone(f.issue);
    boundaries.read.mockResolvedValue({ status: "unavailable", reason });
    await expect(f.service.prepare("company", "issue", "done", actor)).rejects.toMatchObject({ status: 409, details: { code: "code_delivery_unavailable", reason } });
    expect(f.writes).toEqual([]);
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(f.issue).toEqual(before);
  });
  it("expires preparation rather than refreshing cached observations inside the transaction", async () => {
    vi.useFakeTimers();
    const f = harness(), token = await f.service.prepare("company", "issue", "done", actor);
    vi.advanceTimersByTime(30_001);
    await expect(f.apply(token)).rejects.toMatchObject({ status: 409 });
    expect(f.writes).toEqual([]);
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(f.mutate).not.toHaveBeenCalled();
    expect(boundaries.read).toHaveBeenCalledTimes(1);
  });
  it("claims a token synchronously so concurrent duplicate approvals invoke only one mutation", async () => {
    const f = harness(), token = await f.service.prepare("company", "issue", "done", actor);
    const results = await Promise.allSettled([f.apply(token), f.apply(token)]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.mutate).toHaveBeenCalledTimes(1);
    expect(f.writes.filter(row => row.table === codeDeliveryReadinessReceipts)).toHaveLength(1);
  });
  it.each(["noop", "wrong_status", "wrong_revision", "wrong_transaction", "missing_consumption", "exception"])("rolls back the savepoint on %s and burns the token", async fault => {
    const f = harness(), before = structuredClone(f.issue), token = await f.service.prepare("company", "issue", "done", actor);
    const mutate = vi.fn(async (tx: DeliveryTransaction) => {
      if (fault === "noop") return "unchanged";
      await f.mutate(tx);
      if (fault === "wrong_status") f.issue.status = "in_review";
      if (fault === "wrong_revision") f.issue.codeDeliveryRevision += 1;
      if (fault === "missing_consumption") f.datasets.set(codeDeliveryReceiptConsumptions, []);
      if (fault === "wrong_transaction") f.datasets.set(codeDeliveryReceiptConsumptions, [{ receiptId: "receipt", issueRevision: 5, terminalStatus: "done", transactionId: "other" }]);
      if (fault === "exception") throw new Error("native decision failed");
      return "updated";
    });
    await expect(f.apply(token, mutate)).rejects.toThrow();
    expect(f.issue).toEqual(before);
    expect(f.writes).toEqual([]);
    expect(f.datasets.get(codeDeliveryReceiptConsumptions)).toEqual([]);
    await expect(f.apply(token)).rejects.toMatchObject({ details: { reason: "preparation_required" } });
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
