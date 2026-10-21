import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, lstat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES,
  SshSyncBackSizeLimitExceededError,
  syncDirectoryFromSsh,
  type SshRemoteExecutionSpec,
} from "./ssh.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

// A nested agent worktree plus build outputs once filled a production host's
// root disk: sync-back copied them through /tmp staging until ENOSPC. Plain
// `.claude/worktrees` style excludes are not enough: task workspaces also nest
// real git linked worktrees (a `child/.git` *file* whose `gitdir:` target is a
// worktree admin dir carrying `commondir` metadata), plus
// `.paperclip/worktrees` and `.worktrees` roots. A `.git` file pointing at an
// external dir *without* `commondir` is a separate-git-dir repository, not a
// linked worktree, and must keep transferring.
// These tests run the real transfer functions against a fake `ssh` that
// executes the trailing `sh -c` payload locally after remapping the fake
// remote root to a fixture directory, so the nested-worktree exclusions and
// the size cap are verified without an SSH lab.
const FAKE_REMOTE_ROOT = "/stub-ssh-remote";
const STUB_SOURCE = `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  "sh -c "*) payload=\${last#"sh -c "};;
  *) echo "stub-ssh: unexpected trailing arg: $last" >&2; exit 99;;
esac
rewritten=$(printf '%s' "$payload" | sed "s|$STUB_SSH_REMOTE_ROOT|$STUB_SSH_FIXTURE_DIR|g")
if [ -n "$STUB_SSH_REMOTE_BIN" ]; then
  PATH="$STUB_SSH_REMOTE_BIN:$PATH"
  HOME="$STUB_SSH_REMOTE_BIN/home"
  mkdir -p "$HOME"
  printf '%s\\n' 'PATH="$STUB_SSH_REMOTE_BIN:$PATH"; export PATH' > "$HOME/.zprofile"
  export PATH HOME
fi
eval "sh -c $rewritten"
`;

const TEST_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 120_000;
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
  if (process.env.PAPERCLIP_TEST_LOCAL_TAR) {
    await symlink(process.env.PAPERCLIP_TEST_LOCAL_TAR, path.join(binDir, "tar"));
  }
  if (process.env.PAPERCLIP_TEST_REMOTE_TAR) {
    const remoteBinDir = await createFixtureRootDir("paperclip-stub-remote-bin-");
    await symlink(process.env.PAPERCLIP_TEST_REMOTE_TAR, path.join(remoteBinDir, "tar"));
    process.env.STUB_SSH_REMOTE_BIN = remoteBinDir;
  }
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

async function pathExists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, () => false);
}

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

beforeEach(async () => {
  await installStubSsh();
});

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES;
  delete process.env.STUB_SSH_REMOTE_ROOT;
  delete process.env.STUB_SSH_FIXTURE_DIR;
  delete process.env.STUB_SSH_REMOTE_BIN;
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// A scratch main checkout living outside the workspace, so every linked
// worktree gitdir target stays outside the transferred tree.
async function initMainRepo(): Promise<string> {
  const mainRepo = await createFixtureRootDir("paperclip-nested-main-");
  await git(mainRepo, "init", "-q", "-b", "main");
  await writeFile(path.join(mainRepo, "README.md"), "main\n");
  await git(mainRepo, "add", "README.md");
  await git(mainRepo, "commit", "-q", "-m", "initial");
  return mainRepo;
}

// A genuine linked worktree: `git worktree add` writes the `.git` gitfile and
// the worktree admin dir carrying `commondir` metadata.
async function addLinkedWorktree(mainRepo: string, worktreePath: string, branch: string): Promise<void> {
  await git(mainRepo, "worktree", "add", worktreePath, "-b", branch);
}

// Nested linked worktrees covering the absolute-gitdir, relative-gitdir, and
// special-characters-in-name shapes. The relative shape rewrites a genuine
// `.git` file to a relative `gitdir:` value, keeping the real `commondir`
// metadata in the target.
async function buildNestedWorktreeFixtures(localDir: string): Promise<{ mainRepo: string }> {
  const mainRepo = await initMainRepo();
  await writeTree(localDir, { "keep.txt": "deliverable\n" });

  const childDir = path.join(localDir, "child");
  await addLinkedWorktree(mainRepo, childDir, "nested-branch");
  await writeFile(path.join(childDir, "payload.bin"), Buffer.alloc(4096, 0x41));

  const relChildDir = path.join(localDir, "relchild");
  await addLinkedWorktree(mainRepo, relChildDir, "rel-branch");
  const absoluteGitdir = (await readFile(path.join(relChildDir, ".git"), "utf8"))
    .replace(/^gitdir: /, "")
    .trim();
  expect(absoluteGitdir.startsWith("/")).toBe(true);
  expect(await pathExists(path.join(absoluteGitdir, "commondir"))).toBe(true);
  const relativeGitdir = path.relative(relChildDir, absoluteGitdir).split(path.sep).join("/");
  await writeFile(path.join(relChildDir, ".git"), `gitdir: ${relativeGitdir}\n`);
  await writeFile(path.join(relChildDir, "payload.bin"), Buffer.alloc(4096, 0x42));

  const weirdDir = path.join(localDir, "weird [brackets] (name)");
  await addLinkedWorktree(mainRepo, weirdDir, "weird-branch");
  await writeFile(path.join(weirdDir, "payload.bin"), Buffer.alloc(4096, 0x43));

  return { mainRepo };
}

describe("SSH task-workspace nested worktree exclusions", () => {
  it("excludes root .paperclip/worktrees and .worktrees on seed", async () => {
    const localDir = await createFixtureRootDir("paperclip-nested-seed-local-");
    await writeTree(localDir, {
      "keep.txt": "deliverable\n",
      ".paperclip/worktrees/wt/marker.txt": "agent-local worktree\n",
      ".worktrees/wt/marker.txt": "agent-local worktree\n",
    });
    const remoteDir = await createFixtureRootDir("paperclip-nested-seed-remote-");
    const spec = buildStubSpec(remoteDir);

    await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    await expect(readFile(path.join(remoteDir, "keep.txt"), "utf8")).resolves.toBe("deliverable\n");
    expect(await pathExists(path.join(remoteDir, ".paperclip", "worktrees"))).toBe(false);
    expect(await pathExists(path.join(remoteDir, ".worktrees"))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("excludes root .paperclip/worktrees and .worktrees on sync-back", async () => {
    const remoteDir = await createFixtureRootDir("paperclip-nested-back-remote-");
    await writeTree(remoteDir, {
      "keep.txt": "deliverable\n",
      ".paperclip/worktrees/wt/marker.txt": "agent-local worktree\n",
      ".worktrees/wt/marker.txt": "agent-local worktree\n",
    });
    const spec = buildStubSpec(remoteDir);
    const localDir = await createFixtureRootDir("paperclip-nested-back-local-");

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe("deliverable\n");
    expect(await pathExists(path.join(localDir, ".paperclip", "worktrees"))).toBe(false);
    expect(await pathExists(path.join(localDir, ".worktrees"))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("excludes nested linked-worktree gitfiles in both directions", async () => {
    const localDir = await createFixtureRootDir("paperclip-nested-both-local-");
    await buildNestedWorktreeFixtures(localDir);
    const remoteDir = await createFixtureRootDir("paperclip-nested-both-remote-");
    const spec = buildStubSpec(remoteDir);

    await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    await expect(readFile(path.join(remoteDir, "keep.txt"), "utf8")).resolves.toBe("deliverable\n");
    expect(await pathExists(path.join(remoteDir, "child"))).toBe(false);
    expect(await pathExists(path.join(remoteDir, "relchild"))).toBe(false);
    expect(await pathExists(path.join(remoteDir, "weird [brackets] (name)"))).toBe(false);

    const backDir = await createFixtureRootDir("paperclip-nested-both-back-");
    await restoreWorkspaceFromSshExecution({ spec, localDir: backDir, remoteDir: FAKE_REMOTE_ROOT });

    await expect(readFile(path.join(backDir, "keep.txt"), "utf8")).resolves.toBe("deliverable\n");
    expect(await pathExists(path.join(backDir, "child"))).toBe(false);
    expect(await pathExists(path.join(backDir, "relchild"))).toBe(false);
    expect(await pathExists(path.join(backDir, "weird [brackets] (name)"))).toBe(false);
  }, GIT_TIMEOUT_MS);

  it.each([
    { gitBacked: false, label: "plain" },
    { gitBacked: true, label: "git-backed" },
  ])("preserves a local linked worktree on a non-baseline $label restore", async ({ gitBacked }) => {
    const localDir = await createFixtureRootDir("paperclip-nested-replace-local-");
    await writeTree(localDir, { "keep.txt": "before remote edit\n" });
    if (gitBacked) {
      await git(localDir, "init", "-q", "-b", "main");
      await git(localDir, "add", "keep.txt");
      await git(localDir, "commit", "-q", "-m", "primary");
    }
    const mainRepo = await initMainRepo();
    const nestedName = "nested [linked]";
    const nestedDir = path.join(localDir, nestedName);
    await addLinkedWorktree(mainRepo, nestedDir, "preserved-local");
    await writeFile(path.join(nestedDir, "marker.txt"), "local work must survive\n");
    const gitfile = await readFile(path.join(nestedDir, ".git"), "utf8");
    const nestedHead = await git(nestedDir, "rev-parse", "HEAD");
    const nestedStatus = await git(nestedDir, "status", "--porcelain");
    const remoteDir = await createFixtureRootDir("paperclip-nested-replace-remote-");
    const spec = buildStubSpec(remoteDir);
    const prepared = await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });
    expect(prepared.gitBacked).toBe(gitBacked);
    expect(await pathExists(path.join(remoteDir, nestedName))).toBe(false);

    await writeTree(remoteDir, { "keep.txt": "remote edit\n", "added.txt": "remote addition\n" });
    // Only the local discovery can exclude this path: the remote collision is
    // an ordinary directory, not a linked checkout. It must neither transfer
    // over the cap nor replace the excluded local worktree.
    await mkdir(path.join(remoteDir, nestedName));
    await writeFile(path.join(remoteDir, nestedName, "payload.bin"), Buffer.alloc(1024 * 1024, 0x41));
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe("remote edit\n");
    await expect(readFile(path.join(localDir, "added.txt"), "utf8")).resolves.toBe("remote addition\n");
    await expect(readFile(path.join(nestedDir, "marker.txt"), "utf8")).resolves.toBe("local work must survive\n");
    await expect(readFile(path.join(nestedDir, ".git"), "utf8")).resolves.toBe(gitfile);
    expect(await pathExists(path.join(nestedDir, "payload.bin"))).toBe(false);
    expect(await git(nestedDir, "rev-parse", "--show-toplevel")).toBe(`${nestedDir}\n`);
    expect(await git(nestedDir, "rev-parse", "HEAD")).toBe(nestedHead);
    expect(await git(nestedDir, "status", "--porcelain")).toBe(nestedStatus);
    if (gitBacked) expect((await git(localDir, "rev-parse", "--is-inside-work-tree")).trim()).toBe("true");
  }, GIT_TIMEOUT_MS);

  it.each([
    { shape: "CRLF", direction: "seed" },
    { shape: "CRLF", direction: "restore" },
    { shape: "symlink", direction: "seed" },
    { shape: "symlink", direction: "restore" },
  ] as const)("excludes a real $shape gitfile linked checkout on $direction", async ({ shape, direction }) => {
    const sourceDir = await createFixtureRootDir("paperclip-nested-shape-source-");
    await writeTree(sourceDir, { "keep.txt": "deliverable\n" });
    const mainRepo = await initMainRepo();
    const nestedDir = path.join(sourceDir, "linked checkout");
    await addLinkedWorktree(mainRepo, nestedDir, "gitfile-shape");
    const gitfilePath = path.join(nestedDir, ".git");
    const gitfile = await readFile(gitfilePath, "utf8");
    if (shape === "CRLF") {
      await writeFile(gitfilePath, gitfile.replace(/\n$/, "\r\n"));
      expect(await readFile(gitfilePath, "utf8")).toMatch(/\r\n$/);
    } else {
      const regularGitfile = path.join(mainRepo, "linked-gitfile");
      await writeFile(regularGitfile, gitfile);
      await rm(gitfilePath);
      await symlink(regularGitfile, gitfilePath);
      expect((await lstat(gitfilePath)).isSymbolicLink()).toBe(true);
    }
    // These are Git-usable checkouts, not merely strings resembling gitfiles.
    expect(await git(nestedDir, "rev-parse", "--show-toplevel")).toBe(`${nestedDir}\n`);
    expect(await git(nestedDir, "rev-parse", "HEAD")).toBe(await git(mainRepo, "rev-parse", "HEAD"));
    await writeFile(path.join(nestedDir, "marker.bin"), Buffer.alloc(1024 * 1024, 0x42));
    const targetDir = await createFixtureRootDir("paperclip-nested-shape-target-");
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);
    if (direction === "seed") {
      const spec = buildStubSpec(targetDir);
      await prepareWorkspaceForSshExecution({ spec, localDir: sourceDir, remoteDir: FAKE_REMOTE_ROOT });
    } else {
      // The local target has never seen this remote-created linked worktree.
      const spec = buildStubSpec(sourceDir);
      await restoreWorkspaceFromSshExecution({ spec, localDir: targetDir, remoteDir: FAKE_REMOTE_ROOT });
    }
    await expect(readFile(path.join(targetDir, "keep.txt"), "utf8")).resolves.toBe("deliverable\n");
    expect(await pathExists(path.join(targetDir, "linked checkout"))).toBe(false);
    expect((await lstat(path.join(nestedDir, "marker.bin"))).size).toBe(1024 * 1024);
    expect(await git(nestedDir, "rev-parse", "--show-toplevel")).toBe(`${nestedDir}\n`);
  }, GIT_TIMEOUT_MS);

  it("still seeds a primary root linked checkout", async () => {
    // The workspace root itself is a linked checkout: its `.git` file must
    // keep working through the git-backed path, not be mistaken for a nested
    // worktree to drop.
    const mainRepo = await initMainRepo();
    const parentDir = await createFixtureRootDir("paperclip-root-linked-parent-");
    const localDir = path.join(parentDir, "linked-root");
    fixtureRoots.push(localDir);
    await addLinkedWorktree(mainRepo, localDir, "linked-branch");
    await writeFile(path.join(localDir, "keep.txt"), "linked work\n");
    await git(localDir, "add", "keep.txt");
    await git(localDir, "commit", "-q", "-m", "linked work");
    const remoteDir = await createFixtureRootDir("paperclip-root-linked-remote-");
    const spec = buildStubSpec(remoteDir);

    const result = await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    expect(result.gitBacked).toBe(true);
    await expect(readFile(path.join(remoteDir, "keep.txt"), "utf8")).resolves.toBe("linked work\n");
  }, GIT_TIMEOUT_MS);

  it("still transfers nested independent repos, submodule gitfiles, and separate-git-dir repos", async () => {
    const localDir = await createFixtureRootDir("paperclip-nested-keep-local-");
    await writeTree(localDir, { "keep.txt": "deliverable\n" });
    // Ordinary nested repository: `.git` is a directory, not a worktree pointer.
    await mkdir(path.join(localDir, "sub"), { recursive: true });
    await git(path.join(localDir, "sub"), "init", "-q", "-b", "main");
    await writeFile(path.join(localDir, "sub", "lib.js"), "module.exports = 1;\n");
    // Submodule-style pointer: the gitdir target stays inside the workspace.
    await mkdir(path.join(localDir, "parent", ".git", "modules", "mod"), { recursive: true });
    await writeFile(
      path.join(localDir, "parent", ".git", "modules", "mod", "HEAD"),
      "ref: refs/heads/main\n",
    );
    await mkdir(path.join(localDir, "parent", "mod"), { recursive: true });
    await writeFile(path.join(localDir, "parent", "mod", ".git"), "gitdir: ../.git/modules/mod\n");
    await writeFile(path.join(localDir, "parent", "mod", "code.js"), "source\n");
    // Separate-git-dir repository: the `.git` file points outside the
    // workspace, but the target has no `commondir`, so it is not a linked
    // worktree and must keep transferring.
    const separateGitDir = await createFixtureRootDir("paperclip-nested-separate-git-");
    await git(separateGitDir, "init", "-q", "-b", "main");
    expect(await pathExists(path.join(separateGitDir, "commondir"))).toBe(false);
    await mkdir(path.join(localDir, "ext"), { recursive: true });
    await writeFile(path.join(localDir, "ext", ".git"), `gitdir: ${separateGitDir}\n`);
    await writeFile(path.join(localDir, "ext", "code.js"), "external gitdir source\n");
    const remoteDir = await createFixtureRootDir("paperclip-nested-keep-remote-");
    const spec = buildStubSpec(remoteDir);

    await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    await expect(readFile(path.join(remoteDir, "sub", "lib.js"), "utf8")).resolves.toBe(
      "module.exports = 1;\n",
    );
    expect(await pathExists(path.join(remoteDir, "sub", ".git", "HEAD"))).toBe(true);
    await expect(readFile(path.join(remoteDir, "parent", "mod", ".git"), "utf8")).resolves.toBe(
      "gitdir: ../.git/modules/mod\n",
    );
    await expect(readFile(path.join(remoteDir, "parent", "mod", "code.js"), "utf8")).resolves.toBe(
      "source\n",
    );
    await expect(readFile(path.join(remoteDir, "ext", ".git"), "utf8")).resolves.toBe(
      `gitdir: ${separateGitDir}\n`,
    );
    await expect(readFile(path.join(remoteDir, "ext", "code.js"), "utf8")).resolves.toBe(
      "external gitdir source\n",
    );
  }, GIT_TIMEOUT_MS);

  it("does not let a large nested worktree trip the sync-back cap", async () => {
    const remoteDir = await createFixtureRootDir("paperclip-nested-cap-remote-");
    await writeTree(remoteDir, { "keep.txt": "x".repeat(2048) });
    const mainRepo = await initMainRepo();
    const childDir = path.join(remoteDir, "child");
    await addLinkedWorktree(mainRepo, childDir, "cap-branch");
    await writeFile(path.join(childDir, "payload.bin"), Buffer.alloc(1024 * 1024, 0x41));
    const spec = buildStubSpec(remoteDir);
    const localDir = await createFixtureRootDir("paperclip-nested-cap-local-");
    // The cap sits far above the deliverable but far below the nested
    // worktree, so this passes only when the worktree stays out of the transfer.
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe("x".repeat(2048));
    expect(await pathExists(path.join(localDir, "child"))).toBe(false);
  }, GIT_TIMEOUT_MS);

  it("still rejects real source over the sync-back cap", async () => {
    const remoteDir = await createFixtureRootDir("paperclip-nested-cap-real-remote-");
    await writeFile(path.join(remoteDir, "data.bin"), Buffer.alloc(1024 * 1024, 0x42));
    const spec = buildStubSpec(remoteDir);
    const localDir = await createFixtureRootDir("paperclip-nested-cap-real-local-");
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

    const failure = await syncDirectoryFromSsh({
      spec,
      remoteDir: FAKE_REMOTE_ROOT,
      localDir,
      exclude: [...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES],
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SshSyncBackSizeLimitExceededError);
  }, TEST_TIMEOUT_MS);

  it("excludes a remote-created linked worktree on sync-back", async () => {
    const remoteDir = await createFixtureRootDir("paperclip-nested-remote-made-remote-");
    await writeTree(remoteDir, { "keep.txt": "deliverable\n" });
    // Created by the remote run after seed: the local side never saw it. A
    // genuine linked worktree carries `commondir` metadata in its target.
    const remoteMain = await initMainRepo();
    const newDir = path.join(remoteDir, "newdir");
    await addLinkedWorktree(remoteMain, newDir, "remote-branch");
    await writeFile(path.join(newDir, "payload.bin"), Buffer.alloc(4096, 0x44));
    const spec = buildStubSpec(remoteDir);
    const localDir = await createFixtureRootDir("paperclip-nested-remote-made-local-");

    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });

    await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe("deliverable\n");
    expect(await pathExists(path.join(localDir, "newdir"))).toBe(false);
  }, GIT_TIMEOUT_MS);

  it("preserves local excluded content on a baseline restore", async () => {
    const remoteDir = await createFixtureRootDir("paperclip-nested-preserve-remote-");
    await writeTree(remoteDir, { "keep.txt": "edited remotely\n", "added.txt": "added remotely\n" });
    const spec = buildStubSpec(remoteDir);
    const localDir = await createFixtureRootDir("paperclip-nested-preserve-local-");
    await writeTree(localDir, {
      "keep.txt": "stale local\n",
      ".paperclip/worktrees/wt/marker.txt": "local excluded work\n",
      ".worktrees/wt/marker.txt": "local excluded work\n",
    });
    const mainRepo = await initMainRepo();
    const nestedDir = path.join(localDir, "child");
    await addLinkedWorktree(mainRepo, nestedDir, "preserve-branch");
    await writeFile(path.join(nestedDir, "marker.txt"), "local nested work\n");
    // The baseline predates the nested-worktree exclusions, so it still lists
    // the excluded content: the restore must not mistake its absence on the
    // remote for a remote deletion.
    const baseline = await captureDirectorySnapshot(localDir, { exclude: [".paperclip-runtime"] });

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: FAKE_REMOTE_ROOT,
      baselineSnapshot: baseline,
    });

    await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe("edited remotely\n");
    await expect(readFile(path.join(localDir, "added.txt"), "utf8")).resolves.toBe("added remotely\n");
    await expect(readFile(path.join(localDir, ".paperclip/worktrees/wt/marker.txt"), "utf8")).resolves.toBe(
      "local excluded work\n",
    );
    await expect(readFile(path.join(localDir, ".worktrees/wt/marker.txt"), "utf8")).resolves.toBe(
      "local excluded work\n",
    );
    await expect(readFile(path.join(nestedDir, "marker.txt"), "utf8")).resolves.toBe("local nested work\n");
  }, GIT_TIMEOUT_MS);

  // Additive acceptance: combined git-backed primary path. Authored after the
  // implementation landed, so failed_before=not-run (no revert performed).
  it("seeds and restores a git-backed primary checkout with an over-cap nested worktree", async () => {
    const localDir = await createFixtureRootDir("paperclip-nested-combined-local-");
    await git(localDir, "init", "-q", "-b", "main");
    await writeFile(path.join(localDir, "keep.txt"), "primary deliverable\n");
    await git(localDir, "add", "keep.txt");
    await git(localDir, "commit", "-q", "-m", "primary");
    const mainRepo = await initMainRepo();
    const childDir = path.join(localDir, "child");
    await addLinkedWorktree(mainRepo, childDir, "combined-branch");
    await writeFile(path.join(childDir, "payload.bin"), Buffer.alloc(1024 * 1024, 0x41));
    const remoteDir = await createFixtureRootDir("paperclip-nested-combined-remote-");
    const spec = buildStubSpec(remoteDir);

    const prepared = await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: FAKE_REMOTE_ROOT });
    expect(prepared.gitBacked).toBe(true);
    await expect(readFile(path.join(remoteDir, "keep.txt"), "utf8")).resolves.toBe(
      "primary deliverable\n",
    );
    expect(await pathExists(path.join(remoteDir, "child"))).toBe(false);

    // The remote run edits the deliverable and adds a file; it never sees the
    // nested tree.
    await writeFile(path.join(remoteDir, "keep.txt"), "edited remotely\n");
    await writeFile(path.join(remoteDir, "added.txt"), "added remotely\n");
    const baseline = await captureDirectorySnapshot(localDir, {
      exclude: [".git", ".git/*", ...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES],
    });
    // The cap sits far below the nested worktree payload, so the sync-back
    // passes only when the nested tree stays out of the transfer.
    process.env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES = String(64 * 1024);

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir,
      remoteDir: FAKE_REMOTE_ROOT,
      baselineSnapshot: baseline,
      restoreGitHistory: true,
    });

    await expect(readFile(path.join(localDir, "keep.txt"), "utf8")).resolves.toBe("edited remotely\n");
    await expect(readFile(path.join(localDir, "added.txt"), "utf8")).resolves.toBe("added remotely\n");
    expect(await pathExists(path.join(remoteDir, "child"))).toBe(false);
    expect((await lstat(path.join(childDir, "payload.bin"))).size).toBe(1024 * 1024);
    // The excluded nested tree is preserved locally; no worktree payload
    // leaks into git status.
    const status = await git(localDir, "status", "--porcelain");
    expect(status).toContain("?? child/");
    expect(status).not.toContain("payload.bin");
  }, GIT_TIMEOUT_MS);

  it("keeps the persistent all-files exemption for excluded content", async () => {
    const localDir = await createFixtureRootDir("paperclip-nested-all-local-");
    await writeTree(localDir, {
      "keep.txt": "deliverable\n",
      ".paperclip/worktrees/wt/marker.txt": "persistent worktree\n",
      ".worktrees/wt/marker.txt": "persistent worktree\n",
    });
    const mainRepo = await initMainRepo();
    const nestedDir = path.join(localDir, "child");
    await addLinkedWorktree(mainRepo, nestedDir, "all-branch");
    await writeFile(path.join(nestedDir, "marker.txt"), "persistent nested work\n");
    const remoteDir = await createFixtureRootDir("paperclip-nested-all-remote-");
    const spec = buildStubSpec(remoteDir);

    await prepareWorkspaceForSshExecution({
      spec,
      localDir,
      remoteDir: FAKE_REMOTE_ROOT,
      workspaceFileMode: "all",
    });

    await expect(readFile(path.join(remoteDir, ".paperclip/worktrees/wt/marker.txt"), "utf8")).resolves.toBe(
      "persistent worktree\n",
    );
    await expect(readFile(path.join(remoteDir, ".worktrees/wt/marker.txt"), "utf8")).resolves.toBe(
      "persistent worktree\n",
    );
    await expect(readFile(path.join(remoteDir, "child", "marker.txt"), "utf8")).resolves.toBe(
      "persistent nested work\n",
    );
  }, GIT_TIMEOUT_MS);
});
