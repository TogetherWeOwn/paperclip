import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES,
  type SshRemoteExecutionSpec,
  SshSyncBackSizeLimitExceededError,
} from "./ssh.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// Acceptance contract: full-copy transfer obeys repository .gitignore, never
// host-global/info excludes. Tracked files win over ignore rules. Without a
// Git index, .gitignore is inert and the existing safe plain-copy path remains.
// Run alone with --maxWorkers=1 --no-file-parallelism; no real SSH host is used.
const REMOTE = "/acceptance-ssh-remote";
const exec = promisify(execFile);
const scratch =
  process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
  process.env.PAPERCLIP_SCRATCH_DIR ??
  os.tmpdir();
let root: string;
let local: string;
let remote: string;
let spec: SshRemoteExecutionSpec;

// Both shims share a locked, per-test launch budget. They cannot call the live
// managed launcher: PATH is replaced, and git execs a verified absolute ELF.
const GUARD = `import fcntl, os, sys
with open(os.environ["ACCEPTANCE_LAUNCH_COUNT"], "a+") as counter:
    fcntl.flock(counter, fcntl.LOCK_EX)
    counter.seek(0)
    count = int(counter.read() or "0") + 1
    if count > 400:
        sys.exit("acceptance subprocess launch budget exceeded")
    counter.seek(0)
    counter.truncate()
    counter.write(str(count))
`;
const FAKE_SSH = `#!/usr/bin/python3
${GUARD}
import shlex, signal, subprocess
if os.environ.get("ACCEPTANCE_SSH_DEPTH"):
    sys.exit("recursive fake SSH refused")
os.environ["ACCEPTANCE_SSH_DEPTH"] = "1"
args = shlex.split(sys.argv[-1])
if len(args) != 3 or args[:2] != ["sh", "-c"]:
    sys.exit("fake SSH requires one sh -c payload")
script = args[2].replace("${REMOTE}", os.environ["ACCEPTANCE_REMOTE"])
child = subprocess.Popen(["/bin/sh", "-c", script], start_new_session=True)
def stop(signum, frame):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    sys.exit(99)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    sys.exit(child.wait(timeout=20))
except subprocess.TimeoutExpired:
    stop(None, None)
`;
const GUARDED_GIT = `#!/usr/bin/python3
${GUARD}
depth = int(os.environ.get("ACCEPTANCE_GIT_DEPTH", "0")) + 1
if depth > 4:
    sys.exit("recursive git refused")
os.environ["ACCEPTANCE_GIT_DEPTH"] = str(depth)
os.execv("/usr/bin/git", ["/usr/bin/git", *sys.argv[1:]])
`;

async function writeTree(
  dir: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("/usr/bin/git", ["-C", dir, ...args], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Acceptance Test");
  await git(dir, "config", "user.email", "acceptance@example.invalid");
}

async function commit(dir: string): Promise<void> {
  await git(dir, "add", "-f", ".");
  await git(dir, "commit", "-q", "-m", "fixture");
}

async function exists(dir: string, relative: string): Promise<boolean> {
  return lstat(path.join(dir, relative)).then(
    () => true,
    () => false,
  );
}

async function expectTree(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await expect(
      readFile(path.join(dir, relative), "utf8"),
      relative,
    ).resolves.toBe(content);
  }
}

async function baseline(ignoredPaths: string[] = []) {
  return captureDirectorySnapshot(local, {
    exclude: [
      ".git",
      ".git/*",
      ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES,
      ...ignoredPaths,
    ],
  });
}

async function stagingDirs(): Promise<string[]> {
  return (await readdir(os.tmpdir()))
    .filter((name) => name.startsWith("paperclip-ssh-sync-back-"))
    .sort();
}

beforeEach(async () => {
  expect(await realpath("/usr/bin/git")).toBe("/usr/bin/git");
  expect((await readFile("/usr/bin/git")).subarray(0, 4).toString("hex")).toBe(
    "7f454c46",
  );
  await access("/usr/bin/git", constants.X_OK);
  root = await mkdtemp(path.join(scratch, "ssh-ignore-acceptance-"));
  local = path.join(root, "local");
  remote = path.join(root, "remote");
  const bin = path.join(root, "bin");
  await Promise.all(
    [local, remote, bin, path.join(root, "home"), path.join(root, "tmp")].map(
      (dir) => mkdir(dir),
    ),
  );
  await writeFile(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  await writeFile(path.join(bin, "git"), GUARDED_GIT, { mode: 0o755 });
  // An allowlist is safer than trying to recognize every runtime-launcher dir.
  vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("HOME", path.join(root, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "home"));
  vi.stubEnv("TMPDIR", path.join(root, "tmp"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(root, "global-config"));
  vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
  // The managed launcher deliberately injects empty ambient identities. Empty
  // env values override repository config, so fixture identities must be explicit.
  vi.stubEnv("GIT_AUTHOR_NAME", "Acceptance Test");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "acceptance@example.invalid");
  vi.stubEnv("GIT_COMMITTER_NAME", "Acceptance Test");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "acceptance@example.invalid");
  vi.stubEnv("ACCEPTANCE_REMOTE", remote);
  vi.stubEnv("ACCEPTANCE_LAUNCH_COUNT", path.join(root, "launch-count"));
  vi.stubEnv("PAPERCLIP_SSH_INCREMENTAL_SYNC", "0");
  vi.stubEnv("PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES", "2097152");
  spec = {
    host: "fake.invalid",
    port: 22,
    username: "fixture",
    remoteWorkspacePath: REMOTE,
    remoteCwd: REMOTE,
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: false,
  };
}, 10_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

type RuleCase = {
  label: string;
  rules: Record<string, string>;
  tracked: Record<string, string>;
  included: Record<string, string>;
  omitted: Record<string, string>;
};
const cases: RuleCase[] = [
  {
    label: "root and nested rules with directory anchoring",
    rules: {
      ".gitignore": "/cache/\n*.log\n",
      "pkg/.gitignore": "/build/\n*.tmp\n",
    },
    tracked: { "keep.txt": "source\n" },
    included: {
      "src/cache/source.ts": "nested cache is source\n",
      "pkg/src/build/source.ts": "nested build is source\n",
    },
    omitted: {
      "cache/root.bin": "cache\n",
      "root.log": "log\n",
      "pkg/build/output.bin": "build\n",
      "pkg/nested/output.tmp": "temp\n",
    },
  },
  {
    label: "root and nested negation, including a re-included directory",
    rules: {
      ".gitignore": "*.log\n!keep.log\n/cache/*\n!/cache/keep/\n",
      "pkg/.gitignore": "*.tmp\n!important.tmp\n",
    },
    tracked: { "keep.txt": "source\n" },
    included: {
      "keep.log": "root exception\n",
      "cache/keep/source.txt": "directory exception\n",
      "pkg/important.tmp": "nested exception\n",
    },
    omitted: {
      "drop.log": "log\n",
      "cache/drop.txt": "cache\n",
      "pkg/drop.tmp": "temp\n",
    },
  },
  {
    label: "tracked files inside ignored directories",
    rules: { ".gitignore": "/cache/\n*.log\n", "pkg/.gitignore": "/build/\n" },
    tracked: {
      "cache/tracked.txt": "tracked cache source\n",
      "tracked.log": "tracked log source\n",
      "pkg/build/tracked.ts": "tracked build source\n",
    },
    included: { "new.txt": "untracked source\n" },
    omitted: {
      "cache/untracked.txt": "cache\n",
      "untracked.log": "log\n",
      "pkg/build/untracked.bin": "build\n",
    },
  },
  {
    label: "literal metacharacters and awkward path names",
    rules: { ".gitignore": "literal\\[1\\].log\n*.tmp\n" },
    tracked: { "keep.txt": "source\n" },
    included: {
      "literal1.log": "not the literal bracket name\n",
      "space ' quote.txt": "quoted source\n",
      "line\nbreak.txt": "newline source\n",
    },
    omitted: {
      "literal[1].log": "literal ignored\n",
      "space ' quote.tmp": "quoted ignored\n",
      "line\nbreak.tmp": "newline ignored\n",
    },
  },
];

async function setupCase(dir: string, fixture: RuleCase): Promise<void> {
  await initRepo(dir);
  await writeTree(dir, {
    ...fixture.rules,
    ...Object.fromEntries(
      Object.entries(fixture.tracked).map(([name, content]) => [
        name,
        `committed: ${content}`,
      ]),
    ),
  });
  await commit(dir);
  // Dirty tracked content must arrive from the overlay, not accidentally pass
  // because the Git bundle already checked out the expected committed bytes.
  await writeTree(dir, {
    ...fixture.tracked,
    ...fixture.included,
    ...fixture.omitted,
  });
}

describe("SSH full-copy repository ignore acceptance", () => {
  it.each(cases)(
    "seed honors $label with the incremental kill switch",
    async (fixture) => {
      await setupCase(local, fixture);
      const prepared = await prepareWorkspaceForSshExecution({
        spec,
        localDir: local,
        remoteDir: REMOTE,
      });
      expect(prepared.gitBacked).toBe(true);
      expect(prepared.seedMode).toBe("full-copy");
      await expectTree(remote, {
        ...fixture.rules,
        ...fixture.tracked,
        ...fixture.included,
      });
      for (const relative of Object.keys(fixture.omitted)) {
        expect.soft(await exists(remote, relative), relative).toBe(false);
      }
    },
    30_000,
  );

  it.each(cases)(
    "full restore independently honors remote $label",
    async (fixture) => {
      // No ignoredPaths or seed provenance: this exercises the safe full-copy
      // fallback, not just pruning paths remembered from an earlier seed.
      await initRepo(local);
      await writeTree(local, { "local.txt": "local\n" });
      await commit(local);
      await setupCase(remote, fixture);
      await restoreWorkspaceFromSshExecution({
        spec,
        localDir: local,
        remoteDir: REMOTE,
        baselineSnapshot: await baseline(),
      });
      await expectTree(local, {
        ...fixture.rules,
        ...fixture.tracked,
        ...fixture.included,
      });
      for (const relative of Object.keys(fixture.omitted)) {
        expect.soft(await exists(local, relative), relative).toBe(false);
      }
    },
    30_000,
  );

  it.each(["seed", "restore"] as const)(
    "%s does not treat global or info excludes as transfer authority",
    async (direction) => {
      const source = direction === "seed" ? local : remote;
      const target = direction === "seed" ? remote : local;
      await initRepo(source);
      await writeTree(source, {
        ".gitignore": "repo-only.tmp\n",
        "keep.txt": "source\n",
      });
      await commit(source);
      const globalIgnore = path.join(root, "global-ignore");
      await writeFile(globalIgnore, "global-only.tmp\n");
      await exec(
        "/usr/bin/git",
        ["config", "--global", "core.excludesFile", globalIgnore],
        { timeout: 10_000 },
      );
      await writeTree(source, {
        ".git/info/exclude": "info-only.tmp\n",
        "global-only.tmp": "global is not authority\n",
        "info-only.tmp": "info is not authority\n",
        "repo-only.tmp": "repo ignored\n",
      });
      // Confirm the fixture really has active host/info ignores, rather than
      // obtaining a false pass because those rules were never configured.
      expect(
        (await git(source, "check-ignore", "global-only.tmp", "info-only.tmp"))
          .trim()
          .split("\n"),
      ).toEqual(["global-only.tmp", "info-only.tmp"]);
      if (direction === "seed") {
        await prepareWorkspaceForSshExecution({
          spec,
          localDir: local,
          remoteDir: REMOTE,
        });
      } else {
        await restoreWorkspaceFromSshExecution({
          spec,
          localDir: local,
          remoteDir: REMOTE,
        });
      }
      await expectTree(target, {
        "global-only.tmp": "global is not authority\n",
        "info-only.tmp": "info is not authority\n",
      });
      expect(await exists(target, "repo-only.tmp")).toBe(false);
    },
    30_000,
  );

  it.each(["plain", "baseline"] as const)(
    "%s restore preserves root local config while nested tracked config and relative links transfer",
    async (mode) => {
      await initRepo(local);
      await writeTree(local, {
        ".gitignore": "/.env\n",
        "keep.txt": "seed\n",
        "pkg/.env": "tracked nested config\n",
      });
      await commit(local);
      await writeTree(local, {
        ".env": "local fixture configuration\n",
        ".paperclip-runtime/state.json": "local runtime\n",
        "node_modules/dep/index.js": "local dependencies\n",
      });
      await symlink("keep.txt", path.join(local, "current.txt"));
      const prepared = await prepareWorkspaceForSshExecution({
        spec,
        localDir: local,
        remoteDir: REMOTE,
      });
      // Local config must not cross the seed boundary, even though it is needed
      // locally after restore. Nested tracked .env is deliberately not private.
      expect.soft(await exists(remote, ".env")).toBe(false);
      expect(await readlink(path.join(remote, "current.txt"))).toBe("keep.txt");
      const captured =
        mode === "baseline" ? await baseline(prepared.ignoredPaths) : undefined;
      await writeTree(remote, {
        ".env": "remote must not overwrite\n",
        "keep.txt": "remote edit\n",
        "pkg/.env": "remote nested edit\n",
        "second.txt": "second\n",
      });
      await rm(path.join(remote, "current.txt"));
      await symlink("second.txt", path.join(remote, "current.txt"));
      await restoreWorkspaceFromSshExecution({
        spec,
        localDir: local,
        remoteDir: REMOTE,
        baselineSnapshot: captured,
        ignoredPaths: prepared.ignoredPaths,
      });
      expect(
        (await lstat(path.join(local, "current.txt"))).isSymbolicLink(),
      ).toBe(true);
      expect(await readlink(path.join(local, "current.txt"))).toBe(
        "second.txt",
      );
      await expectTree(local, {
        ".env": "local fixture configuration\n",
        "keep.txt": "remote edit\n",
        "pkg/.env": "remote nested edit\n",
        ".paperclip-runtime/state.json": "local runtime\n",
        "node_modules/dep/index.js": "local dependencies\n",
      });
    },
    30_000,
  );

  it.each(["plain", "baseline"] as const)(
    "%s git round trip keeps relative symlinks byte-exact",
    async (mode) => {
      await initRepo(local);
      await writeTree(local, { "one.txt": "one\n", "two.txt": "two\n" });
      await commit(local);
      await symlink("one.txt", path.join(local, "current.txt"));
      await symlink("missing.txt", path.join(local, "dangling.txt"));
      const prepared = await prepareWorkspaceForSshExecution({
        spec,
        localDir: local,
        remoteDir: REMOTE,
      });
      expect(await readlink(path.join(remote, "current.txt"))).toBe("one.txt");
      expect(await readlink(path.join(remote, "dangling.txt"))).toBe(
        "missing.txt",
      );
      const captured =
        mode === "baseline" ? await baseline(prepared.ignoredPaths) : undefined;
      await rm(path.join(remote, "current.txt"));
      await symlink("two.txt", path.join(remote, "current.txt"));
      await restoreWorkspaceFromSshExecution({
        spec,
        localDir: local,
        remoteDir: REMOTE,
        baselineSnapshot: captured,
        ignoredPaths: prepared.ignoredPaths,
      });
      expect(
        (await lstat(path.join(local, "current.txt"))).isSymbolicLink(),
      ).toBe(true);
      expect(await readlink(path.join(local, "current.txt"))).toBe("two.txt");
      expect(await readlink(path.join(local, "dangling.txt"))).toBe(
        "missing.txt",
      );
    },
    30_000,
  );

  it("falls back safely to filtered full restore when seed provenance is unavailable", async () => {
    await initRepo(local);
    await writeTree(local, { ".gitignore": "*.tmp\n", "keep.txt": "seed\n" });
    await commit(local);
    const prepared = await prepareWorkspaceForSshExecution({
      spec,
      localDir: local,
      remoteDir: REMOTE,
    });
    const captured = await baseline(prepared.ignoredPaths);
    await writeTree(remote, {
      "keep.txt": "remote edit\n",
      "new-ignored.tmp": "excluded\n",
    });
    vi.stubEnv("PAPERCLIP_SSH_INCREMENTAL_SYNC", "1");
    await restoreWorkspaceFromSshExecution({
      spec,
      localDir: local,
      remoteDir: REMOTE,
      baselineSnapshot: captured,
      restoreGitHistory: true,
      ignoredPaths: prepared.ignoredPaths,
    });
    await expectTree(local, { "keep.txt": "remote edit\n" });
    expect(await exists(local, "new-ignored.tmp")).toBe(false);
    expect(await stagingDirs()).toEqual([]);
  }, 30_000);

  it("uses safe full-copy seeding when a content-filter checkout cannot use the mirror", async () => {
    vi.stubEnv("PAPERCLIP_SSH_INCREMENTAL_SYNC", "1");
    await initRepo(local);
    await writeTree(local, {
      ".gitattributes": "keep.txt filter=fixture\n",
      ".gitignore": "*.tmp\n",
      "keep.txt": "working bytes\n",
    });
    await commit(local);
    await writeTree(local, { "ignored.tmp": "excluded\n" });
    const prepared = await prepareWorkspaceForSshExecution({
      spec,
      localDir: local,
      remoteDir: REMOTE,
    });
    expect(prepared.seedMode).toBe("full-copy");
    await expectTree(remote, { "keep.txt": "working bytes\n" });
    expect(await exists(remote, "ignored.tmp")).toBe(false);
  }, 30_000);

  it.each(["seed", "restore"] as const)(
    "non-git %s safely keeps files when .gitignore has no index authority",
    async (direction) => {
      const source = direction === "seed" ? local : remote;
      const target = direction === "seed" ? remote : local;
      const files = {
        ".gitignore": "*.tmp\n",
        "pkg/.gitignore": "*.log\n",
        "keep.txt": "source\n",
        "ordinary.tmp": "plain file\n",
        "pkg/ordinary.log": "nested plain file\n",
      };
      await writeTree(source, files);
      await symlink("keep.txt", path.join(source, "current.txt"));
      if (direction === "seed") {
        const prepared = await prepareWorkspaceForSshExecution({
          spec,
          localDir: local,
          remoteDir: REMOTE,
        });
        expect(prepared.gitBacked).toBe(false);
        expect(prepared.seedMode).toBe("full-copy");
      } else {
        await restoreWorkspaceFromSshExecution({
          spec,
          localDir: local,
          remoteDir: REMOTE,
        });
      }
      await expectTree(target, files);
      expect(await readlink(path.join(target, "current.txt"))).toBe("keep.txt");
    },
    30_000,
  );

  it("filters ignored ballast before enforcing the unchanged full-copy size cap", async () => {
    await initRepo(remote);
    await writeTree(remote, {
      ".gitignore": "*.tmp\n",
      "keep.txt": "small source\n",
    });
    await commit(remote);
    await writeTree(remote, { "ballast.tmp": Buffer.alloc(256 * 1024, 0x41) });
    vi.stubEnv("PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES", String(64 * 1024));
    await restoreWorkspaceFromSshExecution({
      spec,
      localDir: local,
      remoteDir: REMOTE,
    });
    await expectTree(local, { "keep.txt": "small source\n" });
    expect(await exists(local, "ballast.tmp")).toBe(false);
    expect(await stagingDirs()).toEqual([]);
  }, 30_000);

  it.each(["plain", "baseline"] as const)(
    "%s full restore still refuses included over-cap bytes atomically",
    async (mode) => {
      await initRepo(remote);
      await writeTree(remote, {
        ".gitignore": "*.tmp\n",
        "keep.txt": "remote replacement\n",
      });
      await commit(remote);
      await writeTree(remote, {
        "included.bin": Buffer.alloc(256 * 1024, 0x42),
      });
      await writeTree(local, {
        "keep.txt": "local must survive\n",
        "local-only.txt": "local\n",
      });
      const captured = mode === "baseline" ? await baseline() : undefined;
      const before = await captureDirectorySnapshot(local);
      vi.stubEnv("PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES", String(64 * 1024));
      await expect(
        restoreWorkspaceFromSshExecution({
          spec,
          localDir: local,
          remoteDir: REMOTE,
          baselineSnapshot: captured,
        }),
      ).rejects.toBeInstanceOf(SshSyncBackSizeLimitExceededError);
      expect(await captureDirectorySnapshot(local)).toEqual(before);
      expect(await stagingDirs()).toEqual([]);
    },
    30_000,
  );
});
