import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countProcessesInGroup,
  RUN_PID_LIMIT_ENV_KEY,
} from "./run-pids-guard.js";
import { RUN_PID_LIMIT_EXCEEDED, runChildProcess } from "./server-utils.js";

const isLinux = process.platform === "linux";
// Unique fixture markers: no other test binary uses these sleep durations.
const FORK_MARKER = "29731";
const SETSID_MARKER = "29732";
const TRAP_MARKER = "29733";
const FORK_CHILDREN = 48;

const hasSetsid = (() => {
  if (!isLinux) return false;
  try {
    return spawnSync("setsid", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

function procCmdlinesContain(marker: string): number[] {
  const hits: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return hits;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(path.join("/proc", entry, "cmdline"), "utf8");
      if (cmdline.includes(marker)) hits.push(Number(entry));
    } catch {
      continue;
    }
  }
  return hits;
}

async function killFixtureLeftovers(): Promise<void> {
  if (!isLinux) return;
  for (const marker of [FORK_MARKER, SETSID_MARKER, TRAP_MARKER]) {
    for (const pid of procCmdlinesContain(marker)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

describe("runChildProcess per-run PID limit", () => {
  const savedEnv = {
    limit: process.env[RUN_PID_LIMIT_ENV_KEY],
    interval: process.env.PAPERCLIP_RUN_PID_GUARD_INTERVAL_MS,
    cgroup: process.env.PAPERCLIP_RUN_CGROUP_PARENT,
  };
  beforeEach(() => {
    delete process.env[RUN_PID_LIMIT_ENV_KEY];
    delete process.env.PAPERCLIP_RUN_PID_GUARD_INTERVAL_MS;
    delete process.env.PAPERCLIP_RUN_CGROUP_PARENT;
  });
  afterEach(async () => {
    if (savedEnv.limit === undefined) delete process.env[RUN_PID_LIMIT_ENV_KEY];
    else process.env[RUN_PID_LIMIT_ENV_KEY] = savedEnv.limit;
    if (savedEnv.interval === undefined) {
      delete process.env.PAPERCLIP_RUN_PID_GUARD_INTERVAL_MS;
    } else {
      process.env.PAPERCLIP_RUN_PID_GUARD_INTERVAL_MS = savedEnv.interval;
    }
    if (savedEnv.cgroup === undefined) {
      delete process.env.PAPERCLIP_RUN_CGROUP_PARENT;
    } else {
      process.env.PAPERCLIP_RUN_CGROUP_PARENT = savedEnv.cgroup;
    }
    await killFixtureLeftovers();
  });

  it("records the default budget on a normal run", async () => {
    const result = await runChildProcess(randomUUID(), "echo", ["hi"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 30,
      graceSec: 1,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.errorCode ?? null).toBeNull();
    expect(result.pidStats?.limit).toBe(512);
    expect(result.pidStats?.exceeded).toBe(false);
    expect(result.pidStats?.peak).toBeGreaterThanOrEqual(isLinux ? 1 : 0);
  });

  it.runIf(isLinux)(
    "fails only the runaway run with run_pid_limit_exceeded",
    async () => {
      // Bounded fork fixture: exactly FORK_CHILDREN short sleeps, no
      // recursion, unique marker for the afterEach backstop.
      const forkScript = [
        "const { spawn } = require('node:child_process');",
        `for (let i = 0; i < ${FORK_CHILDREN}; i += 1) {`,
        `  const c = spawn('sleep', ['${FORK_MARKER}'], { stdio: 'ignore' });`,
        "  c.unref();",
        "}",
        "setTimeout(() => {}, 60000);",
      ].join("\n");
      let forkPgid: number | null = null;
      const forkRun = runChildProcess(randomUUID(), process.execPath, ["-e", forkScript], {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 30,
        graceSec: 1,
        pidLimit: 32,
        pidGuardIntervalMs: 50,
        onLog: async () => {},
        onSpawn: async (meta) => {
          forkPgid = meta.processGroupId;
        },
      });
      // A normal run alongside the runaway must be unaffected.
      const normalRun = runChildProcess(
        randomUUID(),
        process.execPath,
        ["-e", "setTimeout(() => console.log('alongside-ok'), 1200);"],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 30,
          graceSec: 1,
          onLog: async () => {},
        },
      );
      const [forkResult, normalResult] = await Promise.all([forkRun, normalRun]);

      expect(forkResult.errorCode).toBe(RUN_PID_LIMIT_EXCEEDED);
      expect(RUN_PID_LIMIT_EXCEEDED).toBe("run_pid_limit_exceeded");
      expect(forkResult.stderr).toContain("run PID limit exceeded");
      expect(forkResult.stderr).toContain(RUN_PID_LIMIT_EXCEEDED);
      expect(forkResult.pidStats?.limit).toBe(32);
      expect(forkResult.pidStats?.exceeded).toBe(true);
      expect(forkResult.pidStats?.peak).toBeGreaterThan(32);
      expect(forkResult.pidStats?.enforced).toBe("poll");

      expect(normalResult.exitCode).toBe(0);
      expect(normalResult.errorCode ?? null).toBeNull();
      expect(normalResult.stdout).toContain("alongside-ok");
      expect(normalResult.pidStats?.exceeded).toBe(false);

      // The runaway tree is fully reaped: its process group is empty and no
      // fixture sleep survives anywhere on the box.
      if (forkPgid === null) throw new Error("fork fixture never spawned");
      expect(countProcessesInGroup(forkPgid)).toBe(0);
      expect(procCmdlinesContain(FORK_MARKER)).toEqual([]);
    },
    30_000,
  );

  it.runIf(isLinux)("honors an explicit per-agent limit", async () => {
    const result = await runChildProcess(randomUUID(), "echo", ["hi"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 30,
      graceSec: 1,
      pidLimit: 128,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.pidStats?.limit).toBe(128);
    expect(result.pidStats?.exceeded).toBe(false);
  });

  it.runIf(hasSetsid)(
    "catches runaways that escape into a new session (setsid)",
    async () => {
      // Same shape as a bwrap --new-session sandbox payload: the leader's
      // group holds only the wrapper while the tree runs in a new session.
      // The trap reaps the session synchronously so no straggler outlives
      // the kill list snapshot.
      // Self-bound at 10s: the escaped session is unreachable by
      // timeoutSec's group kill, so if fork pressure ever leaves a partial
      // tree the guard stays quiet and the fixture would hang past the
      // test timeout. The killer reaps the session from within (kill 0 is
      // the fixture's own group) so that mode fails fast and diagnosably
      // instead of hanging; healthy runs finish in ~1s and never reach it.
      // Newline-joined: a ";" join would emit "&;" after the backgrounded
      // killer, which is a sh syntax error.
      const script = [
        "trap 'kill 0; exit 0' TERM",
        "(sleep 10; kill 0) &",
        "i=0",
        `while [ $i -lt ${FORK_CHILDREN} ]; do sleep ${SETSID_MARKER} & i=$((i+1)); done`,
        "wait",
      ].join("\n");
      const result = await runChildProcess(
        randomUUID(),
        "setsid",
        ["-w", "sh", "-c", script],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 30,
          graceSec: 1,
          pidLimit: 32,
          pidGuardIntervalMs: 50,
          onLog: async () => {},
        },
      );
      expect(result.errorCode).toBe(RUN_PID_LIMIT_EXCEEDED);
      expect(result.stderr).toContain("run PID limit exceeded");
      expect(result.pidStats?.exceeded).toBe(true);
      expect(result.pidStats?.peak).toBeGreaterThan(32);
      // Either the signal shape or the synthesized trap-exit shape, but
      // never a clean 0: the typed failure must survive the wrapper.
      expect(result.exitCode).not.toBe(0);
      expect(procCmdlinesContain(SETSID_MARKER)).toEqual([]);
    },
    30_000,
  );

  it.runIf(isLinux)(
    "counts threads against the budget (worker_threads)",
    async () => {
      // One process, ~50 OS threads: the pids cgroup charges tasks, so the
      // guard must fire even though the group holds a single leader.
      const workerScript = [
        "const { Worker } = require('node:worker_threads');",
        `for (let i = 0; i < ${FORK_CHILDREN}; i += 1) {`,
        "  new Worker('setTimeout(() => {}, 60000);', { eval: true });",
        "}",
        "setTimeout(() => {}, 60000);",
      ].join("\n");
      const result = await runChildProcess(
        randomUUID(),
        process.execPath,
        ["-e", workerScript],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 30,
          graceSec: 1,
          pidLimit: 32,
          pidGuardIntervalMs: 50,
          onLog: async () => {},
        },
      );
      expect(result.errorCode).toBe(RUN_PID_LIMIT_EXCEEDED);
      expect(result.pidStats?.exceeded).toBe(true);
      expect(result.pidStats?.peak).toBeGreaterThan(32);
    },
    30_000,
  );

  it.runIf(isLinux)(
    "a SIGTERM-trapping child that exits 0 still fails the run",
    async () => {
      const script = [
        "trap 'exit 0' TERM",
        "i=0",
        `while [ $i -lt ${FORK_CHILDREN} ]; do sleep ${TRAP_MARKER} & i=$((i+1)); done`,
        "wait",
      ].join("; ");
      const result = await runChildProcess(randomUUID(), "sh", ["-c", script], {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 30,
        graceSec: 1,
        pidLimit: 32,
        pidGuardIntervalMs: 50,
        onLog: async () => {},
      });
      expect(result.errorCode).toBe(RUN_PID_LIMIT_EXCEEDED);
      expect(result.exitCode).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain("run PID limit exceeded");
      expect(result.pidStats?.exceeded).toBe(true);
      expect(procCmdlinesContain(TRAP_MARKER)).toEqual([]);
    },
    30_000,
  );
});
