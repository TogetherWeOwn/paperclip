import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { claimedAdapterType } from "./conversation-continuation.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;

// Every server-written cancelRun eventMessage; a message missing here keeps its hold blocking.
const NEVER_STARTED_CANCEL_MESSAGES = [
  "run cancelled",
  "run cancelled before issue reassignment",
  "run cancelled before issue terminalization",
  "run cancelled from Slack",
  "run interrupted by board comment",
  "source run cancelled for isolated external-chat answer continuation",
];

/** Historical queued legacy cancellations have no process to stop. Require
 * untouched launch metadata, fully released leases with no pending or failed
 * cleanup, and only queue, cancellation, or settlement lifecycle events under
 * the run lock. A server cancel note also covers the closed-issue status the
 * terminalization writer echoes beside it. Current execution controls remain
 * the caller's gates. */
export async function isNeverStartedLegacyRun(db: Db, run: Run, coordinator: Coordinator | undefined) {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || !run.finishedAt || coordinator ||
      run.startedAt || run.processPid || run.processGroupId || run.processStartedAt ||
      run.controllerBootId || run.controllerLeaseExpiresAt || run.executionStage ||
      run.nativeSessionId || run.runnerInstanceId || run.sessionIdAfter ||
      run.lastOutputSeq !== 0 || run.lastOutputAt || run.lastOutputBytes ||
      run.logStore || run.logRef || run.logBytes) return false;
  const leases = await db.select({ releasedAt: environmentLeases.releasedAt, status: environmentLeases.status,
    cleanupStatus: environmentLeases.cleanupStatus }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId), ne(heartbeatRunEvents.eventType, "lifecycle"),
      sql`coalesce(${heartbeatRunEvents.stream}, '') <> 'system'`,
      sql`not (coalesce(${heartbeatRunEvents.payload}->>'status', '') in ('queued', 'scheduled_retry', 'cancelled')
        or (coalesce(${heartbeatRunEvents.payload}->>'status', '') = ''
          and (coalesce(${heartbeatRunEvents.message}, '') in (${sql.join(NEVER_STARTED_CANCEL_MESSAGES.map(message => sql`${message}`), sql`, `)})
            or (coalesce(${heartbeatRunEvents.payload}->>'automaticRecovery', '') = 'preserve_without_replay_v1'
              and coalesce(${heartbeatRunEvents.payload}->>'replay', '') = 'blocked')))
        or (coalesce(${heartbeatRunEvents.message}, '') in (${sql.join(NEVER_STARTED_CANCEL_MESSAGES.map(message => sql`${message}`), sql`, `)})
          and coalesce(${heartbeatRunEvents.payload}->>'status', '') = 'done'))`),
  )).limit(1);
  return !execution;
}

/** Caller holds the coordinator and run locks when using this proof to admit
 * work. Attempt zero is a durable never-claimed receipt: every native executor
 * commits its first claim before it can start or attach a provider. */
export async function isCancelledNativeStartup(db: Db, run: Run, coordinator: Coordinator | undefined) {
  if (run.status !== "cancelled" || !run.finishedAt || run.processPid || run.processGroupId ||
      run.processStartedAt || run.sessionIdAfter) return false;
  const cancellation = run.resultJson?.startupCancellation as Record<string, unknown> | undefined;
  const beforeSelection = run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
    !run.nativeSessionId && !coordinator && claimedAdapterType(run) === "paperclip_runner" &&
    cancellation?.beforeNativeSelection === true;
  const neverClaimed = run.runtimeMode === "native" && coordinator &&
    ["observed", "terminal_failure"].includes(coordinator.phase) && coordinator.attempt === 0 &&
    coordinator.controllerGeneration === 0 && !coordinator.controllerBootId &&
    !coordinator.controllerPid && !coordinator.leaseOwner && !coordinator.leaseExpiresAt &&
    !coordinator.resultId && !coordinator.failureDetail?.successorRunId;
  if (!beforeSelection && !neverClaimed) return false;
  const settled = typeof run.resultJson?.startupPreparationSettledAt === "string";
  // The old preparer can still be unwinding even though the run is terminal.
  if (!settled && run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if ((!settled && leases.length === 0) || leases.some(lease =>
    lease.provider === "local"
      ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
      : !hasRemoteTerminationReceipt(lease))) return false;
  // Reject contradictory retained evidence, including a crash after a launch
  // request but before the PID callback. Provider events never certify a stop.
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}
