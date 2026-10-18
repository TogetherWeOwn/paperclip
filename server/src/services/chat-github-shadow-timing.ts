/** Operator-tunable bounds for paired (shadow) snapshot capture. Both default to
 * the historical 15 s. Values are positive integer milliseconds clamped to
 * [5 s, 300 s]; anything else (empty, non-integer, zero/negative, unsafe)
 * falls back to the default rather than disabling or unbounding capture. */
export const GITHUB_SHADOW_TIMING_DEFAULT_MS = 15_000;
export const GITHUB_SHADOW_TIMING_MIN_MS = 5_000;
export const GITHUB_SHADOW_TIMING_MAX_MS = 300_000;

export function parseGitHubShadowDurationMs(raw: string | undefined, fallback = GITHUB_SHADOW_TIMING_DEFAULT_MS): number {
  const text = raw?.trim();
  if (!text || !/^[0-9]+$/.test(text)) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(GITHUB_SHADOW_TIMING_MAX_MS, Math.max(GITHUB_SHADOW_TIMING_MIN_MS, value));
}

/** Admission-relative deadline for a paired capture (fairness window). */
export function githubShadowCaptureWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseGitHubShadowDurationMs(env.PAPERCLIP_GITHUB_SHADOW_CAPTURE_WINDOW_MS);
}

/** Hard budget for the sealed snapshot's GitHub reads, from snapshot start. */
export function githubShadowSnapshotBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseGitHubShadowDurationMs(env.PAPERCLIP_GITHUB_SHADOW_SNAPSHOT_BUDGET_MS);
}

/** A claim older than this is presumed dead and may be re-claimed. It must
 * outlive the longest legitimate capture (the window) or a live worker would be
 * fenced as "interrupted". Default stays 30 s (15 s window + 15 s margin). */
export function githubShadowCaptureClaimStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  return githubShadowCaptureWindowMs(env) + 15_000;
}
