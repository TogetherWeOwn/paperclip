import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countProcessesInGroup,
  DEFAULT_RUN_PID_GUARD_INTERVAL_MS,
  DEFAULT_RUN_PID_LIMIT,
  getLiveRunPidsSnapshot,
  MAX_RUN_PID_GUARD_INTERVAL_MS,
  MAX_RUN_PID_LIMIT,
  MIN_RUN_PID_GUARD_INTERVAL_MS,
  MIN_RUN_PID_LIMIT,
  parseStatProcessGroup,
  resolveRunPidGuardIntervalMs,
  resolveRunPidLimit,
  RUN_PID_GUARD_INTERVAL_ENV_KEY,
  RUN_PID_LIMIT_ENV_KEY,
  startRunPidsGuard,
  tryAttachRunPidsCgroup,
} from "./run-pids-guard.js";

const isLinux = process.platform === "linux";

describe("resolveRunPidLimit", () => {
  const saved = process.env[RUN_PID_LIMIT_ENV_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[RUN_PID_LIMIT_ENV_KEY];
    else process.env[RUN_PID_LIMIT_ENV_KEY] = saved;
  });

  it("defaults to 512", () => {
    delete process.env[RUN_PID_LIMIT_ENV_KEY];
    expect(resolveRunPidLimit(undefined)).toBe(DEFAULT_RUN_PID_LIMIT);
    expect(DEFAULT_RUN_PID_LIMIT).toBe(512);
  });

  it("accepts explicit numbers and numeric strings", () => {
    expect(resolveRunPidLimit(100)).toBe(100);
    expect(resolveRunPidLimit("256")).toBe(256);
  });

  it("clamps to the safe floor and ceiling", () => {
    expect(resolveRunPidLimit(1)).toBe(MIN_RUN_PID_LIMIT);
    expect(resolveRunPidLimit(0)).toBe(MIN_RUN_PID_LIMIT);
    expect(resolveRunPidLimit(-5)).toBe(MIN_RUN_PID_LIMIT);
    expect(resolveRunPidLimit(100_000)).toBe(MAX_RUN_PID_LIMIT);
    expect(MIN_RUN_PID_LIMIT).toBe(32);
    expect(MAX_RUN_PID_LIMIT).toBe(4096);
  });

  it("falls back to the default for non-numeric input", () => {
    delete process.env[RUN_PID_LIMIT_ENV_KEY];
    expect(resolveRunPidLimit(null)).toBe(DEFAULT_RUN_PID_LIMIT);
    expect(resolveRunPidLimit("unlimited")).toBe(DEFAULT_RUN_PID_LIMIT);
    expect(resolveRunPidLimit({})).toBe(DEFAULT_RUN_PID_LIMIT);
    expect(resolveRunPidLimit(Number.NaN)).toBe(DEFAULT_RUN_PID_LIMIT);
    expect(resolveRunPidLimit(12.5)).toBe(DEFAULT_RUN_PID_LIMIT);
  });

  it("honors the env override when no explicit value is given", () => {
    process.env[RUN_PID_LIMIT_ENV_KEY] = "128";
    expect(resolveRunPidLimit(undefined)).toBe(128);
    expect(resolveRunPidLimit(200)).toBe(200);
    process.env[RUN_PID_LIMIT_ENV_KEY] = "99999";
    expect(resolveRunPidLimit(undefined)).toBe(MAX_RUN_PID_LIMIT);
  });
});

describe("resolveRunPidGuardIntervalMs", () => {
  const saved = process.env[RUN_PID_GUARD_INTERVAL_ENV_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[RUN_PID_GUARD_INTERVAL_ENV_KEY];
    else process.env[RUN_PID_GUARD_INTERVAL_ENV_KEY] = saved;
  });

  it("defaults to 1000ms and clamps", () => {
    delete process.env[RUN_PID_GUARD_INTERVAL_ENV_KEY];
    expect(resolveRunPidGuardIntervalMs(undefined)).toBe(
      DEFAULT_RUN_PID_GUARD_INTERVAL_MS,
    );
    expect(resolveRunPidGuardIntervalMs(1)).toBe(MIN_RUN_PID_GUARD_INTERVAL_MS);
    expect(resolveRunPidGuardIntervalMs(60_000)).toBe(
      MAX_RUN_PID_GUARD_INTERVAL_MS,
    );
  });
});

describe("parseStatProcessGroup", () => {
  it("parses a normal stat line", () => {
    expect(parseStatProcessGroup("1234 (node) S 1000 1234 0 0 0")).toBe(1234);
  });

  it("anchors on the last paren when comm has spaces and parens", () => {
    expect(
      parseStatProcessGroup("99 (my (weird) proc) R 1 4242 0 0 0"),
    ).toBe(4242);
  });

  it("returns null for malformed input", () => {
    expect(parseStatProcessGroup("")).toBeNull();
    expect(parseStatProcessGroup("no parens here")).toBeNull();
    expect(parseStatProcessGroup("1 (x) S")).toBeNull();
  });
});

describe("countProcessesInGroup", () => {
  it.runIf(isLinux)("counts a spawned fixture tree in its own group", async () => {
    const child = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    const pgid = child.pid as number;
    try {
      let count: number | null = null;
      for (let i = 0; i < 50 && (count === null || count < 3); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        count = countProcessesInGroup(pgid);
      }
      expect(count).toBeGreaterThanOrEqual(3);
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Already gone.
      }
      child.unref();
    }
  });

  it.runIf(isLinux)("returns 0 for an unused group and null for bad input", () => {
    expect(countProcessesInGroup(4194302)).toBe(0);
    expect(countProcessesInGroup(-1)).toBeNull();
    expect(countProcessesInGroup(Number.NaN)).toBeNull();
  });

  it("supports an injected proc root for deterministic tests", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pids-guard-proc-"));
    mkdirSync(path.join(root, "10"));
    mkdirSync(path.join(root, "11"));
    mkdirSync(path.join(root, "self"));
    writeFileSync(path.join(root, "10", "stat"), "10 (a) S 1 77 0 0 0");
    writeFileSync(path.join(root, "11", "stat"), "11 (b) S 1 78 0 0 0");
    if (!isLinux) {
      expect(countProcessesInGroup(77, { procRoot: root })).toBeNull();
      return;
    }
    expect(countProcessesInGroup(77, { procRoot: root })).toBe(1);
    expect(countProcessesInGroup(78, { procRoot: root })).toBe(1);
    expect(countProcessesInGroup(79, { procRoot: root })).toBe(0);
  });

  it.runIf(!isLinux)("returns null off Linux", () => {
    expect(countProcessesInGroup(process.pid)).toBeNull();
  });
});

describe("tryAttachRunPidsCgroup", () => {
  const saved = process.env.PAPERCLIP_RUN_CGROUP_PARENT;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCLIP_RUN_CGROUP_PARENT;
    else process.env.PAPERCLIP_RUN_CGROUP_PARENT = saved;
  });

  it("returns null without a delegated parent (the production default)", () => {
    delete process.env.PAPERCLIP_RUN_CGROUP_PARENT;
    expect(tryAttachRunPidsCgroup(process.pid, 64)).toBeNull();
  });

  it("returns null for invalid pids and missing parents", () => {
    expect(
      tryAttachRunPidsCgroup(-1, 64, { parentDir: os.tmpdir() }),
    ).toBeNull();
    expect(
      tryAttachRunPidsCgroup(process.pid, 64, {
        parentDir: path.join(os.tmpdir(), "pids-guard-no-such-dir"),
      }),
    ).toBeNull();
  });

  it("writes pids.max and claims the pid under a fake parent", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "pids-guard-cg-"));
    const attached = tryAttachRunPidsCgroup(4242, 96, {
      runId: "test-run",
      parentDir: parent,
    });
    expect(attached).not.toBeNull();
    expect(readFileSync(path.join(attached!.path, "pids.max"), "utf8")).toBe(
      "96\n",
    );
    expect(
      readFileSync(path.join(attached!.path, "cgroup.procs"), "utf8"),
    ).toBe("4242\n");
    // Cleanup is best-effort rmdir (the real-cgroup semantic): under a fake
    // parent with regular files it no-ops instead of throwing, and repeats
    // are safe.
    expect(() => attached!.cleanup()).not.toThrow();
    expect(() => attached!.cleanup()).not.toThrow();
  });
});

describe("startRunPidsGuard", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      child.unref();
    }
  });

  it.runIf(isLinux)("fires onExceeded once when the group passes the limit", async () => {
    const child = spawn("sh", ["-c", "sleep 30 & sleep 30 & sleep 30 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    children.push(child);
    const pgid = child.pid as number;
    const seen: number[] = [];
    const guard = startRunPidsGuard({
      runId: `guard-test-${Date.now()}`,
      processGroupId: pgid,
      limit: 2,
      intervalMs: 25,
      onExceeded: (stats) => {
        seen.push(stats.lastCount);
      },
    });
    try {
      for (let i = 0; i < 100 && seen.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(seen.length).toBe(1);
      expect(seen[0]).toBeGreaterThanOrEqual(3);
      const stats = guard.getStats();
      expect(stats.exceeded).toBe(true);
      expect(stats.peak).toBeGreaterThanOrEqual(3);
      expect(stats.limit).toBe(2);
      expect(stats.enforced).toBe("poll");
    } finally {
      guard.stop();
    }
  });

  it.runIf(isLinux)("exposes live samples until stopped", async () => {
    const child = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
    });
    children.push(child);
    const runId = `guard-live-${Date.now()}`;
    const guard = startRunPidsGuard({
      runId,
      processGroupId: child.pid as number,
      limit: 4096,
      intervalMs: 25,
      onExceeded: () => {},
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const live = getLiveRunPidsSnapshot().find((s) => s.runId === runId);
      expect(live).toBeDefined();
      expect(live!.limit).toBe(4096);
      expect(live!.exceeded).toBe(false);
    } finally {
      guard.stop();
    }
    expect(
      getLiveRunPidsSnapshot().some((s) => s.runId === runId),
    ).toBe(false);
  });

  it("reports enforced none without a process group", () => {
    const guard = startRunPidsGuard({
      runId: `guard-nopg-${Date.now()}`,
      processGroupId: null,
      limit: 64,
      onExceeded: () => {
        throw new Error("must not fire without a group");
      },
    });
    const stats = guard.stop();
    expect(stats.enforced).toBe("none");
    expect(stats.exceeded).toBe(false);
  });
});
