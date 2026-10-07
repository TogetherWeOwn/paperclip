import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_REPOSITORIES_DIR } from "./git-workspace-sync.js";
import {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

// Use the stub-SSH pattern from ssh-sync-back-guard.test.ts: real tar and Git
// transfers, with only the SSH endpoint replaced by a local fixture directory.
const FAKE_REMOTE_ROOT = "/stub-ssh-remote";
const STUB_SOURCE = `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  "sh -c "*) payload=\${last#"sh -c "};;
  *) printf 'stub-ssh: unexpected trailing arg: %s\\n' "$last" >&2; exit 99;;
esac
rewritten=$(printf '%s' "$payload" | sed "s|$STUB_SSH_REMOTE_ROOT|$STUB_SSH_FIXTURE_DIR|g")
eval "sh -c $rewritten"
`;
const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];
const GIT_ROUND_TRIP_TIMEOUT_MS = 180_000;

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-nested-git-"));
  fixtureRoots.push(root);
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c", "user.name=Paperclip Test", "-c", "user.email=test@example.invalid", ...args,
  ], { cwd });
  return stdout.trim();
}

async function initRepository(dir: string, gitDir?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-b", "main", ...(gitDir ? ["--separate-git-dir", gitDir] : []));
  await writeFile(path.join(dir, "tracked.txt"), "initial\n");
  await writeFile(path.join(dir, "deleted.txt"), "delete remotely\n");
  await git(dir, "add", "tracked.txt", "deleted.txt");
  await git(dir, "commit", "-m", "initial history");
}

beforeEach(async () => {
  const binDir = await fixtureRoot();
  await writeFile(path.join(binDir, "ssh"), STUB_SOURCE, { mode: 0o755 });
  vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (fixtureRoots.length > 0) {
    await rm(fixtureRoots.pop()!, { recursive: true, force: true });
  }
});

function stubSpec(remoteDir: string): SshRemoteExecutionSpec {
  vi.stubEnv("STUB_SSH_REMOTE_ROOT", FAKE_REMOTE_ROOT);
  vi.stubEnv("STUB_SSH_FIXTURE_DIR", remoteDir);
  return {
    host: "stub",
    port: 22,
    username: "stub",
    remoteWorkspacePath: FAKE_REMOTE_ROOT,
    remoteCwd: FAKE_REMOTE_ROOT,
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: false,
  };
}

describe("SSH git-backed restore preserves nested project Git metadata", () => {
  it.each(["directory", "gitfile"] as const)("round-trips a nested repository with a .git %s", async (kind) => {
    const root = await fixtureRoot();
    const localDir = path.join(root, "local");
    const remoteDir = path.join(root, "remote");
    await initRepository(localDir);
    await writeFile(path.join(localDir, ".gitignore"), `/${PROJECT_REPOSITORIES_DIR}/\n`);
    await git(localDir, "add", ".gitignore");
    await git(localDir, "commit", "-m", "ignore managed repositories");
    const rootHead = await git(localDir, "rev-parse", "HEAD");

    const relativeRepo = path.join(PROJECT_REPOSITORIES_DIR, "toolkit-example");
    const nestedDir = path.join(localDir, relativeRepo);
    const remoteNestedDir = path.join(remoteDir, relativeRepo);
    await initRepository(nestedDir, kind === "gitfile" ? path.join(root, "nested-git-dir") : undefined);
    const nestedHead = await git(nestedDir, "rev-parse", "HEAD");
    expect(nestedHead).not.toBe(rootHead);
    const siblingDir = path.join(localDir, PROJECT_REPOSITORIES_DIR, "second-repository");
    await initRepository(siblingDir);
    const siblingHead = await git(siblingDir, "rev-parse", "HEAD");
    const metadataPath = path.join(nestedDir, ".git");
    const metadataBefore = kind === "gitfile"
      ? await readFile(metadataPath, "utf8")
      : await readFile(path.join(metadataPath, "config"), "utf8");
    await writeFile(path.join(nestedDir, "tracked.txt"), "dirty local\n");
    const spec = stubSpec(remoteDir);

    for (let round = 1; round <= 2; round += 1) {
      expect(await prepareWorkspaceForSshExecution({ spec, localDir })).toEqual({ gitBacked: true });
      // The nested working tree transfers, but its metadata must stay local.
      await expect(lstat(path.join(remoteNestedDir, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(remoteNestedDir, "tracked.txt"), "utf8")).resolves.toBe(
        round === 1 ? "dirty local\n" : "remote edit 1\n",
      );
      await writeFile(path.join(remoteNestedDir, "tracked.txt"), `remote edit ${round}\n`);
      await rm(path.join(remoteNestedDir, "deleted.txt"), { force: true });
      await writeFile(path.join(remoteNestedDir, "added.txt"), `remote addition ${round}\n`);
      // A stale local-only file must not survive by preserving the whole repo.
      await writeFile(path.join(nestedDir, "stale.txt"), "local stale\n");

      await restoreWorkspaceFromSshExecution({ spec, localDir });

      expect(await git(nestedDir, "log", "-1", "--format=%H")).toBe(nestedHead);
      expect(await git(nestedDir, "rev-parse", "--show-toplevel")).toBe(nestedDir);
      expect(await git(siblingDir, "log", "-1", "--format=%H")).toBe(siblingHead);
      expect(await git(siblingDir, "rev-parse", "--show-toplevel")).toBe(siblingDir);
      expect((await git(nestedDir, "status", "--short")).split("\n").map((line) => line.trim()).sort())
        .toEqual(["M tracked.txt", "D deleted.txt", "?? added.txt"].sort());
      await expect(readFile(path.join(nestedDir, "tracked.txt"), "utf8")).resolves.toBe(`remote edit ${round}\n`);
      await expect(readFile(path.join(nestedDir, "added.txt"), "utf8")).resolves.toBe(`remote addition ${round}\n`);
      await expect(lstat(path.join(nestedDir, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(nestedDir, "stale.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(metadataPath)).isDirectory()).toBe(kind === "directory");
      expect(await readFile(kind === "gitfile" ? metadataPath : path.join(metadataPath, "config"), "utf8"))
        .toBe(metadataBefore);
      expect(await git(localDir, "rev-parse", "HEAD")).toBe(rootHead);
    }
  }, GIT_ROUND_TRIP_TIMEOUT_MS);

  it.each([
    { ancestor: "repository", kind: "file" },
    { ancestor: "repository", kind: "symlink" },
    { ancestor: "repositories root", kind: "file" },
    { ancestor: "repositories root", kind: "symlink" },
  ] as const)("rejects a remote $ancestor replacement with a $kind before clearing local files", async ({ ancestor, kind }) => {
    const root = await fixtureRoot();
    const localDir = path.join(root, "local");
    const remoteDir = path.join(root, "remote");
    await initRepository(localDir);
    const nestedDir = path.join(localDir, PROJECT_REPOSITORIES_DIR, "replaced-repository");
    await initRepository(nestedDir);
    const nestedHead = await git(nestedDir, "rev-parse", "HEAD");
    await writeFile(path.join(localDir, "tracked.txt"), "keep local root edit\n");
    await writeFile(path.join(nestedDir, "tracked.txt"), "keep local nested edit\n");
    const statusBefore = await git(nestedDir, "status", "--short");
    const spec = stubSpec(remoteDir);
    await prepareWorkspaceForSshExecution({ spec, localDir });

    const replacementPath = path.join(remoteDir, PROJECT_REPOSITORIES_DIR,
      ...(ancestor === "repository" ? ["replaced-repository"] : []));
    await rm(replacementPath, { recursive: true });
    if (kind === "file") {
      await writeFile(replacementPath, "remote replacement\n");
    } else {
      await symlink("replacement-target", replacementPath);
    }
    await writeFile(path.join(remoteDir, "tracked.txt"), "remote root edit\n");

    await expect(restoreWorkspaceFromSshExecution({ spec, localDir }))
      .rejects.toThrow(/cannot replace .* with a non-directory.*preserved local entries/);
    expect(await git(nestedDir, "log", "-1", "--format=%H")).toBe(nestedHead);
    expect(await git(nestedDir, "status", "--short")).toBe(statusBefore);
    await expect(readFile(path.join(nestedDir, "tracked.txt"), "utf8")).resolves.toBe("keep local nested edit\n");
    await expect(readFile(path.join(nestedDir, "deleted.txt"), "utf8")).resolves.toBe("delete remotely\n");
    await expect(readFile(path.join(localDir, "tracked.txt"), "utf8")).resolves.toBe("keep local root edit\n");
    await expect(readFile(path.join(localDir, "deleted.txt"), "utf8")).resolves.toBe("delete remotely\n");
  }, GIT_ROUND_TRIP_TIMEOUT_MS);

  it("keeps history when the remote removes the entire nested working tree", async () => {
    const root = await fixtureRoot();
    const localDir = path.join(root, "local");
    const remoteDir = path.join(root, "remote");
    await initRepository(localDir);
    const relativeRepo = path.join(PROJECT_REPOSITORIES_DIR, "removed-repository");
    const nestedDir = path.join(localDir, relativeRepo);
    await initRepository(nestedDir);
    const nestedHead = await git(nestedDir, "rev-parse", "HEAD");
    const spec = stubSpec(remoteDir);

    await prepareWorkspaceForSshExecution({ spec, localDir });
    await rm(path.join(remoteDir, PROJECT_REPOSITORIES_DIR), { recursive: true });
    await restoreWorkspaceFromSshExecution({ spec, localDir });

    expect(await git(nestedDir, "log", "-1", "--format=%H")).toBe(nestedHead);
    expect(await git(nestedDir, "status", "--short")).toBe("D deleted.txt\n D tracked.txt");
    await expect(lstat(path.join(nestedDir, "tracked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, GIT_ROUND_TRIP_TIMEOUT_MS);
});
