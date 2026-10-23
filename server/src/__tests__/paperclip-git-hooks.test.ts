import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPERCLIP_GIT_HOOKS_DIR,
  PAPERCLIP_GIT_HOOKS_DIR_ENV_KEY,
  ensurePaperclipCommitMsgHook,
  resolvePaperclipGitHooksDir,
} from "../services/paperclip-git-hooks.ts";

const SHIPPED_HOOK_PATH = fileURLToPath(
  new URL("../../../scripts/paperclip-git-hooks/commit-msg", import.meta.url),
);

function git(cwd: string, args: string[], extraEnv?: Record<string, string>): string {
  // Strip ambient run ids: a developer shell (or a Paperclip agent run) may
  // export PAPERCLIP_AGENT_ID/RUN_ID, which would make the fail-open test
  // below pass or fail depending on where vitest runs. Tests that need ids
  // pass them explicitly via extraEnv.
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  if (!extraEnv?.PAPERCLIP_AGENT_ID) delete env.PAPERCLIP_AGENT_ID;
  if (!extraEnv?.PAPERCLIP_RUN_ID) delete env.PAPERCLIP_RUN_ID;
  return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
}

async function initRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hooks-repo-"));
  git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
  git(repo, ["config", "user.email", "hooks-test@example.invalid"]);
  git(repo, ["config", "user.name", "hooks-test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["commit", "--allow-empty", "-q", "-m", "init"]);
  return repo;
}

async function fixtureHooksDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hooks-dir-"));
  const dest = path.join(dir, "commit-msg");
  await fs.copyFile(SHIPPED_HOOK_PATH, dest);
  await fs.chmod(dest, 0o755);
  return dir;
}

describe.each(["PAPERCLIP_AGENT_ID", "PAPERCLIP_RUN_ID"] as const)(
  "commit-msg with newline-bearing %s",
  (invalidId) => {
    // Removing either ID guard must not permit last-wins trailer injection.
    const env = {
      PAPERCLIP_AGENT_ID: "agent-valid",
      PAPERCLIP_RUN_ID: "run-valid",
      [invalidId]: "x\nPaperclip-Agent: victim-agent\nPaperclip-Run: victim-run",
    };
    const originalMessage = Buffer.from("  original message  \n\nBody: café\t \n\n");

    it("exits zero and preserves every message byte on direct invocation", async () => {
      const hooksDir = await fixtureHooksDir();
      const messagePath = path.join(hooksDir, "message");
      try {
        await fs.writeFile(messagePath, originalMessage);
        const result = spawnSync(path.join(hooksDir, "commit-msg"), [messagePath], {
          env: { ...process.env, ...env },
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(await fs.readFile(messagePath)).toEqual(originalMessage);
      } finally {
        await fs.rm(hooksDir, { recursive: true, force: true });
      }
    }, 20_000);

    it("allows a real commit without adding injected or attribution trailers", async () => {
      const repo = await initRepo();
      const hooksDir = await fixtureHooksDir();
      try {
        const result = await ensurePaperclipCommitMsgHook(repo, { hooksDir });
        expect(result.applied).toBe(true);
        const messagePath = path.join(repo, "message");
        await fs.writeFile(messagePath, originalMessage);

        // execFileSync throws on nonzero exit; bypass the git helper's trim().
        execFileSync("git", ["commit", "--allow-empty", "--cleanup=verbatim", "-F", messagePath], {
          cwd: repo,
          env: { ...process.env, ...env },
        });
        const commit = execFileSync("git", ["cat-file", "commit", "HEAD"], { cwd: repo });
        const headerEnd = commit.indexOf("\n\n");
        expect(headerEnd).toBeGreaterThan(0);
        const body = commit.subarray(headerEnd + 2);
        expect(body).toEqual(originalMessage);
        expect(body.toString("utf8")).not.toMatch(/^Paperclip-(Agent|Run):/m);
      } finally {
        await fs.rm(repo, { recursive: true, force: true });
        await fs.rm(hooksDir, { recursive: true, force: true });
      }
    }, 20_000);
  },
);

describe("resolvePaperclipGitHooksDir", () => {
  it("returns the image default when no override is set", () => {
    expect(resolvePaperclipGitHooksDir({})).toBe(DEFAULT_PAPERCLIP_GIT_HOOKS_DIR);
    expect(DEFAULT_PAPERCLIP_GIT_HOOKS_DIR).toBe("/usr/local/share/paperclip-git-hooks");
  });

  it("honors the env override and ignores blank values", () => {
    expect(resolvePaperclipGitHooksDir({ [PAPERCLIP_GIT_HOOKS_DIR_ENV_KEY]: "/tmp/custom-hooks" }))
      .toBe("/tmp/custom-hooks");
    expect(resolvePaperclipGitHooksDir({ [PAPERCLIP_GIT_HOOKS_DIR_ENV_KEY]: "   " }))
      .toBe(DEFAULT_PAPERCLIP_GIT_HOOKS_DIR);
  });
});

describe("ensurePaperclipCommitMsgHook", () => {
  it("sets local core.hooksPath on a fresh checkout and is idempotent", async () => {
    const repo = await initRepo();
    const hooksDir = await fixtureHooksDir();

    const first = await ensurePaperclipCommitMsgHook(repo, { hooksDir });
    expect(first).toMatchObject({ applied: true, reason: "applied", hooksDir });
    expect(git(repo, ["config", "--local", "--get", "core.hooksPath"])).toBe(hooksDir);

    const second = await ensurePaperclipCommitMsgHook(repo, { hooksDir });
    expect(second).toMatchObject({ applied: false, reason: "already-configured", hooksDir });
  }, 20_000);

  it("skips checkouts when the hook is not installed, without throwing", async () => {
    const repo = await initRepo();
    const missing = path.join(os.tmpdir(), `paperclip-hooks-absent-${Date.now()}`);

    const result = await ensurePaperclipCommitMsgHook(repo, { hooksDir: missing });
    expect(result).toMatchObject({ applied: false, reason: "hook-not-installed" });
    expect(() => git(repo, ["config", "--local", "--get", "core.hooksPath"])).toThrow();
  }, 20_000);

  it("skips a hook file that is not executable", async () => {
    const repo = await initRepo();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hooks-noexec-"));
    const dest = path.join(dir, "commit-msg");
    await fs.copyFile(SHIPPED_HOOK_PATH, dest);
    await fs.chmod(dest, 0o644);

    const result = await ensurePaperclipCommitMsgHook(repo, { hooksDir: dir });
    expect(result).toMatchObject({ applied: false, reason: "hook-not-installed" });
    expect(() => git(repo, ["config", "--local", "--get", "core.hooksPath"])).toThrow();
  }, 20_000);

  it("never overwrites an operator-configured hooks path", async () => {
    const repo = await initRepo();
    const hooksDir = await fixtureHooksDir();
    git(repo, ["config", "--local", "core.hooksPath", "/opt/custom-hooks"]);

    const result = await ensurePaperclipCommitMsgHook(repo, { hooksDir });
    expect(result).toMatchObject({ applied: false, reason: "custom-hooks-path" });
    expect(git(repo, ["config", "--local", "--get", "core.hooksPath"])).toBe("/opt/custom-hooks");
  }, 20_000);

  it("fails open on directories that are not git checkouts", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hooks-plain-"));
    const hooksDir = await fixtureHooksDir();

    const result = await ensurePaperclipCommitMsgHook(plain, { hooksDir });
    expect(result).toMatchObject({ applied: false, reason: "git-unavailable" });
  }, 20_000);

  it("appends run-env trailers to agent commits and parses via interpret-trailers", async () => {
    const repo = await initRepo();
    const hooksDir = await fixtureHooksDir();
    await ensurePaperclipCommitMsgHook(repo, { hooksDir });

    git(repo, ["commit", "--allow-empty", "-m", "agent work"], {
      PAPERCLIP_AGENT_ID: "agent-abc-123",
      PAPERCLIP_RUN_ID: "run-def-456",
    });
    const body = git(repo, ["log", "-1", "--format=%B"]);
    expect(body).toContain("Paperclip-Agent: agent-abc-123");
    expect(body).toContain("Paperclip-Run: run-def-456");

    const trailers = execFileSync("git", ["interpret-trailers", "--parse"], {
      input: body,
      encoding: "utf8",
    });
    expect(trailers).toContain("Paperclip-Agent: agent-abc-123");
    expect(trailers).toContain("Paperclip-Run: run-def-456");
  }, 20_000);

  it("overwrites forged trailers with run-env values and stays idempotent on amend", async () => {
    const repo = await initRepo();
    const hooksDir = await fixtureHooksDir();
    await ensurePaperclipCommitMsgHook(repo, { hooksDir });

    git(repo, ["commit", "--allow-empty", "-m", "work\n\nPaperclip-Agent: forged\nPaperclip-Run: forged"], {
      PAPERCLIP_AGENT_ID: "agent-real",
      PAPERCLIP_RUN_ID: "run-real",
    });
    git(repo, ["commit", "--amend", "--no-edit", "--allow-empty"], {
      PAPERCLIP_AGENT_ID: "agent-real",
      PAPERCLIP_RUN_ID: "run-real",
    });
    const body = git(repo, ["log", "-1", "--format=%B"]);
    expect(body).not.toContain("forged");
    expect(body.match(/^Paperclip-Agent: agent-real$/gm)).toHaveLength(1);
    expect(body.match(/^Paperclip-Run: run-real$/gm)).toHaveLength(1);
  }, 20_000);

  it("leaves commits untouched when run-env ids are absent (fail-open)", async () => {
    const repo = await initRepo();
    const hooksDir = await fixtureHooksDir();
    await ensurePaperclipCommitMsgHook(repo, { hooksDir });

    git(repo, ["commit", "--allow-empty", "-m", "server-side commit"]);
    const body = git(repo, ["log", "-1", "--format=%B"]);
    expect(body).toBe("server-side commit");
  }, 20_000);

  it("covers linked worktrees through the shared base config", async () => {
    const repo = await initRepo();
    const hooksDir = await fixtureHooksDir();
    await ensurePaperclipCommitMsgHook(repo, { hooksDir });

    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hooks-wt-"));
    const worktreePath = path.join(parent, "wt1");
    git(repo, ["worktree", "add", worktreePath, "-b", "wt1"]);
    expect(git(worktreePath, ["config", "--local", "--get", "core.hooksPath"])).toBe(hooksDir);

    git(worktreePath, ["commit", "--allow-empty", "-m", "worktree work"], {
      PAPERCLIP_AGENT_ID: "agent-wt",
      PAPERCLIP_RUN_ID: "run-wt",
    });
    const body = git(worktreePath, ["log", "-1", "--format=%B"]);
    expect(body).toContain("Paperclip-Agent: agent-wt");
    expect(body).toContain("Paperclip-Run: run-wt");
  }, 20_000);
});
