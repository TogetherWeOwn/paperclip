import { parseObject } from "../adapters/utils.js";

export interface TerminalResultCleanupOutcomeInput {
  exitCode?: number | null;
  signal?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
}

/**
 * Decide whether a non-zero process end is cleanup noise from the
 * terminal-result cleanup rather than a run failure.
 *
 * The cleanup SIGTERMs a lingering background task after the adapter already
 * produced its terminal result; the CLI then exits 143 (128 + SIGTERM), or
 * Node reports the SIGTERM directly. That end of process must not fail a run
 * the adapter itself reports as successful.
 *
 * Forgiveness is deliberately narrow. All of the following must hold:
 * - the adapter reports no failure of its own (a set `errorMessage` or
 *   `errorCode` — including refusal codes, which carry an errorCode with a
 *   null message — keeps failing);
 * - the `unmanagedBackgroundTask` evidence shows a terminal result was
 *   actually seen (`terminalResultSeen: true`);
 * - the process end is attributable to the cleanup: exit 143 and/or a
 *   SIGTERM signal, with no other exit code or signal present.
 *
 * Everything else keeps failing as before: no terminal result, `is_error`
 * results (they always set an adapter errorMessage), force-kill escalations
 * that end in SIGKILL/137, and any other exit code or signal.
 */
export function isTerminalResultCleanupSuccess(
  input: TerminalResultCleanupOutcomeInput,
): boolean {
  if (input.errorMessage || input.errorCode) return false;
  const evidence = parseObject(input.resultJson?.unmanagedBackgroundTask);
  if (evidence.kind !== "terminal_result_cleanup") return false;
  if (evidence.stopped !== true || evidence.terminalResultSeen !== true)
    return false;
  const exitCode = input.exitCode ?? 0;
  if (exitCode !== 0 && exitCode !== 143) return false;
  if (input.signal != null && input.signal !== "SIGTERM") return false;
  return exitCode === 143 || input.signal === "SIGTERM";
}
