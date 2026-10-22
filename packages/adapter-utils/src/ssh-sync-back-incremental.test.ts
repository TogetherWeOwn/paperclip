import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSshChangedFilesDownloadScript,
  createSshSyncBackCapTransform,
  downloadChangedFilesFromSsh,
  parseSshPorcelainStatusV1Z,
  restoreWorkspaceFromSshExecution,
  SshSyncBackSizeLimitExceededError,
  syncDirectoryFromSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";
import { SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES } from "./ssh-workspace-excludes.js";
import { SSH_REMOTE_ARG_MAX_BYTES } from "./remote-execution-env.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

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
  delete process.env.PAPERCLIP_SSH_INCREMENTAL_SYNC;
  delete process.env.STUB_SSH_REMOTE_ROOT;
  delete process.env.STUB_SSH_FIXTURE_DIR;
  delete process.env.STUB_GIT_ARGV_LOG;
  delete process.env.STUB_REAL_GIT;
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

describe("buildSshChangedFilesDownloadScript", () => {
  it("archives exactly the listed paths with root-anchored, quoted targets", () => {
    const script = buildSshChangedFilesDownloadScript({
      remoteDir: FAKE_REMOTE_ROOT,
      paths: ["a.txt", "sub/b.txt", "-dash.txt", "sp ace.txt", "qu'ote.txt"],
      exclude: ["node_modules"],
    });
    expect(script).toContain(`cd '${FAKE_REMOTE_ROOT}'`);
    expect(script).toContain("tar ");
    expect(script).toContain("-cf -");
    for (const target of ["'./a.txt'", "'./sub/b.txt'", "'./-dash.txt'", "'./sp ace.txt'"]) {
      expect(script).toContain(target);
    }
    // Single quotes inside a path are shell-escaped, never breaking quoting.
    expect(script).toContain(`'./qu'"'"'ote.txt'`);
    expect(script).toContain("'--exclude'");
    expect(script).toContain("'node_modules'");
    expect(script).not.toContain(" -cf - . ");
  });

  it("selects the tar dialect when excludes are root-relative", () => {
    const script = buildSshChangedFilesDownloadScript({
      remoteDir: FAKE_REMOTE_ROOT,
      paths: ["a.txt"],
      exclude: ["./node_modules"],
    });
    expect(script).toContain('case "$(tar --version)" in');
    expect(script).toContain("'./a.txt'");
  });
});

describe("downloadChangedFilesFromSsh", () => {
  beforeEach(installStubSsh);

  async function writeTree(root: string, files: Record<string, string>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(root, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
  }

  async function pathExists(target: string): Promise<boolean> {
    return await lstat(target).then(() => true, () => false);
  }

  it("transfers only the listed paths and honors excludes", async () => {
    const remoteDir = await createTempDir("paperclip-changed-remote-");
    await writeTree(remoteDir, {
      "listed.txt": "listed\n",
      "unlisted.txt": "unlisted\n",
      "sub/listed.txt": "nested listed\n",
      "node_modules/junk.txt": "excluded\n",
    });
    const spec = buildStubSpec(remoteDir);
    const stagingDir = await createTempDir("paperclip-changed-staging-");

    await downloadChangedFilesFromSsh({
      spec,
      remoteDir: FAKE_REMOTE_ROOT,
      stagingDir,
      paths: ["listed.txt", "sub/listed.txt", "node_modules/junk.txt"],
      exclude: ["node_modules"],
    });

    await expect(readFile(path.join(stagingDir, "listed.txt"), "utf8")).resolves.toBe("listed\n");
    await expect(readFile(path.join(stagingDir, "sub/listed.txt"), "utf8")).resolves.toBe("nested listed\n");
    expect(await pathExists(path.join(stagingDir, "unlisted.txt"))).toBe(false);
    expect(await pathExists(path.join(stagingDir, "node_modules"))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("transfers awkward filenames byte-exact", async () => {
    const remoteDir = await createTempDir("paperclip-awkward-remote-");
    const names = ["-dash.txt", "sp ace.txt", "qu'ote.txt", "déjà.txt"];
    await writeTree(remoteDir, Object.fromEntries(names.map((name) => [name, `${name}\n`])));
    const spec = buildStubSpec(remoteDir);
    const stagingDir = await createTempDir("paperclip-awkward-staging-");

    await downloadChangedFilesFromSsh({
      spec,
      remoteDir: FAKE_REMOTE_ROOT,
      stagingDir,
      paths: names,
    });

    for (const name of names) {
      await expect(readFile(path.join(stagingDir, name), "utf8")).resolves.toBe(`${name}\n`);
    }
  }, TEST_TIMEOUT_MS);

  it("resolves without transferring when no paths changed", async () => {
    const remoteDir = await createTempDir("paperclip-empty-remote-");
    await writeFile(path.join(remoteDir, "a.txt"), "a\n");
    const spec = buildStubSpec(remoteDir);
    const stagingDir = await createTempDir("paperclip-empty-staging-");

    await downloadChangedFilesFromSsh({ spec, remoteDir: FAKE_REMOTE_ROOT, stagingDir, paths: [] });

    expect(await readdir(stagingDir)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("refuses an over-cap transfer without completing the extraction", async () => {
    const remoteDir = await createTempDir("paperclip-changed-cap-remote-");
    await writeFile(path.join(remoteDir, "big.bin"), Buffer.alloc(64 * 1024, 0x41));
    const spec = buildStubSpec(remoteDir);
    const stagingDir = await createTempDir("paperclip-changed-cap-staging-");

    const failure = await downloadChangedFilesFromSsh({
      spec,
      remoteDir: FAKE_REMOTE_ROOT,
      stagingDir,
      paths: ["big.bin"],
      capBytes: 1024,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
  }, TEST_TIMEOUT_MS);

  it("rejects a path list that exceeds the remote command budget", async () => {
    const remoteDir = await createTempDir("paperclip-budget-remote-");
    const spec = buildStubSpec(remoteDir);
    const stagingDir = await createTempDir("paperclip-budget-staging-");
    // ~45 bytes per path once quoted: 5000 paths blow the ~124 KiB budget.
    const paths = Array.from({ length: 5000 }, (_, index) => `dir-${index}/file-with-a-long-name-${index}.txt`);

    const script = buildSshChangedFilesDownloadScript({ remoteDir: FAKE_REMOTE_ROOT, paths });
    expect(Buffer.byteLength(script, "utf8")).toBeGreaterThan(SSH_REMOTE_ARG_MAX_BYTES);

    await expect(
      downloadChangedFilesFromSsh({ spec, remoteDir: FAKE_REMOTE_ROOT, stagingDir, paths }),
    ).rejects.toThrow(/budget/);
    expect(await readdir(stagingDir)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("rejects when a listed path is missing remotely so the caller falls back", async () => {
    const remoteDir = await createTempDir("paperclip-missing-remote-");
    await writeFile(path.join(remoteDir, "present.txt"), "present\n");
    const spec = buildStubSpec(remoteDir);
    const stagingDir = await createTempDir("paperclip-missing-staging-");

    // GNU tar exits nonzero for a missing member; bsdtar too. Either way the
    // changed-files path must surface the failure instead of silently
    // delivering a partial tree.
    await expect(
      downloadChangedFilesFromSsh({
        spec,
        remoteDir: FAKE_REMOTE_ROOT,
        stagingDir,
        paths: ["present.txt", "gone.txt"],
      }),
    ).rejects.toThrow();
  }, TEST_TIMEOUT_MS);
});

describe("incremental sync-back bundle export", () => {
  const GIT_TIMEOUT_MS = 60_000;

  beforeEach(installStubSsh);

  // Resolve the REAL git binary for the argv-log shim to exec. Inside a
  // Paperclip run, PATH starts with the live managed launcher, so a naive
  // `command -v git` returns the launcher shim — and a logging shim that execs
  // the launcher recurses without bound (the launcher re-resolves `git` to the
  // logging shim). On 2026-10-22 that fork-bombed the shared container to its
  // PID limit and the run was killed by the PID guard. Strip every launcher
  // dir and test bin dir, then fail closed unless the result is an absolute,
  // executable, non-shim path.
  function resolveRealGitPath(): string {
    const cleanPath = originalPath
      .split(path.delimiter)
      .filter(
        (entry) =>
          entry.length > 0 &&
          !entry.includes("paperclip-github-runtime") &&
          !tempDirs.includes(entry),
      )
      .join(path.delimiter);
    const resolved = execFileSync("sh", ["-c", "command -v git"], {
      env: { ...process.env, PATH: cleanPath },
    })
      .toString()
      .trim();
    if (resolved.length === 0 || !path.isAbsolute(resolved)) {
      throw new Error(
        `git-argv-log: no absolute real git found (got ${JSON.stringify(resolved)})`,
      );
    }
    if (!statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`git-argv-log: real git is not a file: ${resolved}`);
    }
    try {
      accessSync(resolved, fsConstants.X_OK);
    } catch {
      throw new Error(`git-argv-log: real git is not executable: ${resolved}`);
    }
    // Refuse shims even if PATH filtering missed one: our own shim embeds
    // STUB_REAL_GIT, the managed launcher embeds its credential-cache marker.
    const head = readFileSync(resolved, "utf8").slice(0, 4096);
    if (
      head.includes("STUB_REAL_GIT") ||
      head.includes("paperclip-github-credential-cache") ||
      head.includes("managedDigests")
    ) {
      throw new Error(
        `git-argv-log: resolved git is a shim, refusing: ${resolved}`,
      );
    }
    return resolved;
  }

  // Log every git invocation (local and stub-remote alike — both resolve
  // through the test process PATH) so the tests can count `bundle create`
  // attempts and inspect the revision range each one carried.
  async function installGitArgvLog(): Promise<{ logPath: string }> {
    const binDir = await createTempDir("paperclip-git-log-bin-");
    const logPath = path.join(binDir, "git-argv.log");
    await writeFile(path.join(binDir, "git"), `#!/bin/sh
# Recursion guard: a misresolved STUB_REAL_GIT re-entering this shim would
# fork without bound (PID-guard kill, 2026-10-22). Real git nests child git
# processes at most a couple deep; past that, fail loudly instead.
depth=\${STUB_GIT_ARGV_DEPTH:-0}
depth=$((depth + 1))
if [ "$depth" -gt 5 ]; then
  echo "git-argv-log: recursion depth $depth exceeds bound; STUB_REAL_GIT=$STUB_REAL_GIT" >&2
  exit 99
fi
export STUB_GIT_ARGV_DEPTH="$depth"
printf '%s\\n' "$*" >> "$STUB_GIT_ARGV_LOG"
exec "$STUB_REAL_GIT" "$@"
`, { mode: 0o755 });
    process.env.STUB_REAL_GIT = resolveRealGitPath();
    process.env.STUB_GIT_ARGV_LOG = logPath;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
    return { logPath };
  }

  async function bundleCreateArgvs(logPath: string): Promise<string[]> {
    const content = await readFile(logPath, "utf8").catch(() => "");
    return content.split("\n").filter((line) => line.includes("bundle create"));
  }

  async function initRepo(): Promise<string> {
    const repoDir = await createTempDir("paperclip-bundle-repo-");
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "bundle-test@example.com"]);
    await git(repoDir, ["config", "user.name", "Bundle Test"]);
    return repoDir;
  }

  async function commitFile(repoDir: string, relative: string, content: string, message: string): Promise<string> {
    const full = path.join(repoDir, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-m", message]);
    return git(repoDir, ["rev-parse", "HEAD"]);
  }

  function gitRemoteClone(sourceDir: string, targetDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", ["clone", "-q", sourceDir, targetDir], (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim()));
          return;
        }
        resolve(stdout);
      });
    });
  }

  it("skips the bundle entirely when the remote made no commits", async () => {
    const localDir = await initRepo();
    const head = await commitFile(localDir, "tracked.txt", "v1\n", "initial");
    const remoteDir = await createTempDir("paperclip-bundle-remote-");
    await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
    const checkoutDir = path.join(remoteDir, "checkout");
    // The remote run edited the worktree without committing.
    await writeFile(path.join(checkoutDir, "tracked.txt"), "v2\n");
    const spec = buildStubSpec(remoteDir);
    const baseline = await captureDirectorySnapshot(localDir, {
      exclude: [".git", ".git/*", ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES],
    });
    const { logPath } = await installGitArgvLog();

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
      baselineSnapshot: baseline,
      restoreGitHistory: true,
    });

    expect(await bundleCreateArgvs(logPath)).toEqual([]);
    await expect(readFile(path.join(localDir, "tracked.txt"), "utf8")).resolves.toBe("v2\n");
    expect(await git(localDir, ["rev-parse", "HEAD"])).toBe(head);
  }, GIT_TIMEOUT_MS);

  it("fetches only the new commits when the remote advanced", async () => {
    const localDir = await initRepo();
    const baseHead = await commitFile(localDir, "tracked.txt", "v1\n", "initial");
    const remoteDir = await createTempDir("paperclip-bundle-remote-");
    await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
    const checkoutDir = path.join(remoteDir, "checkout");
    await git(checkoutDir, ["config", "user.email", "bundle-test@example.com"]);
    await git(checkoutDir, ["config", "user.name", "Bundle Test"]);
    await commitFile(checkoutDir, "tracked.txt", "v2\n", "remote work");
    const remoteHead = await commitFile(checkoutDir, "second.txt", "more\n", "remote work 2");
    const spec = buildStubSpec(remoteDir);
    const baseline = await captureDirectorySnapshot(localDir, {
      exclude: [".git", ".git/*", ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES],
    });
    const { logPath } = await installGitArgvLog();

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
      baselineSnapshot: baseline,
      restoreGitHistory: true,
    });

    const bundles = await bundleCreateArgvs(logPath);
    expect(bundles).toHaveLength(1);
    // baseHead carries the rev-parse trailing newline; the logged argv joins
    // args with spaces.
    expect(bundles[0]).toContain(`^${baseHead.trim()}`);
    expect(await git(localDir, ["rev-parse", "HEAD"])).toBe(remoteHead);
    await expect(readFile(path.join(localDir, "tracked.txt"), "utf8")).resolves.toBe("v2\n");
    await expect(readFile(path.join(localDir, "second.txt"), "utf8")).resolves.toBe("more\n");
  }, GIT_TIMEOUT_MS);

  it("falls back to the full bundle when the remote lacks the local base", async () => {
    const localDir = await initRepo();
    await commitFile(localDir, "local.txt", "local\n", "initial");
    // A remote with an unrelated history: the incremental `^base` range
    // cannot resolve there, so the export must retry as a full bundle.
    const remoteDir = await createTempDir("paperclip-bundle-remote-");
    const checkoutDir = path.join(remoteDir, "checkout");
    await mkdir(checkoutDir, { recursive: true });
    await git(checkoutDir, ["init", "-b", "main"]);
    await git(checkoutDir, ["config", "user.email", "bundle-test@example.com"]);
    await git(checkoutDir, ["config", "user.name", "Bundle Test"]);
    const remoteHead = await commitFile(checkoutDir, "remote.txt", "remote\n", "unrelated root");
    const spec = buildStubSpec(remoteDir);
    const { logPath } = await installGitArgvLog();

    // The non-baseline git path resets the workspace to the imported head,
    // which is well-defined even for unrelated histories.
    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
    });

    const bundles = await bundleCreateArgvs(logPath);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]).toContain("^");
    expect(bundles[1]).not.toContain("^");
    expect(await git(localDir, ["rev-parse", "HEAD"])).toBe(remoteHead);
    await expect(readFile(path.join(localDir, "remote.txt"), "utf8")).resolves.toBe("remote\n");
  }, GIT_TIMEOUT_MS);

  it("uses the full bundle when the incremental kill switch is set", async () => {
    const localDir = await initRepo();
    await commitFile(localDir, "tracked.txt", "v1\n", "initial");
    const remoteDir = await createTempDir("paperclip-bundle-remote-");
    await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
    const spec = buildStubSpec(remoteDir);
    const baseline = await captureDirectorySnapshot(localDir, {
      exclude: [".git", ".git/*", ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES],
    });
    const { logPath } = await installGitArgvLog();
    process.env.PAPERCLIP_SSH_INCREMENTAL_SYNC = "0";

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
      baselineSnapshot: baseline,
      restoreGitHistory: true,
    });

    const bundles = await bundleCreateArgvs(logPath);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).not.toContain("^");
  }, GIT_TIMEOUT_MS);

  it("keeps reset semantics on the skip path: staged changes reset like the full export", async () => {
    const localDir = await initRepo();
    await commitFile(localDir, "tracked.txt", "v1\n", "initial");
    const remoteDir = await createTempDir("paperclip-bundle-remote-");
    await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
    // Stage (but do not commit) a local change while the remote stayed at
    // HEAD: the full export's `reset --hard` wipes it and the tree overlay
    // restores HEAD content, ending clean. The skip path must behave
    // identically (not leave the worktree/index disagreeing as "MM").
    await writeFile(path.join(localDir, "tracked.txt"), "staged\n");
    await git(localDir, ["add", "tracked.txt"]);
    const spec = buildStubSpec(remoteDir);
    const { logPath } = await installGitArgvLog();

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
    });

    expect(await bundleCreateArgvs(logPath)).toEqual([]);
    await expect(readFile(path.join(localDir, "tracked.txt"), "utf8")).resolves.toBe("v1\n");
    expect(await git(localDir, ["status", "--porcelain"])).toBe("");
  }, GIT_TIMEOUT_MS);
});
