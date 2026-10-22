import { execFile, execFileSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  statSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SSH_REMOTE_ARG_MAX_BYTES } from "./remote-execution-env.js";
import {
  buildSshChangedFilesDownloadScript,
  buildSshRemoteStatusScript,
  createSshSyncBackCapTransform,
  downloadChangedFilesFromSsh,
  parseSshPorcelainStatusV1Z,
  resolveSshSyncBackTransferSets,
  restoreWorkspaceFromSshExecution,
  type SshRemoteExecutionSpec,
  SshSyncBackSizeLimitExceededError,
  syncDirectoryFromSsh,
} from "./ssh.js";
import { SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES } from "./ssh-workspace-excludes.js";
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
if [ -n "$STUB_SSH_ARGV_LOG" ]; then printf '%s\\n' "$payload" >> "$STUB_SSH_ARGV_LOG"; fi
eval "sh -c $rewritten"
`;

const TEST_TIMEOUT_MS = 30_000;
const originalPath = process.env.PATH ?? "";
const originalTmpdir = process.env.TMPDIR;

// Sync-back staging Dirs live under os.tmpdir(), which every parallel test
// worker shares. These tests scope TMPDIR to a private directory per test so
// the staging-leak assertions below observe only this file's own transfers.
async function installPrivateTmpdir(): Promise<void> {
  const privateTmp = await mkdtemp(
    path.join(os.tmpdir(), "paperclip-syncback-test-tmp-"),
  );
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
  return entries
    .filter((entry) => entry.startsWith("paperclip-ssh-sync-back-"))
    .sort();
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

function runShell(
  script: string,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", script], (error, stdout) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ exitCode: typeof code === "number" ? code : 0, stdout });
    });
  });
}

async function cleanTreeSeedState(
  repoDir: string,
): Promise<{ headCommit: string; overlayPaths: string[] }> {
  // These fixtures seed from a clean tree (every setup file is committed
  // before the remote diverges), so the overlay is empty and the current
  // local head is the seed head: no fixture commits locally after setup.
  return {
    headCommit: (await git(repoDir, ["rev-parse", "HEAD"])).trim(),
    overlayPaths: [],
  };
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
  delete process.env.STUB_SSH_ARGV_LOG;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("parseSshPorcelainStatusV1Z", () => {
  it("returns empty sets for a clean tree", () => {
    expect(parseSshPorcelainStatusV1Z("")).toEqual({
      changedPaths: [],
      deletedPaths: [],
      ignoredPaths: [],
    });
  });

  it("treats worktree and index modifications as changed", () => {
    const output = `${[" M modified.txt", "M  staged.txt", "MM both.txt", "A  added.txt"].join("\0")}\0`;
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["added.txt", "both.txt", "modified.txt", "staged.txt"],
      deletedPaths: [],
      ignoredPaths: [],
    });
  });

  it("collects ignored entries separately so the caller can reconcile creations", () => {
    const output = `${["?? new.txt", "?? sub/dir/file.txt", "!! ignored.log"].join("\0")}\0`;
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["new.txt", "sub/dir/file.txt"],
      deletedPaths: [],
      ignoredPaths: ["ignored.log"],
    });
  });

  it("strips the directory marker from ignored directory records", () => {
    const output = `${["!! logs/", "!! run.log"].join("\0")}\0`;
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: [],
      deletedPaths: [],
      ignoredPaths: ["logs", "run.log"],
    });
  });

  it("treats pure deletions as deleted, not changed", () => {
    const output = `${[" D gone.txt", "D  staged-gone.txt", "D  dir/nested-gone.txt"].join("\0")}\0`;
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: [],
      deletedPaths: ["dir/nested-gone.txt", "gone.txt", "staged-gone.txt"],
      ignoredPaths: [],
    });
  });

  it("transfers unmerged entries, whose worktree content still exists", () => {
    const output = `${["UU conflict.txt", "AA both-added.txt", "UD deleted-by-them.txt"].join("\0")}\0`;
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["both-added.txt", "conflict.txt", "deleted-by-them.txt"],
      deletedPaths: [],
      ignoredPaths: [],
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

    const output = await git(repoDir, [
      "status",
      "--porcelain=v1",
      "-z",
      "-uall",
      "--",
      ".",
    ]);
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["new.txt"],
      deletedPaths: ["old.txt"],
      ignoredPaths: [],
    });
  });

  it("keeps filenames with spaces and quotes byte-exact", () => {
    const output = `${['?? a file "quoted".txt', " M déjà-vu.txt"].join("\0")}\0`;
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ['a file "quoted".txt', "déjà-vu.txt"],
      deletedPaths: [],
      ignoredPaths: [],
    });
  });

  it("dedupes repeated entries deterministically", () => {
    const output = `${[" M b.txt", "?? a.txt", " M b.txt"].join("\0")}\0`;
    expect(parseSshPorcelainStatusV1Z(output)).toEqual({
      changedPaths: ["a.txt", "b.txt"],
      deletedPaths: [],
      ignoredPaths: [],
    });
  });
});

describe("createSshSyncBackCapTransform", () => {
  it("passes chunks through while the cumulative bytes stay within the cap", async () => {
    const cap = createSshSyncBackCapTransform({
      capBytes: 10,
      remoteDir: FAKE_REMOTE_ROOT,
    });
    const received: Buffer[] = [];
    cap.on("data", (chunk: Buffer) => received.push(chunk));
    cap.write(Buffer.alloc(6, 0x41));
    cap.write(Buffer.alloc(4, 0x42));
    await new Promise<void>((resolve, reject) => {
      cap.on("error", reject);
      cap.end(resolve);
    });
    expect(Buffer.concat(received)).toEqual(
      Buffer.concat([Buffer.alloc(6, 0x41), Buffer.alloc(4, 0x42)]),
    );
  });

  it("destroys the stream with the cap error once cumulative bytes exceed it", async () => {
    const cap = createSshSyncBackCapTransform({
      capBytes: 10,
      remoteDir: FAKE_REMOTE_ROOT,
    });
    cap.resume();
    cap.write(Buffer.alloc(6, 0x41));
    const failure = await new Promise<unknown>((resolve) => {
      cap.on("error", resolve);
      cap.write(Buffer.alloc(5, 0x42));
    });
    expect(failure).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
    expect((failure as Error).message).toContain(FAKE_REMOTE_ROOT);
    expect((failure as Error).message).toContain(
      "PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES",
    );
  });
});

describe("sync-back streaming cap", () => {
  beforeEach(installStubSsh);

  it(
    "refuses an over-cap sync-back from the single transfer stream",
    async () => {
      const remoteDir = await createTempDir("paperclip-syncback-cap-remote-");
      await writeFile(
        path.join(remoteDir, "big.bin"),
        Buffer.alloc(64 * 1024, 0x41),
      );
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
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "still refuses when hardlinked extraction exceeds the cap the stream fit",
    async () => {
      // The tar stream carries one 200 KiB copy plus hardlink entries, but the
      // extraction lands 21 paths: only the post-extract staging check can
      // refuse this, proving it survived the probe removal.
      const { link } = await import("node:fs/promises");
      const remoteDir = await createTempDir("paperclip-syncback-links-remote-");
      await writeFile(
        path.join(remoteDir, "orig.bin"),
        Buffer.alloc(200 * 1024, 0x41),
      );
      for (let index = 0; index < 20; index += 1) {
        await link(
          path.join(remoteDir, "orig.bin"),
          path.join(remoteDir, `copy-${index}.bin`),
        );
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
    },
    TEST_TIMEOUT_MS,
  );
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
    for (const target of [
      "'./a.txt'",
      "'./sub/b.txt'",
      "'./-dash.txt'",
      "'./sp ace.txt'",
    ]) {
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

describe("buildSshRemoteStatusScript", () => {
  it("lists the whole tree with porcelain -z behind a toplevel guard", () => {
    const script = buildSshRemoteStatusScript(FAKE_REMOTE_ROOT);
    expect(script).toContain(
      `git -C '${FAKE_REMOTE_ROOT}' rev-parse --show-prefix`,
    );
    expect(script).toContain(
      `git -C '${FAKE_REMOTE_ROOT}' status --porcelain=v1 -z -uall`,
    );
    // Ignored creations must be visible or the sync-back silently drops them.
    expect(script).toContain("--ignored");
  });

  it(
    "succeeds at a repo root and fails closed in a subdir or non-repo",
    async () => {
      const repoDir = await createTempDir("paperclip-status-script-");
      await git(repoDir, ["init", "-b", "main"]);
      await git(repoDir, ["config", "user.email", "status-test@example.com"]);
      await git(repoDir, ["config", "user.name", "Status Test"]);
      await writeFile(path.join(repoDir, "dirty.txt"), "v1\n");
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-m", "initial"]);
      await writeFile(path.join(repoDir, "dirty.txt"), "v2\n");

      const atRoot = await runShell(buildSshRemoteStatusScript(repoDir));
      expect(atRoot.exitCode).toBe(0);
      expect(parseSshPorcelainStatusV1Z(atRoot.stdout).changedPaths).toEqual([
        "dirty.txt",
      ]);

      // Status paths are repo-root-relative, so a subdir remote must fail
      // (the caller falls back to the full copy) rather than silently
      // mis-resolve every path against the wrong root.
      const subDir = path.join(repoDir, "sub");
      await mkdir(subDir, { recursive: true });
      expect(
        (await runShell(buildSshRemoteStatusScript(subDir))).exitCode,
      ).not.toBe(0);

      const plainDir = await createTempDir("paperclip-status-plain-");
      expect(
        (await runShell(buildSshRemoteStatusScript(plainDir))).exitCode,
      ).not.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("resolveSshSyncBackTransferSets", () => {
  it("unions disjoint status and committed sets", () => {
    expect(
      resolveSshSyncBackTransferSets({
        status: {
          changedPaths: ["dirty.txt"],
          deletedPaths: ["gone.txt"],
          ignoredPaths: [],
        },
        committed: {
          changedPaths: ["new.txt"],
          deletedPaths: ["old.txt"],
          ignoredPaths: [],
        },
      }),
    ).toEqual({
      transferPaths: ["dirty.txt", "new.txt"],
      deletedPaths: ["gone.txt", "old.txt"],
    });
  });

  it("lets a worktree recreate win over a committed delete", () => {
    // The run committed a delete of f, then recreated f uncommitted: the
    // remote HAS f, so it transfers and is not deleted.
    expect(
      resolveSshSyncBackTransferSets({
        status: { changedPaths: ["f.txt"], deletedPaths: [], ignoredPaths: [] },
        committed: {
          changedPaths: [],
          deletedPaths: ["f.txt"],
          ignoredPaths: [],
        },
      }),
    ).toEqual({ transferPaths: ["f.txt"], deletedPaths: [] });
  });

  it("lets a worktree delete win over a committed add", () => {
    // The run committed f, then deleted it from the worktree: f is gone
    // remotely, so it must not be asked of tar (a missing member fails the
    // whole download) and lands in the delete set instead.
    expect(
      resolveSshSyncBackTransferSets({
        status: { changedPaths: [], deletedPaths: ["f.txt"], ignoredPaths: [] },
        committed: {
          changedPaths: ["f.txt"],
          deletedPaths: [],
          ignoredPaths: [],
        },
      }),
    ).toEqual({ transferPaths: [], deletedPaths: ["f.txt"] });
  });

  it("lets worktree presence win when status reports both changed and deleted", () => {
    // `git rm --cached f` (or a staged delete plus a recreate) emits both
    // `D  f` and `?? f`: the remote HAS f, so it transfers, never deletes.
    expect(
      resolveSshSyncBackTransferSets({
        status: {
          changedPaths: ["f.txt"],
          deletedPaths: ["f.txt"],
          ignoredPaths: [],
        },
        committed: { changedPaths: [], deletedPaths: [], ignoredPaths: [] },
      }),
    ).toEqual({ transferPaths: ["f.txt"], deletedPaths: [] });
  });

  it("dedupes and sorts both sets deterministically", () => {
    expect(
      resolveSshSyncBackTransferSets({
        status: {
          changedPaths: ["b.txt", "a.txt"],
          deletedPaths: ["z.txt"],
          ignoredPaths: [],
        },
        committed: {
          changedPaths: ["a.txt", "c.txt"],
          deletedPaths: ["z.txt", "y.txt"],
          ignoredPaths: [],
        },
      }),
    ).toEqual({
      transferPaths: ["a.txt", "b.txt", "c.txt"],
      deletedPaths: ["y.txt", "z.txt"],
    });
  });
});

describe("downloadChangedFilesFromSsh", () => {
  beforeEach(installStubSsh);

  async function writeTree(
    root: string,
    files: Record<string, string>,
  ): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(root, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
  }

  async function pathExists(target: string): Promise<boolean> {
    return await lstat(target).then(
      () => true,
      () => false,
    );
  }

  it(
    "transfers only the listed paths and honors excludes",
    async () => {
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

      await expect(
        readFile(path.join(stagingDir, "listed.txt"), "utf8"),
      ).resolves.toBe("listed\n");
      await expect(
        readFile(path.join(stagingDir, "sub/listed.txt"), "utf8"),
      ).resolves.toBe("nested listed\n");
      expect(await pathExists(path.join(stagingDir, "unlisted.txt"))).toBe(
        false,
      );
      expect(await pathExists(path.join(stagingDir, "node_modules"))).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "transfers awkward filenames byte-exact",
    async () => {
      const remoteDir = await createTempDir("paperclip-awkward-remote-");
      const names = ["-dash.txt", "sp ace.txt", "qu'ote.txt", "déjà.txt"];
      await writeTree(
        remoteDir,
        Object.fromEntries(names.map((name) => [name, `${name}\n`])),
      );
      const spec = buildStubSpec(remoteDir);
      const stagingDir = await createTempDir("paperclip-awkward-staging-");

      await downloadChangedFilesFromSsh({
        spec,
        remoteDir: FAKE_REMOTE_ROOT,
        stagingDir,
        paths: names,
      });

      for (const name of names) {
        await expect(
          readFile(path.join(stagingDir, name), "utf8"),
        ).resolves.toBe(`${name}\n`);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resolves without transferring when no paths changed",
    async () => {
      const remoteDir = await createTempDir("paperclip-empty-remote-");
      await writeFile(path.join(remoteDir, "a.txt"), "a\n");
      const spec = buildStubSpec(remoteDir);
      const stagingDir = await createTempDir("paperclip-empty-staging-");

      await downloadChangedFilesFromSsh({
        spec,
        remoteDir: FAKE_REMOTE_ROOT,
        stagingDir,
        paths: [],
      });

      expect(await readdir(stagingDir)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an over-cap transfer without completing the extraction",
    async () => {
      const remoteDir = await createTempDir("paperclip-changed-cap-remote-");
      await writeFile(
        path.join(remoteDir, "big.bin"),
        Buffer.alloc(64 * 1024, 0x41),
      );
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
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a path list that exceeds the remote command budget",
    async () => {
      const remoteDir = await createTempDir("paperclip-budget-remote-");
      const spec = buildStubSpec(remoteDir);
      const stagingDir = await createTempDir("paperclip-budget-staging-");
      // ~45 bytes per path once quoted: 5000 paths blow the ~124 KiB budget.
      const paths = Array.from(
        { length: 5000 },
        (_, index) => `dir-${index}/file-with-a-long-name-${index}.txt`,
      );

      const script = buildSshChangedFilesDownloadScript({
        remoteDir: FAKE_REMOTE_ROOT,
        paths,
      });
      expect(Buffer.byteLength(script, "utf8")).toBeGreaterThan(
        SSH_REMOTE_ARG_MAX_BYTES,
      );

      await expect(
        downloadChangedFilesFromSsh({
          spec,
          remoteDir: FAKE_REMOTE_ROOT,
          stagingDir,
          paths,
        }),
      ).rejects.toThrow(/budget/);
      expect(await readdir(stagingDir)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects when a listed path is missing remotely so the caller falls back",
    async () => {
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
    },
    TEST_TIMEOUT_MS,
  );
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
    await writeFile(
      path.join(binDir, "git"),
      `#!/bin/sh
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
`,
      { mode: 0o755 },
    );
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

  async function commitFile(
    repoDir: string,
    relative: string,
    content: string,
    message: string,
  ): Promise<string> {
    const full = path.join(repoDir, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-m", message]);
    return git(repoDir, ["rev-parse", "HEAD"]);
  }

  function gitRemoteClone(
    sourceDir: string,
    targetDir: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        ["clone", "-q", sourceDir, targetDir],
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error((stderr || stdout || error.message).trim()));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  it(
    "skips the bundle entirely when the remote made no commits",
    async () => {
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
        seedState: await cleanTreeSeedState(localDir),
      });

      expect(await bundleCreateArgvs(logPath)).toEqual([]);
      await expect(
        readFile(path.join(localDir, "tracked.txt"), "utf8"),
      ).resolves.toBe("v2\n");
      expect(await git(localDir, ["rev-parse", "HEAD"])).toBe(head);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "fetches only the new commits when the remote advanced",
    async () => {
      const localDir = await initRepo();
      const baseHead = await commitFile(
        localDir,
        "tracked.txt",
        "v1\n",
        "initial",
      );
      const remoteDir = await createTempDir("paperclip-bundle-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      await git(checkoutDir, [
        "config",
        "user.email",
        "bundle-test@example.com",
      ]);
      await git(checkoutDir, ["config", "user.name", "Bundle Test"]);
      await commitFile(checkoutDir, "tracked.txt", "v2\n", "remote work");
      const remoteHead = await commitFile(
        checkoutDir,
        "second.txt",
        "more\n",
        "remote work 2",
      );
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
        seedState: await cleanTreeSeedState(localDir),
      });

      const bundles = await bundleCreateArgvs(logPath);
      expect(bundles).toHaveLength(1);
      // baseHead carries the rev-parse trailing newline; the logged argv joins
      // args with spaces.
      expect(bundles[0]).toContain(`^${baseHead.trim()}`);
      expect(await git(localDir, ["rev-parse", "HEAD"])).toBe(remoteHead);
      await expect(
        readFile(path.join(localDir, "tracked.txt"), "utf8"),
      ).resolves.toBe("v2\n");
      await expect(
        readFile(path.join(localDir, "second.txt"), "utf8"),
      ).resolves.toBe("more\n");
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "falls back to the full bundle when the remote lacks the local base",
    async () => {
      const localDir = await initRepo();
      await commitFile(localDir, "local.txt", "local\n", "initial");
      // A remote with an unrelated history: the incremental `^base` range
      // cannot resolve there, so the export must retry as a full bundle.
      const remoteDir = await createTempDir("paperclip-bundle-remote-");
      const checkoutDir = path.join(remoteDir, "checkout");
      await mkdir(checkoutDir, { recursive: true });
      await git(checkoutDir, ["init", "-b", "main"]);
      await git(checkoutDir, [
        "config",
        "user.email",
        "bundle-test@example.com",
      ]);
      await git(checkoutDir, ["config", "user.name", "Bundle Test"]);
      const remoteHead = await commitFile(
        checkoutDir,
        "remote.txt",
        "remote\n",
        "unrelated root",
      );
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
      await expect(
        readFile(path.join(localDir, "remote.txt"), "utf8"),
      ).resolves.toBe("remote\n");
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "uses the full bundle when the incremental kill switch is set",
    async () => {
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
        seedState: await cleanTreeSeedState(localDir),
      });

      const bundles = await bundleCreateArgvs(logPath);
      expect(bundles).toHaveLength(1);
      expect(bundles[0]).not.toContain("^");
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "keeps reset semantics on the skip path: staged changes reset like the full export",
    async () => {
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
      await expect(
        readFile(path.join(localDir, "tracked.txt"), "utf8"),
      ).resolves.toBe("v1\n");
      expect(await git(localDir, ["status", "--porcelain"])).toBe("");
    },
    GIT_TIMEOUT_MS,
  );
});

describe("changed-files sync-back wiring", () => {
  const GIT_TIMEOUT_MS = 60_000;

  beforeEach(installStubSsh);

  async function initRepo(): Promise<string> {
    const repoDir = await createTempDir("paperclip-wire-repo-");
    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "wire-test@example.com"]);
    await git(repoDir, ["config", "user.name", "Wire Test"]);
    return repoDir;
  }

  async function commitFile(
    repoDir: string,
    relative: string,
    content: string,
    message: string,
  ): Promise<string> {
    const full = path.join(repoDir, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-m", message]);
    return git(repoDir, ["rev-parse", "HEAD"]);
  }

  function gitRemoteClone(
    sourceDir: string,
    targetDir: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        ["clone", "-q", sourceDir, targetDir],
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error((stderr || stdout || error.message).trim()));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  async function installSshArgvLog(): Promise<{ logPath: string }> {
    const logPath = path.join(
      await createTempDir("paperclip-ssh-log-"),
      "ssh-argv.log",
    );
    process.env.STUB_SSH_ARGV_LOG = logPath;
    return { logPath };
  }

  async function sshLogLines(logPath: string): Promise<string[]> {
    const content = await readFile(logPath, "utf8").catch(() => "");
    return content.split("\n").filter(Boolean);
  }

  // Full-tree and changed-files downloads both run `tar ... -cf - ...` on
  // the remote (only the excludes and targets are quoted, never the flags);
  // the tar-dialect probe (`tar --version`) and uploads (`tar -xf`) match
  // neither half of this filter.
  async function countTarDownloads(logPath: string): Promise<number> {
    return (await sshLogLines(logPath)).filter(
      (line) => line.includes("tar ") && line.includes("-cf"),
    ).length;
  }

  async function countStatusQueries(logPath: string): Promise<number> {
    return (await sshLogLines(logPath)).filter((line) =>
      line.includes("status --porcelain"),
    ).length;
  }

  function baselineExcludes(): string[] {
    return [".git", ".git/*", ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES];
  }

  it(
    "restores only the changed files under a cap the full tree would refuse",
    async () => {
      const localDir = await initRepo();
      await writeFile(
        path.join(localDir, "big.bin"),
        Buffer.alloc(1024 * 1024, 0x41),
      );
      await commitFile(localDir, "small.txt", "v1\n", "seed");
      const remoteDir = await createTempDir("paperclip-wire-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      // The run edited one small file without committing; the 1 MiB ballast
      // is untouched. A 64 KiB cap refuses the full tree but fits the delta.
      await writeFile(path.join(checkoutDir, "small.txt"), "v2\n");
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: await cleanTreeSeedState(localDir),
      });

      await expect(
        readFile(path.join(localDir, "small.txt"), "utf8"),
      ).resolves.toBe("v2\n");
      expect((await lstat(path.join(localDir, "big.bin"))).size).toBe(
        1024 * 1024,
      );
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "uses the full copy when the incremental kill switch is set",
    async () => {
      const localDir = await initRepo();
      await writeFile(
        path.join(localDir, "big.bin"),
        Buffer.alloc(1024 * 1024, 0x41),
      );
      await commitFile(localDir, "small.txt", "v1\n", "seed");
      const remoteDir = await createTempDir("paperclip-wire-kill-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      await writeFile(path.join(remoteDir, "checkout", "small.txt"), "v2\n");
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);
      process.env.PAPERCLIP_SSH_INCREMENTAL_SYNC = "0";

      const failure = await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
      expect(await countStatusQueries(logPath)).toBe(0);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "applies committed adds, deletes and dirty edits while keeping local-only edits",
    async () => {
      const localDir = await initRepo();
      await writeFile(
        path.join(localDir, "big.bin"),
        Buffer.alloc(1024 * 1024, 0x41),
      );
      await commitFile(localDir, "edit.txt", "v1\n", "seed edit");
      await commitFile(localDir, "del.txt", "bye\n", "seed del");
      await commitFile(localDir, "dirty.txt", "v1\n", "seed dirty");
      await commitFile(localDir, "local.txt", "v1\n", "seed local");
      const remoteDir = await createTempDir("paperclip-wire-mixed-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      await git(checkoutDir, ["config", "user.email", "wire-test@example.com"]);
      await git(checkoutDir, ["config", "user.name", "Wire Test"]);
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      // The run's committed work: a modification, an add, and a delete.
      await commitFile(checkoutDir, "edit.txt", "v2\n", "remote edit");
      await commitFile(checkoutDir, "new.txt", "new\n", "remote add");
      await git(checkoutDir, ["rm", "-q", "del.txt"]);
      await git(checkoutDir, ["commit", "-q", "-m", "remote delete"]);
      const remoteHead = await git(checkoutDir, ["rev-parse", "HEAD"]);
      // ...plus an uncommitted worktree edit.
      await writeFile(path.join(checkoutDir, "dirty.txt"), "v2dirty\n");
      // A concurrent local-only edit to a file the run never touched.
      await writeFile(path.join(localDir, "local.txt"), "local-v2\n");
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: await cleanTreeSeedState(localDir),
      });

      await expect(
        readFile(path.join(localDir, "edit.txt"), "utf8"),
      ).resolves.toBe("v2\n");
      await expect(
        readFile(path.join(localDir, "new.txt"), "utf8"),
      ).resolves.toBe("new\n");
      expect(
        await lstat(path.join(localDir, "del.txt")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      await expect(
        readFile(path.join(localDir, "dirty.txt"), "utf8"),
      ).resolves.toBe("v2dirty\n");
      await expect(
        readFile(path.join(localDir, "local.txt"), "utf8"),
      ).resolves.toBe("local-v2\n");
      expect(await git(localDir, ["rev-parse", "HEAD"])).toBe(remoteHead);
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "lets the worktree win over commits in both directions",
    async () => {
      const localDir = await initRepo();
      await writeFile(
        path.join(localDir, "big.bin"),
        Buffer.alloc(1024 * 1024, 0x41),
      );
      await commitFile(localDir, "recreate.txt", "v1\n", "seed");
      const remoteDir = await createTempDir(
        "paperclip-wire-precedence-remote-",
      );
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      await git(checkoutDir, ["config", "user.email", "wire-test@example.com"]);
      await git(checkoutDir, ["config", "user.name", "Wire Test"]);
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      // Committed a delete, then recreated the file uncommitted: the remote
      // HAS it, so it transfers and survives.
      await git(checkoutDir, ["rm", "-q", "recreate.txt"]);
      await git(checkoutDir, ["commit", "-q", "-m", "remote delete"]);
      await writeFile(path.join(checkoutDir, "recreate.txt"), "v2recreated\n");
      // Committed an add, then deleted it from the worktree: it must land in
      // the delete set, never in a tar request (a missing member fails the
      // whole download and would force a fallback the cap refuses).
      await commitFile(checkoutDir, "vanish.txt", "v1\n", "remote add");
      await rm(path.join(checkoutDir, "vanish.txt"));
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: await cleanTreeSeedState(localDir),
      });

      await expect(
        readFile(path.join(localDir, "recreate.txt"), "utf8"),
      ).resolves.toBe("v2recreated\n");
      expect(
        await lstat(path.join(localDir, "vanish.txt")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "falls back to the full copy when the changed list exceeds the command budget",
    async () => {
      const localDir = await initRepo();
      await commitFile(localDir, "seed.txt", "seed\n", "seed");
      const remoteDir = await createTempDir("paperclip-wire-budget-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      await git(checkoutDir, ["config", "user.email", "wire-test@example.com"]);
      await git(checkoutDir, ["config", "user.name", "Wire Test"]);
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      // 5000 committed files: the incremental list blows the ~124 KiB remote
      // command budget, so the restore must fall back to the full copy and
      // still succeed (no cap set: the default 2 GiB fits trivially).
      for (let index = 0; index < 5000; index += 1) {
        const full = path.join(
          checkoutDir,
          `dir-${index}`,
          `file-with-a-long-name-${index}.txt`,
        );
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, `content ${index}\n`);
      }
      await git(checkoutDir, ["add", "-A"]);
      await git(checkoutDir, ["commit", "-q", "-m", "remote bulk add"]);
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: await cleanTreeSeedState(localDir),
      });

      await expect(
        readFile(
          path.join(localDir, "dir-4999", "file-with-a-long-name-4999.txt"),
          "utf8",
        ),
      ).resolves.toBe("content 4999\n");
      // The incremental path was attempted (status ran) but the single tar
      // download is the full-copy fallback.
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "refuses an over-cap delta without retrying the larger full copy",
    async () => {
      const localDir = await initRepo();
      await commitFile(localDir, "seed.txt", "seed\n", "seed");
      const remoteDir = await createTempDir("paperclip-wire-cap-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      // The delta itself exceeds the cap: the failure must propagate, not fall
      // back — the full copy is a superset, so it would refuse too, after
      // burning a second transfer.
      await writeFile(
        path.join(checkoutDir, "big-changed.bin"),
        Buffer.alloc(256 * 1024, 0x42),
      );
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

      const failure = await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: await cleanTreeSeedState(localDir),
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "falls back to the full copy without a status round trip when the histories share no base",
    async () => {
      const localDir = await initRepo();
      await commitFile(localDir, "local.txt", "local\n", "initial");
      // A remote with an unrelated history: the local merge-base fails first,
      // so no status round trip is spent and the restore falls back to the
      // full copy (which grafts the imported history like today).
      const remoteDir = await createTempDir("paperclip-wire-unrelated-remote-");
      const checkoutDir = path.join(remoteDir, "checkout");
      await mkdir(checkoutDir, { recursive: true });
      await git(checkoutDir, ["init", "-b", "main"]);
      await git(checkoutDir, ["config", "user.email", "wire-test@example.com"]);
      await git(checkoutDir, ["config", "user.name", "Wire Test"]);
      const remoteHead = await commitFile(
        checkoutDir,
        "remote.txt",
        "remote\n",
        "unrelated root",
      );
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: await cleanTreeSeedState(localDir),
      });

      await expect(
        readFile(path.join(localDir, "remote.txt"), "utf8"),
      ).resolves.toBe("remote\n");
      // The graft records the import in the commit body (single parent: the
      // previous local head), so the full body — not --oneline — carries it.
      const graftBody = await git(localDir, ["log", "-1", "--format=%B"]);
      expect(graftBody).toContain("(Paperclip SSH sync graft");
      expect(await git(localDir, ["rev-parse", "HEAD"])).not.toBe(remoteHead);
      expect(await countStatusQueries(logPath)).toBe(0);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "keeps a remotely rm-cached file instead of deleting the local copy",
    async () => {
      const localDir = await initRepo();
      await writeFile(
        path.join(localDir, "big.bin"),
        Buffer.alloc(1024 * 1024, 0x41),
      );
      await commitFile(localDir, "foo.txt", "v1\n", "seed");
      const remoteDir = await createTempDir("paperclip-wire-rmcached-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      // `git rm --cached` stages a delete while the file stays on disk: real
      // git reports BOTH `D  foo.txt` and `?? foo.txt`. The worktree has the
      // file, so it must transfer — never land in the delete set.
      await git(checkoutDir, ["rm", "--cached", "-q", "foo.txt"]);
      await writeFile(path.join(checkoutDir, "foo.txt"), "v2remote\n");
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: await cleanTreeSeedState(localDir),
      });

      await expect(
        readFile(path.join(localDir, "foo.txt"), "utf8"),
      ).resolves.toBe("v2remote\n");
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "heals a seeded dirty file the run reverted to HEAD",
    async () => {
      const localDir = await initRepo();
      await writeFile(
        path.join(localDir, "big.bin"),
        Buffer.alloc(1024 * 1024, 0x41),
      );
      await commitFile(localDir, "dirty.txt", "base\n", "seed");
      const seedHead = (await git(localDir, ["rev-parse", "HEAD"])).trim();
      // Seeded dirt: the local tree is dirty when the seed carries it.
      await writeFile(path.join(localDir, "dirty.txt"), "localEdit\n");
      const remoteDir = await createTempDir("paperclip-wire-revert-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      // The seed overlay lands remotely, then the run reverts it to HEAD:
      // remote status is clean and the committed diff is empty, so only the
      // seed overlay names this file as a transfer candidate.
      await writeFile(path.join(checkoutDir, "dirty.txt"), "localEdit\n");
      await git(checkoutDir, ["checkout", "--", "dirty.txt"]);
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: { headCommit: seedHead, overlayPaths: ["dirty.txt"] },
      });

      await expect(
        readFile(path.join(localDir, "dirty.txt"), "utf8"),
      ).resolves.toBe("base\n");
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "falls back to the full copy when the run deleted a seeded untracked file",
    async () => {
      const localDir = await initRepo();
      await commitFile(localDir, "seed.txt", "seed\n", "seed");
      const seedHead = (await git(localDir, ["rev-parse", "HEAD"])).trim();
      await writeFile(
        path.join(localDir, "untracked.txt"),
        "seeded untracked\n",
      );
      const remoteDir = await createTempDir(
        "paperclip-wire-seeddelete-remote-",
      );
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      // The seed overlay lands remotely, then the run deletes it: status is
      // clean, so the overlay candidate is the only trace. It is absent
      // remotely, so the delta download rejects and the full-copy fallback
      // heals the local tree (no cap: the fallback must fit).
      await writeFile(
        path.join(checkoutDir, "untracked.txt"),
        "seeded untracked\n",
      );
      await rm(path.join(checkoutDir, "untracked.txt"));
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: { headCommit: seedHead, overlayPaths: ["untracked.txt"] },
      });

      expect(
        await lstat(path.join(localDir, "untracked.txt")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(await countStatusQueries(logPath)).toBe(1);
      // The delta download plus the full-copy fallback.
      expect(await countTarDownloads(logPath)).toBe(2);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "restores an ignored file the run created when none existed at seed time",
    async () => {
      const localDir = await initRepo();
      await writeFile(
        path.join(localDir, "big.bin"),
        Buffer.alloc(1024 * 1024, 0x41),
      );
      await writeFile(path.join(localDir, ".gitignore"), "*.log\n");
      await commitFile(localDir, "seed.txt", "seed\n", "seed");
      const remoteDir = await createTempDir("paperclip-wire-ignored-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      // No .log file exists locally at seed time, so no ignored entry is
      // baseline-blind here; the run's creation must come back.
      await writeFile(path.join(checkoutDir, "run.log"), "remote log\n");
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: await cleanTreeSeedState(localDir),
      });

      await expect(
        readFile(path.join(localDir, "run.log"), "utf8"),
      ).resolves.toBe("remote log\n");
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "leaves seed-time ignored files in place instead of re-transferring them",
    async () => {
      const localDir = await initRepo();
      await writeFile(path.join(localDir, ".gitignore"), "*.log\n");
      await commitFile(localDir, "seed.txt", "seed\n", "seed");
      // A legacy-style baseline: the ignored file is IN the baseline (never
      // transferred on the incremental path), not in its excludes.
      const ignoredBytes = Buffer.alloc(256 * 1024, 0x43);
      await writeFile(path.join(localDir, "big.log"), ignoredBytes);
      const remoteDir = await createTempDir(
        "paperclip-wire-ignoredkeep-remote-",
      );
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      await writeFile(path.join(checkoutDir, "big.log"), ignoredBytes);
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      // Below the ignored file's size: transferring it would refuse.
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: await cleanTreeSeedState(localDir),
      });

      await expect(readFile(path.join(localDir, "big.log"))).resolves.toEqual(
        ignoredBytes,
      );
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(0);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "heals a retry whose first attempt advanced the branch without applying files",
    async () => {
      const localDir = await initRepo();
      await writeFile(
        path.join(localDir, "big.bin"),
        Buffer.alloc(1024 * 1024, 0x41),
      );
      await commitFile(localDir, "f.txt", "v1\n", "seed");
      const seedHead = (await git(localDir, ["rev-parse", "HEAD"])).trim();
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const remoteDir = await createTempDir("paperclip-wire-retry-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      await git(checkoutDir, ["config", "user.email", "wire-test@example.com"]);
      await git(checkoutDir, ["config", "user.name", "Wire Test"]);
      await commitFile(checkoutDir, "f.txt", "v2\n", "remote edit");
      await commitFile(checkoutDir, "new.txt", "new\n", "remote add");
      const remoteHead = (await git(checkoutDir, ["rev-parse", "HEAD"])).trim();
      // The interrupted-merge state: beforeApply already moved the local
      // branch to the imported head, but the worktree still holds pre-run
      // files. A delta rooted at the local head would be empty here; the
      // seed head still names the run's work.
      await git(localDir, ["fetch", checkoutDir, "main"]);
      await git(localDir, ["update-ref", "refs/heads/main", remoteHead]);
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();
      process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
        seedState: { headCommit: seedHead, overlayPaths: [] },
      });

      await expect(
        readFile(path.join(localDir, "f.txt"), "utf8"),
      ).resolves.toBe("v2\n");
      await expect(
        readFile(path.join(localDir, "new.txt"), "utf8"),
      ).resolves.toBe("new\n");
      expect(await countStatusQueries(logPath)).toBe(1);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "falls back to the full copy without a status round trip when the seed state is omitted",
    async () => {
      const localDir = await initRepo();
      await commitFile(localDir, "tracked.txt", "v1\n", "seed");
      const remoteDir = await createTempDir("paperclip-wire-noseed-remote-");
      await gitRemoteClone(localDir, path.join(remoteDir, "checkout"));
      const checkoutDir = path.join(remoteDir, "checkout");
      await writeFile(path.join(checkoutDir, "tracked.txt"), "v2\n");
      const baseline = await captureDirectorySnapshot(localDir, {
        exclude: baselineExcludes(),
      });
      const spec = buildStubSpec(remoteDir);
      const { logPath } = await installSshArgvLog();

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir,
        remoteDir: `${FAKE_REMOTE_ROOT}/checkout`,
        baselineSnapshot: baseline,
        restoreGitHistory: true,
      });

      await expect(
        readFile(path.join(localDir, "tracked.txt"), "utf8"),
      ).resolves.toBe("v2\n");
      expect(await countStatusQueries(logPath)).toBe(0);
      expect(await countTarDownloads(logPath)).toBe(1);
    },
    GIT_TIMEOUT_MS,
  );
});
