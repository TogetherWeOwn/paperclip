/**
 * Replay comment-wake suppression over real wake history (CLI wrapper).
 *
 * The replay itself lives in `server/src/services/wake-suppression-replay.ts`
 * so it resolves workspace dependencies from the server package. This file
 * only parses flags, connects, prints, and sets the exit code.
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

import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { replayWakeSuppression } from "../server/src/services/wake-suppression-replay.js";
import {
  COMMENT_WAKE_DEBOUNCE_MINUTES_DEFAULT,
  WAKE_RECENT_RUN_GUARD_MINUTES_DEFAULT,
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

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim() ||
    config.databaseUrl ||
    `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const hours = Math.min(parsePositiveInt(parseFlag("--hours"), 24), 24 * 7);
  const limit = parsePositiveInt(parseFlag("--limit"), 2000);
  const debounceMinutes = parsePositiveInt(
    parseFlag("--debounce-minutes"),
    COMMENT_WAKE_DEBOUNCE_MINUTES_DEFAULT,
  );
  const guardMinutes = parsePositiveInt(
    parseFlag("--guard-minutes"),
    WAKE_RECENT_RUN_GUARD_MINUTES_DEFAULT,
  );
  const companyIds = parseRepeatedFlag("--company");
  const asJson = process.argv.includes("--json");

  const db = createDb(dbUrl);
  try {
    const report = await replayWakeSuppression(db, {
      windowStart: new Date(Date.now() - hours * 3_600_000),
      limit,
      debounceMs: debounceMinutes * 60_000,
      guardMs: guardMinutes * 60_000,
      companyIds,
    });

    if (asJson) {
      console.log(
        JSON.stringify(
          { windowHours: hours, debounceMinutes, guardMinutes, ...report },
          null,
          2,
        ),
      );
    } else {
      console.log(`Wake-suppression replay (last ${hours}h, limit ${limit})`);
      console.log(`- wakes scanned:            ${report.wakesScanned}`);
      console.log(`- already skipped (old):    ${report.alreadySkipped}`);
      console.log(`- not run-starting:         ${report.notRunStarting}`);
      for (const [status, count] of Object.entries(report.notRunStartingByStatus)) {
        console.log(`    - ${status}: ${count}`);
      }
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
        console.log("- sample suppressed wakes (ids only, no bodies):");
        for (const sample of report.suppressedWakeSample) {
          console.log(`    - ${sample.wakeId} [${sample.reason}] comment ${sample.commentId}`);
        }
      }
    }

    if (report.humanWakesSuppressed > 0) {
      console.error(
        `FAIL: ${report.humanWakesSuppressed} human/owner wake(s) would be suppressed. Refusing.`,
      );
      process.exitCode = 1;
    }
  } finally {
    // Gate-shaped CLI: close the pool so the process exits promptly with its
    // verdict instead of lingering on idle sockets.
    await db.$client.end().catch(() => {});
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Wake-suppression replay failed: ${message}`);
  process.exitCode = 1;
});
