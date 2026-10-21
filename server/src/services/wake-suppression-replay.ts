/**
 * Replay comment-wake suppression over real wake history.
 *
 * Reads `issue_commented` wakeup requests from a lookback window, reconstructs
 * the inputs the `enqueueWakeup` suppression gate would have seen (triggering
 * comment author/body, last finished run, human comments and activity since),
 * and applies the same pure evaluators the gate uses. Reports how many runs
 * the rules would have prevented. Callers fail closed when any human/owner
 * wake would have been suppressed.
 *
 * This lives in `server/` (not `scripts/`) so it resolves `drizzle-orm` from
 * the server workspace. The CLI wrapper is `scripts/replay-wake-suppression.ts`.
 */

import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
} from "@paperclipai/db";
import {
  CHILD_STOP_RELAY_ACTOR_ID,
  NON_COMMENT_NEW_INPUT_ACTIVITY_ACTIONS,
  SUPPRESSION_REASON_AUTOMATION_NO_MARKER,
  SUPPRESSION_REASON_DEBOUNCED,
  SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES,
  evaluateAutomationCommentSkip,
  evaluateCommentWakeDebounce,
  evaluateRecentRunGuard,
  findActionableCommentMarkers,
  isAutomationCommentAuthor,
  isCommentWakeSuppressionCandidate,
} from "./comment-wake-suppression.js";

/**
 * Wake-row statuses that never started a run: absorbed by a live run
 * (`coalesced`), still pending (`deferred_issue_execution`), or terminal
 * without execution (`failed`, `cancelled`, `expired`). These are excluded
 * from the `classified` denominator so the projected run reduction reads as
 * "runs prevented / runs that ran", and reported separately for audit.
 */
export const NON_RUN_STARTING_WAKE_STATUSES: ReadonlySet<string> = new Set([
  "coalesced",
  "deferred_issue_execution",
  "failed",
  "cancelled",
  "expired",
]);

export interface WakeSuppressionReplayOptions {
  windowStart: Date;
  limit: number;
  debounceMs: number;
  guardMs: number;
  companyIds: string[];
}

export interface WakeSuppressionReplayReport {
  wakesScanned: number;
  alreadySkipped: number;
  /** Rows that never started a run (coalesced/deferred/failed/…): outside the denominator. */
  notRunStarting: number;
  notRunStartingByStatus: Record<string, number>;
  classified: number;
  admitted: number;
  suppressedTotal: number;
  suppressedByReason: Record<string, number>;
  /** Suppressed / classified: the projected run reduction. */
  projectedRunReduction: number;
  humanWakesSeen: number;
  humanWakesSuppressed: number;
  /** Wake/comment ids and reason only: never comment bodies (receipt parity). */
  suppressedWakeSample: Array<{
    wakeId: string;
    reason: string;
    commentId: string;
  }>;
}

export async function replayWakeSuppression(
  db: Db,
  options: WakeSuppressionReplayOptions,
): Promise<WakeSuppressionReplayReport> {
  const tallies = {
    wakesScanned: 0,
    alreadySkipped: 0,
    notRunStartingByStatus: {} as Record<string, number>,
    admitted: 0,
    suppressedByReason: {
      [SUPPRESSION_REASON_AUTOMATION_NO_MARKER]: 0,
      [SUPPRESSION_REASON_DEBOUNCED]: 0,
      [SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES]: 0,
    } as Record<string, number>,
    humanWakesSeen: 0,
    humanWakesSuppressed: 0,
    suppressedWakeSample: [] as WakeSuppressionReplayReport["suppressedWakeSample"],
  };

  const wakeRows = await db
    .select({
      id: agentWakeupRequests.id,
      companyId: agentWakeupRequests.companyId,
      agentId: agentWakeupRequests.agentId,
      reason: agentWakeupRequests.reason,
      status: agentWakeupRequests.status,
      payload: agentWakeupRequests.payload,
      requestedByActorType: agentWakeupRequests.requestedByActorType,
      requestedByActorId: agentWakeupRequests.requestedByActorId,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.reason, "issue_commented"),
        gte(agentWakeupRequests.requestedAt, options.windowStart),
        options.companyIds.length > 0
          ? inArray(agentWakeupRequests.companyId, options.companyIds)
          : undefined,
      ),
    )
    .orderBy(agentWakeupRequests.requestedAt)
    .limit(options.limit);

  for (const wake of wakeRows) {
    tallies.wakesScanned += 1;
    if (wake.status === "skipped") {
      tallies.alreadySkipped += 1;
      continue;
    }
    if (NON_RUN_STARTING_WAKE_STATUSES.has(wake.status)) {
      tallies.notRunStartingByStatus[wake.status] =
        (tallies.notRunStartingByStatus[wake.status] ?? 0) + 1;
      continue;
    }
    const payload = (wake.payload ?? {}) as Record<string, unknown>;
    const commentId = typeof payload.commentId === "string" ? payload.commentId : null;
    const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
    if (!commentId || !issueId) {
      tallies.admitted += 1;
      continue;
    }
    // allowRunCoalescing, forceFreshSession, explicit resumes, and liveness
    // continuations are not persisted on the wake row (they ride the live wake
    // options/context snapshot); the replay cannot observe them, so it treats
    // every row as coalescible, non-fresh, non-resume, non-liveness. That can
    // only over-count suppression for those rare rows, never hide a human
    // wake (human content bypasses every rule below). The stop-relay bypass
    // IS observable via the persisted requestedByActorId, so it is honored.
    const candidate = isCommentWakeSuppressionCandidate({
      reason: wake.reason,
      mutation: payload.mutation,
      wakeCommentId: commentId,
      allowRunCoalescing: undefined,
      forceFreshSession: false,
      hasResumeIntent: payload.resumeIntent === true,
      hasExplicitResume: false,
      hasReviewPathLost: payload.reviewPathLost === true,
      hasReopenedFrom: payload.reopenedFrom !== undefined && payload.reopenedFrom !== null,
      hasInterruptedRunId:
        payload.interruptedRunId !== undefined && payload.interruptedRunId !== null,
      hasLivenessContinuation: false,
      hasStopRelay: wake.requestedByActorId === CHILD_STOP_RELAY_ACTOR_ID,
    });
    if (!candidate) {
      tallies.admitted += 1;
      continue;
    }

    const commentRows = await db
      .select({
        id: issueComments.id,
        authorType: issueComments.authorType,
        authorAgentId: issueComments.authorAgentId,
        createdByRunId: issueComments.createdByRunId,
        body: issueComments.body,
        deletedAt: issueComments.deletedAt,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, wake.companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.id, commentId),
        ),
      )
      .limit(1);
    const comment = commentRows[0] ?? null;
    if (!comment || comment.deletedAt) {
      tallies.admitted += 1;
      continue;
    }

    const isAutomation = isAutomationCommentAuthor({
      authorType: comment.authorType,
      authorAgentId: comment.authorAgentId,
      createdByRunId: comment.createdByRunId,
    });
    const isHumanWake = wake.requestedByActorType === "user" || !isAutomation;
    if (isHumanWake) tallies.humanWakesSeen += 1;

    const markers = findActionableCommentMarkers(comment.body);
    let decision = evaluateAutomationCommentSkip({
      isAutomationAuthor: isAutomation,
      requestedByActorType: wake.requestedByActorType,
      markers,
    });

    if (!decision.suppress && markers.length > 0 && wake.requestedAt) {
      const wakeMs = wake.requestedAt.getTime();
      const lastRunRows = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          finishedAt: heartbeatRuns.finishedAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, wake.companyId),
            eq(heartbeatRuns.agentId, wake.agentId),
            sql`${heartbeatRuns.finishedAt} is not null`,
            lte(heartbeatRuns.finishedAt, wake.requestedAt),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ),
        )
        .orderBy(desc(heartbeatRuns.finishedAt))
        .limit(1);
      const lastRun = lastRunRows[0] ?? null;
      const lastRunFinishedAt = lastRun?.finishedAt ?? null;
      if (lastRunFinishedAt) {
        const humanCommentSinceRows = await db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, wake.companyId),
              eq(issueComments.issueId, issueId),
              gt(issueComments.createdAt, lastRunFinishedAt),
              lte(issueComments.createdAt, wake.requestedAt),
              ne(issueComments.id, commentId),
              isNull(issueComments.deletedAt),
              or(
                eq(issueComments.authorType, "user"),
                and(
                  isNull(issueComments.authorType),
                  isNull(issueComments.authorAgentId),
                  isNull(issueComments.createdByRunId),
                ),
              ),
            ),
          )
          .limit(1);
        const hasHumanCommentSinceLastFinish = humanCommentSinceRows.length > 0;
        const lastRunSucceeded = lastRun?.status === "succeeded";
        decision = evaluateCommentWakeDebounce({
          nowMs: wakeMs,
          isAutomationAuthor: isAutomation,
          requestedByActorType: wake.requestedByActorType,
          lastRunFinishedAtMs: lastRunFinishedAt.getTime(),
          lastRunSucceeded,
          debounceMs: options.debounceMs,
          hasHumanCommentSinceLastFinish,
        });
        if (!decision.suppress) {
          const nonCommentInputRows = lastRunSucceeded
            ? await db
                .select({ id: activityLog.id })
                .from(activityLog)
                .where(
                  and(
                    eq(activityLog.companyId, wake.companyId),
                    eq(activityLog.entityType, "issue"),
                    eq(activityLog.entityId, issueId),
                    gt(activityLog.createdAt, lastRunFinishedAt),
                    lte(activityLog.createdAt, wake.requestedAt),
                    inArray(activityLog.action, [...NON_COMMENT_NEW_INPUT_ACTIVITY_ACTIONS]),
                  ),
                )
                .limit(1)
            : [];
          decision = evaluateRecentRunGuard({
            nowMs: wakeMs,
            isAutomationAuthor: isAutomation,
            requestedByActorType: wake.requestedByActorType,
            lastRunFinishedAtMs: lastRunFinishedAt.getTime(),
            lastRunSucceeded,
            guardMs: options.guardMs,
            hasChangesSinceLastFinish:
              hasHumanCommentSinceLastFinish || nonCommentInputRows.length > 0,
          });
        }
      }
    }

    if (decision.suppress) {
      tallies.suppressedByReason[decision.reason] =
        (tallies.suppressedByReason[decision.reason] ?? 0) + 1;
      if (isHumanWake) tallies.humanWakesSuppressed += 1;
      if (tallies.suppressedWakeSample.length < 10) {
        tallies.suppressedWakeSample.push({
          wakeId: wake.id,
          reason: decision.reason,
          commentId,
        });
      }
    } else {
      tallies.admitted += 1;
    }
  }

  const notRunStarting = Object.values(tallies.notRunStartingByStatus).reduce(
    (sum, count) => sum + count,
    0,
  );
  const classified = tallies.wakesScanned - tallies.alreadySkipped - notRunStarting;
  const suppressedTotal =
    tallies.suppressedByReason[SUPPRESSION_REASON_AUTOMATION_NO_MARKER] +
    tallies.suppressedByReason[SUPPRESSION_REASON_DEBOUNCED] +
    tallies.suppressedByReason[SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES];

  return {
    wakesScanned: tallies.wakesScanned,
    alreadySkipped: tallies.alreadySkipped,
    notRunStarting,
    notRunStartingByStatus: tallies.notRunStartingByStatus,
    classified,
    admitted: tallies.admitted,
    suppressedTotal,
    suppressedByReason: tallies.suppressedByReason,
    projectedRunReduction: classified > 0 ? Number((suppressedTotal / classified).toFixed(4)) : 0,
    humanWakesSeen: tallies.humanWakesSeen,
    humanWakesSuppressed: tallies.humanWakesSuppressed,
    suppressedWakeSample: tallies.suppressedWakeSample,
  };
}
