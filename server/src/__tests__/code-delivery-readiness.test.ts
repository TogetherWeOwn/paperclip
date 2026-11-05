import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, codeDeliveryDecisions, codeDeliveryDiscoveries, codeDeliveryObligations, codeDeliveryOwnershipEvents,
  codeDeliveryReadinessReceipts, issueCodeDeliveryIntents, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
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
    [codeDeliveryDecisions, intent === "non_code" ? [] : [{ id: "acceptance", companyId: "company", issueId: "issue", obligationId: "obligation",
      kind: "accept_head", actorType: "user", actorId: "reviewer", obligationRevision: 1, payload: { headSha: head }, authority: { kind: "final_stage" } }]],
    [projects, [{ id: "project", companyId: "company", gitAuthorizationGrantId: "grant" }]],
    [projectWorkspaces, [{ id: "workspace", companyId: "company", projectId: "project", repoUrl: "https://github.com/fixture/source" }]],
  ]);
  const writes: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const db = {
    select: (projection?: Record<string, unknown>) => ({ from: (table: unknown) => {
      const rows = () => table === issues && projection ? [{ revision: issue.codeDeliveryRevision }] : structuredClone(datasets.get(table) ?? []);
      const query = { where: () => query, orderBy: () => query, limit: () => query, for: () => query,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve) };
      return query;
    } }),
    insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
      writes.push({ table, value: structuredClone(value) });
      const query = { returning: async () => [{ id: "receipt", ...value }], then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
      return query;
    } }),
  } as unknown as Db;
  boundaries.issue.mockImplementation(async () => structuredClone(issue));
  boundaries.lock.mockImplementation(async () => [structuredClone(issue)]);
  boundaries.authority.mockResolvedValue({ kind: "final_stage" });
  const observe = () => ({ status: "observed", pullRequests: [{ repositoryId: "42", repository: "fixture/source", number: 1,
    baseRef: "main", headSha: head, state: "merged", draft: false, mergedAt: new Date(Date.now() - 1000).toISOString(),
    mergeCommitSha: merge, observedAt: new Date().toISOString() }] });
  boundaries.read.mockImplementation(async () => observe());
  return { db, tx: db as unknown as DeliveryTransaction, issue, obligation, datasets, writes, observe, service: codeDeliveryReadinessService(db) };
}

beforeEach(() => { vi.useRealTimers(); Object.values(boundaries).forEach(mock => mock.mockReset()); });
describe("prepared code-delivery readiness boundary", () => {
  it("does not even read delivery state for an earlier approval whose effective result is in_review", async () => {
    const f = harness();
    expect(await f.service.prepare("company", "issue", "in_review", actor)).toBeNull();
    expect(await f.service.commit(f.tx, "company", "issue", "in_review", actor, null)).toBeNull();
    expect(boundaries.issue).not.toHaveBeenCalled();
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(boundaries.read).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it.each(["done", "cancelled"])("requires a process-local prepared token for effective %s", async status => {
    const f = harness();
    for (const token of [null, {}, { receipt: { terminalStatus: status, mergeCommitSha: merge } }]) {
      await expect(f.service.commit(f.tx, "company", "issue", status, actor, token as PreparedCodeDeliveryReadiness | null))
        .rejects.toMatchObject({ status: 409, details: { code: "code_delivery_not_ready", reason: "preparation_required" } });
    }
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it("skips GitHub entirely for genuine non-code completion and saves no receipt during preparation", async () => {
    const f = harness("non_code");
    const token = await f.service.prepare("company", "issue", "done", actor);
    expect(token).toBeDefined();
    expect(Object.keys(token!)).toEqual([]);
    expect(f.writes).toEqual([]);
    expect(boundaries.read).not.toHaveBeenCalled();
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(await f.service.commit(f.tx, "company", "issue", "done", actor, token)).toMatchObject({ evidence: { intent: { kind: "non_code" }, pullRequests: [] } });
  });
  it("observes before taking locks and retains exact repository/head/merge evidence in the transaction receipt", async () => {
    const f = harness(), before = structuredClone(f.issue);
    boundaries.read.mockImplementation(async () => {
      expect(boundaries.lock).not.toHaveBeenCalled();
      return f.observe();
    });
    const token = await f.service.prepare("company", "issue", "done", actor);
    expect(f.writes).toEqual([]);
    const receipt = await f.service.commit(f.tx, "company", "issue", "done", actor, token);
    expect(receipt).toMatchObject({ companyId: "company", issueId: "issue", issueRevision: 4, terminalStatus: "done",
      evidence: { version: 1, pullRequests: [{ obligationId: "obligation", obligationRevision: 2, decisionId: "acceptance",
        outcome: "merged", observation: { repositoryId: "42", headSha: head, mergeCommitSha: merge } }] } });
    expect(f.issue).toEqual(before);
    expect(f.writes.map(row => row.table)).toEqual([codeDeliveryReadinessReceipts, activityLog]);
    expect(boundaries.read).toHaveBeenCalledTimes(1);
  });
  it.each(["company", "issue", "status", "actor", "serialized"])("cannot replay preparation with another %s", async fault => {
    const f = harness(), token = await f.service.prepare("company", "issue", "done", actor);
    await expect(f.service.commit(f.tx, fault === "company" ? "other-company" : "company", fault === "issue" ? "other-issue" : "issue",
      fault === "status" ? "cancelled" : "done", fault === "actor" ? { ...actor, userId: "other" } : actor,
      fault === "serialized" ? JSON.parse(JSON.stringify(token)) : token)).rejects.toMatchObject({ status: 409 });
    expect(f.writes).toEqual([]);
    expect(boundaries.lock).not.toHaveBeenCalled();
  });
  it.each(["issue_revision", "round", "participant", "obligation", "discovery", "source", "authority"])("re-locks and rejects a concurrent %s change with no partial receipt", async fault => {
    const f = harness(), token = await f.service.prepare("company", "issue", "done", actor);
    if (fault === "issue_revision") f.issue.codeDeliveryRevision += 2;
    if (fault === "round") f.issue.executionState.changesRequestedCount += 1;
    if (fault === "participant") f.issue.executionState.currentParticipant.userId = "other";
    if (fault === "obligation") f.obligation.reviewedHeadSha = "c".repeat(40);
    if (fault === "discovery") f.datasets.set(codeDeliveryDiscoveries, [{ id: "late", companyId: "company", issueId: "issue", snapshot: {} }]);
    if (fault === "source") f.datasets.set(projectWorkspaces, [{ id: "workspace", repoUrl: "https://github.com/fixture/other" }]);
    if (fault === "authority") boundaries.authority.mockResolvedValue({ kind: "technical_authority", authorityRevision: 2 });
    const before = structuredClone(f.issue);
    await expect(f.service.commit(f.tx, "company", "issue", "done", actor, token)).rejects.toMatchObject({ status: 409 });
    expect(boundaries.lock).toHaveBeenCalledTimes(1);
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
  it("expires the entire prepared attempt rather than refreshing cached observations inside the transaction", async () => {
    vi.useFakeTimers();
    const f = harness(), token = await f.service.prepare("company", "issue", "done", actor);
    vi.advanceTimersByTime(30_001);
    await expect(f.service.commit(f.tx, "company", "issue", "done", actor, token)).rejects.toMatchObject({ status: 409 });
    expect(f.writes).toEqual([]);
    expect(boundaries.lock).not.toHaveBeenCalled();
    expect(boundaries.read).toHaveBeenCalledTimes(1);
  });
});
