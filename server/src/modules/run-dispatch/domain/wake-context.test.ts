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

  it("trims the oldest wake comment ids when the ids are the overage and keeps a thread pointer", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `comment-${String(i).padStart(4, "0")}-${"0".repeat(32)}`);
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      taskId: "issue-1",
      taskKey: "task-key-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ids,
    });
    const kept = result.snapshot.wakeCommentIds as string[];
    expect(kept).toHaveLength(WAKE_CONTEXT_SNAPSHOT_KEPT_COMMENT_IDS);
    expect(kept.at(-1)).toBe(ids.at(-1));
    expect(result.droppedWakeCommentIds).toBe(ids.length - WAKE_CONTEXT_SNAPSHOT_KEPT_COMMENT_IDS);
    expect(result.snapshot.wakeCommentIdsDroppedFromFront).toBe(result.droppedWakeCommentIds);
    expect(result.snapshot.issueId).toBe("issue-1");
    expect(result.snapshot.taskKey).toBe("task-key-1");
    expect(result.snapshot.wakeReason).toBe("issue_commented");
    expect(result.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
  });

  it("keeps every wake comment id when shrinking one string alone reaches the budget", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `comment-${i}`);
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ids,
      note: "x".repeat(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES),
    });
    expect(result.snapshot.wakeCommentIds).toEqual(ids);
    expect(result.droppedWakeCommentIds).toBe(0);
    expect(result.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
  });

  it("keeps every wake comment id when removing debug alone reaches the budget", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `comment-${i}-${"0".repeat(32)}`);
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ids,
      debug: { providerTrace: "raw", blob: "x".repeat(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES) },
    });
    expect(result.snapshot.debug).toBeUndefined();
    expect(result.snapshot.wakeCommentIds).toEqual(ids);
    expect(result.droppedWakeCommentIds).toBe(0);
  });

  it("keeps every wake comment id when a non-string field is the overage", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `comment-${i}-${"0".repeat(32)}`);
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ids,
      checkboxSelection: { items: { payload: "x".repeat(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES * 2) } },
    });
    expect(result.snapshot.wakeCommentIds).toEqual(ids);
    expect(result.droppedWakeCommentIds).toBe(0);
    expect(result.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(result.bytes).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
  });

  it("enforces the byte bound for an oversized nested diagnostic value", () => {
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ["comment-1", "comment-2"],
      diagnostics: { trace: "x".repeat(30_000) },
    });
    expect(result.truncated).toBe(true);
    expect(result.snapshot.wakeCommentIds).toEqual(["comment-1", "comment-2"]);
    expect(result.droppedWakeCommentIds).toBe(0);
    expect(result.snapshot.issueId).toBe("issue-1");
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(result.bytes).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
  });

  it("enforces the byte bound for large nested arrays", () => {
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ["comment-1"],
      events: Array.from({ length: 2_000 }, (_, i) => ({ index: i, payload: "y".repeat(50) })),
    });
    expect(result.truncated).toBe(true);
    expect(result.snapshot.wakeCommentIds).toEqual(["comment-1"]);
    expect(result.droppedWakeCommentIds).toBe(0);
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(result.bytes).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
  });

  it("enforces the byte bound for many small keys", () => {
    const diagnostics: Record<string, string> = {};
    for (let i = 0; i < 3_000; i += 1) diagnostics[`key-${i}`] = "v".repeat(20);
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      diagnostics,
    });
    expect(result.truncated).toBe(true);
    expect(result.snapshot.issueId).toBe("issue-1");
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(result.bytes).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
  });

  it("never replaces a string with a longer truncation marker", () => {
    // Every value here is shorter than any truncation marker, so appending a
    // marker can only grow the snapshot. The cap must still reach the budget
    // without emitting a longer replacement.
    const filler: Record<string, string> = {};
    for (let i = 0; i < 2_000; i += 1) filler[`tiny-${i}`] = "v".repeat(30);
    const input = {
      issueId: "issue-1",
      wakeReason: "issue_commented",
      filler,
    };
    const result = capWakeContextSnapshotBytes(input);
    expect(result.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(result.bytes).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    const collectStrings = (value: unknown, out: string[]): void => {
      if (typeof value === "string") {
        out.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) collectStrings(entry, out);
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const entry of Object.values(value)) collectStrings(entry, out);
      }
    };
    const shrunk: string[] = [];
    collectStrings(result.snapshot, shrunk);
    for (const value of shrunk) {
      expect(value.length).toBeLessThanOrEqual(30);
    }
  });

  it("accumulates the dropped id count across repeated caps", () => {
    const first = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeCommentIds: Array.from({ length: 1000 }, (_, i) => `first-${i}-${"0".repeat(32)}`),
    });
    const second = capWakeContextSnapshotBytes({
      ...first.snapshot,
      wakeCommentIds: [
        ...(first.snapshot.wakeCommentIds as string[]),
        ...Array.from({ length: 1000 }, (_, i) => `second-${i}-${"0".repeat(32)}`),
      ],
    });
    expect(second.snapshot.wakeCommentIdsDroppedFromFront).toBe(
      first.droppedWakeCommentIds + second.droppedWakeCommentIds,
    );
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

  it("keeps nested unprotected values intact when dropping wake comment ids fits the budget", () => {
    const ids = Array.from(
      { length: 1000 },
      (_, i) => `comment-${String(i).padStart(4, "0")}-${"0".repeat(32)}`,
    );
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeCommentIds: ids,
      checkboxSelection: { q1: ["option-a", "option-b"] },
      itemVerdicts: { "item-1": "accepted" },
    });
    expect(result.droppedWakeCommentIds).toBe(
      ids.length - WAKE_CONTEXT_SNAPSHOT_KEPT_COMMENT_IDS,
    );
    expect(result.snapshot.checkboxSelection).toEqual({
      q1: ["option-a", "option-b"],
    });
    expect(result.snapshot.itemVerdicts).toEqual({ "item-1": "accepted" });
  });

  it("keeps routing flags unreduced when protected queued ids alone exceed the budget", () => {
    const queued = Array.from(
      { length: 700 },
      (_, i) => `queued-${String(i).padStart(4, "0")}-${"0".repeat(32)}`,
    );
    const flags = {
      paperclipHarnessCheckedOut: true,
      paperclipExternalChatExecutionBound: true,
      workspaceBusyDeferredWhileAssignee: false,
      interactionStatus: "accepted",
      activeTreeHold: true,
    };
    const result = capWakeContextSnapshotBytes({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      queuedCommentIds: queued,
      ...flags,
    });
    expect(result.snapshot).toEqual({
      issueId: "issue-1",
      wakeReason: "issue_commented",
      queuedCommentIds: queued,
      ...flags,
      snapshotTruncated: true,
    });
    expect(result.droppedWakeCommentIds).toBe(0);
    expect(result.bytes).toBe(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    );
  });

  it("fits the budget when many top-level keys collapse to removal markers", () => {
    const input: Record<string, unknown> = {
      issueId: "issue-1",
      wakeReason: "issue_commented",
    };
    const sized = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (let i = 0; i < 3_000; i += 1) {
      input[`key-${String(i).padStart(4, "0")}`] = sized;
    }
    const result = capWakeContextSnapshotBytes(input);
    expect(result.truncated).toBe(true);
    expect(result.snapshot.issueId).toBe("issue-1");
    expect(result.bytes).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(result.snapshot), "utf8")).toBe(
      result.bytes,
    );
  });

  it("keeps admitted paperclipWake ids when one large comment body exceeds the budget", () => {
    const issueId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const commentId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    const attachmentId = "cccccccc-3333-4333-8333-cccccccccccc";
    const contentPath = `/api/attachments/${attachmentId}/content`;
    const result = capWakeContextSnapshotBytes({
      issueId,
      taskId: issueId,
      wakeReason: "issue_commented",
      source: "chat:discord",
      wakeCommentIds: [commentId],
      commentId,
      wakeCommentId: commentId,
      paperclipExternalChatExecutionBound: true,
      paperclipWake: {
        issue: { id: issueId },
        commentIds: [commentId],
        latestCommentId: commentId,
        comments: [{ id: commentId, body: "x".repeat(30_000) }],
        attachments: [{ id: attachmentId, contentPath }],
        externalChatProvider: "discord",
        externalChatExecutionBound: true,
      },
    });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    expect(
      Buffer.byteLength(JSON.stringify(result.snapshot), "utf8"),
    ).toBeLessThanOrEqual(WAKE_CONTEXT_SNAPSHOT_MAX_BYTES);
    const wake = result.snapshot.paperclipWake as {
      issue: { id: string };
      commentIds: string[];
      latestCommentId: string;
      comments: Array<{ id: string; body: string }>;
      attachments: Array<{ id: string; contentPath: string }>;
    };
    expect(wake.issue.id).toBe(issueId);
    expect(wake.commentIds).toEqual([commentId]);
    expect(wake.latestCommentId).toBe(commentId);
    expect(wake.comments[0].id).toBe(commentId);
    expect(wake.attachments[0].id).toBe(attachmentId);
    expect(wake.attachments[0].contentPath).toBe(contentPath);
    expect(wake.comments[0].body.length).toBeLessThan(30_000);
    expect(JSON.stringify(result.snapshot)).not.toContain("…[truncated 36 chars]");
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
