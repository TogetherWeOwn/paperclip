/**
 * Comment-wake suppression: stop no-op runs before they start.
 *
 * Host research (2026-10-19..10-21, heartbeat_runs) found 48% of Meta runs
 * change nothing, with comment wakes the top wake source (3,927 runs in 3
 * days). Many of those wakes come from bot/automation comments that need no
 * action: PR-controller notes, age alerts, receipts.
 *
 * This module holds the pure decision logic for three pre-execution skip
 * rules, applied in `enqueueWakeup` right after wake-queue admission (so a
 * live run still absorbs the wake via coalesce first) and before the
 * PAP-13775 event-free rewake throttle:
 *
 * 1. `automation_comment_no_marker` — skip wakes for automation-authored
 *    comments that carry no actionable marker. The allowlist of markers that
 *    SHOULD wake is explicit: review findings, CI red, merge conflicts, and
 *    @-mentions (a directed ping always wakes; owner/CEO identity cannot be
 *    resolved cheaply at this layer, so any mention wakes).
 * 2. `comment_wake_debounced` — rate-limit even marker-bearing automation
 *    chatter to one wake per N minutes per issue. The window anchors to the
 *    last finished run (observable, indexed); in-flight runs are already
 *    coalesced by wake-queue admission. Any human-authored comment since the
 *    last finish resets the window.
 * 3. `recent_run_no_changes` — skip when the last run on the issue ended
 *    within M minutes and nothing changed since: no human comment and no
 *    non-comment new-input activity (docs, work products, interactions,
 *    approvals, …). The triggering comment's own activity row is excluded or
 *    the rule could never fire for comment wakes.
 *
 * Safety properties (all pinned by tests):
 * - Human-authored comments always wake. Owner/CEO board comments arrive as
 *   `user` actors, so "no lost human or owner wakes" holds by construction.
 * - Reopened issues, explicit resumes, review-path recovery, interrupted-run
 *   recovery, force-fresh sessions, and interaction-mutation wakes bypass.
 * - A missing or deleted triggering comment fails open (wake).
 * - A last run that did not succeed fails open (its follow-up is recovery).
 *
 * Configuration (all default ON):
 * - `COMMENT_WAKE_SUPPRESSION_ENABLED` — `"false"` disables all three rules.
 * - `COMMENT_WAKE_DEBOUNCE_MINUTES` — N for rule 2 (default 5, clamped 1..1440).
 * - `WAKE_RECENT_RUN_GUARD_MINUTES` — M for rule 3 (default 10, clamped 1..1440).
 */

import { ISSUE_NEW_INPUT_ACTIVITY_ACTIONS } from "./issue-rewake-throttle.js";

/** Wakeup-request `reason` stored on suppression receipts. */
export const COMMENT_WAKE_SUPPRESSED_WAKE_REASON = "comment_wake_suppressed";

/** Rule 2: automation comment without an actionable marker. */
export const SUPPRESSION_REASON_AUTOMATION_NO_MARKER = "automation_comment_no_marker";
/** Rule 1: marker-bearing automation chatter inside the debounce window. */
export const SUPPRESSION_REASON_DEBOUNCED = "comment_wake_debounced";
/** Rule 3: last run finished within M minutes and nothing changed. */
export const SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES = "recent_run_no_changes";

export const COMMENT_WAKE_SUPPRESSION_REASONS: ReadonlyArray<string> = [
  SUPPRESSION_REASON_AUTOMATION_NO_MARKER,
  SUPPRESSION_REASON_DEBOUNCED,
  SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES,
];

export const COMMENT_WAKE_SUPPRESSION_ENABLED_DEFAULT = true;
export const COMMENT_WAKE_DEBOUNCE_MINUTES_DEFAULT = 5;
export const WAKE_RECENT_RUN_GUARD_MINUTES_DEFAULT = 10;
const SUPPRESSION_WINDOW_MINUTES_MIN = 1;
const SUPPRESSION_WINDOW_MINUTES_MAX = 1440;

export interface CommentWakeSuppressionConfig {
  enabled: boolean;
  /** Rule 2 window: debounce marker-bearing automation chatter. */
  debounceMs: number;
  /** Rule 3 window: quiet period after the last finished run. */
  recentRunGuardMs: number;
}

function readWindowMinutes(
  env: NodeJS.ProcessEnv,
  name: string,
  fallbackMinutes: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallbackMinutes;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallbackMinutes;
  const floored = Math.floor(parsed);
  if (floored < SUPPRESSION_WINDOW_MINUTES_MIN) return SUPPRESSION_WINDOW_MINUTES_MIN;
  if (floored > SUPPRESSION_WINDOW_MINUTES_MAX) return SUPPRESSION_WINDOW_MINUTES_MAX;
  return floored;
}

export function readCommentWakeSuppressionConfig(
  env: NodeJS.ProcessEnv = process.env,
): CommentWakeSuppressionConfig {
  return {
    enabled: env.COMMENT_WAKE_SUPPRESSION_ENABLED !== "false",
    debounceMs:
      readWindowMinutes(env, "COMMENT_WAKE_DEBOUNCE_MINUTES", COMMENT_WAKE_DEBOUNCE_MINUTES_DEFAULT) *
      60_000,
    recentRunGuardMs:
      readWindowMinutes(env, "WAKE_RECENT_RUN_GUARD_MINUTES", WAKE_RECENT_RUN_GUARD_MINUTES_DEFAULT) *
      60_000,
  };
}

export interface ActionableCommentMarker {
  name: string;
  patterns: RegExp[];
}

/**
 * Explicit allowlist of markers that SHOULD wake. An automation-authored
 * comment matching any pattern wakes normally; anything else is suppressed.
 * Patterns are intentionally fail-open: negation ("no findings") still wakes.
 */
export const ACTIONABLE_COMMENT_MARKERS: ReadonlyArray<ActionableCommentMarker> = [
  { name: "finding", patterns: [/\bfindings?\b/i] },
  {
    name: "ci_red",
    patterns: [
      /\bci\b[\s\S]{0,60}\b(red|fail\w*|broken|errors?)\b/i,
      /\b(red|fail\w*|broken)\b[\s\S]{0,60}\bci\b/i,
      /\bchecks?\s+(failed|failing|red)\b/i,
      /\baction_required\b/i,
    ],
  },
  { name: "conflict", patterns: [/\bconflicts?\b/i, /\brebase\b/i] },
  // Owner/CEO identity is not resolvable at this layer, so any directed ping
  // wakes. This keeps "no lost owner wakes" true by construction.
  { name: "mention", patterns: [/@[\w][\w.-]*/] },
];

/** Marker names present in `body`, sorted and deduplicated. */
export function findActionableCommentMarkers(body: string | null | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  for (const marker of ACTIONABLE_COMMENT_MARKERS) {
    if (marker.patterns.some((pattern) => pattern.test(body))) {
      found.add(marker.name);
    }
  }
  return [...found].sort();
}

export interface CommentAuthorInput {
  authorType: string | null | undefined;
  authorAgentId: string | null | undefined;
  createdByRunId: string | null | undefined;
}

/**
 * Whether a comment was authored by an automation identity (agent or system).
 * Unknown authorship fails open toward human: only explicit agent/system
 * markers, an agent id, or a creating run id count as automation.
 */
export function isAutomationCommentAuthor(input: CommentAuthorInput): boolean {
  if (input.authorType === "user") return false;
  if (input.authorType === "agent" || input.authorType === "system") return true;
  return Boolean(input.authorAgentId ?? input.createdByRunId);
}

export interface CommentWakeSuppressionCandidateInput {
  reason: string | null;
  /** Wake payload `mutation`: must be absent or "comment" (never "interaction"). */
  mutation: unknown;
  wakeCommentId: string | null;
  allowRunCoalescing?: boolean;
  forceFreshSession: boolean;
  hasResumeIntent: boolean;
  hasExplicitResume: boolean;
  hasReviewPathLost: boolean;
  hasReopenedFrom: boolean;
  hasInterruptedRunId: boolean;
}

/**
 * Whether a wake is even eligible for comment-wake suppression. Deliberate
 * and recovery-shaped wakes always pass: reopens (a different reason),
 * resumes, review-path recovery, interrupted-run recovery, fresh sessions,
 * interaction continuations, and causally-isolated wakes.
 */
export function isCommentWakeSuppressionCandidate(
  input: CommentWakeSuppressionCandidateInput,
): boolean {
  if (input.reason !== "issue_commented") return false;
  if (!input.wakeCommentId) return false;
  if (input.mutation !== undefined && input.mutation !== null && input.mutation !== "comment") {
    return false;
  }
  if (input.allowRunCoalescing === false) return false;
  if (input.forceFreshSession) return false;
  if (input.hasResumeIntent || input.hasExplicitResume) return false;
  if (input.hasReviewPathLost || input.hasReopenedFrom || input.hasInterruptedRunId) return false;
  return true;
}

/**
 * New-input activity actions minus `issue.comment_added`. Rule 3 must exclude
 * the triggering comment's own row or it could never fire for comment wakes;
 * comment-shaped input is covered separately by the human-comment check.
 */
export const NON_COMMENT_NEW_INPUT_ACTIVITY_ACTIONS: ReadonlyArray<string> =
  ISSUE_NEW_INPUT_ACTIVITY_ACTIONS.filter((action) => action !== "issue.comment_added");

export type CommentWakeSuppressionDecision =
  | { suppress: false }
  | { suppress: true; reason: string; detail: Record<string, unknown> };

/** Rule 2: markerless automation comments never need a run. */
export function evaluateAutomationCommentSkip(input: {
  isAutomationAuthor: boolean;
  requestedByActorType: string | null | undefined;
  markers: ReadonlyArray<string>;
}): CommentWakeSuppressionDecision {
  if (!input.isAutomationAuthor) return { suppress: false };
  // A user-requested wake that references an automation comment (board-driven
  // re-wake, manual dispatch) is deliberate: wake.
  if (input.requestedByActorType === "user") return { suppress: false };
  if (input.markers.length > 0) return { suppress: false };
  return {
    suppress: true,
    reason: SUPPRESSION_REASON_AUTOMATION_NO_MARKER,
    detail: { markers: [] },
  };
}

/** Rule 1: one wake per N minutes for marker-bearing automation chatter. */
export function evaluateCommentWakeDebounce(input: {
  nowMs: number;
  /** Finish time of the last run, or null when there is none. */
  lastRunFinishedAtMs: number | null;
  lastRunSucceeded: boolean;
  debounceMs: number;
  hasHumanCommentSinceLastFinish: boolean;
}): CommentWakeSuppressionDecision {
  if (input.lastRunFinishedAtMs === null) return { suppress: false };
  // A non-succeeded last run makes this wake recovery, not chatter.
  if (!input.lastRunSucceeded) return { suppress: false };
  if (input.hasHumanCommentSinceLastFinish) return { suppress: false };
  const nextAllowedAtMs = input.lastRunFinishedAtMs + input.debounceMs;
  if (input.nowMs >= nextAllowedAtMs) return { suppress: false };
  return {
    suppress: true,
    reason: SUPPRESSION_REASON_DEBOUNCED,
    detail: {
      lastRunFinishedAt: new Date(input.lastRunFinishedAtMs).toISOString(),
      nextAllowedAt: new Date(nextAllowedAtMs).toISOString(),
      debounceMs: input.debounceMs,
    },
  };
}

/** Rule 3: no run when the last run just finished and nothing changed. */
export function evaluateRecentRunGuard(input: {
  nowMs: number;
  /** Finish time of the last run, or null when there is none. */
  lastRunFinishedAtMs: number | null;
  lastRunSucceeded: boolean;
  guardMs: number;
  hasChangesSinceLastFinish: boolean;
}): CommentWakeSuppressionDecision {
  if (input.lastRunFinishedAtMs === null) return { suppress: false };
  // A non-succeeded last run makes this wake recovery, not a re-poll.
  if (!input.lastRunSucceeded) return { suppress: false };
  if (input.hasChangesSinceLastFinish) return { suppress: false };
  const nextAllowedAtMs = input.lastRunFinishedAtMs + input.guardMs;
  if (input.nowMs >= nextAllowedAtMs) return { suppress: false };
  return {
    suppress: true,
    reason: SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES,
    detail: {
      lastRunFinishedAt: new Date(input.lastRunFinishedAtMs).toISOString(),
      nextAllowedAt: new Date(nextAllowedAtMs).toISOString(),
      guardMs: input.guardMs,
    },
  };
}
