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
 * The `debug` object goes first. Unprotected values then shrink (nested
 * strings truncate largest-first, then unshrinkable values blank out, then
 * whole unprotected subtrees collapse to a removal marker), if that alone
 * reaches the budget. Oldest wake comment ids drop only when dropping
 * them (with values shrunk to fit) reaches the budget, because an id drop
 * that cannot reach it loses thread pointers for no byte gain. Queued comment
 * ids and every protected routing key are never touched: dropping pending
 * input would silently lose work, and rewriting an id or reason would change
 * what the run does. The returned snapshot fits the budget whenever any
 * combination of unprotected reductions can reach it. When protected content
 * alone is over the budget, no reduction can fit it, so the debug-stripped
 * snapshot is returned unreduced with an honest byte count.
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
  const shrunkKeepingIds = shrinkUnprotectedValues(base, maxBytes);
  if (dropCount === 0 || wakeContextSnapshotBytes(shrunkKeepingIds) <= maxBytes) {
    return finishWakeContextCap(shrunkKeepingIds, 0);
  }

  const shrunkWithTrimmedIds = shrinkUnprotectedValues(
    withTrimmedWakeCommentIds(base, ids, dropCount),
    maxBytes,
  );
  if (wakeContextSnapshotBytes(shrunkWithTrimmedIds) <= maxBytes) {
    return finishWakeContextCap(shrunkWithTrimmedIds, dropCount);
  }
  return finishWakeContextCap(base, 0);
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

/**
 * Bookkeeping keys the cap itself writes. They are tiny, but removing them
 * would lie about the truncation, so no reduction phase touches them.
 */
const WAKE_CONTEXT_CAP_BOOKKEEPING_KEYS = new Set([
  "snapshotTruncated",
  "wakeCommentIdsDroppedFromFront",
]);

type WakeSnapshotPath = Array<string | number>;

interface UnprotectedStringLeaf {
  path: WakeSnapshotPath;
  value: string;
  bytes: number;
}

function isWakeSnapshotObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtectedWakeSnapshotKey(key: string): boolean {
  return WAKE_CONTEXT_SNAPSHOT_PROTECTED_KEYS.has(key) || WAKE_CONTEXT_CAP_BOOKKEEPING_KEYS.has(key);
}

function collectUnprotectedStringLeaves(snapshot: Record<string, unknown>): UnprotectedStringLeaf[] {
  const out: UnprotectedStringLeaf[] = [];
  const visit = (value: unknown, path: WakeSnapshotPath, sheltered: boolean): void => {
    if (typeof value === "string") {
      if (!sheltered && value.length > 0) {
        out.push({ path, value, bytes: Buffer.byteLength(value, "utf8") });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], [...path, index], sheltered);
      }
      return;
    }
    if (isWakeSnapshotObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, [...path, key], sheltered);
      }
    }
  };
  for (const [key, value] of Object.entries(snapshot)) {
    visit(value, [key], isProtectedWakeSnapshotKey(key));
  }
  return out;
}

function compareWakeSnapshotPaths(a: WakeSnapshotPath, b: WakeSnapshotPath): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left) < String(right) ? -1 : 1;
  }
  return a.length - b.length;
}

function setWakeSnapshotPath(snapshot: Record<string, unknown>, path: WakeSnapshotPath, value: unknown): void {
  let node: unknown = snapshot;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(node)) return;
      node = node[segment];
    } else {
      if (!isWakeSnapshotObject(node)) return;
      node = node[segment];
    }
  }
  const last = path[path.length - 1];
  if (typeof last === "number") {
    if (Array.isArray(node)) node[last] = value;
  } else if (isWakeSnapshotObject(node)) {
    node[last] = value;
  }
}

/**
 * Truncates a string to fit the remaining budget ratio. Returns the original
 * value when truncating would not help: a truncation marker longer than the
 * value it replaces only grows the snapshot. Short strings (ids, paths,
 * routing markers) are never truncated: their byte saving is negligible, but
 * rewriting a 36-char UUID into a truncation marker breaks the admitted-wake
 * id equality, the current-wake-comments binding, and the attachment UUID
 * gate, while the large body that actually covers the overage is still huge.
 */
function truncateWakeSnapshotString(value: string, ratio: number): string {
  if (value.length < 256) return value;
  const keepChars = Math.max(0, Math.floor(value.length * ratio) - 64);
  if (keepChars >= value.length) return value;
  const removed = value.length - keepChars;
  const candidate = `${value.slice(0, keepChars)}…[truncated ${removed} chars]`;
  return Buffer.byteLength(candidate, "utf8") < Buffer.byteLength(value, "utf8") ? candidate : value;
}

function protectedWakeSnapshotBytes(snapshot: Record<string, unknown>): number {
  return wakeContextSnapshotBytes(
    Object.fromEntries(
      Object.entries(snapshot).filter(([key]) =>
        isProtectedWakeSnapshotKey(key),
      ),
    ),
  );
}

/**
 * Shrinks every unprotected value (at any depth) until the serialized
 * snapshot fits `maxBytes`. Protected routing keys, queued input, and the
 * cap's own bookkeeping markers are never touched. Three phases, each
 * strictly reducing the serialized size so the loop always terminates:
 * proportional truncation of the largest nested strings first (least data
 * loss), then blanking the values a marker cannot shrink, then collapsing
 * the largest remaining unprotected subtree into a removal marker. Returns
 * the input unchanged when protected content alone exceeds the budget,
 * because no reduction can fit it. The input is never mutated.
 */
function shrinkUnprotectedValues(
  input: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  if (protectedWakeSnapshotBytes(input) > maxBytes) return input;
  const snapshot = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  let bytes = wakeContextSnapshotBytes(snapshot);
  while (bytes > maxBytes) {
    const leaves = collectUnprotectedStringLeaves(snapshot);
    if (leaves.length === 0) break;
    leaves.sort((a, b) => b.bytes - a.bytes || compareWakeSnapshotPaths(a.path, b.path));
    // Truncate a largest-first prefix whose estimated saving covers the
    // overage, so a crowd of small strings converges in few passes instead of
    // one stringify per value. Replacing a value never shifts paths, so the
    // whole prefix applies safely before re-measuring.
    const ratio = maxBytes / bytes;
    const overage = bytes - maxBytes;
    let covered = 0;
    const planned: Array<{ path: WakeSnapshotPath; candidate: string; saving: number }> = [];
    for (const target of leaves) {
      const candidate = truncateWakeSnapshotString(target.value, ratio);
      if (candidate === target.value) continue;
      const saving = target.bytes - Buffer.byteLength(candidate, "utf8");
      if (saving <= 0) continue;
      planned.push({ path: target.path, candidate, saving });
      covered += saving;
      if (covered >= overage) break;
    }
    if (planned.length === 0) break;
    for (const { path, candidate } of planned) {
      setWakeSnapshotPath(snapshot, path, candidate);
    }
    const nextBytes = wakeContextSnapshotBytes(snapshot);
    if (nextBytes >= bytes) break;
    bytes = nextBytes;
  }
  while (bytes > maxBytes) {
    const leaves = collectUnprotectedStringLeaves(snapshot);
    if (leaves.length === 0) break;
    leaves.sort((a, b) => b.bytes - a.bytes || compareWakeSnapshotPaths(a.path, b.path));
    const overage = bytes - maxBytes;
    let covered = 0;
    let count = 0;
    for (const leaf of leaves) {
      // Blanking a value saves at least its content bytes (JSON escapes can
      // only inflate the saving), so this prefix covers the overage.
      covered += leaf.bytes;
      count += 1;
      if (covered >= overage) break;
    }
    for (const leaf of leaves.slice(0, Math.max(1, count))) {
      setWakeSnapshotPath(snapshot, leaf.path, "");
    }
    const nextBytes = wakeContextSnapshotBytes(snapshot);
    if (nextBytes >= bytes) break;
    bytes = nextBytes;
  }
  while (bytes > maxBytes) {
    let largestKey: string | null = null;
    let largestBytes = 0;
    for (const [key, value] of Object.entries(snapshot)) {
      if (isProtectedWakeSnapshotKey(key)) continue;
      const size = Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
      if (size > largestBytes) {
        largestBytes = size;
        largestKey = key;
      }
    }
    if (largestKey === null || largestBytes <= 0) break;
    const marker = `…[removed ${largestBytes} bytes]`;
    if (Buffer.byteLength(JSON.stringify(marker), "utf8") < largestBytes) {
      snapshot[largestKey] = marker;
    } else {
      delete snapshot[largestKey];
    }
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
