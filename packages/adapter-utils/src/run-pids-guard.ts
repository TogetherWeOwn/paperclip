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
 * - Poll (always on Linux): the run's tree is counted from /proc at a short
 *   interval; on exceed the tree is SIGTERM/SIGKILLed and the run fails with
 *   the typed code. Needs no privileges.
 * - cgroup v2 (opportunistic): when PAPERCLIP_RUN_CGROUP_PARENT points at a
 *   writable delegated subtree with the pids controller enabled, the run's
 *   child is moved into a per-run child cgroup with pids.max set. The server
 *   cannot create this delegation itself (/sys/fs/cgroup is read-only for
 *   the service user), so this layer is best-effort and never throws.
 *
 * Counting rules (all three match the kernel pids-controller accounting the
 * incident filled):
 * - Threads count: the pids cgroup charges tasks, not thread-group leaders,
 *   so each member contributes its stat num_threads.
 * - Descendants count: sandboxed runs (bwrap --new-session) and setsid'd or
 *   reparented children leave the wrapper's process group, so members of the
 *   group plus all descendants of the spawned leader are attributed to the run.
 * - One shared scan: every live guard is served by a single /proc pass per
 *   tick (plus its own immediate first sample), so dozens of concurrent runs
 *   cost one scan per interval instead of one scan per run per interval.
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
  /** Highest sampled run-tree size (threads) during the run. */
  peak: number;
  /** Most recent sampled run-tree size, threads (0 when unmeasurable). */
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

export interface ProcStatFields {
  ppid: number;
  pgrp: number;
  numThreads: number;
}

/**
 * Parse the ppid/pgrp/num_threads fields from one /proc/<pid>/stat line. The
 * comm field may contain spaces and parens, so anchor on the LAST ")":
 * everything after is ` state ppid pgrp ... num_threads ...`. num_threads
 * defaults to 1 when the line is truncated (real kernel lines always carry
 * all 52 fields).
 */
export function parseStatFields(statLine: string): ProcStatFields | null {
  const close = statLine.lastIndexOf(")");
  if (close === -1) return null;
  const fields = statLine.slice(close + 1).trim().split(/\s+/);
  // fields[0] = state, fields[1] = ppid, fields[2] = pgrp,
  // fields[17] = num_threads.
  if (fields.length < 3) return null;
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  const pgrp = Number.parseInt(fields[2] ?? "", 10);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgrp)) return null;
  const rawThreads =
    fields.length > 17 ? Number.parseInt(fields[17] ?? "", 10) : Number.NaN;
  const numThreads =
    Number.isInteger(rawThreads) && (rawThreads as number) >= 1
      ? (rawThreads as number)
      : 1;
  return { ppid, pgrp, numThreads };
}

/**
 * Parse the pgrp field from one /proc/<pid>/stat line. Kept as a thin
 * wrapper for callers that only need the group.
 */
export function parseStatProcessGroup(statLine: string): number | null {
  return parseStatFields(statLine)?.pgrp ?? null;
}

export interface ProcEntry {
  pid: number;
  ppid: number;
  pgrp: number;
  /** Thread-group size from stat num_threads (>= 1). */
  threads: number;
}

/**
 * One /proc pass returning every readable process entry. Throws when the
 * root itself is unreadable; individual entries that vanish mid-scan are
 * skipped. Zombies are included: they still hold PIDs against the cgroup
 * budget until reaped.
 */
export function scanProcessEntries(procRoot = "/proc"): ProcEntry[] {
  const entries: ProcEntry[] = [];
  const names = readdirSync(procRoot);
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let stat: string;
    try {
      stat = readFileSync(path.join(procRoot, name, "stat"), "utf8");
    } catch {
      continue;
    }
    const fields = parseStatFields(stat);
    if (!fields) continue;
    entries.push({
      pid,
      ppid: fields.ppid,
      pgrp: fields.pgrp,
      threads: fields.numThreads,
    });
  }
  return entries;
}

/**
 * Attribute scanned entries to one run: members of its process group plus
 * all descendants of the spawned leader (bwrap --new-session, setsid, and
 * daemon double-forks all leave the wrapper group but stay descendants).
 * The count is thread-weighted to match pids-cgroup accounting. Pure: no I/O,
 * so the shared scanner calls it once per live guard per tick.
 */
export function countRunTree(input: {
  entries: readonly ProcEntry[];
  processGroupId?: number | null;
  rootPid?: number | null;
}): { count: number; pids: number[] } {
  const { entries } = input;
  const pgid = input.processGroupId ?? null;
  const rootPid = input.rootPid ?? null;
  const inTree = new Set<number>();
  if (typeof rootPid === "number" && rootPid > 0) {
    const children = new Map<number, number[]>();
    for (const entry of entries) {
      const list = children.get(entry.ppid);
      if (list) list.push(entry.pid);
      else children.set(entry.ppid, [entry.pid]);
    }
    const queue = [rootPid];
    inTree.add(rootPid);
    while (queue.length > 0) {
      const current = queue.pop() as number;
      const kids = children.get(current);
      if (!kids) continue;
      for (const kid of kids) {
        if (inTree.has(kid)) continue;
        inTree.add(kid);
        queue.push(kid);
      }
    }
  }
  let count = 0;
  const pids: number[] = [];
  for (const entry of entries) {
    if (entry.pgrp === pgid || inTree.has(entry.pid)) {
      count += entry.threads;
      pids.push(entry.pid);
    }
  }
  return { count, pids };
}

/**
 * Count the live tasks (threads) in a process group with one /proc pass.
 * Zombies count: they still hold PIDs against the cgroup budget until reaped.
 * Returns null off Linux or when /proc is unreadable (caller disables polling
 * and reports enforced "none" rather than failing the run). Group-only: use
 * {@link countRunTree} to also cover descendants that left the group.
 */
export function countProcessesInGroup(
  pgid: number,
  opts: { procRoot?: string } = {},
): number | null {
  if (process.platform !== "linux") return null;
  if (!Number.isInteger(pgid) || pgid <= 0) return null;
  let entries: ProcEntry[];
  try {
    entries = scanProcessEntries(opts.procRoot ?? "/proc");
  } catch {
    return null;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.pgrp === pgid) count += entry.threads;
  }
  return count;
}

/**
 * Read the cgroup v2 pids.events "max" counter: how many times the kernel
 * refused a fork/clone in this cgroup. Null when unreadable or unparsable.
 */
export function readCgroupPidsMaxEvents(cgroupPath: string): number | null {
  try {
    const text = readFileSync(path.join(cgroupPath, "pids.events"), "utf8");
    const match = /^max\s+(\d+)\s*$/m.exec(text);
    if (!match) return null;
    const value = Number.parseInt(match[1] ?? "", 10);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
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
  /**
   * Spawned leader pid. Descendants of the leader count toward the run even
   * when they left the wrapper's process group (bwrap --new-session, setsid).
   */
  rootPid?: number | null;
  limit: number;
  intervalMs?: number;
  /** True when tryAttachRunPidsCgroup succeeded for this run. */
  cgroupAttached?: boolean;
  /** Per-run cgroup dir from tryAttachRunPidsCgroup (pids.events trigger). */
  cgroupPath?: string | null;
  onExceeded: (stats: RunPidsStats) => void;
}

export interface RunPidsGuard {
  stop: () => RunPidsStats;
  getStats: () => RunPidsStats;
  /** Pids matched to this run by the last sample ([] after stop). */
  getTreePids: () => number[];
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

interface GuardRegistration {
  processGroupId: number;
  rootPid: number | null;
  limit: number;
  intervalMs: number;
  cgroupAttached: boolean;
  cgroupPath: string | null;
  onExceeded: (stats: RunPidsStats) => void;
  stats: RunPidsStats;
  lastSampleAt: number;
  lastTreePids: number[];
  stopped: boolean;
}

const guardRegistrations = new Map<string, GuardRegistration>();
let sharedScannerTimer: NodeJS.Timeout | null = null;
let sharedScannerScans = 0;

/**
 * Shared-scanner telemetry: live guard count and total /proc passes. The
 * scans counter proves the fan-out (one pass per tick for all guards) during
 * the staging soak.
 */
export function getRunPidsSharedScannerStats(): {
  activeGuards: number;
  scansPerformed: number;
} {
  return {
    activeGuards: guardRegistrations.size,
    scansPerformed: sharedScannerScans,
  };
}

function evaluateGuardWithEntries(
  reg: GuardRegistration,
  entries: readonly ProcEntry[],
  now: number,
): void {
  if (reg.stopped || reg.stats.exceeded) return;
  const { count, pids } = countRunTree({
    entries,
    processGroupId: reg.processGroupId,
    rootPid: reg.rootPid,
  });
  reg.lastSampleAt = now;
  reg.lastTreePids = pids;
  reg.stats.lastCount = count;
  if (count > reg.stats.peak) reg.stats.peak = count;
  let exceeded = count > reg.limit;
  if (!exceeded && reg.cgroupAttached) {
    // With pids.max = limit the kernel refuses forks at the cap, so a poll
    // of `count > limit` can never fire. The precise trigger is the cgroup's
    // max-event counter; when it is unreadable, count >= limit approximates
    // the capped state (a healthy run never sits exactly at its budget).
    const events = reg.cgroupPath
      ? readCgroupPidsMaxEvents(reg.cgroupPath)
      : null;
    exceeded = events !== null ? events > 0 : count >= reg.limit;
  }
  if (!exceeded) return;
  reg.stats.exceeded = true;
  try {
    reg.onExceeded({ ...reg.stats });
  } catch {
    // The kill path must never throw out of the sampler.
  }
}

function rescheduleSharedScanner(): void {
  if (sharedScannerTimer) {
    clearInterval(sharedScannerTimer);
    sharedScannerTimer = null;
  }
  if (guardRegistrations.size === 0) return;
  let interval = DEFAULT_RUN_PID_GUARD_INTERVAL_MS;
  for (const reg of guardRegistrations.values()) {
    if (reg.intervalMs < interval) interval = reg.intervalMs;
  }
  sharedScannerTimer = setInterval(() => {
    let entries: ProcEntry[];
    try {
      entries = scanProcessEntries("/proc");
    } catch {
      return;
    }
    sharedScannerScans += 1;
    const now = Date.now();
    for (const reg of guardRegistrations.values()) {
      try {
        if (now - reg.lastSampleAt < reg.intervalMs) continue;
        evaluateGuardWithEntries(reg, entries, now);
      } catch {
        continue;
      }
    }
  }, interval);
  if (typeof (sharedScannerTimer as unknown as { unref?: () => void }).unref === "function") {
    (sharedScannerTimer as unknown as { unref: () => void }).unref();
  }
}

/**
 * Poll the run's tree until stop(). Calls onExceeded exactly once when the
 * sampled size first exceeds limit; the caller owns the kill. Sampling is
 * fanned out from one shared /proc scan per tick (each guard keeps its own
 * cadence); the shared timer is unref'd so it never holds the server loop.
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
      getTreePids: () => [],
    };
  }

  const rootPid =
    typeof input.rootPid === "number" && input.rootPid > 0
      ? input.rootPid
      : null;
  const reg: GuardRegistration = {
    processGroupId: input.processGroupId as number,
    rootPid,
    limit,
    intervalMs: input.intervalMs ?? DEFAULT_RUN_PID_GUARD_INTERVAL_MS,
    cgroupAttached: input.cgroupAttached === true,
    cgroupPath: input.cgroupPath ?? null,
    onExceeded: input.onExceeded,
    stats,
    lastSampleAt: 0,
    lastTreePids: [],
    stopped: false,
  };
  // Sample immediately so a run that spawns its whole tree in the first
  // few milliseconds is caught before the first shared tick.
  try {
    evaluateGuardWithEntries(reg, scanProcessEntries("/proc"), Date.now());
  } catch {
    // A failed first sample degrades to the shared ticks, never to a run
    // failure.
  }
  guardRegistrations.set(input.runId, reg);
  rescheduleSharedScanner();
  return {
    stop: () => {
      reg.stopped = true;
      reg.lastTreePids = [];
      guardRegistrations.delete(input.runId);
      liveRunPids.delete(input.runId);
      rescheduleSharedScanner();
      return getStats();
    },
    getStats,
    getTreePids: () => (reg.stopped ? [] : [...reg.lastTreePids]),
  };
}
