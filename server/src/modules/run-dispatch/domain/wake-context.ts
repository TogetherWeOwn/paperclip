// Shared wake-reason and retry-reason constants, and the pure classifiers
// that read them off a run's context snapshot. `heartbeat.ts` and this
// module's own Postgres adapter both decide on the same context snapshot
// shape, so this file is their one shared source for it: a second,
// independently maintained copy in either file could silently drift out of
// sync with the other and change only one of the two gates that read it.

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export const MAX_TURN_CONTINUATION_RETRY_REASON = "max_turns_continuation";
export const WORKSPACE_BUSY_RETRY_REASON = "workspace_busy";
export const AI_CONNECTION_BUSY_RETRY_REASON = "ai_connection_busy";
export const INTERACTION_CONTINUATION_INFRA_RETRY_REASON = "interaction_continuation_infra_retry";
export const INTERACTION_CONTINUATION_INFRA_WAKE_REASON = "interaction_continuation_infra_retry";
export const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";
/**
 * Byte budget for the context snapshot injected into every run request.
 * The snapshot is a routing envelope, not the thread itself: ids trimmed
 * here stay fetchable through the issue-comments API, and the prompt-time
 * inline tail (`MAX_INLINE_WAKE_COMMENTS`) renders from the kept ids.
 */
export const WAKE_CONTEXT_SNAPSHOT_MAX_BYTES = 24_000;
/** Newest wake comment ids kept when a snapshot exceeds its byte budget. */
export const WAKE_CONTEXT_SNAPSHOT_KEPT_COMMENT_IDS = 8;
/**
 * Snapshot keys that must survive capping byte-for-byte. Routing,
 * continuation identity, and pending input live here; trimming any of them
 * changes what the run does, while everything else is diagnostic context.
 */
const WAKE_CONTEXT_SNAPSHOT_PROTECTED_KEYS = new Set([
  "issueId",
  "taskId",
  "taskKey",
  "commentId",
  "wakeCommentId",
  WAKE_COMMENT_IDS_KEY,
  "queuedCommentIds",
  "wakeReason",
  "retryReason",
  "source",
  "wakeSource",
  "mutation",
  "interactionId",
  "forceFreshSession",
  "previousRunId",
  "retryOfRunId",
]);
export const RESOLVED_INTERACTION_CONTINUATION_STATUSES = new Set([
  "accepted",
  "answered",
  "cancelled",
  "rejected",
]);

/**
 * True for a resource-wait retry whose original run did not
 * execute under assignee-ship (a comment or review-participant wake). Such a
 * retry has an expected assignee mismatch, so the scheduled-retry gate and
 * the queued-run staleness check must not treat it as a reassignment.
 */
export function isNonAssigneeWorkspaceBusyRetry(
  retryReason: string | null | undefined,
  contextSnapshot: Record<string, unknown>,
): boolean {
  return (
    (retryReason === WORKSPACE_BUSY_RETRY_REASON &&
      contextSnapshot.workspaceBusyDeferredWhileAssignee === false) ||
    (retryReason === AI_CONNECTION_BUSY_RETRY_REASON &&
      contextSnapshot.aiConnectionBusyDeferredWhileAssignee === false)
  );
}

export function extractWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const raw = contextSnapshot?.[WAKE_COMMENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = readNonEmptyString(entry);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

export function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload?: Record<string, unknown> | null,
): string | null {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

/**
 * `allowedWakeReasons` is the issue-tree-control module's own set of wake
 * reasons that excuse an interaction wake. This file stays free of service
 * imports, so the caller passes the set in rather than this function reading
 * it from the service directly.
 */
export function allowsIssueInteractionWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
  allowedWakeReasons: ReadonlySet<string>,
): boolean {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (!wakeReason || !allowedWakeReasons.has(wakeReason)) return false;
  return Boolean(deriveCommentId(contextSnapshot));
}

export interface CappedWakeContextSnapshot {
  snapshot: Record<string, unknown>;
  /** True when any byte was removed or rewritten to fit the budget. */
  truncated: boolean;
  /** Oldest-first wake comment ids dropped; the oldest kept id stays the thread pointer. */
  droppedWakeCommentIds: number;
  /** Serialized byte size of the returned snapshot. */
  bytes: number;
}

function wakeContextSnapshotBytes(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Caps an enriched wake context snapshot to `maxBytes` serialized bytes.
 * The `debug` object goes first. Unprotected strings then shrink, if that
 * alone reaches the budget. Oldest wake comment ids drop only when dropping
 * them (with strings shrunk to fit) reaches the budget, because an id drop
 * that cannot reach it loses thread pointers for no byte gain. Queued comment
 * ids and every protected routing key are never touched: dropping pending
 * input would silently lose work, and rewriting an id or reason would change
 * what the run does.
 */
export function capWakeContextSnapshotBytes(
  input: Record<string, unknown>,
  maxBytes: number = WAKE_CONTEXT_SNAPSHOT_MAX_BYTES,
): CappedWakeContextSnapshot {
  const originalBytes = wakeContextSnapshotBytes(input);
  if (originalBytes <= maxBytes) {
    return { snapshot: input, truncated: false, droppedWakeCommentIds: 0, bytes: originalBytes };
  }
  const base: Record<string, unknown> = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  delete base.debug;
  // Queryable marker, set before measuring so it counts against the budget.
  base.snapshotTruncated = true;
  if (wakeContextSnapshotBytes(base) <= maxBytes) {
    return finishWakeContextCap(base, 0);
  }

  const ids = extractWakeCommentIds(base);
  const dropCount = Math.max(0, ids.length - WAKE_CONTEXT_SNAPSHOT_KEPT_COMMENT_IDS);
  const shrunkKeepingIds = shrinkUnprotectedStrings({ ...base }, maxBytes);
  if (dropCount === 0 || wakeContextSnapshotBytes(shrunkKeepingIds) <= maxBytes) {
    return finishWakeContextCap(shrunkKeepingIds, 0);
  }

  const shrunkWithTrimmedIds = shrinkUnprotectedStrings(
    withTrimmedWakeCommentIds(base, ids, dropCount),
    maxBytes,
  );
  if (wakeContextSnapshotBytes(shrunkWithTrimmedIds) <= maxBytes) {
    return finishWakeContextCap(shrunkWithTrimmedIds, dropCount);
  }
  return finishWakeContextCap(shrunkKeepingIds, 0);
}

function withTrimmedWakeCommentIds(
  snapshot: Record<string, unknown>,
  ids: string[],
  dropped: number,
): Record<string, unknown> {
  const priorDropped =
    typeof snapshot.wakeCommentIdsDroppedFromFront === "number"
      ? snapshot.wakeCommentIdsDroppedFromFront
      : 0;
  return {
    ...snapshot,
    [WAKE_COMMENT_IDS_KEY]: ids.slice(-WAKE_CONTEXT_SNAPSHOT_KEPT_COMMENT_IDS),
    wakeCommentIdsDroppedFromFront: priorDropped + dropped,
  };
}

function shrinkUnprotectedStrings(
  snapshot: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  let bytes = wakeContextSnapshotBytes(snapshot);
  while (bytes > maxBytes) {
    let largestKey: string | null = null;
    let largestBytes = 0;
    for (const [key, value] of Object.entries(snapshot)) {
      if (WAKE_CONTEXT_SNAPSHOT_PROTECTED_KEYS.has(key)) continue;
      if (typeof value !== "string") continue;
      const size = Buffer.byteLength(value, "utf8");
      if (size > largestBytes) {
        largestBytes = size;
        largestKey = key;
      }
    }
    if (largestKey === null || largestBytes <= 0) break;
    const value = snapshot[largestKey] as string;
    const keepChars = Math.max(0, Math.floor(value.length * (maxBytes / bytes)) - 64);
    snapshot[largestKey] =
      value.length > keepChars
        ? `${value.slice(0, Math.max(0, keepChars))}…[truncated ${value.length - Math.max(0, keepChars)} chars]`
        : value;
    const nextBytes = wakeContextSnapshotBytes(snapshot);
    if (nextBytes >= bytes) break;
    bytes = nextBytes;
  }
  return snapshot;
}

function finishWakeContextCap(
  snapshot: Record<string, unknown>,
  droppedWakeCommentIds: number,
): CappedWakeContextSnapshot {
  return {
    snapshot,
    truncated: true,
    droppedWakeCommentIds,
    bytes: wakeContextSnapshotBytes(snapshot),
  };
}

export function isResolvedInteractionContinuationWakeContext(contextSnapshot: unknown): boolean {
  const context = parseObject(contextSnapshot);
  const interactionId = readNonEmptyString(context.interactionId);
  const interactionStatus = readNonEmptyString(context.interactionStatus);
  if (!interactionId || !interactionStatus) return false;
  if (!RESOLVED_INTERACTION_CONTINUATION_STATUSES.has(interactionStatus)) return false;

  const mutation = readNonEmptyString(context.mutation);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const retryReason = readNonEmptyString(context.retryReason);
  return (
    (mutation === "interaction" && wakeReason === "issue_commented") ||
    wakeReason === INTERACTION_CONTINUATION_INFRA_WAKE_REASON ||
    retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
  );
}
