/**
 * `wakes_suppressed_total{reason}` — counter sink for comment-wake suppression.
 *
 * This repo has no Prometheus client; the established metrics sink is the
 * `tool_runtime_metric_counters` table (company-scoped, per-minute buckets),
 * written by `incrementToolRuntimeMetricCounter`. Wake-suppression counts
 * reuse that sink under `wake_suppressed:<reason>` metric names so operators
 * keep one aggregation path:
 *
 *   SELECT metric, date_trunc('hour', bucket_start_at) AS hour, sum(count)
 *   FROM tool_runtime_metric_counters
 *   WHERE metric LIKE 'wake_suppressed:%'
 *   GROUP BY 1, 2 ORDER BY 2, 1;
 *
 * The skipped-wake receipts (`agent_wakeup_requests` rows with
 * `reason = 'comment_wake_suppressed'` and a `payload.wakeSuppression`
 * object) remain the per-wake machine-readable record; the counter is the
 * cheap aggregate. Counter writes are always best-effort: a metrics failure
 * must never break a wake.
 */

import type { Db } from "@paperclipai/db";
import { incrementToolRuntimeMetricCounter } from "./tool-runtime-metrics.js";

export const WAKE_SUPPRESSED_METRIC_PREFIX = "wake_suppressed:";

export function wakeSuppressedMetricName(reason: string): string {
  return `${WAKE_SUPPRESSED_METRIC_PREFIX}${reason}`;
}

export async function recordWakeSuppressed(
  db: Db,
  input: { companyId: string; reason: string; at?: Date },
): Promise<void> {
  await incrementToolRuntimeMetricCounter(db, {
    companyId: input.companyId,
    metric: wakeSuppressedMetricName(input.reason),
    at: input.at,
  });
}

/** Best-effort wrapper: logs and swallows failures so wakes never break. */
export async function recordWakeSuppressedBestEffort(
  db: Db,
  input: { companyId: string; reason: string; at?: Date },
): Promise<void> {
  try {
    await recordWakeSuppressed(db, input);
  } catch (error) {
    console.error("[wake-suppression-metrics] Failed to record suppression counter", {
      companyId: input.companyId,
      reason: input.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
