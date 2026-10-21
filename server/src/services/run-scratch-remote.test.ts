import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHeartbeatRunScratchEnv,
  cleanupRemoteHeartbeatRunScratch,
  HEARTBEAT_RUN_SCRATCH_MARKER,
  type HeartbeatRunScratch,
  prepareRemoteHeartbeatRunScratch,
  provisionHeartbeatRunScratch,
  type RemoteHeartbeatRunScratchExec,
  type RemoteHeartbeatRunScratchShellResult,
} from "./run-scratch.js";

/**
 * In-memory fake for the remote execution-target shell channel. Implements
 * exactly the four command shapes the remote scratch helpers send — anything
 * else throws, so the test fails loudly if the implementation drifts to a new
 * shape. No live SSH, no filesystem access.
 */
class FakeRemoteShell {
  readonly commands: string[] = [];
  private readonly dirs = new Set<string>(["/tmp"]);
  private readonly files = new Map<string, { content: string; mode: number }>();
  private mktempCounter = 0;
  /** When set, the next command whose text starts with the key fails this way. */
  failNext: { prefix: string; exitCode: number; stderr: string } | null = null;

  readonly exec: RemoteHeartbeatRunScratchExec = async (command: string) => {
    this.commands.push(command);
    if (this.failNext && command.startsWith(this.failNext.prefix)) {
      const { exitCode, stderr } = this.failNext;
      this.failNext = null;
      return this.result({ exitCode, stderr });
    }
    const mktemp = command.match(
      /^mktemp -d "\$\{TMPDIR:-\/tmp\}\/([A-Za-z0-9._-]+)XXXXXX"$/,
    );
    if (mktemp) {
      this.mktempCounter += 1;
      const dir = `/tmp/${mktemp[1]}${String(this.mktempCounter).padStart(6, "0")}`;
      this.dirs.add(dir);
      return this.result({ stdout: `${dir}\n` });
    }
    const write = command.match(
      /^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > '([^']+)' && chmod 600 '([^']+)'$/,
    );
    if (write) {
      const [, encoded, target, chmodTarget] = write;
      if (target !== chmodTarget)
        throw new Error(
          `fake remote shell: chmod target mismatch in ${command}`,
        );
      const parent = target.slice(0, target.lastIndexOf("/")) || "/";
      if (!this.dirs.has(parent))
        return this.result({
          exitCode: 1,
          stderr: "No such file or directory",
        });
      this.files.set(target, {
        content: Buffer.from(encoded, "base64").toString("utf8"),
        mode: 0o600,
      });
      return this.result({});
    }
    const cat = command.match(/^cat '([^']+)'$/);
    if (cat) {
      const file = this.files.get(cat[1]);
      if (!file)
        return this.result({
          exitCode: 1,
          stderr: "No such file or directory",
        });
      return this.result({ stdout: file.content });
    }
    const rm = command.match(/^rm -rf -- '([^']+)'$/);
    if (rm) {
      const dir = rm[1];
      for (const file of Array.from(this.files.keys())) {
        if (file === dir || file.startsWith(`${dir}/`)) this.files.delete(file);
      }
      for (const entry of Array.from(this.dirs)) {
        if (entry === dir || entry.startsWith(`${dir}/`))
          this.dirs.delete(entry);
      }
      return this.result({});
    }
    throw new Error(`fake remote shell: unexpected command: ${command}`);
  };

  hasDir(dir: string): boolean {
    return this.dirs.has(dir);
  }

  readFile(file: string): { content: string; mode: number } | undefined {
    return this.files.get(file);
  }

  seedDir(dir: string): void {
    this.dirs.add(dir);
  }

  private result(
    overrides: Partial<RemoteHeartbeatRunScratchShellResult>,
  ): RemoteHeartbeatRunScratchShellResult {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...overrides,
    };
  }
}

function provisionInput(
  overrides: Partial<{ runId: string; issueIdentifier: string }> = {},
) {
  return {
    companyId: "company-1",
    agentId: "agent-1",
    runId: "run-1",
    issueId: "issue-1",
    issueIdentifier: "DEMO-123",
    now: new Date("2026-10-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("remote heartbeat run scratch", () => {
  it("provisions a run-unique remote dir with an ownership marker via the shell channel", async () => {
    const shell = new FakeRemoteShell();

    const first = await prepareRemoteHeartbeatRunScratch(
      provisionInput({ runId: "run-aaa" }),
      { exec: shell.exec },
    );
    const second = await prepareRemoteHeartbeatRunScratch(
      provisionInput({ runId: "run-bbb" }),
      { exec: shell.exec },
    );

    expect(first.dir).not.toBe(second.dir);
    expect(first.dir).toMatch(/^\/tmp\/paperclip-run-demo-123-run-aaa-/);
    expect(shell.commands[0]).toMatch(
      /^mktemp -d "\$\{TMPDIR:-\/tmp\}\/paperclip-run-demo-123-run-aaa-XXXXXX"$/,
    );
    const marker = shell.readFile(
      `${first.dir}/${HEARTBEAT_RUN_SCRATCH_MARKER}`,
    );
    expect(marker?.mode).toBe(0o600);
    expect(JSON.parse(marker?.content ?? "{}")).toMatchObject({
      version: 1,
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-aaa",
    });
    expect(first.markerPath).toBe(
      `${first.dir}/${HEARTBEAT_RUN_SCRATCH_MARKER}`,
    );
  });

  it("builds run env pointing at the run-unique remote dir", async () => {
    const shell = new FakeRemoteShell();
    const scratch = await prepareRemoteHeartbeatRunScratch(provisionInput(), {
      exec: shell.exec,
    });

    const result = buildHeartbeatRunScratchEnv({}, scratch);

    expect(result.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
    expect(result.env.TMPDIR).toBe(scratch.dir);
    expect(result.env.TEMP).toBe(scratch.dir);
    expect(result.env.TMP).toBe(scratch.dir);
    expect(result.tempKeysApplied).toEqual(["TMPDIR", "TEMP", "TMP"]);
  });

  it("removes the marked remote dir at cleanup", async () => {
    const shell = new FakeRemoteShell();
    const scratch = await prepareRemoteHeartbeatRunScratch(provisionInput(), {
      exec: shell.exec,
    });

    const result = await cleanupRemoteHeartbeatRunScratch(
      { scratch },
      { exec: shell.exec },
    );

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    expect(shell.hasDir(scratch.dir)).toBe(false);
    expect(shell.readFile(scratch.markerPath)).toBeUndefined();
  });

  it("preserves a remote dir without the ownership marker", async () => {
    const shell = new FakeRemoteShell();
    shell.seedDir("/tmp/paperclip-run-unmarked-000001");
    const scratch: HeartbeatRunScratch = {
      dir: "/tmp/paperclip-run-unmarked-000001",
      markerPath: `/tmp/paperclip-run-unmarked-000001/${HEARTBEAT_RUN_SCRATCH_MARKER}`,
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date("2026-10-20T00:00:00.000Z").toISOString(),
      },
    };

    const result = await cleanupRemoteHeartbeatRunScratch(
      { scratch },
      { exec: shell.exec },
    );

    expect(result).toEqual({
      removed: false,
      dir: scratch.dir,
      reason: "unmarked",
    });
    expect(shell.hasDir(scratch.dir)).toBe(true);
    expect(shell.commands.some((command) => command.startsWith("rm -rf"))).toBe(
      false,
    );
  });

  it("preserves remote scratch when the marker owner does not match the run", async () => {
    const shell = new FakeRemoteShell();
    const scratch = await prepareRemoteHeartbeatRunScratch(
      provisionInput({ runId: "run-aaa" }),
      { exec: shell.exec },
    );
    const mismatched = {
      ...scratch,
      metadata: { ...scratch.metadata, runId: "run-bbb" },
    };

    const result = await cleanupRemoteHeartbeatRunScratch(
      { scratch: mismatched },
      { exec: shell.exec },
    );

    expect(result).toEqual({
      removed: false,
      dir: scratch.dir,
      reason: "owner_mismatch",
    });
    expect(shell.hasDir(scratch.dir)).toBe(true);
    expect(shell.commands.some((command) => command.startsWith("rm -rf"))).toBe(
      false,
    );
  });

  it("refuses to remove remote paths outside paperclip-run-*", async () => {
    const shell = new FakeRemoteShell();
    shell.seedDir("/tmp/other");
    const scratch: HeartbeatRunScratch = {
      dir: "/tmp/other",
      markerPath: `/tmp/other/${HEARTBEAT_RUN_SCRATCH_MARKER}`,
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date("2026-10-20T00:00:00.000Z").toISOString(),
      },
    };

    const result = await cleanupRemoteHeartbeatRunScratch(
      { scratch },
      { exec: shell.exec },
    );

    expect(result).toEqual({
      removed: false,
      dir: "/tmp/other",
      reason: "unmarked",
    });
    expect(shell.commands).toEqual([]);
  });

  it("propagates provisioning shell failures so dispatch can continue without scratch env", async () => {
    const shell = new FakeRemoteShell();
    shell.failNext = {
      prefix: "mktemp -d",
      exitCode: 1,
      stderr: "mktemp: failed",
    };

    await expect(
      prepareRemoteHeartbeatRunScratch(provisionInput(), { exec: shell.exec }),
    ).rejects.toThrow(
      /Could not create the remote heartbeat run scratch directory/,
    );
  });

  it("removes the remote dir when the marker write fails after mktemp succeeds", async () => {
    const shell = new FakeRemoteShell();
    shell.failNext = {
      prefix: "printf '%s'",
      exitCode: 1,
      stderr: "base64: command not found",
    };

    await expect(
      prepareRemoteHeartbeatRunScratch(provisionInput(), { exec: shell.exec }),
    ).rejects.toThrow(/Could not write the remote run scratch marker/);
    expect(shell.hasDir("/tmp/paperclip-run-demo-123-run-1-000001")).toBe(
      false,
    );
    expect(
      shell.commands.some((command) =>
        command.startsWith("rm -rf -- '/tmp/paperclip-run-"),
      ),
    ).toBe(true);
  });

  it("propagates remote removal failures like the local rm path", async () => {
    const shell = new FakeRemoteShell();
    const scratch = await prepareRemoteHeartbeatRunScratch(provisionInput(), {
      exec: shell.exec,
    });
    shell.failNext = {
      prefix: "rm -rf",
      exitCode: 1,
      stderr: "rm: permission denied",
    };

    await expect(
      cleanupRemoteHeartbeatRunScratch({ scratch }, { exec: shell.exec }),
    ).rejects.toThrow(
      /Could not remove the remote heartbeat run scratch directory/,
    );
  });
});

describe("provisionHeartbeatRunScratch dispatch wiring", () => {
  const localDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      Array.from(localDirs, (dir) =>
        fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
    localDirs.clear();
  });

  it("provisions remote scratch through the shell channel with the full run env", async () => {
    const shell = new FakeRemoteShell();

    const first = await provisionHeartbeatRunScratch(
      "remote",
      provisionInput({ runId: "run-aaa" }),
      {},
      { exec: shell.exec },
    );
    const second = await provisionHeartbeatRunScratch(
      "remote",
      provisionInput({ runId: "run-bbb" }),
      {},
      { exec: shell.exec },
    );

    expect(first.location).toBe("remote");
    expect(first.scratch.dir).not.toBe(second.scratch.dir);
    expect(first.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(first.scratch.dir);
    expect(first.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(first.scratch.dir);
    expect(first.env.PAPERCLIP_SCRATCH_DIR).toBe(first.scratch.dir);
    expect(first.env.PAPERCLIP_TMPDIR).toBe(first.scratch.dir);
    expect(first.env.TMPDIR).toBe(first.scratch.dir);
    expect(first.tempKeysApplied).toEqual(["TMPDIR", "TEMP", "TMP"]);
    expect(
      shell.commands.filter((command) => command.startsWith("mktemp -d")),
    ).toHaveLength(2);
  });

  it("throws on remote provisioning failure so dispatch continues without scratch env", async () => {
    const shell = new FakeRemoteShell();
    shell.failNext = {
      prefix: "mktemp -d",
      exitCode: 1,
      stderr: "mktemp: failed",
    };

    await expect(
      provisionHeartbeatRunScratch(
        "remote",
        provisionInput(),
        {},
        { exec: shell.exec },
      ),
    ).rejects.toThrow(
      /Could not create the remote heartbeat run scratch directory/,
    );
  });

  it("provisions local scratch on the host filesystem with the full run env", async () => {
    const shell = new FakeRemoteShell();

    const provisioned = await provisionHeartbeatRunScratch(
      "local",
      provisionInput(),
      {},
      { exec: shell.exec },
    );
    localDirs.add(provisioned.scratch.dir);

    expect(provisioned.location).toBe("local");
    expect(provisioned.scratch.dir.startsWith(`${os.tmpdir()}/`)).toBe(true);
    expect(provisioned.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(
      provisioned.scratch.dir,
    );
    expect(provisioned.env.PAPERCLIP_TMPDIR).toBe(provisioned.scratch.dir);
    await expect(
      fs.stat(provisioned.scratch.markerPath),
    ).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    // Local provisioning never touches the remote shell channel.
    expect(shell.commands).toEqual([]);
  });

  it("preserves pre-set temp keys instead of overriding them", async () => {
    const shell = new FakeRemoteShell();

    const provisioned = await provisionHeartbeatRunScratch(
      "remote",
      provisionInput(),
      { TMPDIR: "/custom-tmp", TEMP: "", TMP: "   " },
      { exec: shell.exec },
    );

    expect(provisioned.env.TMPDIR).toBeUndefined();
    expect(provisioned.env.TEMP).toBe(provisioned.scratch.dir);
    expect(provisioned.env.TMP).toBe(provisioned.scratch.dir);
    expect(provisioned.tempKeysApplied).toEqual(["TEMP", "TMP"]);
  });
});
