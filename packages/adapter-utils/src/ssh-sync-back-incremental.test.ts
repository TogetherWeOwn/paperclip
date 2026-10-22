import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSshPorcelainStatusV1Z } from "./ssh.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
