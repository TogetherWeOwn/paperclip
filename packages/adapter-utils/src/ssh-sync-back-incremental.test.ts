import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSshSyncBackCapTransform,
  parseSshPorcelainStatusV1Z,
  SshSyncBackSizeLimitExceededError,
  syncDirectoryFromSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Same stub-ssh pattern as ssh-seed-mirror.test.ts: the fake `ssh` executes
// the trailing `sh -c` payload locally after remapping the fake remote root.
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
const originalPath = process.env.PATH ?? "";
const originalTmpdir = process.env.TMPDIR;

// Sync-back staging Dirs live under os.tmpdir(), which every parallel test
// worker shares. These tests scope TMPDIR to a private directory per test so
// the staging-leak assertions below observe only this file's own transfers.
async function installPrivateTmpdir(): Promise<void> {
  const privateTmp = await mkdtemp(path.join(os.tmpdir(), "paperclip-syncback-test-tmp-"));
  tempDirs.push(privateTmp);
  process.env.TMPDIR = privateTmp;
}

async function installStubSsh(): Promise<void> {
  await installPrivateTmpdir();
  const binDir = await createTempDir("paperclip-syncback-stub-ssh-bin-");
  await writeFile(path.join(binDir, "ssh"), STUB_SOURCE, { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
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

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  delete process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES;
  delete process.env.STUB_SSH_REMOTE_ROOT;
  delete process.env.STUB_SSH_FIXTURE_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("parseSshPorcelainStatusV1Z", () => {
  it("returns empty sets for a clean tree", () => {
    expect(parseSshPorcelainStatusV1Z("")).toEqual({ changedPaths: [], deletedPaths: [] });
  });

  it("treats worktree and index modifications as changed", () => {
    const output = [" M modified.txt", "M  staged.txt", "MM both.txt", "A  added.txt"].join("\0") + "\0";
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["added.txt", "both.txt", "modified.txt", "staged.txt"],
      deletedPaths: [],
    });
  });

  it("treats untracked files as changed and skips ignored entries", () => {
    const output = ["?? new.txt", "?? sub/dir/file.txt", "!! ignored.log"].join("\0") + "\0";
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["new.txt", "sub/dir/file.txt"],
      deletedPaths: [],
    });
  });

  it("treats pure deletions as deleted, not changed", () => {
    const output = [" D gone.txt", "D  staged-gone.txt", "D  dir/nested-gone.txt"].join("\0") + "\0";
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: [],
      deletedPaths: ["dir/nested-gone.txt", "gone.txt", "staged-gone.txt"],
    });
  });

  it("transfers unmerged entries, whose worktree content still exists", () => {
    const output = ["UU conflict.txt", "AA both-added.txt", "UD deleted-by-them.txt"].join("\0") + "\0";
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["both-added.txt", "conflict.txt", "deleted-by-them.txt"],
      deletedPaths: [],
    });
  });

  it("parses real git rename output as changed-new plus deleted-old", async () => {
    const repoDir = await createTempDir("paperclip-porcelain-rename-");
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "porcelain-test@example.com"]);
    await git(repoDir, ["config", "user.name", "Porcelain Test"]);
    await writeFile(path.join(repoDir, "old.txt"), "hi\n");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-m", "initial"]);
    await git(repoDir, ["mv", "old.txt", "new.txt"]);

    const output = await git(repoDir, ["status", "--porcelain=v1", "-z", "-uall", "--", "."]);
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["new.txt"],
      deletedPaths: ["old.txt"],
    });
  });

  it("keeps filenames with spaces and quotes byte-exact", () => {
    const output = ["?? a file \"quoted\".txt", " M déjà-vu.txt"].join("\0") + "\0";
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["a file \"quoted\".txt", "déjà-vu.txt"],
      deletedPaths: [],
    });
  });

  it("dedupes repeated entries deterministically", () => {
    const output = [" M b.txt", "?? a.txt", " M b.txt"].join("\0") + "\0";
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["a.txt", "b.txt"],
      deletedPaths: [],
    });
  });
});

describe("createSshSyncBackCapTransform", () => {
  it("passes chunks through while the cumulative bytes stay within the cap", async () => {
    const cap = createSshSyncBackCapTransform({ capBytes: 10, remoteDir: FAKE_REMOTE_ROOT });
    const received: Buffer[] = [];
    cap.on("data", (chunk: Buffer) => received.push(chunk));
    cap.write(Buffer.alloc(6, 0x41));
    cap.write(Buffer.alloc(4, 0x42));
    await new Promise<void>((resolve, reject) => {
      cap.on("error", reject);
      cap.end(resolve);
    });
    expect(Buffer.concat(received)).toEqual(Buffer.concat([Buffer.alloc(6, 0x41), Buffer.alloc(4, 0x42)]));
  });

  it("destroys the stream with the cap error once cumulative bytes exceed it", async () => {
    const cap = createSshSyncBackCapTransform({ capBytes: 10, remoteDir: FAKE_REMOTE_ROOT });
    cap.resume();
    cap.write(Buffer.alloc(6, 0x41));
    const failure = await new Promise<unknown>((resolve) => {
      cap.on("error", resolve);
      cap.write(Buffer.alloc(5, 0x42));
    });
    expect(failure).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
    expect((failure as Error).message).toContain(FAKE_REMOTE_ROOT);
    expect((failure as Error).message).toContain("PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES");
  });
});

describe("sync-back streaming cap", () => {
  beforeEach(installStubSsh);

  it("refuses an over-cap sync-back from the single transfer stream", async () => {
    const remoteDir = await createTempDir("paperclip-syncback-cap-remote-");
    await writeFile(path.join(remoteDir, "big.bin"), Buffer.alloc(64 * 1024, 0x41));
    const spec = buildStubSpec(remoteDir);
    const localDir = await createTempDir("paperclip-syncback-cap-local-");
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = "1024";
    const stagingBefore = await listSyncBackStagingDirs();

    const failure = await syncDirectoryFromSsh({
      spec,
      remoteDir: FAKE_REMOTE_ROOT,
      localDir,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
    expect(await readdir(localDir)).toEqual([]);
    expect(await listSyncBackStagingDirs()).toEqual(stagingBefore);
  }, TEST_TIMEOUT_MS);

  it("still refuses when hardlinked extraction exceeds the cap the stream fit", async () => {
    // The tar stream carries one 200 KiB copy plus hardlink entries, but the
    // extraction lands 21 paths: only the post-extract staging check can
    // refuse this, proving it survived the probe removal.
    const { link } = await import("node:fs/promises");
    const remoteDir = await createTempDir("paperclip-syncback-links-remote-");
    await writeFile(path.join(remoteDir, "orig.bin"), Buffer.alloc(200 * 1024, 0x41));
    for (let index = 0; index < 20; index += 1) {
      await link(path.join(remoteDir, "orig.bin"), path.join(remoteDir, `copy-${index}.bin`));
    }
    const spec = buildStubSpec(remoteDir);
    const localDir = await createTempDir("paperclip-syncback-links-local-");
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(1024 * 1024);
    const stagingBefore = await listSyncBackStagingDirs();

    const failure = await syncDirectoryFromSsh({
      spec,
      remoteDir: FAKE_REMOTE_ROOT,
      localDir,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
    expect(await readdir(localDir)).toEqual([]);
    expect(await listSyncBackStagingDirs()).toEqual(stagingBefore);
  }, TEST_TIMEOUT_MS);
});
