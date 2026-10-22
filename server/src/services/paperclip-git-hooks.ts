/**
 * Paperclip git-hook provisioning for execution checkouts.
 *
 * Agent commits must carry `Paperclip-Agent:` / `Paperclip-Run:` trailers so
 * downstream gates can attribute test authorship. The commit-msg hook that
 * emits them is baked into the image at {@link DEFAULT_PAPERCLIP_GIT_HOOKS_DIR};
 * this module points each execution checkout at it via local `core.hooksPath`.
 *
 * Local config is the only layer that survives the run environment: agent runs
 * null out the global/system gitconfig (`GIT_CONFIG_GLOBAL=/dev/null`,
 * `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`) and the managed git
 * launcher scrubs inherited `GIT_CONFIG_*` entries, so neither gitconfig files
 * nor env passthrough can deliver the hook path. Per-checkout local config
 * covers every agent commit, and linked worktrees share the base checkout's
 * local config, so one set on the base covers every execution worktree.
 *
 * Everything here is fail-open: a missing hook, a non-git directory, or any
 * git failure yields `{ applied: false }` and provisioning continues. This
 * function never throws.
 */
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** In-image directory holding the Paperclip git hooks (see Dockerfile). */
export const DEFAULT_PAPERCLIP_GIT_HOOKS_DIR = "/usr/local/share/paperclip-git-hooks";

/** Env key overriding the hooks directory (tests, dev machines, remote targets). */
export const PAPERCLIP_GIT_HOOKS_DIR_ENV_KEY = "PAPERCLIP_GIT_HOOKS_DIR";

export const PAPERCLIP_COMMIT_MSG_HOOK_NAME = "commit-msg";

const GIT_CONFIG_TIMEOUT_MS = 10_000;

/**
 * Env keys that could redirect git config reads/writes away from the target
 * checkout. The server is not expected to set them, but a stray `GIT_DIR` (or
 * an injected `GIT_CONFIG_COUNT` entry) would silently aim the operation at
 * the wrong repository, so strip them defensively.
 */
const REDIRECTING_GIT_ENV_PATTERN =
  /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/;

export function resolvePaperclipGitHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PAPERCLIP_GIT_HOOKS_DIR_ENV_KEY]?.trim();
  if (override) return override;
  return DEFAULT_PAPERCLIP_GIT_HOOKS_DIR;
}

export type EnsurePaperclipCommitMsgHookReason =
  | "applied"
  | "already-configured"
  | "custom-hooks-path"
  | "hook-not-installed"
  | "git-unavailable";

export interface EnsurePaperclipCommitMsgHookResult {
  applied: boolean;
  reason: EnsurePaperclipCommitMsgHookReason;
  hooksDir: string;
}

function sanitizedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (REDIRECTING_GIT_ENV_PATTERN.test(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function execExitCode(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return null;
}

/** Reads local `core.hooksPath`: value, null when unset. Throws otherwise. */
async function readLocalHooksPath(gitCwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--local", "--get", "core.hooksPath"], {
      cwd: gitCwd,
      env: sanitizedGitEnv(env),
      timeout: GIT_CONFIG_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    const value = stdout.trim();
    return value ? value : null;
  } catch (error) {
    // Exit 1 means the key is unset. Any other failure (not a repository,
    // git missing, timeout) propagates so the caller fails open.
    if (execExitCode(error) === 1) return null;
    throw error;
  }
}

/**
 * Points `gitCwd`'s local `core.hooksPath` at the image-baked Paperclip hooks
 * when the hook is present and nothing else claims the path. Never throws:
 * every failure mode returns `{ applied: false }` with a reason.
 */
export async function ensurePaperclipCommitMsgHook(
  gitCwd: string,
  opts?: { env?: NodeJS.ProcessEnv; hooksDir?: string },
): Promise<EnsurePaperclipCommitMsgHookResult> {
  try {
    const env = opts?.env ?? process.env;
    const hooksDir = opts?.hooksDir ?? resolvePaperclipGitHooksDir(env);
    const hookPath = path.join(hooksDir, PAPERCLIP_COMMIT_MSG_HOOK_NAME);
    const stat = await fs.stat(hookPath).catch(() => null);
    if (!stat?.isFile()) return { applied: false, reason: "hook-not-installed", hooksDir };
    try {
      await fs.access(hookPath, fsConstants.X_OK);
    } catch {
      // A non-executable hook never fires; setting hooksPath at it would only
      // shadow any operator hooks without emitting trailers.
      return { applied: false, reason: "hook-not-installed", hooksDir };
    }

    const current = await readLocalHooksPath(gitCwd, env);
    if (current === hooksDir) return { applied: false, reason: "already-configured", hooksDir };
    if (current !== null) return { applied: false, reason: "custom-hooks-path", hooksDir };

    await execFileAsync("git", ["config", "--local", "core.hooksPath", hooksDir], {
      cwd: gitCwd,
      env: sanitizedGitEnv(env),
      timeout: GIT_CONFIG_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    return { applied: true, reason: "applied", hooksDir };
  } catch {
    const hooksDir = opts?.hooksDir ?? DEFAULT_PAPERCLIP_GIT_HOOKS_DIR;
    return { applied: false, reason: "git-unavailable", hooksDir };
  }
}
