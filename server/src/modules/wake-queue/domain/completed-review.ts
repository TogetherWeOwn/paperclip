import type { IssueExecutionState } from "@paperclipai/shared";

/** Missing or mixed evidence must not swallow a legitimate follow-up. */
export function commentsCoveredByCompletedReview(input: {
  status: string;
  completedAt: Date | null;
  state: IssueExecutionState | null;
  decision: { id: string; outcome: string; createdAt: Date } | null;
  commentIds: string[];
  comments: { id: string; createdAt: Date }[];
}): boolean {
  const { state, decision, completedAt } = input;
  if (
    input.status !== "done" || !completedAt || !state || !decision ||
    state.status !== "completed" || state.completedStageIds.length === 0 ||
    state.lastDecisionId !== decision.id || state.lastDecisionOutcome !== "approved" ||
    decision.outcome !== "approved"
  ) return false;
  const ids = [...new Set(input.commentIds)];
  const cutoff = Math.min(completedAt.getTime(), decision.createdAt.getTime());
  return Number.isFinite(cutoff) && ids.length > 0 && input.comments.length === ids.length &&
    ids.every((id) => input.comments.some((comment) => comment.id === id && comment.createdAt.getTime() < cutoff));
}
