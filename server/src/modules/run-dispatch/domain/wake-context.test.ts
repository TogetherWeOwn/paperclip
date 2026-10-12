import { describe, expect, it } from "vitest";
import {
  allowsIssueInteractionWake,
  capWakeContextSnapshotBytes,
  deriveCommentId,
  extractWakeCommentIds,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
  WAKE_CONTEXT_SNAPSHOT_KEPT_COMMENT_IDS,
  WAKE_CONTEXT_SNAPSHOT_MAX_BYTES,
  WORKSPACE_BUSY_RETRY_REASON,
} from "./wake-context.js";

describe("wake context", () => {
  it("requires the subscription-specific non-assignee receipt for a subscription wait", () => {
    expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", {
      aiConnectionBusyDeferredWhileAssignee: false,
    })).toBe(true);
    for (const context of [ {}, { aiConnectionBusyDeferredWhileAssignee: true }, { workspaceBusyDeferredWhileAssignee: false } ]) {
      expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", context)).toBe(false);
    }
    expect(isNonAssigneeWorkspaceBusyRetry("transient_failure", { aiConnectionBusyDeferredWhileAssignee: false })).toBe(false);
  });
  it("recognizes only workspace-busy retries deferred outside assignee-ship", () => {
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(true);
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: true,
    })).toBe(false);
    expect(isNonAssigneeWorkspaceBusyRetry("another_reason", {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(false);
  });

  it("keeps ordered, unique, non-empty wake comment ids", () => {
    expect(extractWakeCommentIds({
      wakeCommentIds: ["comment-1", "", null, "comment-2", "comment-1"],
    })).toEqual(["comment-1", "comment-2"]);
    expect(extractWakeCommentIds({ wakeCommentIds: "comment-1" })).toEqual([]);
    expect(extractWakeCommentIds(undefined)).toEqual([]);
  });

  it.each([
    [{ wakeCommentIds: ["batch-1", "batch-2"], wakeCommentId: "wake" }, {}, "batch-2"],
    [{ wakeCommentId: "wake", commentId: "context" }, {}, "wake"],
    [{ commentId: "context" }, { commentId: "payload" }, "context"],
    [{}, { commentId: "payload" }, "payload"],
    [{ wakeCommentId: "  " }, { commentId: "  " }, null],
  ])("derives comment ids by canonical precedence", (context, payload, expected) => {
    expect(deriveCommentId(context, payload)).toBe(expected);
  });

  it("allows interaction wakes only for an allowed reason with a comment id", () => {
    const allowed = new Set(["issue_commented"]);
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(true);
    expect(allowsIssueInteractionWake({
      wakeReason: "timer",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(false);
    expect(allowsIssueInteractionWake({ wakeReason: "issue_commented" }, allowed)).toBe(false);
  });

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s issue-comment interaction continuations",
    (interactionStatus) => {
      expect(isResolvedInteractionContinuationWakeContext({
        interactionId: "interaction-1",
        interactionStatus,
        mutation: "interaction",
        wakeReason: "issue_commented",
      })).toBe(true);
    },
  );

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s infrastructure continuations and rejects incomplete contexts",
    (interactionStatus) => {
      const base = { interactionId: "interaction-1", interactionStatus };
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        wakeReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        retryReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({ ...base, interactionStatus: "pending" })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext({ interactionStatus })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext(null)).toBe(false);
    },
  );
});

describe("capWakeContextSnapshotBytes", () => {
  it("returns small snapshots untouched", () => {
    const snapshot = {
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ["comment-1"],
    };
    const result = capWakeContextSnapshotBytes(snapshot);
    expect(result.snapshot).toBe(snapshot);
    expect(result.truncated).toBe(false);
    expect(result.droppedWakeCommentIds).toBe(0);
  });

  it("trims the oldest wake comment ids first and keeps a thread pointer", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `comment-${i}`);
    const padding = "x".repeat(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      taskId: "issue-1",
      taskKey: "task-key-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ids,
      note: padding,
    });
    const kept = result.snapshot.wakeCommentIds as string[];
    expect(kept.length).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_KEPT_COMMENT_IDS);
    expect(kept.at(-1)).toBe("comment-29");
    expect(result.droppedWakeCommentIds).toBeGreaterThan(0);
    expect(result.snapshot.issueId).toBe("issue-1");
    expect(result.snapshot.taskKey).toBe("task-key-1");
    expect(result.snapshot.wakeReason).toBe("issue_commented");
    expect(result.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
  });

  it("drops debug payload before touching routing input", () => {
    const padding = "x".repeat(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ["comment-1"],
      debug: { providerTrace: "raw", blob: padding },
    });
    expect(result.snapshot.debug).toBeUndefined();
    expect(result.snapshot.issueId).toBe("issue-1");
    expect(result.snapshot.wakeCommentIds).toEqual(["comment-1"]);
    expect(result.truncated).toBe(true);
  });

  it("never drops queued comment ids that carry pending input", () => {
    const queued = Array.from({ length: 12 }, (_, i) => `queued-${i}`);
    const padding = "x".repeat(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ["comment-1"],
      queuedCommentIds: queued,
      filler: padding,
    });
    expect(result.snapshot.queuedCommentIds).toEqual(queued);
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
  });

  it("is deterministic for the same input", () => {
    const input = {
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: Array.from({ length: 30 }, (_, i) => `comment-${i}`),
      filler: "x".repeat(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES),
    };
    expect(capWakeContextSnapshotBytes(input)).toEqual(
      capWakeContextSnapshotBytes(input),
    );
  });
});
