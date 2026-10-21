import { and, eq, inArray } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { deriveCommentId } from "../../modules/run-dispatch/index.js";
import { ISSUE_PROGRESS_ACTIVITY_ACTIONS } from "../issue-rewake-throttle.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export interface PresentationWakeProvenance {
  wakeReason: string | null;
  wakeCommentId: string | null;
}

/**
 * Derive the wake provenance the no-progress/no-event suppression reads.
 * Pure snapshot read: the wake reason plus the wake comment id (including
 * batched/coalesced comment ids). Extracted from run finalization so the
 * suppression contract is covered by tests, not just by inspection.
 */
export function derivePresentationWakeProvenance(
  contextSnapshot: unknown,
): PresentationWakeProvenance {
  const snapshot = parseObject(contextSnapshot);
  return {
    wakeReason: readNonEmptyString(snapshot.wakeReason),
    wakeCommentId: deriveCommentId(snapshot, null),
  };
}

export interface PresentationProgressInput {
  companyId: string;
  runId: string;
  issueId: string | null;
  hasExistingRunComment: boolean;
}

/**
 * Activity actions that are monitor housekeeping, not issue-visible progress
 * for presentation purposes. A monitor wake's own re-arm writes
 * `issue.monitor_scheduled` plus an `issue.updated` row whose changes only
 * touch monitor fields; counting either as progress defeats the no-progress
 * no-event suppression, because every no-op monitor wake re-arms its monitor
 * and would therefore always "make progress". The scheduling writes
 * themselves are untouched — only the publish decision ignores them.
 */
export const PRESENTATION_MONITOR_HOUSEKEEPING_ACTIONS: ReadonlySet<string> =
  new Set(["issue.monitor_scheduled"]);

/**
 * Top-level `issue.updated` change keys that only re-arm or inspect the
 * monitor. `executionState`/`executionPolicy` transitions are compared with
 * their `monitor` sub-object stripped, so a stage or status advance still
 * counts as progress.
 */
export const PRESENTATION_MONITOR_ONLY_UPDATE_KEYS: ReadonlySet<string> =
  new Set([
    "monitorNotes",
    "executionState",
    "executionPolicy",
    "monitorNextCheckAt",
    "monitorScheduledBy",
    "monitorWakeRequestedAt",
    "statusVersion",
  ]);

function canonicalizeForMonitorComparison(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeForMonitorComparison).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeForMonitorComparison(record[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withoutMonitorSubObject(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { monitor: _ignored, ...rest } = value as Record<string, unknown>;
  return rest;
}

/**
 * Keys a freshly created execution policy may carry besides its `monitor`
 * sub-object when the creation is just a monitor re-arm (no stages planned,
 * no workflow configured). A creation carrying anything else — planned
 * stages, an approval chain, etc. — is real work, not housekeeping.
 */
const SCHEDULING_ONLY_POLICY_KEYS: ReadonlySet<string> = new Set([
  "mode",
  "stages",
  "commentRequired",
]);

function isSchedulingOnlyPolicyCreation(value: unknown): boolean {
  const stripped = withoutMonitorSubObject(value);
  if (!stripped || typeof stripped !== "object" || Array.isArray(stripped)) {
    return false;
  }
  for (const [key, entry] of Object.entries(
    stripped as Record<string, unknown>,
  )) {
    if (!SCHEDULING_ONLY_POLICY_KEYS.has(key)) return false;
    if (key === "stages") {
      if (entry === undefined || entry === null) continue;
      if (!Array.isArray(entry) || entry.length > 0) return false;
    }
  }
  return true;
}

/**
 * Whether an `issue.updated` activity row is monitor-only housekeeping (a
 * monitor re-arm) rather than issue-visible progress. Returns false —
 * counting as progress — for anything unclassifiable, so real progress is
 * never silently suppressed.
 */
export function isMonitorOnlyIssueUpdateDetails(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return false;
  }
  const changes = (details as Record<string, unknown>).changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return false;
  }
  const entries = Object.entries(changes as Record<string, unknown>);
  if (entries.length === 0) return true;
  for (const [key, change] of entries) {
    if (!PRESENTATION_MONITOR_ONLY_UPDATE_KEYS.has(key)) return false;
    if (key === "executionState" || key === "executionPolicy") {
      if (!change || typeof change !== "object" || Array.isArray(change)) {
        return false;
      }
      const transition = change as Record<string, unknown>;
      if (!("to" in transition) && !("from" in transition)) return false;
      const from = (transition as { from?: unknown }).from ?? null;
      if (from === null) {
        // A first-time policy/state creation by the run. The monitor re-arm
        // path creates the execution policy when none exists, so a
        // scheduling-only skeleton still counts as housekeeping; anything
        // richer (planned stages, workflow state) counts as progress.
        if (
          key !== "executionPolicy" ||
          !isSchedulingOnlyPolicyCreation(
            (transition as { to?: unknown }).to,
          )
        ) {
          return false;
        }
        continue;
      }
      if (
        canonicalizeForMonitorComparison(
          withoutMonitorSubObject((transition as { to?: unknown }).to),
        ) !== canonicalizeForMonitorComparison(withoutMonitorSubObject(from))
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Resolve whether a run left issue-visible progress for presentation
 * purposes. An explicit run comment counts as progress (it keeps reuse
 * precedence inside the resolver); otherwise progress is any
 * ISSUE_PROGRESS_ACTIVITY_ACTIONS row attributed to this run on this issue,
 * excluding monitor housekeeping (the run's own monitor re-arm). Returns
 * undefined when there is no issue, preserving legacy behavior for callers
 * without an issue context.
 */
export async function readPresentationRunMadeIssueProgress(
  db: Db,
  input: PresentationProgressInput,
): Promise<boolean | undefined> {
  if (!input.issueId) return undefined;
  if (input.hasExistingRunComment) return true;
  const candidateRows = await db
    .select({ action: activityLog.action, details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.runId, input.runId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        inArray(activityLog.action, ISSUE_PROGRESS_ACTIVITY_ACTIONS),
      ),
    )
    .limit(50);
  return candidateRows.some(
    (row) =>
      !PRESENTATION_MONITOR_HOUSEKEEPING_ACTIONS.has(row.action) &&
      !(
        row.action === "issue.updated" &&
        isMonitorOnlyIssueUpdateDetails(row.details)
      ),
  );
}

