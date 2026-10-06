/**
 * Bounded observability receipts for host budget-fraction injection and
 * router run-end reap.
 *
 * Pure functions only — call sites own logging through the existing
 * structured logger. Only safe IDs and bounded numbers are captured here:
 * no prompts, raw arguments, credentials, token/HTTP headers, whole actor
 * contexts, or unbounded result payloads.
 */

/**
 * Bound a raw budget fraction to a single observable number.
 *
 * Finite numbers round to 4 decimals (overspend >1 is preserved, not
 * clamped, so degradation stays visible). Anything non-finite, including
 * `undefined` (no qualifying policy envelope), is an absent stamp.
 */
export function toBoundedBudgetFractionReceipt(
  fraction: number | undefined,
): { injected: boolean; budgetSpentFraction?: number } {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
    return { injected: false };
  }
  const rounded = Math.round(fraction * 10000) / 10000;
  if (!Number.isFinite(rounded)) {
    return { injected: false };
  }
  return { injected: true, budgetSpentFraction: rounded };
}

function toBoundedCount(value: unknown): number | null {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const n = Math.trunc(value);
  if (n < 0 || n > 1000000) {
    return null;
  }
  return n;
}

/**
 * Bound a router cancel-run-invocations result to observable counts.
 *
 * The worker returns `{ cancelled, alreadyTerminal, failed }` counts. Only
 * those three bounded integers are extracted; any other shape (including
 * null/undefined) is still a bounded receipt with `unshaped: true` and
 * zeroed counts. The host run ID is correlated by the caller, never taken
 * from the worker payload.
 */
export function toBoundedReapReceipt(result: unknown): {
  cancelled: number;
  alreadyTerminal: number;
  failed: number;
  unshaped: boolean;
} {
  if (typeof result !== "object" || result === null) {
    return { cancelled: 0, alreadyTerminal: 0, failed: 0, unshaped: true };
  }
  const rec = result as Record<string, unknown>;
  const cancelled = toBoundedCount(rec.cancelled);
  const alreadyTerminal = toBoundedCount(rec.alreadyTerminal);
  const failed = toBoundedCount(rec.failed);
  if (cancelled === null || alreadyTerminal === null || failed === null) {
    return { cancelled: 0, alreadyTerminal: 0, failed: 0, unshaped: true };
  }
  return { cancelled, alreadyTerminal, failed, unshaped: false };
}
