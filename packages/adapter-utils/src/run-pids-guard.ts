import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Per-run process (PID) budget for adapter-spawned run trees.
 *
 * On 2026-10-21 a single runaway run forked ~2,150 node processes through a
 * self-recursive git shim and filled the shared container's PID cgroup
 * (16,345 of 16,384), failing ~40 unrelated runs with spawn EAGAIN. This
 * module gives each local run its own PID budget so exceeding it fails only
 * that run with {@link RUN_PID_LIMIT_EXCEEDED}.
 *
 * Two enforcement layers:
 * - Poll (always on Linux): the run's process group is counted from /proc at
 *   a short interval; on exceed the tree is SIGTERM/SIGKILLed and the run
 *   fails with the typed code. Needs no privileges.
 * - cgroup v2 (opportunistic): when PAPERCLIP_RUN_CGROUP_PARENT points at a
 *   writable delegated subtree with the pids controller enabled, the run's
 *   child is moved into a per-run child cgroup with pids.max set. The server
 *   cannot create this delegation itself (/sys/fs/cgroup is read-only for
 *   the service user), so this layer is best-effort and never throws.
 */

export const RUN_PID_LIMIT_EXCEEDED = "run_pid_limit_exceeded";

/** Default per-run process budget when no agent or env override is set. */
export const DEFAULT_RUN_PID_LIMIT = 512;
/** Floor: below this even a healthy CLI run (rg, git, gh helpers) can trip. */
export const MIN_RUN_PID_LIMIT = 32;
/**
 * Ceiling: a single run must never approach the container budget (16,384 on
 * the current hosts) on its own.
 */
export const MAX_RUN_PID_LIMIT = 4096;

export const RUN_PID_LIMIT_ENV_KEY = "PAPERCLIP_RUN_PID_LIMIT";
export const RUN_PID_GUARD_INTERVAL_ENV_KEY =
  "PAPERCLIP_RUN_PID_GUARD_INTERVAL_MS";
export const DEFAULT_RUN_PID_GUARD_INTERVAL_MS = 1000;
export const MIN_RUN_PID_GUARD_INTERVAL_MS = 50;
export const MAX_RUN_PID_GUARD_INTERVAL_MS = 10_000;

/** Delegated cgroup v2 parent for per-run pids.max children (optional). */
export const RUN_CGROUP_PARENT_ENV_KEY = "PAPERCLIP_RUN_CGROUP_PARENT";

export type RunPidsEnforcement = "poll" | "cgroup" | "cgroup+poll" | "none";

export interface RunPidsStats {
  /** Effective per-run process budget. */
  limit: number;
  /** Highest sampled process-group size during the run. */
  peak: number;
  /** Most recent sampled process-group size (0 when unmeasurable). */
  lastCount: number;
  /** Which enforcement layers were active. */
  enforced: RunPidsEnforcement;
  /** True once the budget was exceeded (the run is being stopped). */
  exceeded: boolean;
}

function parseBudgetInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function clampInt(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Resolve the effective per-run PID budget: explicit value first, then the
 * PAPERCLIP_RUN_PID_LIMIT env override, then the default. Always clamped to
 * [MIN_RUN_PID_LIMIT, MAX_RUN_PID_LIMIT] so neither a typo nor a hostile
 * agent config can disable the guard or seize the container budget.
 */
export function resolveRunPidLimit(value?: unknown): number {
  const explicit = parseBudgetInt(value);
  if (explicit !== null) {
    return clampInt(explicit, MIN_RUN_PID_LIMIT, MAX_RUN_PID_LIMIT);
  }
  const fromEnv = parseBudgetInt(process.env[RUN_PID_LIMIT_ENV_KEY]);
  if (fromEnv !== null) {
    return clampInt(fromEnv, MIN_RUN_PID_LIMIT, MAX_RUN_PID_LIMIT);
  }
  return DEFAULT_RUN_PID_LIMIT;
}

export function resolveRunPidGuardIntervalMs(value?: unknown): number {
  const explicit = parseBudgetInt(value);
  if (explicit !== null) {
    return clampInt(
      explicit,
      MIN_RUN_PID_GUARD_INTERVAL_MS,
      MAX_RUN_PID_GUARD_INTERVAL_MS,
    );
  }
  const fromEnv = parseBudgetInt(process.env[RUN_PID_GUARD_INTERVAL_ENV_KEY]);
  if (fromEnv !== null) {
    return clampInt(
      fromEnv,
      MIN_RUN_PID_GUARD_INTERVAL_MS,
      MAX_RUN_PID_GUARD_INTERVAL_MS,
    );
  }
  return DEFAULT_RUN_PID_GUARD_INTERVAL_MS;
}

/**
 * Count the live processes in a process group by scanning /proc/<pid>/stat.
 * Zombies count: they still hold PIDs against the cgroup budget until reaped.
 * Returns null off Linux or when /proc is unreadable (caller disables polling
 * and reports enforced "none" rather than failing the run).
 */
export function countProcessesInGroup(
  pgid: number,
  opts: { procRoot?: string } = {},
): number | null {
  if (process.platform !== "linux") return null;
  if (!Number.isInteger(pgid) || pgid <= 0) return null;
  const procRoot = opts.procRoot ?? "/proc";
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return null;
  }
  let count = 0;
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(path.join(procRoot, entry, "stat"), "utf8");
    } catch {
      continue;
    }
    const group = parseStatProcessGroup(stat);
    if (group === pgid) count += 1;
  }
  return count;
}

/**
 * Parse the pgrp field from one /proc/<pid>/stat line. The comm field may
 * contain spaces and parens, so anchor on the LAST ")": everything after is
 * ` state ppid pgrp ...`.
 */
export function parseStatProcessGroup(statLine: string): number | null {
  const close = statLine.lastIndexOf(")");
  if (close === -1) return null;
  const fields = statLine.slice(close + 1).trim().split(/\s+/);
  // fields[0] = state, fields[1] = ppid, fields[2] = pgrp
  if (fields.length < 3) return null;
  const pgrp = Number.parseInt(fields[2] ?? "", 10);
  return Number.isInteger(pgrp) ? pgrp : null;
}

export interface RunPidsCgroupAttachment {
  path: string;
  cleanup: () => void;
}

/**
 * Best-effort: move pid into a fresh per-run child cgroup with pids.max set.
 * Returns null unless PAPERCLIP_RUN_CGROUP_PARENT (or explicit parentDir)
 * allows creating a child with the pids controller live. Never throws: every
 * failure (read-only /sys/fs/cgroup, missing delegation, races) degrades to
 * poll-only enforcement.
 */
export function tryAttachRunPidsCgroup(
  pid: number,
  limit: number,
  opts: { runId?: string; parentDir?: string } = {},
): RunPidsCgroupAttachment | null {
  try {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const parent =
      opts.parentDir ?? process.env[RUN_CGROUP_PARENT_ENV_KEY] ?? "";
    if (!parent) return null;
    const name = `run-${opts.runId ?? pid}`;
    const dir = path.join(parent, name);
    mkdirSync(dir, { recursive: false });
    const maxFile = path.join(dir, "pids.max");
    const procsFile = path.join(dir, "cgroup.procs");
    try {
      writeFileSync(maxFile, `${limit}\n`, "utf8");
      writeFileSync(procsFile, `${pid}\n`, "utf8");
    } catch {
      try {
        rmdirSync(dir);
      } catch {
        // Best-effort cleanup only.
      }
      return null;
    }
    let cleaned = false;
    return {
      path: dir,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try {
          rmdirSync(dir);
        } catch {
          // The directory lingers only while migrated processes still run;
          // rmdir fails harmlessly then and the next attach reuses nothing.
        }
      },
    };
  } catch {
    return null;
  }
}

export interface StartRunPidsGuardInput {
  runId: string;
  processGroupId: number | null;
  limit: number;
  intervalMs?: number;
  /** True when tryAttachRunPidsCgroup succeeded for this run. */
  cgroupAttached?: boolean;
  onExceeded: (stats: RunPidsStats) => void;
}

export interface RunPidsGuard {
  stop: () => RunPidsStats;
  getStats: () => RunPidsStats;
}

const liveRunPids = new Map<string, () => RunPidsStats>();

/** Live per-run PID samples for metrics consumers (staging soak, top). */
export function getLiveRunPidsSnapshot(): Array<
  { runId: string } & RunPidsStats
> {
  const out: Array<{ runId: string } & RunPidsStats> = [];
  for (const [runId, getStats] of liveRunPids) {
    try {
      out.push({ runId, ...getStats() });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Poll the run's process group until stop(). Calls onExceeded exactly once
 * when the sampled size first exceeds limit; the caller owns the kill. The
 * timer is unref'd so it never holds the server event loop.
 */
export function startRunPidsGuard(input: StartRunPidsGuardInput): RunPidsGuard {
  // No clamp here: production callers pass resolveRunPidLimit() output, and
  // tests exercise small limits against tiny fixture trees.
  const floored = Math.floor(input.limit);
  const limit =
    Number.isFinite(floored) && floored >= 1 ? floored : DEFAULT_RUN_PID_LIMIT;
  const stats: RunPidsStats = {
    limit,
    peak: 0,
    lastCount: 0,
    enforced: input.cgroupAttached ? "cgroup" : "none",
    exceeded: false,
  };
  const canPoll =
    process.platform === "linux" &&
    typeof input.processGroupId === "number" &&
    input.processGroupId > 0;
  if (canPoll && stats.enforced === "cgroup") stats.enforced = "cgroup+poll";
  if (canPoll && stats.enforced === "none") stats.enforced = "poll";

  const getStats = (): RunPidsStats => ({ ...stats });
  liveRunPids.set(input.runId, getStats);

  if (!canPoll) {
    return {
      stop: () => {
        liveRunPids.delete(input.runId);
        return getStats();
      },
      getStats,
    };
  }

  const pgid = input.processGroupId as number;
  let stopped = false;
  const sample = () => {
    if (stopped || stats.exceeded) return;
    let count: number | null = null;
    try {
      count = countProcessesInGroup(pgid);
    } catch {
      count = null;
    }
    if (count === null) return;
    stats.lastCount = count;
    if (count > stats.peak) stats.peak = count;
    if (count > limit) {
      stats.exceeded = true;
      try {
        input.onExceeded(getStats());
      } catch {
        // The kill path must never throw out of the sampler.
      }
    }
  };
  // Sample immediately so a run that spawns its whole tree in the first
  // few milliseconds is caught before the first interval tick.
  sample();
  const timer = setInterval(sample, input.intervalMs ?? DEFAULT_RUN_PID_GUARD_INTERVAL_MS);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      liveRunPids.delete(input.runId);
      return getStats();
    },
    getStats,
  };
}
