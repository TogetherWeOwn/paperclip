import { describe, expect, it } from "vitest";
import type { IssueExecutionState } from "@paperclipai/shared";
import {
  buildCompletedReviewEvidence,
  completedReviewEvidenceDigest,
  planCompletedReviewRestoration,
  sealCompletedReviewEvidence,
} from "./completed-review-reconciliation-evidence.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { companyId: id(1), issueId: id(2) };
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 11, 32, seconds));
const completed: IssueExecutionState = {
  status: "completed", currentStageId: null, currentStageIndex: null, currentStageType: null,
  currentParticipant: null, returnAssignee: { type: "agent", agentId: id(3), userId: null },
  reviewRequest: null, completedStageIds: [id(4), id(5)], lastDecisionId: id(7),
  lastDecisionOutcome: "approved", monitor: null, changesRequestedCount: 0,
};

function fixture() {
  const policy = {
    executionPolicy: {
      mode: "normal", commentRequired: true,
      stages: [4, 5].map((n) => ({
        id: id(n), type: "review", approvalsNeeded: 1,
        participants: [{ id: id(n + 100), type: "agent", agentId: id(n + 10), userId: null }],
      })),
    },
    reviewPolicy: "not_creator", responsibleUserId: "existing-responsible-user",
  };
  const delivery = [{ id: id(20), type: "pull_request", url: "https://example.invalid/pr/1", status: "merged", updatedAt: at(30) }];
  const pending: IssueExecutionState = {
    ...completed, status: "pending", currentStageId: id(4), currentStageIndex: 0,
    currentStageType: "review", currentParticipant: { type: "agent", agentId: id(14), userId: null },
    returnAssignee: { type: "agent", agentId: id(15), userId: null },
    completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
  };
  const decisions = [4, 5].map((n) => ({
    ...scope, id: id(n + 2), stageId: id(n), stageType: "review", outcome: "approved",
    actorAgentId: id(n + 10), actorUserId: null, createdByRunId: id(n + 30),
    createdAt: at(n + 30), updatedAt: at(n + 30),
  }));
  return {
    ...scope, status: "in_review", executionState: pending, policy, delivery,
    completion: {
      ...scope, id: id(40), actorType: "agent", actorId: id(15), runId: id(35),
      action: "issue.updated", createdAt: at(40),
      details: {
        status: "done", executionState: structuredClone(completed),
        completedReviewEvidence: buildCompletedReviewEvidence({ ...scope, policy, delivery, decisionIds: decisions.map((row) => row.id) }),
      } as Record<string, unknown>,
    },
    decisions,
    laterActivities: [{
      ...scope, id: id(41), actorType: "system", actorId: "heartbeat", runId: id(35),
      action: "issue.updated", createdAt: at(41),
      details: { status: "todo", source: "deferred_comment_wake", reopened: true, reopenedFrom: "done" } as Record<string, unknown>,
    }, {
      ...scope, id: id(42), actorType: "agent", actorId: id(15), runId: id(50),
      action: "issue.updated", createdAt: at(42),
      details: {
        status: "in_review", executionState: structuredClone(pending),
        changes: {
          status: { from: "todo", to: "in_review" },
          executionState: { from: null, to: structuredClone(pending) },
        },
      } as Record<string, unknown>,
    }],
    staleWake: { ...scope, commentIds: [id(60)], promotedRunId: id(50) },
    comments: [{ ...scope, id: id(60), createdAt: at(32) }],
    hasNewerWorkOrGovernance: false,
    restoredCompletionActivityId: null as string | null,
  };
}

describe("completion receipt sealing (fixtures only)", () => {
  function input() {
    const f = fixture();
    return { ...f, status: "done", executionState: structuredClone(completed),
      actorType: f.completion.actorType, actorId: f.completion.actorId, runId: f.completion.runId };
  }

  it("derives references from persisted approvals, without mutating their rows", () => {
    const f = input();
    const before = structuredClone(f);
    expect(sealCompletedReviewEvidence(f)).toEqual(f.completion.details.completedReviewEvidence);
    expect(f).toEqual(before);
  });

  const cases: [string, (f: ReturnType<typeof input>) => void][] = [
    ["incomplete issue", (f) => { f.status = "in_review"; }],
    ["no native policy", (f) => { f.policy.executionPolicy.stages = []; }],
    ["missing decision", (f) => { f.decisions.pop(); }],
    ["newer rejection", (f) => { f.decisions.push({ ...f.decisions[1], id: id(99), outcome: "rejected", createdAt: at(36), updatedAt: at(36) }); }],
    ["changed decision", (f) => { f.decisions[1].updatedAt = at(36); }],
    ["equal-time ambiguous decisions", (f) => { f.decisions.push({ ...f.decisions[1], id: id(99) }); }],
    ["other company", (f) => { f.decisions[0].companyId = id(99); }],
    ["other issue", (f) => { f.decisions[0].issueId = id(99); }],
    ["substituted reviewer", (f) => { f.decisions[1].actorAgentId = id(99); }],
    ["unrelated actor", (f) => { f.actorId = id(99); }],
    ["system actor", (f) => { f.actorType = "system"; }],
    ["other run", (f) => { f.runId = id(99); }],
    ["no return assignee", (f) => { f.executionState.returnAssignee = null; }],
    ["pending review", (f) => { f.executionState.currentStageId = id(4); }],
    ["missing completed stage", (f) => { f.executionState.completedStageIds.pop(); }],
    ["forged last decision", (f) => { f.executionState.lastDecisionId = id(99); }],
  ];
  it.each(cases)("does not seal %s", (_name, mutate) => {
    const f = input();
    mutate(f);
    expect(sealCompletedReviewEvidence(f)).toBeNull();
  });
});

describe("completed review restoration evidence (fixtures only)", () => {
  it("derives the original state and references without replacing approvals", () => {
    const input = fixture();
    const before = structuredClone(input);
    expect(planCompletedReviewRestoration(input)).toEqual({
      outcome: "restore", completionActivityId: id(40), decisionIds: [id(6), id(7)],
      executionState: completed, returnAssignee: completed.returnAssignee,
    });
    expect(input).toEqual(before);
  });

  it("can repair only the reopen, without requiring a reset", () => {
    const input = fixture();
    input.status = "todo";
    input.executionState = null as unknown as IssueExecutionState;
    input.laterActivities.pop();
    expect(planCompletedReviewRestoration(input).outcome).toBe("restore");
  });

  it("is replay-safe only for the same completion and unchanged restored state", () => {
    const input = fixture();
    input.status = "done";
    input.executionState = structuredClone(completed);
    input.restoredCompletionActivityId = id(40);
    expect(planCompletedReviewRestoration(input).outcome).toBe("already_restored");
    input.restoredCompletionActivityId = id(999);
    expect(planCompletedReviewRestoration(input)).toEqual({ outcome: "refused", reason: "restoration_drifted" });
    input.restoredCompletionActivityId = id(40);
    input.executionState.completedStageIds = [];
    expect(planCompletedReviewRestoration(input).outcome).toBe("refused");
  });

  const cases: [string, (input: ReturnType<typeof fixture>) => void][] = [
    ["legacy receipt has no policy/delivery proof", (i) => { delete i.completion.details.completedReviewEvidence; }],
    ["caller-supplied state cannot replace missing persisted state", (i) => { delete i.completion.details.executionState; }],
    ["policy changed", (i) => { i.policy.reviewPolicy = "anyone"; }],
    ["policy changed and was reverted (later audit)", (i) => { i.laterActivities.push({ ...i.laterActivities[1], id: id(90), createdAt: at(43), details: { executionPolicy: i.policy.executionPolicy } }); }],
    ["delivery revision changed", (i) => { i.delivery[0].updatedAt = at(50); }],
    ["delivery deleted", (i) => { i.delivery = []; }],
    ["delivery added", (i) => { i.delivery.push({ ...i.delivery[0], id: id(91) }); }],
    ["approval missing", (i) => { i.decisions.pop(); }],
    ["changes requested", (i) => { i.decisions[1].outcome = "changes_requested"; }],
    ["rejection", (i) => { i.decisions[1].outcome = "rejected"; }],
    ["approval edited", (i) => { i.decisions[1].updatedAt = at(50); }],
    ["reviewer substituted", (i) => { i.decisions[1].actorAgentId = id(3); }],
    ["approval run differs", (i) => { i.decisions[1].createdByRunId = id(999); }],
    ["completion actor differs", (i) => { i.completion.actorId = id(3); }],
    ["newer decision", (i) => { i.decisions.push({ ...i.decisions[1], id: id(99), createdAt: at(43) }); }],
    ["duplicate completion stages", (i) => { const s = i.completion.details.executionState as IssueExecutionState; s.completedStageIds = [id(4), id(4)]; }],
    ["completion from another company", (i) => { i.completion.companyId = id(999); }],
    ["decision from another issue", (i) => { i.decisions[0].issueId = id(999); }],
    ["snapshot from another issue", (i) => { (i.completion.details.completedReviewEvidence as Record<string, unknown>).issueId = id(999); }],
    ["wake from another company", (i) => { i.staleWake.companyId = id(999); }],
    ["comment from another issue", (i) => { i.comments[0].issueId = id(999); }],
    ["newer comment", (i) => { i.comments[0].createdAt = at(50); }],
    ["equal-time comment", (i) => { i.comments[0].createdAt = at(35); }],
    ["missing comment", (i) => { i.comments = []; }],
    ["mixed comment batch", (i) => { i.staleWake.commentIds.push(id(61)); i.comments.push({ ...scope, id: id(61), createdAt: at(50) }); }],
    ["new work or pending governance", (i) => { i.hasNewerWorkOrGovernance = true; }],
    ["ordinary reopen", (i) => { i.laterActivities[0].details.source = "explicit_resume"; }],
    ["explicit resume", (i) => { i.laterActivities[1].details.resumeIntent = true; }],
    ["comment follow-up", (i) => { i.laterActivities[1].details.source = "comment"; }],
    ["reset from independent run", (i) => { i.laterActivities[1].runId = id(999); }],
    ["later intentional mutation", (i) => { i.laterActivities[1].details.changes = { title: { from: "old", to: "new" } }; }],
    ["current-state race", (i) => { i.executionState.completedStageIds = [id(4)]; }],
    ["current-status race", (i) => { i.status = "in_progress"; }],
    ["ambiguous timestamp", (i) => { i.laterActivities[1].createdAt = i.laterActivities[0].createdAt; }],
    ["invalid completion timestamp", (i) => { i.completion.createdAt = new Date("invalid"); }],
  ];
  it.each(cases)("refuses %s", (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(planCompletedReviewRestoration(input).outcome).toBe("refused");
  });

  it("hashes full evidence independent of object key order, not array order", () => {
    expect(completedReviewEvidenceDigest({ b: 2, a: 1 })).toBe(completedReviewEvidenceDigest({ a: 1, b: 2 }));
    expect(completedReviewEvidenceDigest([1, 2])).not.toBe(completedReviewEvidenceDigest([2, 1]));
  });
});
