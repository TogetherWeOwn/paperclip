import { createHash } from "node:crypto";
import {
  issueExecutionPolicySchema,
  issueExecutionStateSchema,
  type IssueExecutionState,
} from "@paperclipai/shared";

type Scope = { companyId: string; issueId: string };
type Activity = Scope & {
  id: string;
  actorType: string;
  actorId: string;
  runId: string | null;
  action: string;
  createdAt: Date;
  details: Record<string, unknown> | null;
};
type Decision = Scope & {
  id: string;
  stageId: string;
  stageType: string;
  actorAgentId: string | null;
  actorUserId: string | null;
  createdByRunId: string | null;
  outcome: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Server-generated completion receipt, never a request body or a replacement approval. */
export interface CompletedReviewEvidence extends Scope {
  version: 1;
  policyDigest: string;
  deliveryDigest: string;
  decisionIds: string[];
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** Fingerprint complete scoped rows, including revisions; do not compare only PR URLs. */
export function completedReviewEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function sameScope(a: Scope, b: Scope) {
  return a.companyId === b.companyId && a.issueId === b.issueId;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function buildCompletedReviewEvidence(input: Scope & {
  policy: unknown;
  delivery: unknown;
  decisionIds: string[];
}): CompletedReviewEvidence {
  return {
    version: 1,
    companyId: input.companyId,
    issueId: input.issueId,
    policyDigest: completedReviewEvidenceDigest(input.policy),
    deliveryDigest: completedReviewEvidenceDigest(input.delivery),
    decisionIds: [...input.decisionIds],
  };
}

export type CompletedReviewRestorationPlan =
  | { outcome: "refused"; reason: string }
  | {
    outcome: "restore" | "already_restored";
    completionActivityId: string;
    decisionIds: string[];
    executionState: IssueExecutionState;
    returnAssignee: IssueExecutionState["returnAssignee"];
  };

/**
 * Pure evidence check. Its inputs must be read from persisted, company/issue-scoped
 * rows under the service's transaction fences. This does not authorize a caller,
 * certify an external delivery, or accept a client-provided execution-state patch.
 */
export function planCompletedReviewRestoration(input: Scope & {
  status: string;
  executionState: unknown;
  policy: unknown;
  delivery: unknown;
  completion: Activity;
  decisions: Decision[];
  laterActivities: Activity[];
  staleWake: Scope & { commentIds: string[]; promotedRunId: string };
  comments: (Scope & { id: string; createdAt: Date })[];
  hasNewerWorkOrGovernance: boolean;
  restoredCompletionActivityId: string | null;
}): CompletedReviewRestorationPlan {
  const refuse = (reason: string): CompletedReviewRestorationPlan => ({ outcome: "refused", reason });
  const receipt = input.completion;
  const details = receipt.details;
  if (!sameScope(input, receipt) || !sameScope(input, input.staleWake) ||
      input.decisions.some((row) => !sameScope(input, row)) ||
      input.laterActivities.some((row) => !sameScope(input, row)) ||
      input.comments.some((row) => !sameScope(input, row))) return refuse("scope_mismatch");
  const policy = issueExecutionPolicySchema.safeParse(object(input.policy)?.executionPolicy);
  const state = issueExecutionStateSchema.safeParse(details?.executionState);
  const proof = object(details?.completedReviewEvidence);
  if (receipt.action !== "issue.updated" || !["agent", "user"].includes(receipt.actorType) ||
      details?.status !== "done" || !state.success || state.data.status !== "completed" ||
      state.data.lastDecisionOutcome !== "approved" || !state.data.lastDecisionId ||
      state.data.currentStageId !== null || state.data.currentStageIndex !== null ||
      state.data.currentStageType !== null || state.data.currentParticipant !== null ||
      state.data.changesRequestedCount !== 0 ||
      state.data.reviewRequest !== null || state.data.monitor != null ||
      !Number.isFinite(receipt.createdAt.getTime())) return refuse("missing_completion_evidence");
  // Legacy activity only captures changed fields. Stage decisions also lack a
  // policy/delivery snapshot. Missing proof is not permission to infer one.
  if (!proof || proof.version !== 1 || !sameScope(input, proof as Scope) ||
      !Array.isArray(proof.decisionIds)) return refuse("missing_policy_delivery_snapshot");
  if (proof.policyDigest !== completedReviewEvidenceDigest(input.policy) ||
      !policy.success || policy.data.stages.length === 0) return refuse("policy_changed");
  if (proof.deliveryDigest !== completedReviewEvidenceDigest(input.delivery)) return refuse("delivery_changed");
  const completedIds = state.data.completedStageIds;
  const stageIds = policy.data.stages.map((stage) => stage.id);
  if (completedReviewEvidenceDigest(completedIds) !== completedReviewEvidenceDigest(stageIds) ||
      new Set(completedIds).size !== completedIds.length ||
      proof.decisionIds.length !== stageIds.length ||
      new Set(proof.decisionIds).size !== stageIds.length) return refuse("ambiguous_stages");
  if (input.decisions.some((row) => !Number.isFinite(row.createdAt.getTime()) ||
      !Number.isFinite(row.updatedAt.getTime()) || row.createdAt > receipt.createdAt ||
      row.updatedAt > receipt.createdAt)) return refuse("later_or_modified_decision");
  const decisions: Decision[] = [];
  for (const [index, stage] of policy.data.stages.entries()) {
    const matching = input.decisions.filter((row) => row.stageId === stage.id);
    const selected = matching.find((row) => row.id === (proof.decisionIds as unknown[])[index]);
    if (!selected || selected.stageType !== stage.type || selected.outcome !== "approved" ||
        !Number.isFinite(selected.createdAt.getTime()) ||
        selected.createdAt > receipt.createdAt || selected.updatedAt > receipt.createdAt ||
        matching.some((row) => row.id !== selected.id && row.createdAt >= selected.createdAt) ||
        !stage.participants.some((participant) => participant.type === "agent"
          ? participant.agentId === selected.actorAgentId && selected.actorUserId === null
          : participant.userId === selected.actorUserId && selected.actorAgentId === null)) {
      return refuse("missing_or_conflicting_decision");
    }
    decisions.push(selected);
  }
  const last = decisions.at(-1)!;
  if (last.id !== state.data.lastDecisionId || last.createdByRunId !== receipt.runId ||
      (receipt.actorType === "agent" ? last.actorAgentId : last.actorUserId) !== receipt.actorId ||
      decisions.some((row, index) => index > 0 && row.createdAt <= decisions[index - 1].createdAt)) {
    return refuse("completion_lineage_mismatch");
  }
  if (input.hasNewerWorkOrGovernance) return refuse("newer_work_or_governance");
  const plan = {
    completionActivityId: receipt.id,
    decisionIds: decisions.map((row) => row.id),
    executionState: state.data,
    returnAssignee: state.data.returnAssignee,
  };
  if (input.restoredCompletionActivityId !== null) {
    return input.restoredCompletionActivityId === receipt.id && input.status === "done" &&
      completedReviewEvidenceDigest(input.executionState) === completedReviewEvidenceDigest(state.data)
      ? { outcome: "already_restored", ...plan } : refuse("restoration_drifted");
  }
  if (input.status !== "todo" && input.status !== "in_review") return refuse("unexpected_current_status");
  const cutoff = Math.min(receipt.createdAt.getTime(), last.createdAt.getTime());
  const ids = [...new Set(input.staleWake.commentIds)];
  if (ids.length === 0 || input.comments.length !== ids.length ||
      ids.some((id) => !input.comments.some((row) => row.id === id && row.createdAt.getTime() < cutoff))) {
    return refuse("comment_not_covered");
  }
  const activities = [...input.laterActivities].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (activities.some((row) => row.createdAt <= receipt.createdAt) ||
      activities.some((row, index) => index > 0 && row.createdAt <= activities[index - 1].createdAt)) {
    return refuse("ambiguous_activity_order");
  }
  const reopen = activities[0];
  if (!reopen || reopen.actorType !== "system" || reopen.actorId !== "heartbeat" ||
      reopen.action !== "issue.updated" || reopen.details?.source !== "deferred_comment_wake" ||
      reopen.details.status !== "todo" || reopen.details.reopened !== true ||
      reopen.details.reopenedFrom !== "done" || reopen.details.resumeIntent === true) {
    return refuse("not_stale_deferred_reopen");
  }
  if (activities.length === 1) {
    return input.status === "todo" && input.executionState === null
      ? { outcome: "restore", ...plan } : refuse("current_state_drifted");
  }
  // Only the first-stage reset from the promoted stale run may follow the reopen.
  // A comment, another PATCH, an explicit resume or any adverse review is new
  // work, not something this action is allowed to discard.
  if (activities.length !== 2) return refuse("later_intent_or_work");
  const reset = activities[1];
  const changes = object(reset.details?.changes);
  const changedFields = changes ? Object.keys(changes) : [];
  const allowed = ["status", "executionState", "assigneeAgentId", "assigneeUserId"];
  const resetState = issueExecutionStateSchema.safeParse(reset.details?.executionState);
  if (reset.action !== "issue.updated" || reset.actorType !== "agent" ||
      reset.runId !== input.staleWake.promotedRunId || reset.details?.resumeIntent === true ||
      reset.details?.followUpRequested === true || reset.details?.source === "comment" ||
      changedFields.length === 0 || changedFields.some((key) => !allowed.includes(key)) ||
      object(changes?.status)?.from !== "todo" || object(changes?.status)?.to !== "in_review" ||
      object(changes?.executionState)?.from !== null ||
      !resetState.success || resetState.data.status !== "pending" ||
      resetState.data.currentStageId !== stageIds[0] || resetState.data.completedStageIds.length !== 0 ||
      resetState.data.lastDecisionId !== null || resetState.data.lastDecisionOutcome !== null ||
      resetState.data.reviewRequest !== null || resetState.data.monitor != null ||
      input.status !== "in_review" ||
      completedReviewEvidenceDigest(input.executionState) !== completedReviewEvidenceDigest(resetState.data) ||
      completedReviewEvidenceDigest(object(changes?.executionState)?.to) !== completedReviewEvidenceDigest(resetState.data)) {
    return refuse("later_intent_or_work");
  }
  return { outcome: "restore", ...plan };
}
