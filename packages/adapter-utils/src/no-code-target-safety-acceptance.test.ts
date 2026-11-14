import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import {
  type AdapterSandboxExecutionTarget,
  prepareNoCodeExecutionTarget,
} from "./execution-target.js";

const ssh = vi.hoisted(() => ({
  io: vi.fn(() => {
    throw new Error("Live SSH is forbidden in scratch acceptance");
  }),
}));
vi.mock("./ssh.js", async () => ({
  ...(await vi.importActual<typeof import("./ssh.js")>("./ssh.js")),
  runSshCommand: ssh.io,
  prepareWorkspaceForSshExecution: ssh.io,
  restoreWorkspaceFromSshExecution: ssh.io,
  syncDirectoryToSsh: ssh.io,
}));

// Breaks caught: following a substituted directory/Git boundary, accepting path
// traversal, deleting existing bytes, or treating workspace contents as assets.
// All filesystem decisions and shell commands are production code. Only the
// external sandbox boundary is replaced with a bounded, credential-free shell.
async function fixture() {
  const scratch = await mkdtemp(
    path.join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
      "no-code-target-safety-",
    ),
  );
  const root = path.join(scratch, "authorized root's directory");
  const home = path.join(scratch, "home");
  const repository = path.join(scratch, "prior-repository");
  const outside = path.join(scratch, "outside");
  await Promise.all([
    mkdir(root),
    mkdir(home),
    mkdir(outside),
    mkdir(path.join(repository, ".git"), { recursive: true }),
  ]);
  await writeFile(
    path.join(root, "KEEP.txt"),
    "authorized pre-existing bytes\n",
  );
  await writeFile(
    path.join(repository, "DO-NOT-TRANSFER.txt"),
    "repository working-tree bytes\n",
  );
  await writeFile(
    path.join(repository, ".git", "KEEP"),
    "history must survive\n",
  );
  await writeFile(
    path.join(outside, "KEEP.txt"),
    "outside bytes must survive\n",
  );
  const calls: Parameters<CommandManagedRuntimeRunner["execute"]>[0][] = [];
  let transfers = 0;
  const runner: CommandManagedRuntimeRunner = {
    execute: async (input) => {
      calls.push(input);
      if (!["sh", "bash", "/bin/sh", "/bin/bash"].includes(input.command)) {
        throw new Error(`Unexpected scratch executable: ${input.command}`);
      }
      return new Promise((resolve, reject) => {
        const startedAt = new Date().toISOString();
        const child = spawn(input.command, input.args ?? [], {
          cwd: input.cwd ?? scratch,
          env: { PATH: "/usr/bin:/bin", HOME: home, ...input.env },
          timeout: 5_000,
          killSignal: "SIGKILL",
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
          if (stdout.length + stderr.length > 256 * 1024) child.kill("SIGKILL");
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
          if (stdout.length + stderr.length > 256 * 1024) child.kill("SIGKILL");
        });
        child.on("error", reject);
        child.on("close", (exitCode, signal) =>
          resolve({
            exitCode,
            signal,
            timedOut: signal === "SIGKILL",
            stdout,
            stderr,
            pid: child.pid ?? null,
            startedAt,
          }),
        );
        child.stdin.on("error", reject);
        child.stdin.end(input.stdin);
      });
    },
    syncIn: async () => {
      transfers++;
      throw new Error("No-code preparation must not upload workspace bytes");
    },
    syncOut: async () => {
      transfers++;
      throw new Error("No-code preparation must not restore workspace bytes");
    },
  };
  const target: AdapterSandboxExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "scratch-only",
    shellCommand: "sh",
    remoteCwd: repository,
    runner,
    streamRunLogs: false,
    workspaceRealization: {
      mode: "copy",
      authoritativeRoot: root,
      pathAliases: [],
      outboundRestorePaths: [],
    },
  };
  const runId = "acceptance-run_1";
  const cwd = path.join(root, ".paperclip-runtime", "no-code", runId);
  return {
    scratch,
    root,
    outside,
    repository,
    target,
    cwd,
    runId,
    calls,
    transfers: () => transfers,
  };
}

// Never follows symlinks. A refusal may leave harmless new directories, but
// every pre-existing entry, symlink target and file digest must remain intact.
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string) {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink())
      result[relative] = `link:${await readlink(absolute)}`;
    else if (stat.isDirectory()) {
      result[relative] = "directory";
      for (const name of (await readdir(absolute)).sort())
        await visit(path.join(relative, name));
    } else
      result[relative] = createHash("sha256")
        .update(await readFile(absolute))
        .digest("hex");
  }
  await visit(".");
  return result;
}

async function assertPreserved(root: string, before: Record<string, string>) {
  const after = await snapshot(root);
  for (const [entry, digest] of Object.entries(before))
    expect(after[entry], `Existing entry changed: ${entry}`).toBe(digest);
}

async function assertRefused(
  f: Awaited<ReturnType<typeof fixture>>,
  root = f.root,
  runId = f.runId,
) {
  const before = await snapshot(f.scratch);
  const target = {
    ...f.target,
    workspaceRealization: {
      mode: "copy" as const,
      authoritativeRoot: root,
      pathAliases: [],
      outboundRestorePaths: [],
    },
  };
  try {
    await expect(
      prepareNoCodeExecutionTarget({ runId, target }),
    ).rejects.toThrow(/no.code|ordinary|director|root|run|git|path|invalid/i);
  } finally {
    await assertPreserved(f.scratch, before);
    expect(f.transfers()).toBe(0);
    expect(ssh.io).not.toHaveBeenCalled();
  }
}

describe("direct no-code target scratch-directory safety acceptance", () => {
  it("uses an authorized ordinary root, not the old repository, without transfer or deletion", async () => {
    const f = await fixture();
    const before = await snapshot(f.scratch);
    const prepared = await prepareNoCodeExecutionTarget({
      runId: f.runId,
      target: f.target,
    });
    expect(prepared).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: f.cwd,
    });
    expect((await lstat(f.cwd)).isDirectory()).toBe(true);
    expect((await lstat(f.cwd)).isSymbolicLink()).toBe(false);
    expect(await readdir(f.cwd)).toEqual([]);
    expect(f.target.remoteCwd).toBe(f.repository);
    await assertPreserved(f.scratch, before);
    expect(f.transfers()).toBe(0);
    expect(ssh.io).not.toHaveBeenCalled();
  });

  it("reuses an ordinary run directory without deleting a prior task artifact", async () => {
    const f = await fixture();
    await mkdir(f.cwd, { recursive: true });
    await writeFile(
      path.join(f.cwd, "prior-result.md"),
      "retain task output\n",
    );
    const before = await snapshot(f.scratch);
    const prepared = await prepareNoCodeExecutionTarget({
      runId: f.runId,
      target: f.target,
    });
    expect(prepared).toMatchObject({ remoteCwd: f.cwd });
    await assertPreserved(f.scratch, before);
    expect(await readdir(f.cwd)).toEqual(["prior-result.md"]);
    expect(f.transfers()).toBe(0);
  });

  it.each([
    ".paperclip-runtime",
    ".paperclip-runtime/no-code",
    ".paperclip-runtime/no-code/acceptance-run_1",
  ])(
    "refuses symlink substitution at %s without touching its target",
    async (component) => {
      const f = await fixture();
      const link = path.join(f.root, component);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(f.outside, link);
      await assertRefused(f);
    },
  );

  it.each([
    ".paperclip-runtime",
    ".paperclip-runtime/no-code",
    ".paperclip-runtime/no-code/acceptance-run_1",
  ])(
    "refuses a file substitution at %s without deleting it",
    async (component) => {
      const f = await fixture();
      const file = path.join(f.root, component);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "do not replace this file\n");
      await assertRefused(f);
    },
  );

  it.each([
    ".",
    ".paperclip-runtime",
    ".paperclip-runtime/no-code",
    ".paperclip-runtime/no-code/acceptance-run_1",
  ])(
    "refuses a .git directory at %s without removing history",
    async (component) => {
      const f = await fixture();
      const git = path.join(f.root, component, ".git");
      await mkdir(git, { recursive: true });
      await writeFile(path.join(git, "KEEP"), "retain history\n");
      await assertRefused(f);
    },
  );

  it.each([
    ".",
    ".paperclip-runtime",
    ".paperclip-runtime/no-code",
    ".paperclip-runtime/no-code/acceptance-run_1",
  ])(
    "refuses a worktree .git file at %s without deleting the pointer",
    async (component) => {
      const f = await fixture();
      const directory = path.join(f.root, component);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, ".git"),
        `gitdir: ${path.join(f.repository, ".git")}\n`,
      );
      await assertRefused(f);
    },
  );

  it("refuses a dangling .git symlink rather than treating it as ordinary", async () => {
    const f = await fixture();
    await mkdir(f.cwd, { recursive: true });
    await symlink(
      path.join(f.outside, "missing-git"),
      path.join(f.cwd, ".git"),
    );
    await assertRefused(f);
  });

  it.each(["directory", "file"])(
    "refuses an authorized root nested inside an ancestor repository (%s .git)",
    async (kind) => {
      const f = await fixture();
      const git = path.join(f.scratch, ".git");
      if (kind === "directory") await mkdir(git);
      else await writeFile(git, `gitdir: ${path.join(f.repository, ".git")}\n`);
      await assertRefused(f);
    },
  );

  it("refuses a symlink replacing the authorized root", async () => {
    const f = await fixture();
    const alias = path.join(f.scratch, "root-alias");
    await symlink(f.root, alias);
    await assertRefused(f, alias);
  });

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "run/child",
    "run\\child",
    "run;touch injected",
    "run\nnext",
    "run\0next",
  ])("refuses malformed run ID %j before remote shell work", async (runId) => {
    const f = await fixture();
    await assertRefused(f, f.root, runId);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    "",
    "/",
    "relative/root",
    "ROOT/../escape",
    "ROOT//child",
    "ROOT/child/..",
  ])(
    "refuses malformed authorized root %j before remote shell work",
    async (input) => {
      const f = await fixture();
      const root = input.replace("ROOT", f.root);
      await assertRefused(f, root);
      expect(f.calls).toHaveLength(0);
    },
  );
});
