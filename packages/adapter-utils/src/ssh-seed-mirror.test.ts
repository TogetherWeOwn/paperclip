import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  isSshIncrementalSyncEnabled,
  prepareWorkspaceForSshExecution,
  resolveSshSeedMirrorRoot,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  type SshEnvLabFixtureState,
  type SshRemoteExecutionSpec,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "./ssh.js";
import {
  escapeTarExcludeLiteral,
  SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES,
} from "./ssh-workspace-excludes.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// Mirror-seed tests run the real seed functions against a fake `ssh` that
// executes the trailing `sh -c` payload locally after remapping the fake
// remote root to a fixture directory (same pattern as
// ssh-sync-back-guard.test.ts). The stub IS the same-host condition: local
// paths are visible to the "remote" payloads, so the fast path triggers and
// every assertion below runs without an SSH lab.
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

const SSH_SEED_MIRROR_TEST_TIMEOUT_MS = 60_000;
const originalPath = process.env.PATH ?? "";
const fixtureRoots: string[] = [];
const tempDirs: string[] = [];
let sshEnvLabUnsupportedReason: string | null = null;

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createFixtureRootDir(prefix: string): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtureRoots.push(rootDir);
  return rootDir;
}

async function installStubSsh(): Promise<void> {
  const binDir = await createFixtureRootDir("paperclip-seed-stub-ssh-bin-");
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

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function pathExists(target: string): Promise<boolean> {
  return await lstat(target).then(
    () => true,
    () => false,
  );
}

/** A repo with committed, modified, deleted, untracked, and ignored files. */
async function initSeedTestRepo(): Promise<{
  repoDir: string;
  head: string;
  branch: string;
}> {
  const repoDir = await createTempDir("paperclip-ssh-seed-repo-");
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.email", "seed-test@example.com"]);
  await git(repoDir, ["config", "user.name", "Seed Test"]);
  await git(repoDir, [
    "remote",
    "add",
    "origin",
    "https://example.com/test/seed-repo.git",
  ]);
  await writeFile(path.join(repoDir, ".gitignore"), "nested/\n*.log\n.env\n");
  await writeFile(path.join(repoDir, "tracked.txt"), "v1\n");
  await writeFile(path.join(repoDir, "modified.txt"), "original\n");
  await writeFile(path.join(repoDir, "deleted.txt"), "gone\n");
  // Tracked source nested under a name the root ignore also uses: anchoring
  // the `nested` exclude must not hide this from the sync-back. A no-slash
  // `nested/` ignore matches at every depth, so plain `add -A` skips this
  // file; force-add it to make it tracked (the documented edge: tracked
  // files under an ignored-name directory travel with the checkout, and the
  // root-anchored merge grammar still sees them).
  await mkdir(path.join(repoDir, "src", "nested"), { recursive: true });
  await writeFile(
    path.join(repoDir, "src", "nested", "keep.txt"),
    "nested source\n",
  );
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["add", "-f", "src/nested/keep.txt"]);
  await git(repoDir, ["commit", "-m", "initial"]);
  // Working-tree delta the seed must carry: one modification, one deletion,
  // two untracked files (one executable), and ignored files that must not.
  await writeFile(path.join(repoDir, "modified.txt"), "changed\n");
  await rm(path.join(repoDir, "deleted.txt"));
  await writeFile(path.join(repoDir, "untracked.txt"), "new file\n");
  await writeFile(path.join(repoDir, "run-me.sh"), "#!/bin/sh\necho hi\n", {
    mode: 0o755,
  });
  await writeFile(path.join(repoDir, "app.log"), "ignored log\n");
  await writeFile(path.join(repoDir, ".env"), "LOCAL=1\n");
  await mkdir(path.join(repoDir, "nested", "node_modules"), {
    recursive: true,
  });
  await writeFile(
    path.join(repoDir, "nested", "node_modules", "junk.txt"),
    "ignored junk\n",
  );
  const head = await git(repoDir, ["rev-parse", "HEAD"]);
  const branch = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { repoDir, head, branch };
}

async function withMirrorEnv<T>(
  mirrorRoot: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const key = "PAPERCLIP_SSH_MIRROR_ROOT";
  const previous = process.env[key];
  if (mirrorRoot === null) delete process.env[key];
  else process.env[key] = mirrorRoot;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

async function withIncrementalEnv<T>(
  value: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const key = "PAPERCLIP_SSH_INCREMENTAL_SYNC";
  const previous = process.env[key];
  if (value === null) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

describe("ssh seed mirror", () => {
  beforeEach(installStubSsh);

  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.STUB_SSH_REMOTE_ROOT;
    delete process.env.STUB_SSH_FIXTURE_DIR;
    while (fixtureRoots.length > 0) {
      const dir = fixtureRoots.pop();
      if (dir)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("resolves incremental-sync env config", () => {
    expect(isSshIncrementalSyncEnabled({})).toBe(true);
    expect(
      isSshIncrementalSyncEnabled({ PAPERCLIP_SSH_INCREMENTAL_SYNC: "0" }),
    ).toBe(false);
    expect(
      isSshIncrementalSyncEnabled({ PAPERCLIP_SSH_INCREMENTAL_SYNC: " 0 " }),
    ).toBe(false);
    expect(
      isSshIncrementalSyncEnabled({ PAPERCLIP_SSH_INCREMENTAL_SYNC: "1" }),
    ).toBe(true);
    expect(resolveSshSeedMirrorRoot({})).toBe(
      path.join(os.homedir(), ".cache", "paperclip", "ssh-seed-mirrors"),
    );
    expect(
      resolveSshSeedMirrorRoot({ PAPERCLIP_SSH_MIRROR_ROOT: " /tmp/mirrors " }),
    ).toBe("/tmp/mirrors");
  });

  it("escapes glob metacharacters in literal tar excludes", () => {
    expect(escapeTarExcludeLiteral("nested")).toBe("nested");
    expect(escapeTarExcludeLiteral("we*ird?.log")).toBe("we\\*ird\\?.log");
    expect(escapeTarExcludeLiteral("br[acket")).toBe("br\\[acket");
    expect(escapeTarExcludeLiteral("back\\slash")).toBe("back\\\\slash");
  });

  it(
    "seeds a same-host workspace from the shared mirror",
    async () => {
      const { repoDir, head, branch } = await initSeedTestRepo();
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const remoteDir = `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`;
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");
      const progressLines: string[] = [];

      const prepared = await withMirrorEnv(mirrorRoot, () =>
        prepareWorkspaceForSshExecution({
          spec,
          localDir: repoDir,
          remoteDir,
          onProgress: async (line) => {
            progressLines.push(line);
          },
        }),
      );

      expect(prepared.gitBacked).toBe(true);
      expect(prepared.seedMode).toBe("shared-mirror");
      expect(prepared.ignoredPaths).toEqual(
        expect.arrayContaining(["nested", "app.log", ".env"]),
      );
      // The history phase still reports, with zero wire bytes from the mirror.
      expect(
        progressLines.some((line) => line.includes("Importing git history")),
      ).toBe(true);

      // Exactly one mirror serves this repo.
      const mirrors = await readdir(mirrorRoot);
      expect(mirrors).toHaveLength(1);
      expect(mirrors[0]).toMatch(/^[0-9a-f]{32}\.git$/);

      expect(await git(localRemoteDir, ["rev-parse", "HEAD"])).toBe(head);
      expect(
        await git(localRemoteDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      ).toBe(branch);
      expect(await git(localRemoteDir, ["remote", "get-url", "origin"])).toBe(
        "https://example.com/test/seed-repo.git",
      );
      await expect(
        readFile(path.join(localRemoteDir, "tracked.txt"), "utf8"),
      ).resolves.toBe("v1\n");
      await expect(
        readFile(path.join(localRemoteDir, "modified.txt"), "utf8"),
      ).resolves.toBe("changed\n");
      await expect(
        readFile(path.join(localRemoteDir, "untracked.txt"), "utf8"),
      ).resolves.toBe("new file\n");
      await expect(
        readFile(
          path.join(localRemoteDir, "src", "nested", "keep.txt"),
          "utf8",
        ),
      ).resolves.toBe("nested source\n");
      expect(
        (await lstat(path.join(localRemoteDir, "run-me.sh"))).mode & 0o111,
      ).not.toBe(0);
      // Deleted locally: absent remotely. Ignored: never transferred.
      expect(await pathExists(path.join(localRemoteDir, "deleted.txt"))).toBe(
        false,
      );
      for (const ignored of ["nested", "app.log", ".env"]) {
        expect(
          await pathExists(path.join(localRemoteDir, ignored)),
          ignored,
        ).toBe(false);
      }
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "reuses one mirror across runs",
    async () => {
      const { repoDir, head } = await initSeedTestRepo();
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);

      await withMirrorEnv(mirrorRoot, async () => {
        for (let run = 0; run < 2; run += 1) {
          const runId = randomUUID();
          const prepared = await prepareWorkspaceForSshExecution({
            spec,
            localDir: repoDir,
            remoteDir: `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`,
          });
          expect(prepared.seedMode).toBe("shared-mirror");
          expect(
            await git(path.join(fixtureDir, "runs", runId, "workspace"), [
              "rev-parse",
              "HEAD",
            ]),
          ).toBe(head);
        }
      });
      expect(await readdir(mirrorRoot)).toHaveLength(1);
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "seeds detached-HEAD workspaces from the mirror",
    async () => {
      const { repoDir, head } = await initSeedTestRepo();
      await git(repoDir, ["checkout", "--detach", "HEAD"]);
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");

      const prepared = await withMirrorEnv(mirrorRoot, () =>
        prepareWorkspaceForSshExecution({
          spec,
          localDir: repoDir,
          remoteDir: `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`,
        }),
      );

      expect(prepared.seedMode).toBe("shared-mirror");
      expect(await git(localRemoteDir, ["rev-parse", "HEAD"])).toBe(head);
      expect(
        await git(localRemoteDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      ).toBe("HEAD");
      await expect(
        readFile(path.join(localRemoteDir, "modified.txt"), "utf8"),
      ).resolves.toBe("changed\n");
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "falls back to the full copy when incremental sync is disabled",
    async () => {
      const { repoDir, head } = await initSeedTestRepo();
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");

      const prepared = await withMirrorEnv(mirrorRoot, () =>
        withIncrementalEnv("0", () =>
          prepareWorkspaceForSshExecution({
            spec,
            localDir: repoDir,
            remoteDir: `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`,
          }),
        ),
      );

      expect(prepared.gitBacked).toBe(true);
      expect(prepared.seedMode).toBe("full-copy");
      expect(prepared.ignoredPaths).toBeUndefined();
      expect(await readdir(mirrorRoot)).toHaveLength(0);
      expect(await git(localRemoteDir, ["rev-parse", "HEAD"])).toBe(head);
      await expect(
        readFile(path.join(localRemoteDir, "modified.txt"), "utf8"),
      ).resolves.toBe("changed\n");
      // Legacy behavior preserved: ignored files transfer with the full tree.
      await expect(
        readFile(
          path.join(localRemoteDir, "nested", "node_modules", "junk.txt"),
          "utf8",
        ),
      ).resolves.toBe("ignored junk\n");
      await expect(
        readFile(path.join(localRemoteDir, "app.log"), "utf8"),
      ).resolves.toBe("ignored log\n");
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "falls back to the full copy when the mirror cannot be created",
    async () => {
      const { repoDir, head } = await initSeedTestRepo();
      // A file where the mirror root must be: every mirror op fails.
      const blocker = path.join(
        await createTempDir("paperclip-ssh-mirror-blocker-"),
        "blocker",
      );
      await writeFile(blocker, "not a directory\n");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");

      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      try {
        const prepared = await withMirrorEnv(blocker, () =>
          prepareWorkspaceForSshExecution({
            spec,
            localDir: repoDir,
            remoteDir: `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`,
          }),
        );
        expect(prepared.seedMode).toBe("full-copy");
        expect(await git(localRemoteDir, ["rev-parse", "HEAD"])).toBe(head);
        await expect(
          readFile(path.join(localRemoteDir, "modified.txt"), "utf8"),
        ).resolves.toBe("changed\n");
      } finally {
        console.warn = originalWarn;
      }
      expect(
        warnings.some((args) =>
          String(args[1] ?? args[0]).includes("falling back to full copy"),
        ),
      ).toBe(true);
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "seeds non-git directories with the full copy",
    async () => {
      const localDir = await createTempDir("paperclip-ssh-seed-plain-");
      await writeFile(path.join(localDir, "notes.txt"), "plain\n");
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");

      const prepared = await withMirrorEnv(mirrorRoot, () =>
        prepareWorkspaceForSshExecution({
          spec,
          localDir,
          remoteDir: `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`,
        }),
      );

      expect(prepared.gitBacked).toBe(false);
      expect(prepared.seedMode).toBe("full-copy");
      await expect(
        readFile(path.join(localRemoteDir, "notes.txt"), "utf8"),
      ).resolves.toBe("plain\n");
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "falls back to the full copy for a subdirectory workspace",
    async () => {
      const { repoDir, head } = await initSeedTestRepo();
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");

      // Overlay paths are toplevel-relative, so a subdir seed cannot stage them:
      // the legacy import carries the workspace instead.
      const prepared = await withMirrorEnv(mirrorRoot, () =>
        prepareWorkspaceForSshExecution({
          spec,
          localDir: path.join(repoDir, "src"),
          remoteDir: `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`,
        }),
      );

      expect(prepared.gitBacked).toBe(true);
      expect(prepared.seedMode).toBe("full-copy");
      expect(await git(localRemoteDir, ["rev-parse", "HEAD"])).toBe(head);
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "preserves local-only ignored files across a baseline restore",
    async () => {
      const { repoDir } = await initSeedTestRepo();
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const remoteDir = `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`;
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");

      const prepared = await withMirrorEnv(mirrorRoot, () =>
        prepareWorkspaceForSshExecution({ spec, localDir: repoDir, remoteDir }),
      );
      expect(prepared.seedMode).toBe("shared-mirror");

      // Same pairing as prepareRemoteManagedRuntime: baseline captured after the
      // seed, with the seed's ignored list added to the excludes.
      const baselineSnapshot = await captureDirectorySnapshot(repoDir, {
        exclude: [
          ...GIT_ARCHIVE_EXCLUDES,
          ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES,
          ...(prepared.ignoredPaths ?? []),
        ],
      });

      // The remote run edits a tracked file, writes its own ignored files, and
      // deletes a tracked file nested under an ignored name.
      await writeFile(
        path.join(localRemoteDir, "tracked.txt"),
        "v1\nremote-edit\n",
      );
      await writeFile(path.join(localRemoteDir, ".env"), "REMOTE=1\n");
      await rm(path.join(localRemoteDir, "src", "nested", "keep.txt"));

      await restoreWorkspaceFromSshExecution({
        spec,
        localDir: repoDir,
        remoteDir,
        baselineSnapshot,
        restoreGitHistory: true,
        ignoredPaths: prepared.ignoredPaths,
      });

      // Tracked remote edits land; local-only ignored files survive untouched;
      // the anchored `nested` exclude does not hide `src/nested/` changes.
      await expect(
        readFile(path.join(repoDir, "tracked.txt"), "utf8"),
      ).resolves.toBe("v1\nremote-edit\n");
      await expect(readFile(path.join(repoDir, ".env"), "utf8")).resolves.toBe(
        "LOCAL=1\n",
      );
      await expect(
        readFile(
          path.join(repoDir, "nested", "node_modules", "junk.txt"),
          "utf8",
        ),
      ).resolves.toBe("ignored junk\n");
      await expect(
        readFile(path.join(repoDir, "modified.txt"), "utf8"),
      ).resolves.toBe("changed\n");
      expect(
        await pathExists(path.join(repoDir, "src", "nested", "keep.txt")),
      ).toBe(false);
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "decomposes staged renames into delete plus add",
    async () => {
      const { repoDir } = await initSeedTestRepo();
      await git(repoDir, ["mv", "tracked.txt", "renamed.txt"]);
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");

      const prepared = await withMirrorEnv(mirrorRoot, () =>
        prepareWorkspaceForSshExecution({
          spec,
          localDir: repoDir,
          remoteDir: `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`,
        }),
      );

      expect(prepared.seedMode).toBe("shared-mirror");
      // Rename detection would hide the old name from the deleted scan and
      // leave a stale HEAD checkout of it on the remote.
      await expect(
        readFile(path.join(localRemoteDir, "renamed.txt"), "utf8"),
      ).resolves.toBe("v1\n");
      expect(await pathExists(path.join(localRemoteDir, "tracked.txt"))).toBe(
        false,
      );
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "keeps index-removed files that are still on disk",
    async () => {
      const { repoDir } = await initSeedTestRepo();
      await git(repoDir, ["rm", "--cached", "tracked.txt"]);
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const remoteDir = `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`;
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");

      const prepared = await withMirrorEnv(mirrorRoot, () =>
        prepareWorkspaceForSshExecution({ spec, localDir: repoDir, remoteDir }),
      );
      expect(prepared.seedMode).toBe("shared-mirror");
      // The D scan reports rm --cached files, but the file is on disk and the
      // overlay carries it, so the remote must keep it.
      await expect(
        readFile(path.join(localRemoteDir, "tracked.txt"), "utf8"),
      ).resolves.toBe("v1\n");

      // A restore with no remote changes must not read the seed back as a
      // remote deletion of the local file.
      const baselineSnapshot = await captureDirectorySnapshot(repoDir, {
        exclude: [
          ...GIT_ARCHIVE_EXCLUDES,
          ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES,
          ...(prepared.ignoredPaths ?? []),
        ],
      });
      await restoreWorkspaceFromSshExecution({
        spec,
        localDir: repoDir,
        remoteDir,
        baselineSnapshot,
        restoreGitHistory: false,
        ignoredPaths: prepared.ignoredPaths,
      });
      await expect(
        readFile(path.join(repoDir, "tracked.txt"), "utf8"),
      ).resolves.toBe("v1\n");
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );

  it(
    "falls back to the full copy when ignored excludes exceed the restore budget",
    async () => {
      const { repoDir, head } = await initSeedTestRepo();
      // Individually-ignored files inside tracked directories: `--directory`
      // cannot collapse them, so each becomes its own restore exclude.
      for (let index = 0; index < 350; index += 1) {
        const name = `bulk-ignored-${String(index).padStart(4, "0")}-padding-to-grow-the-exclude-list.log`;
        await writeFile(path.join(repoDir, name), "ignored bulk\n");
      }
      const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
      const fixtureDir = await createFixtureRootDir("paperclip-seed-remote-");
      const spec = buildStubSpec(fixtureDir);
      const runId = randomUUID();
      const localRemoteDir = path.join(fixtureDir, "runs", runId, "workspace");

      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      try {
        const prepared = await withMirrorEnv(mirrorRoot, () =>
          prepareWorkspaceForSshExecution({
            spec,
            localDir: repoDir,
            remoteDir: `${FAKE_REMOTE_ROOT}/runs/${runId}/workspace`,
          }),
        );
        expect(prepared.seedMode).toBe("full-copy");
        expect(prepared.ignoredPaths).toBeUndefined();
        expect(await readdir(mirrorRoot)).toHaveLength(0);
        expect(await git(localRemoteDir, ["rev-parse", "HEAD"])).toBe(head);
        // Legacy behavior preserved: ignored files transfer with the full tree.
        await expect(
          readFile(
            path.join(
              localRemoteDir,
              "bulk-ignored-0000-padding-to-grow-the-exclude-list.log",
            ),
            "utf8",
          ),
        ).resolves.toBe("ignored bulk\n");
      } finally {
        console.warn = originalWarn;
      }
      expect(
        warnings.some((args) =>
          String(args[1] ?? args[0]).includes("restore command budget"),
        ),
      ).toBe(true);
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );
});

describe("ssh seed mirror over a real ssh transport", () => {
  it(
    "seeds from the mirror through the ssh lab fixture",
    async () => {
      const rootDir = await mkdtemp(
        path.join(os.tmpdir(), "paperclip-ssh-seed-lab-"),
      );
      try {
        if (sshEnvLabUnsupportedReason) {
          console.warn(
            `Skipping ssh-lab mirror seed test: ${sshEnvLabUnsupportedReason}`,
          );
          return;
        }
        const support = await getSshEnvLabSupport();
        if (!support.supported) {
          sshEnvLabUnsupportedReason =
            support.reason ?? "unsupported environment";
          console.warn(
            `Skipping ssh-lab mirror seed test: ${sshEnvLabUnsupportedReason}`,
          );
          return;
        }
        let state: SshEnvLabFixtureState | null = null;
        try {
          state = await startSshEnvLabFixture({
            statePath: path.join(rootDir, "state.json"),
          });
        } catch (error) {
          sshEnvLabUnsupportedReason =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `Skipping ssh-lab mirror seed test: ${sshEnvLabUnsupportedReason}`,
          );
          return;
        }
        try {
          const { repoDir, head } = await initSeedTestRepo();
          const mirrorRoot = await createTempDir("paperclip-ssh-mirrors-");
          const config = await buildSshEnvLabFixtureConfig(state);
          const spec: SshRemoteExecutionSpec = {
            ...config,
            remoteCwd: state.workspaceDir,
          };
          const remoteDir = `${state.workspaceDir}/runs/${randomUUID()}/workspace`;

          const prepared = await withMirrorEnv(mirrorRoot, () =>
            prepareWorkspaceForSshExecution({
              spec,
              localDir: repoDir,
              remoteDir,
            }),
          );
          expect(prepared.seedMode).toBe("shared-mirror");
          const remoteHead = await runSshCommand(
            spec,
            `git -C '${remoteDir}' rev-parse HEAD`,
            {
              timeoutMs: 30_000,
              maxBuffer: 16 * 1024,
            },
          );
          expect(remoteHead.stdout.trim()).toBe(head);
        } finally {
          await stopSshEnvLabFixture(state).catch(() => undefined);
        }
      } finally {
        await rm(rootDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
        while (tempDirs.length > 0) {
          const dir = tempDirs.pop();
          if (dir)
            await rm(dir, { recursive: true, force: true }).catch(
              () => undefined,
            );
        }
      }
    },
    SSH_SEED_MIRROR_TEST_TIMEOUT_MS,
  );
});
