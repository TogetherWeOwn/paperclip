import { describe, expect, it } from "vitest";
import type { IssueExecutionState } from "@paperclipai/shared";
import { commentsCoveredByCompletedReview } from "./completed-review.js";

const completedAt = new Date("2026-10-01T11:32:56.812Z");
const state: IssueExecutionState = {
  status: "completed", currentStageId: null, currentStageIndex: null, currentStageType: null,
  currentParticipant: null, returnAssignee: { agentId: "author", userId: null },
  completedStageIds: ["security", "code"], lastDecisionId: "original-decision",
  lastDecisionOutcome: "approved", monitor: null, reviewRequest: null,
};
const fixture = () => ({
  status: "done", completedAt, state: { ...state },
  decision: { id: "original-decision", outcome: "approved", createdAt: completedAt },
  commentIds: ["closing-comment"],
  comments: [{ id: "closing-comment", createdAt: new Date("2026-10-01T11:32:00Z") }],
});

describe("comments covered by completed native review", () => {
  it("recognizes an older comment without changing the decision", () => {
    const input = fixture();
    expect(commentsCoveredByCompletedReview(input)).toBe(true);
    expect(input.state).toEqual(state);
  });
  it.each(["newer", "equal", "mixed", "missing", "empty", "wrong_id", "pending", "adverse", "no_stages", "wrong_decision", "no_completion", "invalid_date"])(
    "retains ambiguous or newer input (%s)", (scenario) => {
      const input = fixture();
      if (scenario === "newer") input.comments[0].createdAt = new Date(completedAt.getTime() + 1);
      if (scenario === "equal") input.comments[0].createdAt = completedAt;
      if (scenario === "mixed") {
        input.commentIds.push("follow-up");
        input.comments.push({ id: "follow-up", createdAt: new Date(completedAt.getTime() + 1) });
      }
      if (scenario === "missing") input.comments = [];
      if (scenario === "empty") { input.comments = []; input.commentIds = []; }
      if (scenario === "wrong_id") input.comments[0].id = "unrelated";
      if (scenario === "pending") input.state.status = "pending";
      if (scenario === "adverse") input.decision.outcome = "changes_requested";
      if (scenario === "no_stages") input.state.completedStageIds = [];
      if (scenario === "wrong_decision") input.decision.id = "new-decision";
      if (scenario === "no_completion") input.status = "in_review";
      if (scenario === "invalid_date") input.completedAt = new Date("invalid");
      expect(commentsCoveredByCompletedReview(input)).toBe(false);
    },
  );
});
