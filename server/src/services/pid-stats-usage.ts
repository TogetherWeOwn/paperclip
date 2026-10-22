import { parseObject } from "../adapters/utils.js";

/**
 * Mirror the per-run PID accounting from an adapter resultJson into a
 * usageJson spread. Returns `{ pidStats }` when the adapter carried the
 * accounting through, otherwise an empty object so usage rows stay clean.
 * Split out from heartbeat.ts so the mirror key is pinned by unit test.
 */
export function selectPidStatsForUsageJson(
  resultJson: unknown,
): Record<string, unknown> {
  const pidStats = parseObject(resultJson).pidStats ?? null;
  return pidStats ? { pidStats } : {};
}
