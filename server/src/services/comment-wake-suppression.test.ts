import { describe, expect, it } from "vitest";
import {
  COMMENT_WAKE_DEBOUNCE_MINUTES_DEFAULT,
  SUPPRESSION_REASON_AUTOMATION_NO_MARKER,
  SUPPRESSION_REASON_DEBOUNCED,
  SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES,
  WAKE_RECENT_RUN_GUARD_MINUTES_DEFAULT,
  evaluateAutomationCommentSkip,
  evaluateCommentWakeDebounce,
  evaluateRecentRunGuard,
  findActionableCommentMarkers,
  isAutomationCommentAuthor,
  isCommentWakeSuppressionCandidate,
  readCommentWakeSuppressionConfig,
} from "./comment-wake-suppression.js";

const NOW_MS = new Date("2026-10-21T19:00:00.000Z").getTime();

describe("readCommentWakeSuppressionConfig", () => {
  it("defaults ON with 5m debounce and 10m recent-run guard", () => {
    const config = readCommentWakeSuppressionConfig({});
    expect(config.enabled).toBe(true);
    expect(config.debounceMs).toBe(COMMENT_WAKE_DEBOUNCE_MINUTES_DEFAULT * 60_000);
    expect(config.recentRunGuardMs).toBe(WAKE_RECENT_RUN_GUARD_MINUTES_DEFAULT * 60_000);
  });

  it("tunes N/M from the environment and clamps garbage", () => {
    const config = readCommentWakeSuppressionConfig({
      COMMENT_WAKE_DEBOUNCE_MINUTES: "2",
      WAKE_RECENT_RUN_GUARD_MINUTES: "30",
    });
    expect(config.debounceMs).toBe(2 * 60_000);
    expect(config.recentRunGuardMs).toBe(30 * 60_000);

    const clamped = readCommentWakeSuppressionConfig({
      COMMENT_WAKE_DEBOUNCE_MINUTES: "0",
      WAKE_RECENT_RUN_GUARD_MINUTES: "banana",
    });
    expect(clamped.debounceMs).toBe(60_000);
    expect(clamped.recentRunGuardMs).toBe(WAKE_RECENT_RUN_GUARD_MINUTES_DEFAULT * 60_000);
  });

  it("disables all rules with COMMENT_WAKE_SUPPRESSION_ENABLED=false", () => {
    expect(readCommentWakeSuppressionConfig({ COMMENT_WAKE_SUPPRESSION_ENABLED: "false" }).enabled).toBe(
      false,
    );
  });
});

describe("findActionableCommentMarkers", () => {
  it("matches the explicit allowlist: findings, CI red, conflict, mention", () => {
    expect(findActionableCommentMarkers("Review finished with 2 findings.")).toEqual(["finding"]);
    expect(findActionableCommentMarkers("CI is red on the PR head.")).toEqual(["ci_red"]);
    expect(findActionableCommentMarkers("The build failed: ci job unit-tests.")).toEqual(["ci_red"]);
    expect(findActionableCommentMarkers("Greptile: ACTION_REQUIRED")).toEqual(["ci_red"]);
    expect(findActionableCommentMarkers("Checks failed on 8f51802.")).toEqual(["ci_red"]);
    expect(findActionableCommentMarkers("Merge conflict in server/src/routes/issues.ts.")).toEqual([
      "conflict",
    ]);
    expect(findActionableCommentMarkers("Please rebase on master.")).toEqual(["conflict"]);
    expect(findActionableCommentMarkers("@owner please confirm the launch.")).toEqual(["mention"]);
  });

  it("stays quiet on receipts, notes, and alerts", () => {
    expect(findActionableCommentMarkers("PR #235 merged.")).toEqual([]);
    expect(findActionableCommentMarkers("Run completed in 42s. No changes made.")).toEqual([]);
    expect(findActionableCommentMarkers("Age alert: card idle for 6h.")).toEqual([]);
    expect(findActionableCommentMarkers("CI is green on the PR head.")).toEqual([]);
    expect(findActionableCommentMarkers("")).toEqual([]);
    expect(findActionableCommentMarkers(null)).toEqual([]);
  });

  it("fails open on negation: 'no findings' still wakes", () => {
    expect(findActionableCommentMarkers("No new findings in this round.")).toEqual(["finding"]);
  });
});

describe("isAutomationCommentAuthor", () => {
  it("treats agent and system authors as automation, users as human", () => {
    expect(isAutomationCommentAuthor({ authorType: "agent", authorAgentId: "a", createdByRunId: null })).toBe(
      true,
    );
    expect(isAutomationCommentAuthor({ authorType: "system", authorAgentId: null, createdByRunId: null })).toBe(
      true,
    );
    expect(isAutomationCommentAuthor({ authorType: "user", authorAgentId: null, createdByRunId: null })).toBe(
      false,
    );
  });

  it("fails open on unknown authorship without agent signals", () => {
    expect(
      isAutomationCommentAuthor({ authorType: null, authorAgentId: null, createdByRunId: null }),
    ).toBe(false);
    expect(
      isAutomationCommentAuthor({ authorType: null, authorAgentId: "a", createdByRunId: null }),
    ).toBe(true);
    expect(
      isAutomationCommentAuthor({ authorType: undefined, authorAgentId: null, createdByRunId: "r" }),
    ).toBe(true);
  });
});

describe("isCommentWakeSuppressionCandidate", () => {
  const base = {
    reason: "issue_commented",
    mutation: "comment" as unknown,
    wakeCommentId: "comment-1",
    allowRunCoalescing: undefined as boolean | undefined,
    forceFreshSession: false,
    hasResumeIntent: false,
    hasExplicitResume: false,
    hasReviewPathLost: false,
    hasReopenedFrom: false,
    hasInterruptedRunId: false,
  };

  it("admits plain comment wakes with a triggering comment", () => {
    expect(isCommentWakeSuppressionCandidate(base)).toBe(true);
    expect(isCommentWakeSuppressionCandidate({ ...base, mutation: undefined })).toBe(true);
    expect(isCommentWakeSuppressionCandidate({ ...base, mutation: null })).toBe(true);
  });

  it("rejects non-comment reasons and missing comment ids", () => {
    expect(isCommentWakeSuppressionCandidate({ ...base, reason: "issue_reopened_via_comment" })).toBe(
      false,
    );
    expect(isCommentWakeSuppressionCandidate({ ...base, reason: "issue_assigned" })).toBe(false);
    expect(isCommentWakeSuppressionCandidate({ ...base, reason: null })).toBe(false);
    expect(isCommentWakeSuppressionCandidate({ ...base, wakeCommentId: null })).toBe(false);
  });

  it("rejects interaction continuations and causally-isolated wakes", () => {
    expect(isCommentWakeSuppressionCandidate({ ...base, mutation: "interaction" })).toBe(false);
    expect(isCommentWakeSuppressionCandidate({ ...base, allowRunCoalescing: false })).toBe(false);
  });

  it("rejects recovery and escalation wakes", () => {
    expect(isCommentWakeSuppressionCandidate({ ...base, forceFreshSession: true })).toBe(false);
    expect(isCommentWakeSuppressionCandidate({ ...base, hasResumeIntent: true })).toBe(false);
    expect(isCommentWakeSuppressionCandidate({ ...base, hasExplicitResume: true })).toBe(false);
    expect(isCommentWakeSuppressionCandidate({ ...base, hasReviewPathLost: true })).toBe(false);
    expect(isCommentWakeSuppressionCandidate({ ...base, hasReopenedFrom: true })).toBe(false);
    expect(isCommentWakeSuppressionCandidate({ ...base, hasInterruptedRunId: true })).toBe(false);
  });
});

describe("evaluateAutomationCommentSkip", () => {
  it("suppresses markerless automation comments", () => {
    const decision = evaluateAutomationCommentSkip({
      isAutomationAuthor: true,
      requestedByActorType: "agent",
      markers: [],
    });
    expect(decision).toMatchObject({ suppress: true, reason: SUPPRESSION_REASON_AUTOMATION_NO_MARKER });
  });

  it("wakes for human authors, user-requested wakes, and marked comments", () => {
    expect(
      evaluateAutomationCommentSkip({ isAutomationAuthor: false, requestedByActorType: "agent", markers: [] }),
    ).toEqual({ suppress: false });
    expect(
      evaluateAutomationCommentSkip({ isAutomationAuthor: true, requestedByActorType: "user", markers: [] }),
    ).toEqual({ suppress: false });
    expect(
      evaluateAutomationCommentSkip({
        isAutomationAuthor: true,
        requestedByActorType: "system",
        markers: ["ci_red"],
      }),
    ).toEqual({ suppress: false });
  });
});

describe("evaluateCommentWakeDebounce", () => {
  const base = {
    nowMs: NOW_MS,
    lastRunFinishedAtMs: NOW_MS - 60_000,
    lastRunSucceeded: true,
    debounceMs: 5 * 60_000,
    hasHumanCommentSinceLastFinish: false,
  };

  it("suppresses chatter inside the window with machine-readable detail", () => {
    const decision = evaluateCommentWakeDebounce(base);
    expect(decision.suppress).toBe(true);
    if (decision.suppress) {
      expect(decision.reason).toBe(SUPPRESSION_REASON_DEBOUNCED);
      expect(decision.detail.nextAllowedAt).toBe(new Date(NOW_MS + 4 * 60_000).toISOString());
      expect(decision.detail.debounceMs).toBe(5 * 60_000);
    }
  });

  it("wakes outside the window or without a prior run", () => {
    expect(evaluateCommentWakeDebounce({ ...base, nowMs: NOW_MS + 5 * 60_000 })).toEqual({
      suppress: false,
    });
    expect(evaluateCommentWakeDebounce({ ...base, lastRunFinishedAtMs: null })).toEqual({
      suppress: false,
    });
  });

  it("wakes when a human commented since the last finish or the last run failed", () => {
    expect(evaluateCommentWakeDebounce({ ...base, hasHumanCommentSinceLastFinish: true })).toEqual({
      suppress: false,
    });
    expect(evaluateCommentWakeDebounce({ ...base, lastRunSucceeded: false })).toEqual({
      suppress: false,
    });
  });
});

describe("evaluateRecentRunGuard", () => {
  const base = {
    nowMs: NOW_MS,
    lastRunFinishedAtMs: NOW_MS - 3 * 60_000,
    lastRunSucceeded: true,
    guardMs: 10 * 60_000,
    hasChangesSinceLastFinish: false,
  };

  it("suppresses quiet re-wakes inside the guard window", () => {
    const decision = evaluateRecentRunGuard(base);
    expect(decision.suppress).toBe(true);
    if (decision.suppress) {
      expect(decision.reason).toBe(SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES);
      expect(decision.detail.guardMs).toBe(10 * 60_000);
    }
  });

  it("wakes on changes, outside the window, without a prior run, or after failure", () => {
    expect(evaluateRecentRunGuard({ ...base, hasChangesSinceLastFinish: true })).toEqual({
      suppress: false,
    });
    expect(evaluateRecentRunGuard({ ...base, nowMs: NOW_MS + 8 * 60_000 })).toEqual({
      suppress: false,
    });
    expect(evaluateRecentRunGuard({ ...base, lastRunFinishedAtMs: null })).toEqual({
      suppress: false,
    });
    expect(evaluateRecentRunGuard({ ...base, lastRunSucceeded: false })).toEqual({
      suppress: false,
    });
  });
});
