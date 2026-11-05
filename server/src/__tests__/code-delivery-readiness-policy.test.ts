import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deliveryFingerprint, evaluateDeliveryReadiness, planDeliveryReadiness,
  type DeliverySnapshot } from "../services/code-delivery-readiness-policy.js";
import type { CodeDeliveryPullRequestObservation } from "../services/code-delivery-github.js";

const head = "a".repeat(40);
const merge = "b".repeat(40);
const now = Date.parse("2026-11-05T01:00:00.000Z");
function fixture(intent: "code" | "non_code" | "ambiguous" = "code"): DeliverySnapshot {
  const issueId = randomUUID(), companyId = randomUUID();
  return { issue: { id: issueId, companyId, status: "in_review", codeDeliveryRevision: 12, executionState: {
    status: "pending", currentStageId: "qa", currentParticipant: { type: "agent", agentId: "reviewer" },
    completedStageIds: ["security"], changesRequestedCount: 1, returnAssignee: { type: "agent", agentId: "author" } } },
  intent: { issueId, companyId, intent, revision: 2 }, obligations: [], discoveries: [], decisions: [], ownership: [] } as unknown as DeliverySnapshot;
}
function obligation(snapshot: DeliverySnapshot, number = 1, repository = "fixture/source") {
  const id = randomUUID(), decisionId = randomUUID();
  snapshot.obligations.push({ id, companyId: snapshot.issue.companyId, ownerIssueId: snapshot.issue.id, sourceIssueId: snapshot.issue.id,
    sourceProjectId: randomUUID(), sourceWorkspaceId: randomUUID(), provider: "github", repositoryId: String(number), repository,
    pullRequestNumber: number, baseRef: "main", proposedHeadSha: head, reviewedHeadSha: head, headDecisionId: decisionId,
    transferDecisionId: null, revision: 2, provenance: {} } as DeliverySnapshot["obligations"][number]);
  snapshot.decisions.push({ id: decisionId, companyId: snapshot.issue.companyId, issueId: snapshot.issue.id, obligationId: id,
    obligationRevision: 1, kind: "accept_head", payload: { headSha: head } } as DeliverySnapshot["decisions"][number]);
  return snapshot.obligations.at(-1)!;
}
function observation(row: DeliverySnapshot["obligations"][number], patch: Partial<CodeDeliveryPullRequestObservation> = {}): CodeDeliveryPullRequestObservation {
  return { repository: row.repository, repositoryId: row.repositoryId, number: row.pullRequestNumber, baseRef: row.baseRef,
    headSha: head, draft: false, state: "merged", mergedAt: "2026-11-05T00:59:00Z", mergeCommitSha: merge,
    observedAt: new Date(now).toISOString(), ...patch };
}
function evaluate(snapshot: DeliverySnapshot, observations: CodeDeliveryPullRequestObservation[]) {
  return evaluateDeliveryReadiness(snapshot, planDeliveryReadiness(snapshot), observations, now);
}
function disposition(snapshot: DeliverySnapshot, row: DeliverySnapshot["obligations"][number], kind: "closed_unmerged" | "withdrawn") {
  const id = randomUUID();
  snapshot.decisions.push({ id, companyId: snapshot.issue.companyId, issueId: snapshot.issue.id, obligationId: row.id,
    obligationRevision: row.revision, kind, payload: { observation: observation(row, { state: "closed", mergedAt: null, mergeCommitSha: null }) } } as DeliverySnapshot["decisions"][number]);
  return snapshot.decisions.at(-1)!;
}
function discovery(snapshot: DeliverySnapshot, url?: string) {
  const row = { id: randomUUID(), companyId: snapshot.issue.companyId, issueId: snapshot.issue.id, sourceRevision: "revision-1",
    snapshot: { type: url ? "pull_request" : "branch", url: url ?? null, status: "merged" } } as DeliverySnapshot["discoveries"][number];
  snapshot.discoveries.push(row);
  return row;
}
function noPr(snapshot: DeliverySnapshot) {
  const decision = { id: randomUUID(), companyId: snapshot.issue.companyId, issueId: snapshot.issue.id, kind: "no_pr",
    obligationId: null, payload: { reconciliations: snapshot.discoveries.map(row => ({ discoveryId: row.id, sourceRevision: row.sourceRevision, obligationId: null })) } } as DeliverySnapshot["decisions"][number];
  snapshot.decisions.push(decision);
  return decision;
}

describe("effective terminal code-delivery readiness policy", () => {
  it("needs no provider identity for independently classified genuine non-code work", () => {
    const snapshot = fixture("non_code");
    expect(planDeliveryReadiness(snapshot)).toMatchObject({ identities: [], decisions: [], evidence: { intent: { kind: "non_code" } } });
    expect(evaluate(snapshot, [])).toMatchObject({ pullRequests: [], noPrDecisionId: null });
  });
  it.each(["missing", "ambiguous", "terminal"])("denies %s intent/owner without changing the review state", fault => {
    const snapshot = fixture(fault === "ambiguous" ? "ambiguous" : "non_code");
    if (fault === "missing") snapshot.intent = null;
    if (fault === "terminal") snapshot.issue.status = "done";
    const before = structuredClone(snapshot);
    expect(() => planDeliveryReadiness(snapshot)).toThrow();
    expect(snapshot).toEqual(before);
  });
  it.each(["obligation", "discovery"])("does not treat non-code as a waiver for a retained %s", association => {
    const snapshot = fixture("non_code");
    if (association === "obligation") obligation(snapshot); else discovery(snapshot);
    expect(() => planDeliveryReadiness(snapshot)).toThrow();
  });
  it("requires independent typed no-PR evidence and reconciles every retained branch revision", () => {
    const snapshot = fixture();
    const first = discovery(snapshot);
    expect(() => evaluate(snapshot, [])).toThrow();
    const decision = noPr(snapshot);
    expect(evaluate(snapshot, [])).toMatchObject({ noPrDecisionId: decision.id, discoveries: [{ discoveryId: first.id, decisionId: decision.id }] });
    discovery(snapshot);
    expect(() => evaluate(snapshot, [])).toThrow();
    snapshot.discoveries.pop();
    snapshot.discoveries[0]!.sourceRevision = "revision-2";
    expect(() => evaluate(snapshot, [])).toThrow();
  });
  it("never uses a work-product label as live merged authority", () => {
    const snapshot = fixture(), row = obligation(snapshot);
    discovery(snapshot, `https://github.com/${row.repository}/pull/${row.pullRequestNumber}`);
    expect(() => evaluate(snapshot, [observation(row, { state: "open", draft: true, mergedAt: null, mergeCommitSha: null })])).toThrow();
    snapshot.discoveries[0]!.snapshot.status = "active";
    expect(evaluate(snapshot, [observation(row)]).pullRequests[0]).toMatchObject({ outcome: "merged", observation: { mergeCommitSha: merge } });
  });
  it.each(["open", "draft", "closed"])("denies %s without a typed disposition and preserves every input field", state => {
    const snapshot = fixture(), row = obligation(snapshot), before = structuredClone(snapshot);
    expect(() => evaluate(snapshot, [observation(row, { state: state === "closed" ? "closed" : "open", draft: state === "draft",
      mergedAt: null, mergeCommitSha: null })])).toThrow();
    expect(snapshot).toEqual(before);
  });
  it.each(["repository", "repositoryId", "number", "baseRef", "headSha"] as const)("rejects a wrong live %s", field => {
    const snapshot = fixture(), row = obligation(snapshot), observed = observation(row);
    if (field === "number") observed.number += 1;
    else observed[field] = field === "headSha" ? "c".repeat(40) : "wrong";
    expect(() => evaluate(snapshot, [observed])).toThrow();
  });
  it.each(["missing_merge_time", "invalid_merge_time", "future_merge_time", "missing_merge_sha", "invalid_merge_sha", "draft_merged",
    "stale", "future", "invalid_time"])("rejects %s provider proof", fault => {
    const snapshot = fixture(), row = obligation(snapshot), observed = observation(row);
    if (fault === "missing_merge_time") observed.mergedAt = null;
    if (fault === "invalid_merge_time") observed.mergedAt = "not-a-date";
    if (fault === "future_merge_time") observed.mergedAt = new Date(now + 1).toISOString();
    if (fault === "missing_merge_sha") observed.mergeCommitSha = null;
    if (fault === "invalid_merge_sha") observed.mergeCommitSha = "claim";
    if (fault === "draft_merged") observed.draft = true;
    if (fault === "stale") observed.observedAt = new Date(now - 30_001).toISOString();
    if (fault === "future") observed.observedAt = new Date(now + 1).toISOString();
    if (fault === "invalid_time") observed.observedAt = "not-a-date";
    expect(() => evaluate(snapshot, [observed])).toThrow();
  });
  it.each(["missing_head", "missing_decision", "wrong_obligation_revision", "wrong_accepted_head", "foreign_decision"])("rejects %s reviewed-head authority", fault => {
    const snapshot = fixture(), row = obligation(snapshot);
    if (fault === "missing_head") row.reviewedHeadSha = null;
    if (fault === "missing_decision") row.headDecisionId = null;
    if (fault === "wrong_obligation_revision") snapshot.decisions[0]!.obligationRevision = 0;
    if (fault === "wrong_accepted_head") snapshot.decisions[0]!.payload.headSha = "c".repeat(40);
    if (fault === "foreign_decision") snapshot.decisions[0]!.companyId = randomUUID();
    expect(() => evaluate(snapshot, [observation(row)])).toThrow();
  });
  it("requires every PR across repositories, not one merge or a matching count", () => {
    const snapshot = fixture(), first = obligation(snapshot), second = obligation(snapshot, 2, "fixture/other");
    expect(() => evaluate(snapshot, [observation(first)])).toThrow();
    expect(() => evaluate(snapshot, [observation(first), observation(first)])).toThrow();
    expect(() => evaluate(snapshot, [observation(first), observation(second, { state: "open", mergedAt: null, mergeCommitSha: null })])).toThrow();
    expect(evaluate(snapshot, [observation(second), observation(first)]).pullRequests.map(row => row.obligationId)).toEqual([first.id, second.id]);
  });
  it("refuses oversized attempts before constructing remote requests", () => {
    const snapshot = fixture();
    for (let index = 1; index <= 17; index += 1) obligation(snapshot, index);
    expect(() => planDeliveryReadiness(snapshot)).toThrow();
  });
  it.each(["closed_unmerged", "withdrawn"] as const)("requires a fresh live closed observation plus exact independent %s evidence", kind => {
    const snapshot = fixture(), row = obligation(snapshot), decision = disposition(snapshot, row, kind);
    const closed = observation(row, { state: "closed", mergedAt: null, mergeCommitSha: null });
    expect(evaluate(snapshot, [closed]).pullRequests[0]).toMatchObject({ outcome: kind, decisionId: decision.id });
    expect(() => evaluate(snapshot, [{ ...closed, state: "open" }])).toThrow();
    row.revision += 1;
    expect(() => evaluate(snapshot, [closed])).toThrow();
  });
  it("does not let a stale closed decision replace exact reviewed-head proof for a live merge", () => {
    const snapshot = fixture(), row = obligation(snapshot);
    disposition(snapshot, row, "withdrawn");
    row.reviewedHeadSha = null;
    row.headDecisionId = null;
    expect(() => evaluate(snapshot, [observation(row)])).toThrow();
  });
  it("retains transferred source discoveries without falsely requiring a no-PR waiver", () => {
    const snapshot = fixture(), row = obligation(snapshot), destination = randomUUID(), transferId = randomUUID();
    discovery(snapshot, `https://github.com/${row.repository}/pull/${row.pullRequestNumber}`);
    row.ownerIssueId = destination;
    row.transferDecisionId = transferId;
    row.reviewedHeadSha = null;
    row.headDecisionId = null;
    snapshot.ownership.push({ companyId: snapshot.issue.companyId, obligationId: row.id, fromIssueId: snapshot.issue.id,
      toIssueId: destination, obligationRevision: 2, provenance: { decisionId: transferId } } as DeliverySnapshot["ownership"][number]);
    snapshot.decisions.push({ id: transferId, companyId: snapshot.issue.companyId, issueId: snapshot.issue.id, obligationId: row.id,
      kind: "transfer", obligationRevision: 1, payload: { destinationIssueId: destination } } as DeliverySnapshot["decisions"][number]);
    expect(evaluate(snapshot, [])).toMatchObject({ noPrDecisionId: null, transfers: [{ obligationId: row.id, decisionId: transferId }], pullRequests: [] });
    snapshot.ownership = [];
    expect(() => evaluate(snapshot, [])).toThrow();
  });
  it("recognizes an intermediate owner only through retained transfer provenance", () => {
    const snapshot = fixture(), row = obligation(snapshot), destination = randomUUID(), transferId = randomUUID();
    row.sourceIssueId = randomUUID();
    row.ownerIssueId = destination;
    discovery(snapshot, `https://github.com/${row.repository}/pull/${row.pullRequestNumber}`);
    snapshot.ownership.push({ companyId: snapshot.issue.companyId, obligationId: row.id, fromIssueId: snapshot.issue.id,
      toIssueId: destination, obligationRevision: 2, provenance: { decisionId: transferId } } as DeliverySnapshot["ownership"][number]);
    snapshot.decisions.push({ id: transferId, companyId: snapshot.issue.companyId, issueId: snapshot.issue.id, obligationId: row.id,
      kind: "transfer", obligationRevision: 1, payload: { destinationIssueId: destination } } as DeliverySnapshot["decisions"][number]);
    expect(planDeliveryReadiness(snapshot).identities).toEqual([]);
  });
  it("does not conflate canonical JSON key ordering but binds all issue/stage/participant/round fields", () => {
    expect(deliveryFingerprint({ b: 2, a: 1 })).toBe(deliveryFingerprint({ a: 1, b: 2 }));
    const snapshot = fixture(), before = deliveryFingerprint(snapshot);
    snapshot.issue.codeDeliveryRevision += 1;
    expect(deliveryFingerprint(snapshot)).not.toBe(before);
    snapshot.issue.codeDeliveryRevision -= 1;
    snapshot.issue.executionState = { ...snapshot.issue.executionState, changesRequestedCount: 2 };
    expect(deliveryFingerprint(snapshot)).not.toBe(before);
  });
});
