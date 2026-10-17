import type { heartbeatRuns } from "@paperclipai/db";

type Run = typeof heartbeatRuns.$inferSelect;

export const LEGACY_RECOVERY_CAUSE = "legacy_execution_requires_reconciliation";

/**
 * The queued-run staleness gate cancels a continuation whose summary parks
 * the executor for reviewer feedback. That cancellation happens before the
 * run is claimed, so a persisted review wait must not be reopened as an
 * unknown provider outcome. Cancellation alone is not proof: every
 * never-started marker the gate leaves behind must be present, and any
 * process identity or emitted output keeps the run on the normal
 * reconciliation path.
 *
 * Kept in a leaf module (type-only db import) so startup-path consumers
 * such as execution-recovery-resolution can classify runs without pulling
 * in the issue service graph that legacy-execution-recovery depends on.
 */
export function isReviewWaitNeverStartedCancellation(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> &
    Partial<Pick<Run, "startedAt" | "processStartedAt" | "processPid" | "processGroupId" | "lastOutputAt" | "lastOutputSeq">>,
): boolean {
  return (
    run.runtimeMode !== "native" &&
    run.status === "cancelled" &&
    run.errorCode === "issue_continuation_waiting_on_review" &&
    run.resultJson?.stopReason === "issue_continuation_waiting_on_review" &&
    run.resultJson?.timeoutSource === "stale_queued_run_gate" &&
    run.startedAt == null &&
    run.processStartedAt == null &&
    run.processPid == null &&
    run.processGroupId == null &&
    run.lastOutputAt == null &&
    run.lastOutputSeq === 0
  );
}
