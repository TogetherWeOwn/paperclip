/**
 * Replay comment-wake suppression over real wake history.
 *
 * Reads `issue_commented` wakeup requests from the last N hours, reconstructs
 * the inputs the `enqueueWakeup` suppression gate would have seen (triggering
 * comment author/body, last finished run, human comments and activity since),
 * and applies the same pure evaluators the gate uses. Reports how many runs
 * the new rules would have prevented and fails closed if any human/owner wake
 * would have been suppressed.
 *
 * Usage (operator step against a staging or snapshot database):
 *
 *   DATABASE_URL=postgres://... tsx scripts/replay-wake-suppression.ts \
 *     --company <company-id> --hours 24
 *
 * Flags:
 *   --company <id>        Restrict to one company (repeatable). Default: all.
 *   --hours <n>           Lookback window (default 24, max 168).
 *   --limit <n>           Max wakes to replay (default 2000).
 *   --debounce-minutes N  Override rule-2 window (default 5).
 *   --guard-minutes M     Override rule-3 window (default 10).
 *   --json                Machine-readable output.
 *
 * Exit code is 1 when any human/owner wake would be suppressed, or on error.
 * The projected run reduction is reported honestly; it is not an exit-code
 * gate (acceptance target: >= 30% fewer runs on 24h of real wakes).
 */

import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  createDb,
  heartbeatRuns,
  issueComments,
} from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import {
  COMMENT_WAKE_DEBOUNCE_MINUTES_DEFAULT,
  NON_COMMENT_NEW_INPUT_ACTIVITY_ACTIONS,
  SUPPRESSION_REASON_AUTOMATION_NO_MARKER,
  SUPPRESSION_REASON_DEBOUNCED,
  SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES,
  WAKE_RECENT_RUN_GUARD_MINUTES_DEFAULT,
  evaluateAutomationCommentSkip,
  evaluateCommentWakeDebounce,
  evaluateRecentRunGuard,
  findActionableCommentMarkers,
  isAutomationCommentAuthor,
  isCommentWakeSuppressionCandidate,
} from "../server/src/services/comment-wake-suppression.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function parseRepeatedFlag(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) {
      const value = process.argv[index + 1];
      if (value && !value.startsWith("--")) values.push(value);
    }
  }
  return values;
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface ReplayTallies {
  wakesScanned: number;
  alreadySkipped: number;
  noCommentId: number;
  notCandidate: number;
  commentMissing: number;
  admitted: number;
  suppressedByReason: Record<string, number>;
  humanWakesSeen: number;
  humanWakesSuppressed: number;
  suppressedWakeSample: Array<{
    wakeId: string;
    reason: string;
    commentId: string;
    bodyPrefix: string;
  }>;
}

function emptyTallies(): ReplayTallies {
  return {
    wakesScanned: 0,
    alreadySkipped: 0,
    noCommentId: 0,
    notCandidate: 0,
    commentMissing: 0,
    admitted: 0,
    suppressedByReason: {
      [SUPPRESSION_REASON_AUTOMATION_NO_MARKER]: 0,
      [SUPPRESSION_REASON_DEBOUNCED]: 0,
      [SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES]: 0,
    },
    humanWakesSeen: 0,
    humanWakesSuppressed: 0,
    suppressedWakeSample: [],
  };
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim() ||
    config.databaseUrl ||
    `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const hours = Math.min(parsePositiveInt(parseFlag("--hours"), 24), 24 * 7);
  const limit = parsePositiveInt(parseFlag("--limit"), 2000);
  const debounceMs =
    parsePositiveInt(parseFlag("--debounce-minutes"), COMMENT_WAKE_DEBOUNCE_MINUTES_DEFAULT) * 60_000;
  const guardMs =
    parsePositiveInt(parseFlag("--guard-minutes"), WAKE_RECENT_RUN_GUARD_MINUTES_DEFAULT) * 60_000;
  const companyIds = parseRepeatedFlag("--company");
  const asJson = process.argv.includes("--json");

  const db = createDb(dbUrl);
  const windowStart = new Date(Date.now() - hours * 3_600_000);
  const tallies = emptyTallies();

  const wakeRows = await db
    .select({
      id: agentWakeupRequests.id,
      companyId: agentWakeupRequests.companyId,
      agentId: agentWakeupRequests.agentId,
      reason: agentWakeupRequests.reason,
      status: agentWakeupRequests.status,
      payload: agentWakeupRequests.payload,
      requestedByActorType: agentWakeupRequests.requestedByActorType,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.reason, "issue_commented"),
        gte(agentWakeupRequests.requestedAt, windowStart),
        companyIds.length > 0 ? inArray(agentWakeupRequests.companyId, companyIds) : undefined,
      ),
    )
    .orderBy(agentWakeupRequests.requestedAt)
    .limit(limit);

  for (const wake of wakeRows) {
    tallies.wakesScanned += 1;
    if (wake.status === "skipped") {
      tallies.alreadySkipped += 1;
      continue;
    }
    const payload = (wake.payload ?? {}) as Record<string, unknown>;
    const commentId = typeof payload.commentId === "string" ? payload.commentId : null;
    const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
    if (!commentId || !issueId) {
      tallies.noCommentId += 1;
      continue;
    }
    // allowRunCoalescing is not persisted on the wake row; the replay cannot
    // observe causally-isolated wakes, so it treats every row as coalescible.
    // That can only over-count suppression for those rare rows, never hide a
    // human wake (human content bypasses every rule below).
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
    });
    if (!candidate) {
      tallies.notCandidate += 1;
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
      .where(and(eq(issueComments.companyId, wake.companyId), eq(issueComments.id, commentId)))
      .limit(1);
    const comment = commentRows[0] ?? null;
    if (!comment || comment.deletedAt) {
      tallies.commentMissing += 1;
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
          lastRunFinishedAtMs: lastRunFinishedAt.getTime(),
          lastRunSucceeded,
          debounceMs,
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
            lastRunFinishedAtMs: lastRunFinishedAt.getTime(),
            lastRunSucceeded,
            guardMs,
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
          bodyPrefix: comment.body.slice(0, 120),
        });
      }
    } else {
      tallies.admitted += 1;
    }
  }

  const ranWakes = tallies.wakesScanned - tallies.alreadySkipped;
  const suppressedTotal =
    tallies.suppressedByReason[SUPPRESSION_REASON_AUTOMATION_NO_MARKER] +
    tallies.suppressedByReason[SUPPRESSION_REASON_DEBOUNCED] +
    tallies.suppressedByReason[SUPPRESSION_REASON_RECENT_RUN_NO_CHANGES];
  const projectedReduction = ranWakes > 0 ? suppressedTotal / ranWakes : 0;

  const report = {
    windowHours: hours,
    wakesScanned: tallies.wakesScanned,
    alreadySkipped: tallies.alreadySkipped,
    classified: ranWakes,
    admitted: tallies.admitted,
    suppressedTotal,
    suppressedByReason: tallies.suppressedByReason,
    projectedRunReduction: Number(projectedReduction.toFixed(4)),
    humanWakesSeen: tallies.humanWakesSeen,
    humanWakesSuppressed: tallies.humanWakesSuppressed,
    debounceMinutes: debounceMs / 60_000,
    guardMinutes: guardMs / 60_000,
    suppressedWakeSample: tallies.suppressedWakeSample,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Wake-suppression replay (last ${hours}h, limit ${limit})`);
    console.log(`- wakes scanned:            ${report.wakesScanned}`);
    console.log(`- already skipped (old):    ${report.alreadySkipped}`);
    console.log(`- classified:               ${report.classified}`);
    console.log(`- admitted:                 ${report.admitted}`);
    console.log(`- would suppress:           ${report.suppressedTotal}`);
    for (const [reason, count] of Object.entries(report.suppressedByReason)) {
      console.log(`    - ${reason}: ${count}`);
    }
    console.log(
      `- projected run reduction:  ${(report.projectedRunReduction * 100).toFixed(1)}% (target >= 30%)`,
    );
    console.log(
      `- human/owner wakes:        ${report.humanWakesSeen} seen, ${report.humanWakesSuppressed} suppressed (required 0)`,
    );
    if (report.suppressedWakeSample.length > 0) {
      console.log("- sample suppressed wakes:");
      for (const sample of report.suppressedWakeSample) {
        console.log(`    - ${sample.wakeId} [${sample.reason}] ${JSON.stringify(sample.bodyPrefix)}`);
      }
    }
  }

  if (tallies.humanWakesSuppressed > 0) {
    console.error(
      `FAIL: ${tallies.humanWakesSuppressed} human/owner wake(s) would be suppressed. Refusing.`,
    );
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Wake-suppression replay failed: ${message}`);
  process.exitCode = 1;
});
