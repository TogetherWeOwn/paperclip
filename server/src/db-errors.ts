const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const DEADLOCK_DETECTED = "40P01";
const MAX_CAUSE_DEPTH = 4;

/**
 * Recognizes a Postgres unique-constraint violation (SQLSTATE 23505).
 *
 * Drizzle wraps driver failures in its own `Failed query: ...` error, so the
 * Postgres error that carries the code and the constraint name is reachable
 * only through `cause` — inspecting the thrown error directly misses it. The
 * constraint name itself lands on `constraint_name` under postgres.js and on
 * `constraint` under node-postgres, and is not always surfaced at all, so fall
 * back to the driver message.
 */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.code === UNIQUE_VIOLATION) {
      if (!constraintName) return true;
      const constraint = candidate.constraint ?? candidate.constraint_name;
      if (constraint === constraintName) return true;
      if (typeof candidate.message === "string" && candidate.message.includes(constraintName)) return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Recognizes a Postgres foreign-key-constraint violation (SQLSTATE 23503).
 *
 * A delete that leaves an orphan reference raises this code. Drizzle wraps the
 * driver failure in its own `Failed query: ...` error, so the Postgres error
 * that carries the code is reachable only through `cause`. This helper walks
 * the `cause` chain, the same way `isUniqueViolation` does.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === FOREIGN_KEY_VIOLATION) return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * Recognizes a Postgres deadlock abort (SQLSTATE 40P01).
 *
 * The runtime-tools and MCP paths lock `issues` then `heartbeat_runs` while
 * the secret-access audit insert takes `FOR KEY SHARE` on the same rows in
 * the opposite order, so either side can lose a deadlock race and surface as
 * a 500. Like the helpers above, this walks the `cause` chain because
 * Drizzle wraps the driver failure.
 */
export function isDeadlockFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === DEADLOCK_DETECTED) return true;
    current = candidate.cause;
  }
  return false;
}

export interface DeadlockRetryOptions {
  /** Total attempts including the first try. Defaults to 4. */
  maxAttempts?: number;
  /** Base backoff in milliseconds before retrying. Defaults to 25. */
  baseDelayMs?: number;
}

/**
 * Re-runs an idempotent unit of work when Postgres aborts it as a deadlock
 * victim (40P01). A deadlock abort rolls back the whole transaction, so
 * retrying the callback from scratch is safe as long as every effect it has
 * runs inside that transaction. Non-deadlock errors rethrow immediately.
 */
export async function withDeadlockRetry<T>(
  fn: () => Promise<T>,
  options?: DeadlockRetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options?.maxAttempts ?? 4));
  const baseDelayMs = Math.max(0, options?.baseDelayMs ?? 25);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      if (!isDeadlockFailure(error) || attempt >= maxAttempts) throw error;
      const backoffMs = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}
