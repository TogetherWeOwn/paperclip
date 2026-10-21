export type FatalProcess = {
  on(event: "uncaughtException", listener: (error: unknown) => void): void;
  exit(code: number): never;
};

/** Sentry's client close uses 5s. A stuck flush must not leave the process up. */
export const FATAL_EXIT_FLUSH_MS = 6_000;

const FATAL_LOG = "[paperclip] fatal uncaught exception; exiting so the supervisor can restart";

/**
 * Log and exit on an uncaught exception.
 *
 * Node's default is already "print and exit", but a handler that only logs
 * would suppress that exit and leave a crashed process running. Call this
 * only from the real server entry. Importing the server module from tests
 * must not install it.
 *
 * `beforeExit` runs to completion, or until `FATAL_EXIT_FLUSH_MS`, before
 * exit. A synchronous `process.exit` would skip listeners registered later
 * (Sentry's uncaught-exception integration) and drop their flush. A second
 * exception while that flush is in progress exits immediately.
 */
export function installUncaughtExceptionPolicy(
  proc: FatalProcess,
  log: (message: string, error: unknown) => void = (message, error) => {
    console.error(message, error);
  },
  beforeExit?: (error: unknown) => Promise<void> | void,
): void {
  let exiting = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  proc.on("uncaughtException", (error) => {
    if (exiting) {
      if (flushTimer) clearTimeout(flushTimer);
      proc.exit(1);
      return;
    }
    exiting = true;
    try {
      log(FATAL_LOG, error);
    } catch {
      // Logging must not replace the exit.
    }
    if (!beforeExit) {
      proc.exit(1);
      return;
    }
    flushTimer = setTimeout(() => {
      proc.exit(1);
    }, FATAL_EXIT_FLUSH_MS);
    void Promise.resolve()
      .then(() => beforeExit(error))
      .catch(() => undefined)
      .finally(() => {
        if (flushTimer) clearTimeout(flushTimer);
        proc.exit(1);
      });
  });
}
