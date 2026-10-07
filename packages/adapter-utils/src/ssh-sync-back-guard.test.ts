import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, lstat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSshSyncBackSizeWithinCap,
  measureDirectoryFileBytes,
  prepareWorkspaceForSshExecution,
  resolveSshSyncBackMaxBytes,
  restoreWorkspaceFromSshExecution,
  SSH_SYNC_BACK_DEFAULT_MAX_BYTES,
  SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES,
  SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES,
  SshSyncBackSizeLimitExceededError,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";
import { toSshTarExcludes } from "./ssh-workspace-excludes.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// A nested agent worktree plus build outputs once filled a production host's
// root disk: sync-back copied them through /tmp staging until ENOSPC. These
// tests run the real transfer functions against a fake `ssh` that executes
// the trailing `sh -c` payload locally after remapping the fake remote root
// to a fixture directory, so the tar exclude lists and the size cap are
// verified without an SSH lab.
const FAKE_REMOTE_ROOT = "/stub-ssh-remote";
const STUB_SOURCE = `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  "sh -c "*) payload=\${last#"sh -c "};;
  *) echo "stub-ssh: unexpected trailing arg: $last" >&2; exit 99;;
esac
rewritten=$(printf '%s' "$payload" | sed "s|$STUB_SSH_REMOTE_ROOT|$STUB_SSH_FIXTURE_DIR|g")
eval "sh -c $rewritten"
`;

const TEST_TIMEOUT_MS = 30_000;
// A git-backed round trip runs a dozen git processes locally and "remotely";
// that is a few seconds on a developer machine and far slower on a loaded CI
// host or a sandboxed filesystem.
const GIT_ROUND_TRIP_TIMEOUT_MS = 180_000;
const originalPath = process.env.PATH ?? "";
const fixtureRoots: string[] = [];

async function createFixtureRootDir(prefix: string): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureRoots.push(rootDir);
  return rootDir;
}

async function installStubSsh(): Promise<void> {
  const binDir = await createFixtureRootDir("paperclip-stub-ssh-bin-");
  await writeFile(path.join(binDir, "ssh"), STUB_SOURCE, { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
}

// A fake remote workspace: one real deliverable plus the agent-local scratch
// that must never cross the wire in either direction.
async function buildRemoteWorkspace(): Promise<{ fixtureDir: string; keepBytes: number }> {
  const fixtureDir = await createFixtureRootDir("paperclip-sync-back-remote-");
  const keep = Buffer.alloc(2048, 0x41);
  await writeFile(path.join(fixtureDir, "keep.txt"), keep);
  await mkdir(path.join(fixtureDir, ".claude", "worktrees", "nested", "target", "debug"), { recursive: true });
  await writeFile(
    path.join(fixtureDir, ".claude", "worktrees", "nested", "f.bin"),
    Buffer.alloc(1024 * 1024, 0x42),
  );
  await writeFile(
    path.join(fixtureDir, ".claude", "worktrees", "nested", "target", "debug", "output"),
    Buffer.alloc(1024 * 1024, 0x43),
  );
  await mkdir(path.join(fixtureDir, "node_modules", "dep"), { recursive: true });
  await writeFile(
    path.join(fixtureDir, "node_modules", "dep", "index.js"),
    Buffer.alloc(1024 * 1024, 0x44),
  );
  await mkdir(path.join(fixtureDir, "target", "debug"), { recursive: true });
  await writeFile(
    path.join(fixtureDir, "target", "debug", "binary"),
    Buffer.alloc(1024 * 1024, 0x45),
  );
  await mkdir(path.join(fixtureDir, ".paperclip-runtime"), { recursive: true });
  await writeFile(path.join(fixtureDir, ".paperclip-runtime", "state.json"), "{}");
  return { fixtureDir, keepBytes: keep.length };
}

function buildStubSpec(fixtureDir: string): SshRemoteExecutionSpec {
  process.env.STUB_SSH_REMOTE_ROOT = FAKE_REMOTE_ROOT;
  process.env.STUB_SSH_FIXTURE_DIR = fixtureDir;
  return {
    host: "stub",
    port: 22,
    username: "stub",
    remoteWorkspacePath: FAKE_REMOTE_ROOT,
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: false,
    remoteCwd: FAKE_REMOTE_ROOT,
  };
}

async function listSyncBackStagingDirs(): Promise<string[]> {
  const entries = await readdir(os.tmpdir()).catch(() => []);
  return entries.filter((entry) => entry.startsWith("paperclip-ssh-sync-back-")).sort();
}

async function pathExists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, () => false);
}

beforeEach(async () => {
  await installStubSsh();
});

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES;
  delete process.env.STUB_SSH_REMOTE_ROOT;
  delete process.env.STUB_SSH_FIXTURE_DIR;
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("SSH workspace agent-local excludes", () => {
  it("names the scratch directories that are never deliverables", () => {
    expect([...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES]).toEqual(
      expect.arrayContaining([".paperclip-runtime", ".claude/worktrees", "node_modules", "target"]),
    );
  });

  it("does not export nested worktrees or build outputs to the remote", async () => {
    const localDir = await createFixtureRootDir("paperclip-sync-back-local-");
    const keep = Buffer.alloc(2048, 0x41);
    await writeFile(path.join(localDir, "keep.txt"), keep);
    await mkdir(path.join(localDir, ".claude", "worktrees", "nested"), { recursive: true });
    await writeFile(path.join(localDir, ".claude", "worktrees", "nested", "f.bin"), Buffer.alloc(4096, 0x42));
    await mkdir(path.join(localDir, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(localDir, "node_modules", "dep", "index.js"), "module.exports = {};");
    await mkdir(path.join(localDir, "target", "debug"), { recursive: true });
    await writeFile(path.join(localDir, "target", "debug", "binary"), Buffer.alloc(4096, 0x43));

    const fixtureDir = await createFixtureRootDir("paperclip-sync-back-remote-empty-");
    const spec = buildStubSpec(fixtureDir);

    await syncDirectoryToSsh({
      spec,
      localDir,
      remoteDir: FAKE_REMOTE_ROOT,
      exclude: [".git", ...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES],
    });

    await expect(readFile(path.join(fixtureDir, "keep.txt"))).resolves.toEqual(keep);
    expect(await pathExists(path.join(fixtureDir, ".claude", "worktrees"))).toBe(false);
    expect(await pathExists(path.join(fixtureDir, "node_modules"))).toBe(false);
    expect(await pathExists(path.join(fixtureDir, "target"))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("does not sync a nested worktree in the remote workspace back", async () => {
    const { fixtureDir, keepBytes } = await buildRemoteWorkspace();
    const spec = buildStubSpec(fixtureDir);
    const localDir = await createFixtureRootDir("paperclip-sync-back-restore-");
    // The cap sits far above the deliverable but far below the unexcluded
    // total, so this passes only when the excludes reach the transfer.
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(keepBytes * 32);

    await syncDirectoryFromSsh({
      spec,
      remoteDir: FAKE_REMOTE_ROOT,
      localDir,
      exclude: [".git", ...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES],
    });

    await expect(readFile(path.join(localDir, "keep.txt"))).resolves.toEqual(Buffer.alloc(2048, 0x41));
    expect(await pathExists(path.join(localDir, ".claude", "worktrees"))).toBe(false);
    expect(await pathExists(path.join(localDir, "node_modules"))).toBe(false);
    expect(await pathExists(path.join(localDir, "target"))).toBe(false);
    expect(await pathExists(path.join(localDir, ".paperclip-runtime"))).toBe(false);
  }, TEST_TIMEOUT_MS);
});

describe("SSH workspace entry points", () => {
  it("prepareWorkspaceForSshExecution excludes agent-local scratch on export", async () => {
    const localDir = await createFixtureRootDir("paperclip-sync-back-prepare-");
    const keep = Buffer.alloc(2048, 0x41);
    await writeFile(path.join(localDir, "keep.txt"), keep);
    await mkdir(path.join(localDir, ".claude", "worktrees", "nested"), { recursive: true });
    await writeFile(path.join(localDir, ".claude", "worktrees", "nested", "f.bin"), Buffer.alloc(4096, 0x42));
    await mkdir(path.join(localDir, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(localDir, "node_modules", "dep", "index.js"), "module.exports = {};");
    await mkdir(path.join(localDir, "target", "debug"), { recursive: true });
    await writeFile(path.join(localDir, "target", "debug", "binary"), Buffer.alloc(4096, 0x43));

    const remoteDir = await createFixtureRootDir("paperclip-sync-back-prepare-remote-");
    const spec = buildStubSpec(remoteDir);

    const result = await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });
    expect(result.gitBacked).toBe(false);

    await expect(readFile(path.join(remoteDir, "keep.txt"))).resolves.toEqual(keep);
    expect(await pathExists(path.join(remoteDir, ".claude", "worktrees"))).toBe(false);
    expect(await pathExists(path.join(remoteDir, "node_modules"))).toBe(false);
    expect(await pathExists(path.join(remoteDir, "target"))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("restoreWorkspaceFromSshExecution excludes scratch on the plain path", async () => {
    const { fixtureDir, keepBytes } = await buildRemoteWorkspace();
    const spec = buildStubSpec(fixtureDir);
    const localDir = await createFixtureRootDir("paperclip-sync-back-restore-plain-");
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(keepBytes * 32);

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    await expect(readFile(path.join(localDir, "keep.txt"))).resolves.toEqual(Buffer.alloc(2048, 0x41));
    expect(await pathExists(path.join(localDir, ".claude", "worktrees"))).toBe(false);
    expect(await pathExists(path.join(localDir, "node_modules"))).toBe(false);
    expect(await pathExists(path.join(localDir, "target"))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("restoreWorkspaceFromSshExecution excludes scratch on the baseline staging path", async () => {
    const { fixtureDir, keepBytes } = await buildRemoteWorkspace();
    const spec = buildStubSpec(fixtureDir);
    const localDir = await createFixtureRootDir("paperclip-sync-back-restore-baseline-");
    // The baseline exclude alone does not know about SSH scratch; the cap
    // sits far below the unexcluded total, so this passes only when the
    // restore path merges the SSH extras into the inner transfer.
    const baseline = await captureDirectorySnapshot(localDir, { exclude: [".paperclip-runtime"] });
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(keepBytes * 32);

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: FAKE_REMOTE_ROOT,
      baselineSnapshot: baseline,
    });

    await expect(readFile(path.join(localDir, "keep.txt"))).resolves.toEqual(Buffer.alloc(2048, 0x41));
    expect(await pathExists(path.join(localDir, ".claude", "worktrees"))).toBe(false);
    expect(await pathExists(path.join(localDir, "node_modules"))).toBe(false);
    expect(await pathExists(path.join(localDir, "target"))).toBe(false);
  }, TEST_TIMEOUT_MS);
});

const execFileAsync = promisify(execFile);
const GIT_IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...GIT_IDENTITY, ...args], { cwd });
  return stdout;
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

// Tracked source whose directory names collide with scratch names at depth.
// Only the workspace-root `target/`, `node_modules/` and `.claude/worktrees/`
// are scratch; none of these may ever be dropped or deleted.
const NESTED_SOURCE_FILES: Record<string, string> = {
  "keep.txt": "keep\n",
  "src/commands/target/index.ts": "export const target = 1;\n",
  "docs/target": "a plain file named target\n",
  "packages/app/node_modules/vendored.js": "module.exports = 1;\n",
  "packages/app/.claude/worktrees/notes.md": "tracked notes\n",
};

// Uncommitted agent work and rebuildable outputs at the workspace root. The
// sync never carries these, so the restore must leave them exactly as they are.
const ROOT_SCRATCH_FILES: Record<string, string> = {
  ".claude/worktrees/wt/uncommitted.txt": "uncommitted agent work\n",
  "node_modules/dep/index.js": "module.exports = {};\n",
  "target/debug/binary": "built\n",
};

describe("SSH workspace excludes are anchored to the workspace root", () => {
  it("exports a root-anchored tar grammar next to the merge grammar", () => {
    expect([...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES]).toEqual(
      SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.map((entry) => `./${entry}`),
    );
  });

  it("anchors only the scratch names when translating a snapshot exclude list for tar", () => {
    expect(toSshTarExcludes([".git", ".git/*", ".paperclip-runtime", "node_modules", "target", "dist"])).toEqual([
      ".git",
      ".git/*",
      "./.paperclip-runtime",
      "./node_modules",
      "./target",
      "dist",
    ]);
  });

  it("export keeps nested source named like scratch and drops only the root scratch", async () => {
    const localDir = await createFixtureRootDir("paperclip-anchor-export-local-");
    await writeTree(localDir, { ...NESTED_SOURCE_FILES, ...ROOT_SCRATCH_FILES });
    const remoteDir = await createFixtureRootDir("paperclip-anchor-export-remote-");
    const spec = buildStubSpec(remoteDir);

    await syncDirectoryToSsh({
      spec,
      localDir,
      remoteDir: FAKE_REMOTE_ROOT,
      exclude: [".git", ...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES],
    });

    for (const relative of Object.keys(NESTED_SOURCE_FILES)) {
      expect(await pathExists(path.join(remoteDir, relative)), relative).toBe(true);
    }
    for (const relative of Object.keys(ROOT_SCRATCH_FILES)) {
      expect(await pathExists(path.join(remoteDir, relative)), relative).toBe(false);
    }
  }, TEST_TIMEOUT_MS);

  it("sync-back keeps nested source named like scratch and drops only the root scratch", async () => {
    const remoteDir = await createFixtureRootDir("paperclip-anchor-back-remote-");
    await writeTree(remoteDir, { ...NESTED_SOURCE_FILES, ...ROOT_SCRATCH_FILES });
    const spec = buildStubSpec(remoteDir);
    const localDir = await createFixtureRootDir("paperclip-anchor-back-local-");

    await syncDirectoryFromSsh({
      spec,
      remoteDir: FAKE_REMOTE_ROOT,
      localDir,
      exclude: [".git", ...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES],
    });

    for (const relative of Object.keys(NESTED_SOURCE_FILES)) {
      expect(await pathExists(path.join(localDir, relative)), relative).toBe(true);
    }
    for (const relative of Object.keys(ROOT_SCRATCH_FILES)) {
      expect(await pathExists(path.join(localDir, relative)), relative).toBe(false);
    }
  }, TEST_TIMEOUT_MS);
});

describe("SSH workspace restore never deletes local scratch or nested source", () => {
  // The baseline shapes the restore merge sees: the one remote-managed-runtime
  // captures today, and one captured before the scratch excludes existed.
  const baselineShapes = [
    { label: "a baseline that excludes the scratch", exclude: [...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES] },
    { label: "a baseline that still lists the scratch", exclude: [".paperclip-runtime"] },
  ];

  for (const shape of baselineShapes) {
    it(`keeps local scratch and nested source with ${shape.label}`, async () => {
      const localDir = await createFixtureRootDir("paperclip-restore-keep-local-");
      await writeTree(localDir, { ...NESTED_SOURCE_FILES, ...ROOT_SCRATCH_FILES });
      const remoteDir = await createFixtureRootDir("paperclip-restore-keep-remote-");
      const spec = buildStubSpec(remoteDir);

      await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });
      const baseline = await captureDirectorySnapshot(localDir, { exclude: shape.exclude });
      // The remote run edits one file and adds another.
      await writeFile(path.join(remoteDir, "keep.txt"), "edited remotely\n");
      await writeFile(path.join(remoteDir, "added.txt"), "added remotely\n");

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: FAKE_REMOTE_ROOT,
        baselineSnapshot: baseline,
      });

      await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe("edited remotely\n");
      await expect(readFile(path.join(localDir, "added.txt"), "utf8")).resolves.toBe("added remotely\n");
      for (const [relative, content] of Object.entries({ ...NESTED_SOURCE_FILES, ...ROOT_SCRATCH_FILES })) {
        if (relative === "keep.txt") continue;
        await expect(readFile(path.join(localDir, relative), "utf8"), relative).resolves.toBe(content);
      }
    }, TEST_TIMEOUT_MS);
  }

  it("leaves a git-backed workspace clean after a round trip with nested target source", async () => {
    const localDir = await createFixtureRootDir("paperclip-restore-git-local-");
    await git(localDir, "init", "-q", "-b", "main");
    await writeTree(localDir, NESTED_SOURCE_FILES);
    await git(localDir, "add", "-A");
    await git(localDir, "commit", "-q", "-m", "initial");
    await writeTree(localDir, ROOT_SCRATCH_FILES);
    await writeFile(path.join(localDir, ".gitignore"), "/node_modules/\n/target/\n/.claude/worktrees/\n");
    await git(localDir, "add", ".gitignore");
    await git(localDir, "commit", "-q", "-m", "ignore scratch");
    const remoteDir = await createFixtureRootDir("paperclip-restore-git-remote-");
    const spec = buildStubSpec(remoteDir);

    const prepared = await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });
    expect(prepared.gitBacked).toBe(true);
    const baseline = await captureDirectorySnapshot(localDir, {
      exclude: [".git", ".git/*", ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES],
    });

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: FAKE_REMOTE_ROOT,
      baselineSnapshot: baseline,
      restoreGitHistory: true,
    });

    expect((await git(localDir, "status", "--porcelain")).trim()).toBe("");
    for (const relative of Object.keys(ROOT_SCRATCH_FILES)) {
      expect(await pathExists(path.join(localDir, relative)), relative).toBe(true);
    }
  }, GIT_ROUND_TRIP_TIMEOUT_MS);

  it("plain restore preserves root scratch but still replaces other workspace content", async () => {
    const remoteDir = await createFixtureRootDir("paperclip-restore-plain-remote-");
    await writeTree(remoteDir, { ...NESTED_SOURCE_FILES, ".claude/settings.json": "remote settings\n" });
    const spec = buildStubSpec(remoteDir);
    const localDir = await createFixtureRootDir("paperclip-restore-plain-local-");
    await writeTree(localDir, {
      ...ROOT_SCRATCH_FILES,
      ".claude/settings.json": "stale local settings\n",
      "stale.txt": "removed remotely\n",
    });

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    for (const [relative, content] of Object.entries(ROOT_SCRATCH_FILES)) {
      await expect(readFile(path.join(localDir, relative), "utf8"), relative).resolves.toBe(content);
    }
    await expect(readFile(path.join(localDir, ".claude/settings.json"), "utf8")).resolves.toBe("remote settings\n");
    expect(await pathExists(path.join(localDir, "stale.txt"))).toBe(false);
    await expect(readFile(path.join(localDir, "src/commands/target/index.ts"), "utf8")).resolves.toBe(
      "export const target = 1;\n",
    );
  }, TEST_TIMEOUT_MS);
});

describe("SSH sync-back size cap", () => {
  it("resolves the cap from the environment with a safe default", () => {
    expect(resolveSshSyncBackMaxBytes({})).toBe(SSH_SYNC_BACK_DEFAULT_MAX_BYTES);
    expect(resolveSshSyncBackMaxBytes({ PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES: "1024" })).toBe(1024);
    expect(resolveSshSyncBackMaxBytes({ PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES: "not-a-number" })).toBe(
      SSH_SYNC_BACK_DEFAULT_MAX_BYTES,
    );
    expect(resolveSshSyncBackMaxBytes({ PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES: "0" })).toBe(
      SSH_SYNC_BACK_DEFAULT_MAX_BYTES,
    );
    expect(resolveSshSyncBackMaxBytes({ PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES: "-5" })).toBe(
      SSH_SYNC_BACK_DEFAULT_MAX_BYTES,
    );
  });

  it("fails closed with a clear error when the source exceeds the cap", () => {
    expect(() =>
      assertSshSyncBackSizeWithinCap({ sourceBytes: 100, capBytes: 100, remoteDir: FAKE_REMOTE_ROOT }),
    ).not.toThrow();
    try {
      assertSshSyncBackSizeWithinCap({ sourceBytes: 101, capBytes: 100, remoteDir: FAKE_REMOTE_ROOT });
      expect.unreachable("expected the cap to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
      expect((error as Error).message).toContain(FAKE_REMOTE_ROOT);
      expect((error as Error).message).toContain("PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES");
    }
  });

  it("refuses an over-cap sync-back without touching the workspace or leaving staging dirs", async () => {
    const { fixtureDir, keepBytes } = await buildRemoteWorkspace();
    const spec = buildStubSpec(fixtureDir);
    const localDir = await createFixtureRootDir("paperclip-sync-back-cap-");
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(Math.max(1, Math.floor(keepBytes / 2)));
    const stagingBefore = await listSyncBackStagingDirs();

    const failure = await syncDirectoryFromSsh({
      spec,
      remoteDir: FAKE_REMOTE_ROOT,
      localDir,
      exclude: [".git", ...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES],
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
    expect((failure as Error).message).toContain("PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES");
    // The workspace is untouched: the refusal lands before clear/copy.
    expect(await readdir(localDir)).toEqual([]);
    // No staging directory is left behind in the container temp dir.
    expect(await listSyncBackStagingDirs()).toEqual(stagingBefore);
  }, TEST_TIMEOUT_MS);
});

describe("measureDirectoryFileBytes", () => {
  it("sums regular files without following symlinks out of the tree", async () => {
    const rootDir = await createFixtureRootDir("paperclip-sync-back-measure-");
    const outsideDir = await createFixtureRootDir("paperclip-sync-back-outside-");
    await writeFile(path.join(rootDir, "a.bin"), Buffer.alloc(100, 0x1));
    await mkdir(path.join(rootDir, "sub"), { recursive: true });
    await writeFile(path.join(rootDir, "sub", "b.bin"), Buffer.alloc(50, 0x2));
    await writeFile(path.join(outsideDir, "big.bin"), Buffer.alloc(1024 * 1024, 0x3));
    await symlink(path.join(outsideDir, "big.bin"), path.join(rootDir, "escape-link"));
    const linkSize = (await lstat(path.join(rootDir, "escape-link"))).size;

    await expect(measureDirectoryFileBytes(rootDir)).resolves.toBe(150 + linkSize);
  });
});
