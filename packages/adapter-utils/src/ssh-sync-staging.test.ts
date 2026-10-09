import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { resolveNestedWorktreeExcludes } from "./exclude-patterns.js";
import { restoreWorkspaceFromSshExecution, type SshRemoteExecutionSpec } from "./ssh.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// A stand-in `ssh` that runs the remote command on this machine, so the real
// tar/du pipelines of the SSH workspace sync run without an sshd. The remote
// "host" is a local directory tree.
// The login profile that SSH command scripts source resets PATH, so when
// FAKE_REMOTE_PATH is set the stand-in puts that directory first again.
const FAKE_SSH = `#!/bin/sh
for last; do :; done
printf '%s\\n---\\n' "$last" >> "$FAKE_SSH_LOG"
if [ -n "$FAKE_REMOTE_PATH" ]; then
  last=$(printf '%s' "$last" | sed "s|exec sh -c '|exec sh -c 'PATH=$FAKE_REMOTE_PATH:\\$PATH; |")
fi
exec sh -c "$last"
`;

// A BSD-style du: it has no --exclude, and -I masks only match entry names.
const FAKE_BSD_DU = `#!/bin/sh
for arg; do
  case "$arg" in --exclude=*) exit 64;; esac
done
printf '999999999\\t.\\n'
`;

const MB = 1024 * 1024;
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
}

async function exists(target: string): Promise<boolean> {
  return await stat(target).then(() => true, () => false);
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else total += await stat(full).then((stats) => stats.size, () => 0);
  }
  return total;
}

describe("ssh workspace sync staging", { timeout: 90_000 }, () => {
  let root: string;
  let localDir: string;
  let remoteCwd: string;
  let stagingRoot: string;
  let bin: string;
  let sshLog: string;
  let spec: SshRemoteExecutionSpec;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-staging-test-"));
    localDir = path.join(root, "local");
    remoteCwd = path.join(root, "remote");
    stagingRoot = path.join(root, "tmp");
    bin = path.join(root, "bin");
    sshLog = path.join(root, "ssh.log");
    await Promise.all([localDir, remoteCwd, stagingRoot, bin].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
    await writeFile(sshLog, "");
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("FAKE_SSH_LOG", sshLog);
    // Every staging directory the sync creates lands in stagingRoot.
    vi.stubEnv("TMPDIR", stagingRoot);
    spec = {
      host: "127.0.0.1",
      port: 22,
      username: "fixture",
      remoteWorkspacePath: remoteCwd,
      remoteCwd,
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: false,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function writeTree(base: string, files: Record<string, string | Buffer>): Promise<void> {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(base, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
  }

  function prepare(extra: Partial<Parameters<typeof prepareRemoteManagedRuntime>[0]> = {}) {
    return prepareRemoteManagedRuntime({
      spec,
      runId: "run-1",
      adapterKey: "test",
      workspaceLocalDir: localDir,
      ...extra,
    });
  }

  it.each([
    { label: "plain directory", gitBacked: false },
    { label: "git workspace", gitBacked: true },
  ])("neither uploads nor restores nested worktrees ($label)", async ({ gitBacked }) => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    if (gitBacked) {
      await git(localDir, ["init", "-q", "-b", "main"]);
      await git(localDir, ["add", "-A"]);
      await git(localDir, ["commit", "-q", "-m", "init"]);
    }
    await writeTree(localDir, {
      ".paperclip/keep.txt": "synced\n",
      ".paperclip/worktrees/wt1/big.bin": "local worktree one\n",
      ".claude/worktrees/wt2/notes.md": "local worktree two\n",
      "packages/a/.claude/worktrees/wt3/deep.txt": "local nested worktree\n",
    });

    const prepared = await prepare();
    const remote = prepared.workspaceRemoteDir;

    // Not uploaded: the worktrees never reach the remote, their siblings do.
    expect(await readFile(path.join(remote, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(await readFile(path.join(remote, ".paperclip/keep.txt"), "utf8")).toBe("synced\n");
    expect(await exists(path.join(remote, ".paperclip/worktrees"))).toBe(false);
    expect(await exists(path.join(remote, ".claude/worktrees"))).toBe(false);
    expect(await exists(path.join(remote, "packages/a/.claude/worktrees"))).toBe(false);

    // The remote run edits a tracked file and creates worktrees of its own.
    await writeTree(remote, {
      "src/app.ts": "export const app = 2;\n",
      "created-remotely.txt": "new\n",
      ".paperclip/worktrees/remote-made/file.txt": "remote worktree\n",
      ".claude/worktrees/remote-made/file.txt": "remote worktree\n",
    });
    await prepared.restoreWorkspace();

    // Restored: ordinary remote changes come back.
    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 2;\n");
    expect(await readFile(path.join(localDir, "created-remotely.txt"), "utf8")).toBe("new\n");
    // Not restored: remote-created worktrees stay remote.
    expect(await exists(path.join(localDir, ".paperclip/worktrees/remote-made"))).toBe(false);
    expect(await exists(path.join(localDir, ".claude/worktrees/remote-made"))).toBe(false);
    // The local worktrees are not mistaken for remote deletions.
    expect(await readFile(path.join(localDir, ".paperclip/worktrees/wt1/big.bin"), "utf8")).toBe("local worktree one\n");
    expect(await readFile(path.join(localDir, ".claude/worktrees/wt2/notes.md"), "utf8")).toBe("local worktree two\n");
    expect(await readFile(path.join(localDir, "packages/a/.claude/worktrees/wt3/deep.txt"), "utf8")).toBe("local nested worktree\n");
  });

  it("syncs nested worktrees when the default directories are overridden", async () => {
    await writeTree(localDir, {
      "src/app.ts": "export const app = 1;\n",
      ".paperclip/worktrees/wt1/file.txt": "wt1\n",
      ".claude/worktrees/wt2/file.txt": "wt2\n",
    });

    const prepared = await prepare({ nestedWorktreeDirs: [".claude/worktrees"] });

    expect(await exists(path.join(prepared.workspaceRemoteDir, ".paperclip/worktrees/wt1/file.txt"))).toBe(true);
    expect(await exists(path.join(prepared.workspaceRemoteDir, ".claude/worktrees"))).toBe(false);
  });

  it("keeps local nested worktrees when restoring without a baseline", async () => {
    await writeTree(localDir, {
      "stale.txt": "local only\n",
      ".paperclip/worktrees/wt1/file.txt": "local worktree\n",
      ".paperclip/other.txt": "local sibling\n",
    });
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, {
      "fresh.txt": "remote\n",
      ".paperclip/worktrees/remote-made/file.txt": "remote worktree\n",
    });

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote });

    expect(await readFile(path.join(localDir, "fresh.txt"), "utf8")).toBe("remote\n");
    expect(await exists(path.join(localDir, "stale.txt"))).toBe(false);
    expect(await exists(path.join(localDir, ".paperclip/other.txt"))).toBe(false);
    expect(await readFile(path.join(localDir, ".paperclip/worktrees/wt1/file.txt"), "utf8")).toBe("local worktree\n");
    expect(await exists(path.join(localDir, ".paperclip/worktrees/remote-made"))).toBe(false);
  });

  it("stages the restore once: peak temp usage stays within 1x the restored size", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    const restoredBytes = 6 * 4 * MB;
    const blobs: Record<string, Buffer> = {};
    for (let index = 0; index < 6; index += 1) blobs[`data/blob-${index}.bin`] = Buffer.alloc(4 * MB, index + 1);
    await writeTree(prepared.workspaceRemoteDir, blobs);

    let peakBytes = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        peakBytes = Math.max(peakBytes, await directoryBytes(stagingRoot));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    try {
      await prepared.restoreWorkspace();
    } finally {
      sampling = false;
      await sampler;
    }

    expect((await readFile(path.join(localDir, "data/blob-5.bin"))).equals(Buffer.alloc(4 * MB, 6))).toBe(true);
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThanOrEqual(restoredBytes * 1.25);
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it("fails before the first write when the temp volume is too small", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    await writeTree(prepared.workspaceRemoteDir, {
      "src/app.ts": "export const app = 2;\n",
      "data/blob.bin": Buffer.alloc(2 * MB, 7),
    });
    expect(await readdir(stagingRoot)).toEqual([]);
    const mkdtemp = vi.spyOn(fsPromises, "mkdtemp");
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 1024, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);
    await writeFile(sshLog, "");

    await expect(prepared.restoreWorkspace()).rejects.toMatchObject({
      code: "ssh_sync_insufficient_staging_space",
      message: expect.stringMatching(/Not enough free space in .*tmp to restore the workspace from SSH/),
    });

    // No staging directory was created and the remote tree was never read.
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(await readFile(sshLog, "utf8")).not.toContain("-cf");
    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(await exists(path.join(localDir, "data"))).toBe(false);
  });

  it("refuses a restore with several trees before it restores any of them", async () => {
    const repositoryDir = ".paperclip-repositories/app";
    await writeTree(localDir, {
      "src/app.ts": "export const app = 1;\n",
      [`${repositoryDir}/README.md`]: "repository\n",
    });
    const rootExclude = [".paperclip-repositories", ...resolveNestedWorktreeExcludes({})];
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, {
      "src/app.ts": "export const app = 2;\n",
      "data/blob.bin": Buffer.alloc(2 * MB, 7),
      [`${repositoryDir}/README.md`]: "repository, edited remotely\n",
    });
    // Only the repository tree fits in 64 KiB; the workspace root does not.
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 64, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await expect(restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: remote,
      baselineSnapshot: await captureDirectorySnapshot(localDir, { exclude: rootExclude }),
      repositories: [{
        path: repositoryDir,
        baselineSnapshot: await captureDirectorySnapshot(path.join(localDir, repositoryDir), {
          exclude: resolveNestedWorktreeExcludes({}),
        }),
      }],
    })).rejects.toMatchObject({ code: "ssh_sync_insufficient_staging_space" });

    expect(await readFile(path.join(localDir, repositoryDir, "README.md"), "utf8")).toBe("repository\n");
    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 1;\n");
  });

  it("sizes the free-space check by what will be restored, not by excluded paths", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    await writeTree(prepared.workspaceRemoteDir, {
      "data/blob.bin": Buffer.alloc(1 * MB, 3),
      // Excluded from the restore, so it must not count towards the estimate.
      ".paperclip/worktrees/remote-made/huge.bin": Buffer.alloc(24 * MB, 9),
    });
    // 4 MiB free covers 2x the 1 MiB restore but not 2x the 25 MiB on disk.
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 4096, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);

    await prepared.restoreWorkspace();

    expect((await stat(path.join(localDir, "data/blob.bin"))).size).toBe(1 * MB);
    expect(await exists(path.join(localDir, ".paperclip/worktrees"))).toBe(false);
  });

  it("skips the free-space check when the remote size cannot honor the excludes", async () => {
    await writeTree(localDir, { "src/app.ts": "export const app = 1;\n" });
    const prepared = await prepare();
    await writeTree(prepared.workspaceRemoteDir, { "src/app.ts": "export const app = 2;\n" });
    // The remote's du cannot skip the nested worktrees, so its figure is an
    // overcount and must not refuse a restore that would fit.
    await writeFile(path.join(bin, "du"), FAKE_BSD_DU, { mode: 0o755 });
    vi.stubEnv("FAKE_REMOTE_PATH", bin);
    vi.spyOn(fsPromises, "statfs").mockResolvedValue({ bavail: 1024, bsize: 1024 } as Awaited<ReturnType<typeof fsPromises.statfs>>);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await prepared.restoreWorkspace();

    expect(await readFile(path.join(localDir, "src/app.ts"), "utf8")).toBe("export const app = 2;\n");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping the SSH restore free-space check"));
  });

  it("keeps local nested worktrees at any depth when restoring without a baseline", async () => {
    await writeTree(localDir, {
      "packages/a/x.ts": "local\n",
      "packages/a/.claude/worktrees/wt3/deep.txt": "local nested worktree\n",
      "node_modules/pkg/index.js": "stale\n",
    });
    const remote = path.join(remoteCwd, "ws");
    await writeTree(remote, { "packages/a/x.ts": "remote\n" });

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: remote });

    expect(await readFile(path.join(localDir, "packages/a/x.ts"), "utf8")).toBe("remote\n");
    expect(await readFile(path.join(localDir, "packages/a/.claude/worktrees/wt3/deep.txt"), "utf8")).toBe("local nested worktree\n");
    expect(await exists(path.join(localDir, "node_modules"))).toBe(false);
  });

  it("normalizes the configured directories and rejects patterns tar and the baseline would read differently", () => {
    expect(resolveNestedWorktreeExcludes({ nestedWorktreeDirs: ["./wt/", "/other"] })).toEqual([
      "wt", "wt/*", "*/wt", "*/wt/*",
      "other", "other/*", "*/other", "*/other/*",
    ]);
    expect(resolveNestedWorktreeExcludes({ nestedWorktreeDirs: [] })).toEqual([]);
    for (const invalid of ["", ".", "worktrees-*", "a/../b", "a//b", "wt[1]"]) {
      expect(() => resolveNestedWorktreeExcludes({ nestedWorktreeDirs: [invalid] })).toThrow(/Invalid nested worktree directory/);
    }
  });
});
