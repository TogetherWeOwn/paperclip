import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import {
  budgetSshRemoteEnvWithReport,
  SSH_REMOTE_ARG_MAX_BYTES,
  sshScriptOuterQuotedBytes,
} from "./remote-execution-env.js";
import {
  createUnrelatedHistoryGraftCommit,
  GIT_SYNC_COMMIT_IDENTITY_ARGS,
  readSanitizedOriginRemoteUrl,
} from "./git-workspace-sync.js";
import type { RunProcessResult } from "./server-utils.js";
import { shouldExcludePath } from "./exclude-patterns.js";
import {
  SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES,
  SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES,
  escapeTarExcludeLiteral,
  resolveSshTarFlavor,
  toSshTarExcludes,
  translateSshTarExcludes,
  type SshTarFlavor,
} from "./ssh-workspace-excludes.js";
import type { DirectorySnapshot } from "./workspace-restore-merge.js";
import { mergeChangedFilesWithBaseline, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import {
  createRuntimeProgressReporter,
  type RuntimeProgressDirection,
  type RuntimeProgressPhase,
  type RuntimeProgressSink,
} from "./runtime-progress.js";

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  remoteWorkspacePath: string;
  privateKey: string | null;
  knownHosts: string | null;
  strictHostKeyChecking: boolean;
}

export interface SshCommandResult {
  stdout: string;
  stderr: string;
}

export interface SshRemoteExecutionSpec extends SshConnectionConfig {
  remoteCwd: string;
}

export function createSshCommandManagedRuntimeRunner(input: {
  spec: SshRemoteExecutionSpec;
  defaultCwd?: string | null;
  maxBufferBytes?: number | null;
}): CommandManagedRuntimeRunner {
  const defaultCwd = input.defaultCwd?.trim() || input.spec.remoteCwd;
  const maxBufferBytes =
    typeof input.maxBufferBytes === "number" && Number.isFinite(input.maxBufferBytes) && input.maxBufferBytes > 0
      ? Math.trunc(input.maxBufferBytes)
      : 1024 * 1024;

  return {
    execute: async (commandInput): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const command = commandInput.command.trim();
      const args = commandInput.args ?? [];
      const cwd = commandInput.cwd?.trim() || defaultCwd;
      const envEntries = Object.entries(commandInput.env ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === "string");
      const envPrefix = envEntries.length > 0
        ? `env ${envEntries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} `
        : "";
      const exportPrefix = envEntries.length > 0
        ? envEntries.map(([key, value]) => `export ${key}=${shellQuote(value)};`).join(" ") + " "
        : "";
      const commandScript = command === "sh" || command === "bash"
        ? (args[0] === "-c" || args[0] === "-lc") && typeof args[1] === "string"
          ? `${exportPrefix}${args[1]}`
          : `${envPrefix}exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`
        : `${envPrefix}exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`;
      const remoteCommand = `cd ${shellQuote(cwd)} && ${commandScript}`;

      try {
        const result = await runSshCommand(input.spec, remoteCommand, {
          stdin: commandInput.stdin,
          timeoutMs: commandInput.timeoutMs,
          maxBuffer: maxBufferBytes,
        });
        if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
        if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt,
        };
      } catch (error) {
        const failure = error as {
          stdout?: unknown;
          stderr?: unknown;
          code?: unknown;
          signal?: unknown;
          killed?: unknown;
        };
        const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
        const stderr = typeof failure.stderr === "string"
          ? failure.stderr
          : error instanceof Error
            ? error.message
            : String(error);
        if (stdout) await commandInput.onLog?.("stdout", stdout);
        if (stderr) await commandInput.onLog?.("stderr", stderr);
        return {
          exitCode: typeof failure.code === "number" ? failure.code : null,
          signal: typeof failure.signal === "string" ? failure.signal : null,
          timedOut: failure.killed === true,
          stdout,
          stderr,
          pid: null,
          startedAt,
        };
      }
    },
  };
}

export interface SshEnvLabSupport {
  supported: boolean;
  reason: string | null;
}

export interface SshEnvLabFixtureState {
  kind: "ssh_openbsd";
  bindHost: string;
  host: string;
  port: number;
  username: string;
  rootDir: string;
  workspaceDir: string;
  statePath: string;
  pid: number;
  createdAt: string;
  clientPrivateKeyPath: string;
  clientPublicKeyPath: string;
  hostPrivateKeyPath: string;
  hostPublicKeyPath: string;
  authorizedKeysPath: string;
  knownHostsPath: string;
  sshdConfigPath: string;
  sshdLogPath: string;
}

interface LocalGitWorkspaceSnapshot {
  headCommit: string;
  branchName: string | null;
  deletedPaths: string[];
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function isValidShellEnvKey(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function parseSshRemoteExecutionSpec(value: unknown): SshRemoteExecutionSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const parsed = value as Record<string, unknown>;
  const host = typeof parsed.host === "string" ? parsed.host.trim() : "";
  const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
  const remoteCwd = typeof parsed.remoteCwd === "string" ? parsed.remoteCwd.trim() : "";
  const portValue = typeof parsed.port === "number" ? parsed.port : Number(parsed.port);
  if (!host || !username || !remoteCwd || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    return null;
  }

  return {
    host,
    port: portValue,
    username,
    remoteCwd,
    remoteWorkspacePath:
      typeof parsed.remoteWorkspacePath === "string" && parsed.remoteWorkspacePath.trim().length > 0
        ? parsed.remoteWorkspacePath.trim()
        : remoteCwd,
    privateKey: typeof parsed.privateKey === "string" && parsed.privateKey.length > 0 ? parsed.privateKey : null,
    knownHosts: typeof parsed.knownHosts === "string" && parsed.knownHosts.length > 0 ? parsed.knownHosts : null,
    strictHostKeyChecking:
      typeof parsed.strictHostKeyChecking === "boolean" ? parsed.strictHostKeyChecking : true,
  };
}

async function execFileText(
  file: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout ?? 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 128,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function spawnText(
  file: string,
  args: string[],
  options: {
    stdin?: string;
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const maxBuffer = options.maxBuffer ?? 1024 * 128;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finishReject = (error: Error & { stdout?: string; stderr?: string; code?: number | null; killed?: boolean }) => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = timedOut;
      reject(error);
    };

    const append = (
      streamName: "stdout" | "stderr",
      chunk: unknown,
    ) => {
      const text = String(chunk);
      if (streamName === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer || Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        child.kill("SIGTERM");
        finishReject(Object.assign(new Error(`Process output exceeded maxBuffer of ${maxBuffer} bytes.`), {
          code: null,
        }));
      }
    };

    let killEscalation: NodeJS.Timeout | null = null;
    const timeout = options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Escalate to SIGKILL after a 5s grace window so a hung remote
          // command that ignores SIGTERM cannot keep the child alive
          // indefinitely.
          killEscalation = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // child may have already exited between the SIGTERM and the
              // escalation — that's fine.
            }
          }, 5_000);
          killEscalation.unref?.();
        }, options.timeout)
      : null;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
    };

    child.stdout?.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimers();
      finishReject(Object.assign(error, { code: null }));
    });

    child.on("close", (code, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code ?? -1}`), {
        stdout,
        stderr,
        code,
        signal,
        killed: timedOut,
      }));
    });

    if (options.stdin != null && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

async function runLocalGit(
  localDir: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
    stdin?: string;
  } = {},
): Promise<SshCommandResult> {
  // execFile cannot feed stdin; route piped input through the spawn helper.
  if (options.stdin != null) {
    return await spawnText("git", ["-C", localDir, ...args], options);
  }
  return await execFileText("git", ["-C", localDir, ...args], options);
}

async function commandExists(command: string): Promise<boolean> {
  return (await resolveCommandPath(command)) !== null;
}

async function resolveCommandPath(command: string): Promise<string | null> {
  try {
    const result = await execFileText("sh", ["-c", `command -v ${shellQuote(command)}`], {
      timeout: 5_000,
      maxBuffer: 8 * 1024,
    });
    const resolved = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

async function withTempFile(
  prefix: string,
  contents: string,
  mode: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, "payload");
  const normalizedContents = contents.endsWith("\n") ? contents : `${contents}\n`;
  await fs.writeFile(filePath, normalizedContents, { mode, encoding: "utf8" });
  return {
    path: filePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function createSshAuthArgs(
  config: Pick<SshConnectionConfig, "privateKey" | "knownHosts" | "strictHostKeyChecking">,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const tempFiles: Array<() => Promise<void>> = [];
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    `StrictHostKeyChecking=${config.strictHostKeyChecking ? "yes" : "no"}`,
  ];

  if (config.strictHostKeyChecking) {
    if (config.knownHosts) {
      const knownHosts = await withTempFile("paperclip-ssh-known-hosts-", config.knownHosts, 0o600);
      tempFiles.push(knownHosts.cleanup);
      sshArgs.push("-o", `UserKnownHostsFile=${knownHosts.path}`);
    }
  } else {
    sshArgs.push("-o", "UserKnownHostsFile=/dev/null");
  }

  if (config.privateKey) {
    const privateKey = await withTempFile("paperclip-ssh-key-", config.privateKey, 0o600);
    tempFiles.push(privateKey.cleanup);
    sshArgs.push("-i", privateKey.path);
  }

  return {
    args: sshArgs,
    cleanup: async () => {
      await Promise.all(tempFiles.map((cleanup) => cleanup()));
    },
  };
}

function tarExcludeArgs(exclude: string[] | undefined, flavor: SshTarFlavor = "gnu"): string[] {
  const combined = ["._*", ...translateSshTarExcludes(exclude ?? [], flavor)];
  return combined.flatMap((entry) => ["--exclude", entry]);
}

function hasRootRelativeTarExcludes(exclude: string[] | undefined): boolean {
  return (exclude ?? []).some((entry) => entry.startsWith("./"));
}

function tarSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Prevent macOS bsdtar from emitting AppleDouble metadata files like ._README.md.
    COPYFILE_DISABLE: "1",
  };
}

export { SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES, SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES };

/**
 * Return `baseline` with the SSH agent-local scratch treated as out of scope
 * for the restore merge. The sync-back no longer carries these paths, so a
 * baseline that still lists them would make the merge read them as remote
 * deletions and remove the local copies (including uncommitted work in nested
 * agent worktrees). Dropping the entries and adding the excludes makes the
 * merge ignore these paths on both sides, however the baseline was captured.
 */
export function withSshAgentLocalExcludes(baseline: DirectorySnapshot): DirectorySnapshot {
  return {
    exclude: [...new Set([...baseline.exclude, ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES])],
    entries: new Map(
      [...baseline.entries].filter(
        ([relative]) => !shouldExcludePath(relative, SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES),
      ),
    ),
  };
}

/** Default bound on an SSH workspace sync-back payload, before any transfer. */
export const SSH_SYNC_BACK_DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Resolve the sync-back size cap from `PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES`
 * (bytes). Missing, unparseable, or non-positive values fall back to
 * {@link SSH_SYNC_BACK_DEFAULT_MAX_BYTES} so a bad setting fails open to the
 * default cap instead of disabling the bound or refusing every sync-back.
 */
export function resolveSshSyncBackMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES?.trim();
  if (!raw) return SSH_SYNC_BACK_DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return SSH_SYNC_BACK_DEFAULT_MAX_BYTES;
  return Math.floor(parsed);
}

/**
 * Thrown when an SSH workspace sync-back would exceed its size cap, so the
 * caller fails closed with a clear error instead of copying until ENOSPC.
 * The message carries only the remote directory path and byte counts, never
 * credentials or connection details.
 */
export class SshSyncBackSizeLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshSyncBackSizeLimitExceededError";
  }
}

/**
 * A counting Transform that fails a sync-back transfer closed the moment its
 * cumulative wire bytes exceed the cap, so no separate pre-transfer size
 * probe has to read the remote tree first. Splice it into the ssh-to-tar
 * pipe and route its `error` to the same failure handler as the processes:
 * the first over-cap chunk destroys the stream with
 * {@link SshSyncBackSizeLimitExceededError}, and the handler kills both ends
 * before anything is copied out of staging.
 */
export function createSshSyncBackCapTransform(input: {
  capBytes: number;
  remoteDir: string;
}): Transform {
  let seenBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seenBytes += chunk.length;
      if (seenBytes > input.capBytes) {
        try {
          assertSshSyncBackSizeWithinCap({
            sourceBytes: seenBytes,
            capBytes: input.capBytes,
            remoteDir: input.remoteDir,
          });
        } catch (error) {
          callback(error as Error);
          return;
        }
      }
      callback(null, chunk);
    },
  });
}

/**
 * Refuse an SSH workspace sync-back whose measured source exceeds its cap.
 * Both the streaming transfer cap and the post-extract staging size pass
 * through here, so either one fails closed before the copy reaches the
 * workspace (or another staging directory).
 */
export function assertSshSyncBackSizeWithinCap(input: {
  sourceBytes: number;
  capBytes: number;
  remoteDir: string;
}): void {
  if (input.sourceBytes <= input.capBytes) return;
  throw new SshSyncBackSizeLimitExceededError(
    `Refusing SSH workspace sync-back from ${input.remoteDir}: ` +
      `measured ${input.sourceBytes} bytes exceeds the ${input.capBytes}-byte cap ` +
      `(PAPERCLIP_SSH_SYNC_BACK_MAX_BYTES). ` +
      `Agent-local directories (${SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.join(", ")}) are already excluded; ` +
      `raise the cap only for a workspace that genuinely needs it.`,
  );
}

/**
 * The remote shell script the sync-back transfer runs: archive the remote
 * directory to stdout with the caller's excludes. The transfer runs this
 * script exactly once; the size cap is enforced on the stream it produces,
 * so no separate probe has to read the remote tree first.
 */
function buildRemoteWorkspaceDownloadScript(remoteDir: string, exclude?: string[], targets: string[] = ["."]): string {
  const tarCommand = (flavor: SshTarFlavor) =>
    `tar ${[...tarExcludeArgs(exclude, flavor).map(shellQuote), "-cf", "-", ...targets.map(shellQuote)].join(" ")}`;
  // Probe on the creating host: the server and remote can use different tars.
  const archive = hasRootRelativeTarExcludes(exclude)
    ? `case "$(tar --version)" in ` +
      `*"GNU tar"*) ${tarCommand("gnu")} ;; ` +
      `bsdtar\\ *) ${tarCommand("bsd")} ;; ` +
      `*) printf '%s\\n' 'Unsupported tar for root-relative SSH workspace excludes; use GNU tar or bsdtar' >&2; exit 1 ;; esac`
    : tarCommand("gnu");
  return `cd ${shellQuote(remoteDir)} && ${archive}`;
}

/**
 * The remote shell script the changed-files sync-back runs: archive exactly
 * the listed repository-relative paths to stdout with the caller's excludes.
 * Targets are `./`-anchored (root-relative, and dash-safe: a file named
 * `-rf` can never parse as a tar flag) and shell-quoted, so spaces, quotes,
 * and non-ASCII names survive byte-exact.
 */
export function buildSshChangedFilesDownloadScript(input: {
  remoteDir: string;
  paths: readonly string[];
  exclude?: string[];
}): string {
  return buildRemoteWorkspaceDownloadScript(
    input.remoteDir,
    input.exclude,
    input.paths.map((entry) => `./${entry}`),
  );
}

/**
 * Sum the regular-file bytes under a staging directory without following
 * symlinks (an `lstat` walk), so a link pointing outside the tree counts only
 * itself and can never inflate or loop the measurement.
 */
export async function measureDirectoryFileBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const stats = await fs.lstat(full).catch(() => null);
      if (!stats) continue;
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await walk(full);
      } else if (stats.isFile() || stats.isSymbolicLink()) {
        total += stats.size;
      }
    }
  };
  await walk(dir);
  return total;
}

/**
 * The three path sets a `git status --porcelain=v1 -z -uall --ignored`
 * listing splits into for an incremental sync-back: paths whose remote
 * content must transfer, paths the remote deleted (applied as
 * baseline-guarded deletes, never inferred from transfer absence), and
 * ignored paths the run created remotely (reconciled against the baseline
 * separately, since seed-time ignored files must stay local-only).
 */
export interface SshPorcelainChangedPaths {
  changedPaths: string[];
  deletedPaths: string[];
  ignoredPaths: string[];
}

/**
 * Parse `git status --porcelain=v1 -z` output into transfer, delete, and
 * ignored sets. Every entry whose worktree content still exists remotely
 * transfers (modifications, untracked files, unmerged entries, rename
 * destinations); only worktree deletions (a `D` in the Y column: ` D`,
 * `MD`, `AD`, `TD`, plus staged `D ` and unmerged `DD`) and rename sources
 * land in the delete set. A staged-then-worktree-deleted path (`MD`, `AD`)
 * has index content for a file that no longer exists remotely, so asking
 * tar for it would fail the whole download — it deletes, never transfers.
 * Ignored entries (`!!`, only present with `--ignored`) are collected
 * separately with any directory marker stripped (a trailing slash can only
 * mark a directory record, never a filename). A record without a status
 * prefix transfers defensively rather than silently dropping a remote path.
 * All sets are sorted and deduped so the transfer command is deterministic.
 */
export function parseSshPorcelainStatusV1Z(output: string): SshPorcelainChangedPaths {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const ignored = new Set<string>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (!record) continue;
    if (record.length > 3 && record[2] === " ") {
      const status = record.slice(0, 2);
      const entryPath = record.slice(3);
      if (status === "!!") {
        const normalized = entryPath.replace(/\/+$/, "");
        if (normalized) ignored.add(normalized);
        continue;
      }
      // Rename/copy entries carry the destination first and the source as a
      // bare follow-up record (`R  new\0old\0`); the source is a delete, and
      // so is a destination the worktree deleted (`RD`/`CD`).
      if (status[0] === "R" || status[0] === "C") {
        if (entryPath) {
          if (status[1] === "D") deleted.add(entryPath);
          else changed.add(entryPath);
        }
        const from = records[index + 1] ?? "";
        index += 1;
        if (from) deleted.add(from);
        continue;
      }
      // Deletion is a worktree (Y-column) fact: anything with `D` in Y is
      // gone remotely, as is a staged delete (`D `). Only `DD` counts among
      // unmerged codes — every other unmerged entry still holds conflict
      // content in the worktree and must transfer.
      const unmerged = status === "DD" || status === "AA" || status.includes("U");
      const worktreeGone = unmerged
        ? status === "DD"
        : status[1] === "D" || (status[0] === "D" && status[1] === " ");
      if (worktreeGone) {
        if (entryPath) deleted.add(entryPath);
      } else if (entryPath) {
        changed.add(entryPath);
      }
      continue;
    }
    changed.add(record);
  }
  return {
    changedPaths: [...changed].sort(),
    deletedPaths: [...deleted].sort(),
    ignoredPaths: [...ignored].sort(),
  };
}

/**
 * The remote shell script the changed-files sync-back runs to list what the
 * run left dirty: `git status --porcelain=v1 -z -uall --ignored` over the
 * whole tree, parsed by {@link parseSshPorcelainStatusV1Z}. `--ignored` is
 * load-bearing: without it a file the run created under an ignore rule is
 * invisible to the delta and silently lost, while the full copy restores
 * it. `--ignore-submodules=none` is load-bearing too: a tracked
 * `ignore = dirty|all` would otherwise hide a dirty gitlink and blind the
 * delta-driven submodule guard. Agent-local scratch roots are excluded via
 * negative pathspecs (when every pathspec is negative git still implies
 * the whole tree) because the merge drops them anyway — listing every file
 * under `node_modules` over SSH only risks the buffer/timeout fallback.
 * Status paths are repo-root-relative, so the script refuses to run
 * anywhere but a toplevel checkout first: an empty `--show-prefix` proves
 * `remoteDir` is the root, and any other outcome (a subdir, a non-repo, a
 * broken git) exits nonzero so the caller falls back to the full copy
 * instead of mis-resolving every path against the wrong root.
 */
export function buildSshRemoteStatusScript(remoteDir: string): string {
  const gitDir = `git -C ${shellQuote(remoteDir)}`;
  const excludes = SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.map((root) => shellQuote(`:!${root}`)).join(" ");
  return (
    `prefix=$(${gitDir} rev-parse --show-prefix) && test -z "$prefix" && ` +
    `${gitDir} status --porcelain=v1 -z -uall --ignored --ignore-submodules=none -- ${excludes}`
  );
}

/**
 * The remote shell script the changed-files sync-back runs to re-prove the
 * seed's ignored-file fingerprint: the same `ls-files` selection
 * {@link readSshSeedIgnoredFingerprint} hashed at seed time, re-folded
 * remotely. Prints `<content-hex> <meta-hex>`: the content fold (per-file
 * blob hashes of RAW bytes via `--no-filters`, in `ls-files` order) and the
 * meta fold (one `f <mode> <name>` / `l <target> <name>` line per entry,
 * same order). Bare blob hashes are blind to exactly what the merge
 * compares — modes, symlink targets (hashing follows the link), and
 * clean-filter or autocrlf normalizations — so both folds must match.
 *
 * Strictly POSIX `sh` (the transport runs `sh -c`, which may be dash): no
 * `read -d`, no process substitution, no `pipefail`. NUL-separated
 * throughout, so hostile filenames cannot split arguments; `xargs` may hash
 * in several argv batches, whose outputs still concatenate in input order.
 * The `sh -c` guard keeps the empty set hashing to nothing: bare `xargs -0`
 * would still run git once with no file arguments, hashing stdin instead.
 * Any failure rejects and the caller falls back to the full copy; an
 * emptied set folds to the empty blob twice, which can only match a seed
 * that carried nothing (and those seeds skip this probe), so mass deletion
 * fails closed too.
 */
export function buildSshSeededIgnoredProbeScript(remoteDir: string): string {
  const excludes = SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.map((root) => shellQuote(`:!${root}`)).join(" ");
  const selection = `git ls-files --others --ignored --exclude-per-directory=.gitignore -z -- ${excludes}`;
  const contentFold =
    `${selection} | xargs -0 sh -c '[ $# -gt 0 ] && exec git hash-object --no-filters -- "$@"' sh | ` +
    `git hash-object --stdin`;
  // Modes need `stat`, whose flag differs per platform: GNU `-c %a` first,
  // BSD `-f %Lp` as fallback. Either renders permission bits octal without
  // padding, matching the reader; anywhere both fail, the fold mismatches
  // and the restore falls back to the full copy.
  const metaFold =
    `${selection} | xargs -0 sh -c 'for f in "$@"; do ` +
    `if [ -L "./$f" ]; then t=$(readlink "./$f") || exit 1; printf "l %s %s\\n" "$t" "$f"; ` +
    `elif [ -f "./$f" ]; then m=$(stat -c %a "./$f" 2>/dev/null || stat -f %Lp "./$f" 2>/dev/null) || exit 1; ` +
    `printf "f %s %s\\n" "$m" "$f"; ` +
    `else printf "? %s\\n" "$f"; fi; done' sh | ` +
    `git hash-object --stdin`;
  return (
    `cd ${shellQuote(remoteDir)} && ` +
    `content=$(${contentFold}) && ` +
    `meta=$(${metaFold}) && ` +
    `printf "%s %s\\n" "$content" "$meta"`
  );
}

/**
 * Resolve the final sync-back transfer and delete sets from the remote
 * worktree status plus the paths the run's new commits changed (a local
 * `git diff` of the merge-base against the imported head, which shares the
 * transfer/delete shape). The worktree is authoritative where the two
 * disagree: a committed delete the run then recreated transfers (the remote
 * has the file), and a committed add the run then deleted is a delete, never
 * a transfer — asking tar for a missing member fails the whole download, so
 * a path the worktree deleted must never reach the transfer list. The rule
 * also holds inside the status itself: `git rm --cached` (or a staged
 * delete plus a recreate) reports the path as BOTH `D ` and `??`, and the
 * worktree copy wins — it transfers, never deletes. Both sets are sorted
 * and deduped so the transfer command is deterministic.
 */
export function resolveSshSyncBackTransferSets(input: {
  status: SshPorcelainChangedPaths;
  committed: SshPorcelainChangedPaths;
}): { transferPaths: string[]; deletedPaths: string[] } {
  const statusChanged = new Set(input.status.changedPaths);
  const deleted = new Set<string>(
    input.status.deletedPaths.filter((entry) => !statusChanged.has(entry)),
  );
  for (const entry of input.committed.deletedPaths) {
    if (!statusChanged.has(entry)) deleted.add(entry);
  }
  const transfer = new Set<string>();
  for (const entry of [...input.status.changedPaths, ...input.committed.changedPaths]) {
    if (!deleted.has(entry)) transfer.add(entry);
  }
  return {
    transferPaths: [...transfer].sort(),
    deletedPaths: [...deleted].sort(),
  };
}

// Converts a tar `--exclude` pattern into a regexp for the local-size estimate.
// We only need approximate fidelity here (the estimate feeds a clamped percent),
// so we support the literal names and `*`/`?` globs used in practice.
function tarPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

// Walks `localDir` summing regular-file sizes, mirroring tar's `--exclude`
// handling (plus the implicit `._*`) and `followSymlinks` so the to-ssh upload
// can report an estimated total before tar finishes producing the stream.
async function estimateLocalDirSize(input: {
  localDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<number> {
  const regexes = ["._*", ...(input.exclude ?? [])].map(tarPatternToRegExp);
  const isExcluded = (relPath: string, base: string) =>
    regexes.some((regex) => regex.test(relPath) || regex.test(base));

  let total = 0;
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(entryRelative, entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stats = await (input.followSymlinks ? fs.stat(full) : fs.lstat(full)).catch(() => null);
      if (!stats) continue;
      if (stats.isDirectory()) {
        await walk(full, entryRelative);
      } else if (stats.isFile()) {
        total += stats.size;
      }
    }
  };
  await walk(input.localDir, "");
  return total;
}

// Best-effort remote size probe for the from-ssh restore. `du -sk` is POSIX and
// available on the BSD/Linux remotes we target; it over-counts (block-rounded,
// includes excluded dirs) which keeps the reported percent safely below 100
// until the stream actually closes. Returns null when unavailable so the caller
// falls back to MB-received mode.
async function probeRemoteDirSize(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
}): Promise<number | null> {
  try {
    const result = await runSshScript(
      input.spec,
      `du -sk ${shellQuote(input.remoteDir)} 2>/dev/null | cut -f1`,
      { timeoutMs: 15_000, maxBuffer: 16 * 1024 },
    );
    const kilobytes = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

interface TransferProgress {
  // Backpressure-respecting counter to splice into a transport pipe.
  counter: Transform;
  // Last cumulative byte count observed by the counter.
  transferred: () => number;
  // Emit the terminal completion line. Idempotent.
  finish: () => Promise<void>;
  // Emit a terminal failure marker instead of a completion line. Idempotent.
  fail: () => Promise<void>;
}

// Wraps a throttled progress reporter behind a counting Transform so transports
// can `source.pipe(progress.counter).pipe(dest)`. When `totalBytes` is a known
// exact size (e.g. a git bundle) the reporter emits an exact percentage. When it
// is an estimate (tar upload / remote probe) we clamp the reported bytes to 99%
// of the estimate so an inaccurate total never shows a premature 100%; `finish`
// then emits the terminal 100% (or, in MB-only mode, the final MB) line.
//
// `totalBytes` may be a promise so an expensive size estimate (a local dir walk
// or a remote `du` probe) runs concurrently with the transfer instead of
// blocking the pipe from opening. Until it resolves the counter reports bytes in
// MB-only mode, then adopts the percentage once the total is known; `finish`
// awaits the estimate so the terminal 100% line is still guaranteed.
function createTransferProgress(input: {
  onProgress: RuntimeProgressSink;
  phase: RuntimeProgressPhase;
  direction: RuntimeProgressDirection;
  label?: string;
  totalBytes: number | null | Promise<number | null>;
  estimated: boolean;
}): TransferProgress {
  const reporter = createRuntimeProgressReporter({
    sink: input.onProgress,
    phase: input.phase,
    direction: input.direction,
    label: input.label,
    target: "ssh",
  });

  let total: number | null = null;
  let cap: number | null = null;
  const applyTotal = (value: number | null) => {
    total = value != null && value > 0 ? value : null;
    cap = total != null && input.estimated ? Math.floor(total * 0.99) : null;
  };
  const totalReady: Promise<void> =
    input.totalBytes != null && typeof (input.totalBytes as Promise<number | null>).then === "function"
      ? (input.totalBytes as Promise<number | null>).then(applyTotal, () => applyTotal(null))
      : (applyTotal(input.totalBytes as number | null), Promise.resolve());

  let transferred = 0;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch(() => undefined);
  };

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      const reported = cap != null ? Math.min(transferred, cap) : transferred;
      const totalSnapshot = total;
      enqueue(() => reporter.report(reported, totalSnapshot));
      callback(null, chunk);
    },
  });

  return {
    counter,
    transferred: () => transferred,
    finish: async () => {
      await chain.catch(() => undefined);
      await totalReady.catch(() => undefined);
      await reporter.complete(total != null ? total : transferred, total).catch(() => undefined);
    },
    fail: async () => {
      await chain.catch(() => undefined);
      await reporter.fail(transferred, total).catch(() => undefined);
    },
  };
}

async function runSshScript(
  config: SshConnectionConfig,
  script: string,
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await runSshCommand(
    config,
    script,
    options,
  );
}

// Clear `localDir` ahead of a sync-back copy, keeping the listed entries. An
// entry is a path relative to `localDir` and may be nested (`.claude/worktrees`):
// its ancestors are emptied rather than removed so the preserved path survives.
async function clearLocalDirectory(
  localDir: string,
  preserveEntries: readonly string[] = [],
): Promise<void> {
  await fs.mkdir(localDir, { recursive: true });
  const preserve = preserveEntries.map((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, ""));
  const clear = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(relative ? path.join(localDir, relative) : localDir);
    await Promise.all(
      entries.map(async (entry) => {
        const entryRelative = relative ? `${relative}/${entry}` : entry;
        if (preserve.includes(entryRelative)) return;
        const keepsDescendant = preserve.some((kept) => kept.startsWith(`${entryRelative}/`));
        const entryPath = path.join(localDir, entryRelative);
        if (keepsDescendant && (await fs.lstat(entryPath)).isDirectory()) {
          await clear(entryRelative);
          return;
        }
        await fs.rm(entryPath, { recursive: true, force: true });
      }),
    );
  };
  await clear("");
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir);
  await Promise.all(entries.map(async (entry) => {
    await fs.cp(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      // Without this, fs.cp resolves relative symlink targets against the
      // source dir: a restored `cur.log -> two.txt` would come back as an
      // absolute link into this deleted staging directory.
      verbatimSymlinks: true,
    });
  }));
}

async function readLocalGitWorkspaceSnapshot(localDir: string): Promise<LocalGitWorkspaceSnapshot | null> {
  try {
    const insideWorkTree = await runLocalGit(localDir, ["rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (insideWorkTree.stdout.trim() !== "true") {
      return null;
    }

    const [headCommitResult, branchResult, deletedResult] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--deleted", "-z"], {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      }),
    ]);

    const branchName = branchResult.stdout.trim();
    return {
      headCommit: headCommitResult.stdout.trim(),
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      deletedPaths: deletedResult.stdout
        .split("\0")
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

async function streamLocalFileToSsh(input: {
  spec: SshConnectionConfig;
  localFile: string;
  remoteScript: string;
  progress?: TransferProgress;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(input.localFile);
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      source.destroy();
      ssh.kill("SIGTERM");
      reject(error);
    };

    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    source.on("error", fail);
    ssh.on("error", fail);
    if (input.progress) {
      input.progress.counter.on("error", fail);
      source.pipe(input.progress.counter).pipe(ssh.stdin ?? null);
    } else {
      source.pipe(ssh.stdin ?? null);
    }
    ssh.on("close", (code) => {
      if (settled) return;
      settled = true;
      if ((code ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
        return;
      }
      resolve();
    });
  }).finally(auth.cleanup);
}

async function streamSshToLocalFile(input: {
  spec: SshConnectionConfig;
  remoteScript: string;
  localFile: string;
  progress?: TransferProgress;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sink = createWriteStream(input.localFile, { mode: 0o600 });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      ssh.kill("SIGTERM");
      sink.destroy();
      reject(error);
    };

    if (input.progress) {
      input.progress.counter.on("error", fail);
      ssh.stdout?.pipe(input.progress.counter).pipe(sink);
    } else {
      ssh.stdout?.pipe(sink);
    }
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    ssh.on("error", fail);
    sink.on("error", fail);
    ssh.on("close", (code) => {
      sink.end(() => {
        if (settled) return;
        settled = true;
        if ((code ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
          return;
        }
        resolve();
      });
    });
  }).finally(auth.cleanup);
}

async function importGitWorkspaceToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: LocalGitWorkspaceSnapshot;
  onProgress?: RuntimeProgressSink;
}): Promise<void> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  // Per-import unique ref so concurrent imports against the same local repo
  // can't race on `update-ref` between this run's update and bundle create.
  const tempRef = `refs/paperclip/ssh-sync/import/${randomUUID()}`;

  try {
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    await runLocalGit(input.localDir, ["bundle", "create", bundlePath, tempRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const originUrl = await readSanitizedOriginRemoteUrl(input.localDir);
    const alternatesPath = path.posix.join(input.remoteDir, ".git", "objects", "info", "alternates");

    const remoteSetupScript = [
      "set -e",
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "import-XXXXXX.bundle"))})`,
      'trap \'rm -f "$tmp_bundle"\' EXIT',
      'cat > "$tmp_bundle"',
      `if [ ! -d ${shellQuote(path.posix.join(input.remoteDir, ".git"))} ]; then git init ${shellQuote(input.remoteDir)} >/dev/null; fi`,
      `git -C ${shellQuote(input.remoteDir)} fetch --force "$tmp_bundle" '${tempRef}:${tempRef}' >/dev/null`,
      // A fallback reuse of a mirror-seeded clone still borrows the mirror
      // through `objects/info/alternates`, with `origin` pointing at the
      // mirror path. The workspace must not depend on a deletable cache, so
      // dissociate it the same way the mirror seed does: `repack -a` copies
      // every borrowed object home (a plain fetch would NOT — it negotiates
      // the alternates-visible objects as already present and transfers
      // nothing), then the alternates file and the mirror origin go. Repos
      // without an alternates file (every normal reuse) skip this untouched.
      `if [ -f ${shellQuote(alternatesPath)} ]; then git -C ${shellQuote(input.remoteDir)} repack -a -d >/dev/null; rm -f ${shellQuote(alternatesPath)}; git -C ${shellQuote(input.remoteDir)} remote remove origin >/dev/null 2>&1 || true; fi`,
      // Carry the workspace's (credential-scrubbed) origin into the transported
      // repo so branches there keep a publishable remote instead of reading as
      // remote-less snapshots. set-url covers a reused workspace whose origin
      // changed; add covers the fresh-init and stripped-shared-clone cases.
      // Best-effort under `set -e`.
      ...(originUrl
        ? [
          `{ git -C ${shellQuote(input.remoteDir)} remote set-url origin ${shellQuote(originUrl)} >/dev/null 2>&1 || git -C ${shellQuote(input.remoteDir)} remote add origin ${shellQuote(originUrl)} >/dev/null 2>&1; } || true`,
        ]
        : []),
      input.snapshot.branchName
        ? `git -C ${shellQuote(input.remoteDir)} checkout --force -B ${shellQuote(input.snapshot.branchName)} ${shellQuote(input.snapshot.headCommit)} >/dev/null`
        : `git -C ${shellQuote(input.remoteDir)} -c advice.detachedHead=false checkout --force --detach ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} reset --hard ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} clean -fdx -e .paperclip-runtime >/dev/null`,
      // Drop the per-import ref on the remote side too so it can't accumulate.
      `git -C ${shellQuote(input.remoteDir)} update-ref -d ${shellQuote(tempRef)} >/dev/null 2>&1 || true`,
    ].join("\n");

    // The git bundle is a real local file of known size, so report an exact
    // percentage. No `workspace` label: the "Importing git history" phase is
    // already self-describing in the log line.
    const progress = input.onProgress
      ? createTransferProgress({
        onProgress: input.onProgress,
        phase: "Importing git history",
        direction: "to",
        totalBytes: (await fs.stat(bundlePath)).size,
        estimated: false,
      })
      : null;

    try {
      await streamLocalFileToSsh({
        spec: input.spec,
        localFile: bundlePath,
        remoteScript: remoteSetupScript,
        progress: progress ?? undefined,
      });
      await progress?.finish();
    } catch (error) {
      await progress?.fail();
      throw error;
    }
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", tempRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Heads for an incremental sync-back export: the local HEAD the sync-back
// started from plus the remote HEAD the run left behind. Null when either
// side cannot answer (no commits yet, remote not a repo, probe failed): the
// export then falls back to the legacy full bundle.
async function readIncrementalExportHeads(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
}): Promise<{ baseHead: string; remoteHead: string } | null> {
  const [localHead, remoteHead] = await Promise.all([
    runLocalGit(input.localDir, ["rev-parse", "HEAD"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).then(
      (result) => result.stdout.trim(),
      () => "",
    ),
    runSshCommand(input.spec, `git -C ${shellQuote(input.remoteDir)} rev-parse HEAD`, {
      timeoutMs: 10_000,
      maxBuffer: 16 * 1024,
    }).then(
      (result) => result.stdout.trim(),
      () => "",
    ),
  ]);
  // rev-parse answers are interpolated into the export script: only hex SHAs
  // (sha1 or sha256) continue down the incremental path.
  const shaPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
  if (!shaPattern.test(localHead) || !shaPattern.test(remoteHead)) return null;
  return { baseHead: localHead, remoteHead };
}

async function runExportAttempt(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  bundlePath: string;
  importedRef: string;
  // Revision range for `bundle create`: the export ref alone (full history)
  // or `^base <export ref>` (only the run's new commits).
  bundleRange: string;
  resetLocalWorkspace?: boolean;
  onProgress?: RuntimeProgressSink;
}): Promise<string> {
  const exportScript = [
    "set -e",
    `git -C ${shellQuote(input.remoteDir)} update-ref refs/paperclip/ssh-sync/export HEAD`,
    `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
    `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "export-XXXXXX.bundle"))})`,
    'cleanup() { rm -f "$tmp_bundle"; git -C ' + shellQuote(input.remoteDir) + ' update-ref -d refs/paperclip/ssh-sync/export >/dev/null 2>&1 || true; }',
    'trap cleanup EXIT',
    `git -C ${shellQuote(input.remoteDir)} bundle create "$tmp_bundle" ${input.bundleRange} >/dev/null`,
    'cat "$tmp_bundle"',
  ].join("\n");

  // The remote bundle size isn't known before streaming, so report bytes
  // received (MB mode) with a terminal completion line.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Exporting git history",
      direction: "from",
      totalBytes: null,
      estimated: false,
    })
    : null;

  try {
    await streamSshToLocalFile({
      spec: input.spec,
      remoteScript: exportScript,
      localFile: input.bundlePath,
      progress: progress ?? undefined,
    });
    await progress?.finish();
  } catch (error) {
    await progress?.fail();
    throw error;
  }

  await runLocalGit(input.localDir, ["fetch", "--force", input.bundlePath, `refs/paperclip/ssh-sync/export:${input.importedRef}`], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (input.resetLocalWorkspace !== false) {
    await runLocalGit(input.localDir, ["reset", "--hard", input.importedRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  }
  const importedHead = await runLocalGit(input.localDir, ["rev-parse", input.importedRef], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  return importedHead.stdout.trim();
}

async function exportGitWorkspaceFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  importedRef?: string;
  resetLocalWorkspace?: boolean;
  onProgress?: RuntimeProgressSink;
}): Promise<string> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  const importedRef = input.importedRef ?? `refs/paperclip/ssh-sync/imported/${randomUUID()}`;

  try {
    // Incremental export, under the same kill switch as the seed fast path:
    // a run that made no commits skips the bundle entirely, otherwise only
    // the ^base range crosses the wire. A remote that cannot resolve the
    // base (unrelated history, shallow clone without it) fails the
    // incremental attempt and the legacy full bundle runs instead.
    const heads = isSshIncrementalSyncEnabled()
      ? await readIncrementalExportHeads(input).catch(() => null)
      : null;
    if (heads && heads.remoteHead === heads.baseHead) {
      if (input.resetLocalWorkspace !== false) {
        await runLocalGit(input.localDir, ["reset", "--hard", heads.remoteHead], {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
      }
      return heads.remoteHead;
    }
    if (heads) {
      try {
        return await runExportAttempt({
          ...input,
          bundlePath,
          importedRef,
          bundleRange: `${shellQuote(`^${heads.baseHead}`)} refs/paperclip/ssh-sync/export`,
        });
      } catch {
        // Fall through to the full bundle below.
      }
    }
    return await runExportAttempt({
      ...input,
      bundlePath,
      importedRef,
      bundleRange: "refs/paperclip/ssh-sync/export",
    });
  } finally {
    if (input.resetLocalWorkspace !== false) {
      await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }).catch(() => undefined);
    }
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function integrateImportedGitHead(input: {
  localDir: string;
  importedHead: string;
}): Promise<void> {
  const isConcurrentRefUpdateError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("cannot lock ref") && message.includes("expected");
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readLocalGitWorkspaceSnapshot(input.localDir);
    if (!snapshot) return;

    const currentHead = snapshot.headCommit;
    if (!currentHead || currentHead === input.importedHead) return;

    const headRef = snapshot.branchName ? `refs/heads/${snapshot.branchName}` : "HEAD";
    // `git merge-base` exits 1 when the commits share no ancestor — the only
    // outcome that authorizes the graft fallback below. Every other failure
    // (timeout, missing object, repository error) must keep failing the
    // integration instead of silently rewriting the tip.
    let noCommonAncestor = false;
    const mergeBase = await runLocalGit(input.localDir, ["merge-base", currentHead, input.importedHead], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch((error: unknown) => {
      noCommonAncestor = (error as { code?: unknown } | null)?.code === 1;
      return null;
    });
    const mergeBaseHead = mergeBase?.stdout.trim() ?? "";

    if (mergeBaseHead === input.importedHead) {
      return;
    }

    if (mergeBaseHead === currentHead) {
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, input.importedHead, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    if (noCommonAncestor) {
      // No common ancestor — merging is impossible and failing here would
      // discard the imported work. Graft it onto the current head instead;
      // see createUnrelatedHistoryGraftCommit.
      const graftCommit = await createUnrelatedHistoryGraftCommit({
        localDir: input.localDir,
        currentHead,
        importedHead: input.importedHead,
        syncLabel: "Paperclip SSH sync",
      });
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, graftCommit, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    let mergedTree;
    try {
      mergedTree = await runLocalGit(input.localDir, ["merge-tree", "--write-tree", currentHead, input.importedHead], {
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to merge concurrent SSH git histories for ${currentHead.slice(0, 12)} and ${input.importedHead.slice(0, 12)}: ${reason}`,
      );
    }
    const mergedTreeId = mergedTree.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!mergedTreeId) {
      throw new Error("Failed to compute a merged git tree for SSH workspace restore.");
    }

    const mergeCommit = await runLocalGit(
      input.localDir,
      [
        ...GIT_SYNC_COMMIT_IDENTITY_ARGS,
        "commit-tree",
        mergedTreeId,
        "-p",
        currentHead,
        "-p",
        input.importedHead,
        "-m",
        `Paperclip SSH sync merge ${input.importedHead.slice(0, 12)}`,
      ],
      {
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
    );
    try {
      await runLocalGit(input.localDir, ["update-ref", headRef, mergeCommit.stdout.trim(), currentHead], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      return;
    } catch (error) {
      if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
      throw error;
    }
  }

  throw new Error(`Failed to integrate concurrent SSH git history for ${input.importedHead.slice(0, 12)} after multiple retries.`);
}

async function clearRemoteDirectory(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  preserveEntries?: string[];
}): Promise<void> {
  const preservePatterns = (input.preserveEntries ?? [])
    .map((entry) => `! -name ${shellQuote(entry)}`)
    .join(" ");
  const script = [
    "set -e",
    `mkdir -p ${shellQuote(input.remoteDir)}`,
    `find ${shellQuote(input.remoteDir)} -mindepth 1 -maxdepth 1 ${preservePatterns} -exec rm -rf -- {} +`,
  ].join("\n");
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

async function removeDeletedPathsOnSsh(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  deletedPaths: string[];
}): Promise<void> {
  if (input.deletedPaths.length === 0) return;
  const quotedPaths = input.deletedPaths.map((entry) => shellQuote(entry)).join(" ");
  const script = `cd ${shellQuote(input.remoteDir)} && rm -rf -- ${quotedPaths}`;
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

async function allocateLoopbackPort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a loopback port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCondition(
  fn: () => Promise<void>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const timeoutAt = Date.now() + (options.timeoutMs ?? 10_000);
  const intervalMs = options.intervalMs ?? 200;
  let lastError: unknown = null;
  while (Date.now() < timeoutAt) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for SSH fixture readiness.");
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessCommand(pid: number): Promise<string | null> {
  for (const format of ["command=", "args="]) {
    try {
      const result = await execFileText("ps", ["-o", format, "-p", String(pid)], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      });
      const command = result.stdout.trim();
      if (command.length > 0) {
        return command;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function isSshEnvLabFixtureProcess(state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">): Promise<boolean> {
  if (!(await isPidRunning(state.pid))) {
    return false;
  }

  const command = await readProcessCommand(state.pid);
  if (!command) {
    return false;
  }

  return command.includes(state.sshdConfigPath);
}

export async function getSshEnvLabSupport(): Promise<SshEnvLabSupport> {
  if (process.platform === "darwin" && process.env.PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB !== "1") {
    return {
      supported: false,
      reason: "SSH env-lab fixture is disabled on macOS; set PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB=1 to opt in.",
    };
  }

  for (const command of ["ssh", "sshd", "ssh-keygen"]) {
    if (!(await commandExists(command))) {
      return {
        supported: false,
        reason: `Missing required command: ${command}`,
      };
    }
  }

  return {
    supported: true,
    reason: null,
  };
}

export function buildKnownHostsEntry(input: {
  host: string;
  port: number;
  publicKey: string;
}): string {
  return `[${input.host}]:${input.port} ${input.publicKey.trim()}`;
}

export async function runSshCommand(
  config: SshConnectionConfig,
  remoteCommand: string,
  options: {
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  let cleanup: () => Promise<void> = () => Promise.resolve();
  try {
    const auth = await createSshAuthArgs(config);
    cleanup = auth.cleanup;
    const sshArgs = [...auth.args];
    // The whole remote env is folded into one `sh -c` argv string, so the
    // assembled env block needs a per-argument byte budget as well. Reserve
    // the env-independent part of the argument (profile lines, the quoted
    // remote command, wrappers) so a large remote command shrinks the env
    // budget instead of overflowing the assembled argument.
    // Mirror buildSshSpawnTarget: source the login profiles first, then run
    // `env KEY=VAL cmd` so user-supplied identity overrides win over anything a
    // profile re-exports. The SSH target is an operator-configured host, not a
    // Paperclip sandbox image, so it can expose `node` or an agent CLI only
    // through a login profile; a non-login SSH command would miss that PATH.
    // Source `/etc/profile` first so a host that exposes the PATH through
    // `/etc/profile.d` scripts still resolves node and the agent CLI.
    // The script no longer sources `nvm.sh`; a profile that adds nvm still runs.
    // .bash_profile typically sources .bashrc itself; only source .bashrc
    // directly when no .bash_profile exists, so a host that adds nvm in
    // .bashrc still resolves node without a double-run of the setup.
    const profileLines = [
      'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    ];
    const envFreeScript = [
      ...profileLines,
      `exec env  sh -c ${shellQuote(remoteCommand)}`,
    ].join(" && ");
    const reservedArgBytes =
      6 + sshScriptOuterQuotedBytes(envFreeScript);
    const { env: launchEnv, dropped } = budgetSshRemoteEnvWithReport(
      options.env ?? {},
      { reservedArgBytes },
    );
    if (dropped.length) {
      console.warn(
        { droppedKeys: dropped },
        "dropped oversized SSH remote env values before launch",
      );
    }
    for (const [key] of Object.entries(launchEnv)) {
      if (!isValidShellEnvKey(key)) {
        throw new Error(`Invalid SSH environment variable key: ${key}`);
      }
    }

    const envArgs = Object.entries(launchEnv).map(
      ([key, value]) => `${key}=${shellQuote(value)}`,
    );
    const remoteScript = [
      ...profileLines,
      envArgs.length > 0
        ? `exec env ${envArgs.join(" ")} sh -c ${shellQuote(remoteCommand)}`
        : `exec sh -c ${shellQuote(remoteCommand)}`,
    ].join(" && ");

    sshArgs.push(
      "-p",
      String(config.port),
      `${config.username}@${config.host}`,
      `sh -c ${shellQuote(remoteScript)}`,
    );

    return options.stdin != null
      ? await spawnText("ssh", sshArgs, {
          stdin: options.stdin,
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        })
      : await execFileText("ssh", sshArgs, {
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        });
  } finally {
    await cleanup();
  }
}

export async function buildSshSpawnTarget(input: {
  spec: SshRemoteExecutionSpec;
  command: string;
  args: string[];
  env: Record<string, string>;
}): Promise<{
  command: string;
  args: string[];
  cleanup: () => Promise<void>;
}> {
  // Source the login profiles first, then run `env KEY=VAL cmd` so
  // user-supplied identity overrides win over anything a profile re-exports.
  // The SSH target is an operator-configured host, not a Paperclip sandbox
  // image, so it can expose `node` or an agent CLI only through a login
  // profile; a non-login SSH command would miss that PATH. Source
  // `/etc/profile` first so a host that exposes the PATH through
  // `/etc/profile.d` scripts still resolves node and the agent CLI. The script
  // no longer sources `nvm.sh`; a profile that adds nvm still runs.
  // .bash_profile typically sources .bashrc itself; only source .bashrc
  // directly when no .bash_profile exists, so a host that adds nvm in
  // .bashrc still resolves node without a double-run of the setup.
  const profileLines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
  ];
  // The whole remote env is folded into a single `sh -c` argv string, so the
  // assembled env block needs a per-argument byte budget as well (E2BIG).
  // Reserve the env-independent part of the argument (profile lines, the
  // quoted command and args, wrappers) so a large command shrinks the env
  // budget instead of overflowing the assembled argument.
  const remoteCommandParts = [shellQuote(input.command), ...input.args.map((arg) => shellQuote(arg))].join(" ");
  const envFreeScript = [
    ...profileLines,
    `cd ${shellQuote(input.spec.remoteCwd)}`,
    `exec env  ${remoteCommandParts}`,
  ].join(" && ");
  const reservedArgBytes = 6 + sshScriptOuterQuotedBytes(envFreeScript);
  const { env: launchEnv, dropped } = budgetSshRemoteEnvWithReport(input.env, {
    reservedArgBytes,
  });
  if (dropped.length) {
    console.warn(
      { droppedKeys: dropped },
      "dropped oversized SSH remote env values before launch",
    );
  }
  for (const key of Object.keys(launchEnv)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid SSH environment variable key: ${key}`);
    }
  }
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [...auth.args];
  const envArgs = Object.entries(launchEnv)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const remoteScript = [
    ...profileLines,
    `cd ${shellQuote(input.spec.remoteCwd)}`,
    envArgs.length > 0
      ? `exec env ${envArgs.join(" ")} ${remoteCommandParts}`
      : `exec ${remoteCommandParts}`,
  ].join(" && ");

  sshArgs.push(
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(remoteScript)}`,
  );

  return {
    command: "ssh",
    args: sshArgs,
    cleanup: auth.cleanup,
  };
}

/** Literal omissions use a NUL file list, not argv-sized tar exclude patterns. */
async function listSshArchivePaths(localDir: string, omitPaths: readonly string[]): Promise<string[]> {
  const paths = ["."];
  const omitted = new Set(omitPaths);
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(localDir, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (omitted.has(child)) continue;
      paths.push(`./${child}`);
      // Never follow directory symlinks, just as tar without -h does not.
      if (entry.isDirectory()) await walk(child);
    }
  };
  await walk("");
  return paths;
}

export async function syncDirectoryToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  exclude?: string[];
  omitPaths?: readonly string[];
  followSymlinks?: boolean;
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(`mkdir -p ${shellQuote(input.remoteDir)} && tar -xf - -C ${shellQuote(input.remoteDir)}`)}`,
  ];

  // tar's archive size isn't known until tar finishes, so estimate it from the
  // local file sizes and clamp the reported percent to 99% until the pipe closes.
  // The estimate walk runs concurrently with the transfer so it never delays the
  // pipe from opening on large workspaces.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Syncing",
      direction: "to",
      label: input.progressLabel,
      totalBytes: estimateLocalDirSize({
        localDir: input.localDir,
        exclude: input.exclude,
        followSymlinks: input.followSymlinks,
      }),
      estimated: true,
    })
    : null;

  try {
    const flavor = hasRootRelativeTarExcludes(input.exclude)
      ? resolveSshTarFlavor((await execFileText("tar", ["--version"])).stdout)
      : "gnu";
    const archivePaths = input.omitPaths
      ? await listSshArchivePaths(input.localDir, input.omitPaths)
      : null;
    await new Promise<void>((resolve, reject) => {
    const tarArgs = [
      ...(input.followSymlinks ? ["-h"] : []),
      "-C",
      input.localDir,
      ...tarExcludeArgs(input.exclude, flavor),
      "-cf",
      "-",
      ...(archivePaths ? ["--null", "--no-recursion", "-T", "-"] : ["."]),
    ];
    const tar = spawn("tar", tarArgs, {
      stdio: [archivePaths ? "pipe" : "ignore", "pipe", "pipe"],
      env: tarSpawnEnv(),
    });
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let tarStderr = "";
    let sshStderr = "";
    let settled = false;
    let tarExited = false;
    let sshExited = false;
    let tarExitCode: number | null = null;
    let sshExitCode: number | null = null;

    const maybeFinish = () => {
      if (settled || !tarExited || !sshExited) {
        return;
      }
      settled = true;
      if ((tarExitCode ?? 0) !== 0) {
        reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
        return;
      }
      if ((sshExitCode ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
        return;
      }
      resolve();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      tar.kill("SIGTERM");
      ssh.kill("SIGTERM");
      reject(error);
    };

    tar.stdin?.on("error", fail);
    if (archivePaths) tar.stdin?.end(`${archivePaths.join("\0")}\0`);
    if (progress) {
      progress.counter.on("error", fail);
      tar.stdout?.pipe(progress.counter).pipe(ssh.stdin ?? null);
    } else {
      tar.stdout?.pipe(ssh.stdin ?? null);
    }
    tar.stderr?.on("data", (chunk) => {
      tarStderr += String(chunk);
    });
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });

    tar.on("error", fail);
    ssh.on("error", fail);
    tar.on("close", (code) => {
      tarExited = true;
      tarExitCode = code;
      maybeFinish();
    });
    ssh.on("close", (code) => {
      sshExited = true;
      sshExitCode = code;
      maybeFinish();
    });
    });
    await progress?.finish();
  } catch (error) {
    await progress?.fail();
    throw error;
  } finally {
    await auth.cleanup();
  }
}

/**
 * Stream one remote tar script into a staging directory: ssh stdout through
 * the streaming size cap (and the caller's progress counter, if any) into a
 * local tar extractor. Shared by the full-tree sync-back and the
 * changed-files sync-back; both fail closed with
 * {@link SshSyncBackSizeLimitExceededError} on over-cap streams.
 */
async function extractRemoteTarStreamToStaging(input: {
  spec: SshRemoteExecutionSpec;
  remoteScript: string;
  stagingDir: string;
  capBytes: number;
  remoteDir: string;
  progress: TransferProgress | null;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  // Full-copy fallback may omit thousands of ignored paths. Keep the SSH
  // exec argument bounded without dropping any exclusions or the byte cap.
  const scriptViaStdin = sshScriptOuterQuotedBytes(input.remoteScript) > SSH_REMOTE_ARG_MAX_BYTES;
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(scriptViaStdin ? "sh -s" : input.remoteScript)}`,
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      const ssh = spawn("ssh", sshArgs, {
        stdio: [scriptViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const tar = spawn("tar", ["-xf", "-", "-C", input.stagingDir], {
        stdio: ["pipe", "ignore", "pipe"],
        env: tarSpawnEnv(),
      });

      let sshStderr = "";
      let tarStderr = "";
      let settled = false;
      let sshExited = false;
      let tarExited = false;
      let sshExitCode: number | null = null;
      let tarExitCode: number | null = null;

      const maybeFinish = () => {
        if (settled || !sshExited || !tarExited) return;
        settled = true;
        if ((sshExitCode ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
          return;
        }
        if ((tarExitCode ?? 0) !== 0) {
          reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
          return;
        }
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        ssh.kill("SIGTERM");
        tar.kill("SIGTERM");
        reject(error);
      };

      ssh.stdin?.on("error", fail);
      if (scriptViaStdin) ssh.stdin?.end(`${input.remoteScript}\n`);
      // The streaming cap sits first in the pipe so over-cap bytes never
      // reach the extractor; its error kills both processes via `fail`.
      const cap = createSshSyncBackCapTransform({ capBytes: input.capBytes, remoteDir: input.remoteDir });
      cap.on("error", fail);
      if (input.progress) {
        input.progress.counter.on("error", fail);
        ssh.stdout?.pipe(cap).pipe(input.progress.counter).pipe(tar.stdin ?? null);
      } else {
        ssh.stdout?.pipe(cap).pipe(tar.stdin ?? null);
      }
      ssh.stderr?.on("data", (chunk) => {
        sshStderr += String(chunk);
      });
      tar.stderr?.on("data", (chunk) => {
        tarStderr += String(chunk);
      });

      ssh.on("error", fail);
      tar.on("error", fail);
      ssh.on("close", (code) => {
        sshExited = true;
        sshExitCode = code;
        maybeFinish();
      });
      tar.on("close", (code) => {
        tarExited = true;
        tarExitCode = code;
        maybeFinish();
      });
    });
  } finally {
    await auth.cleanup();
  }
}

export async function syncDirectoryFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  exclude?: string[];
  preserveLocalEntries?: readonly string[];
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
  const remoteTarScript = buildRemoteWorkspaceDownloadScript(input.remoteDir, input.exclude);

  // The remote tar size isn't known locally, so probe the remote directory for
  // an estimate (clamped to 99%). The probe runs concurrently with the transfer
  // so its round-trip never delays the restore; when it is unavailable we report
  // bytes received in MB mode with a terminal completion line.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Restoring",
      direction: "from",
      label: input.progressLabel,
      totalBytes: probeRemoteDirSize({ spec: input.spec, remoteDir: input.remoteDir }),
      estimated: true,
    })
    : null;

  try {
    // Fail closed before any byte is copied out of staging: the transfer
    // stream itself carries a cap that aborts the moment cumulative wire
    // bytes exceed it, instead of copying until ENOSPC. A refusal still runs
    // the `finally` below, so no staging directory is left behind.
    const capBytes = resolveSshSyncBackMaxBytes();

    await extractRemoteTarStreamToStaging({
      spec: input.spec,
      remoteScript: remoteTarScript,
      stagingDir,
      capBytes,
      remoteDir: input.remoteDir,
      progress,
    });
    await progress?.finish();

    // The streaming cap bounds wire bytes, not extracted bytes: hardlinks
    // (and sparse members) can expand on disk, so re-check what actually
    // landed before copying it over the workspace (or over another staging
    // directory on the baseline path).
    const stagedBytes = await measureDirectoryFileBytes(stagingDir);
    assertSshSyncBackSizeWithinCap({ sourceBytes: stagedBytes, capBytes, remoteDir: input.remoteDir });

    await clearLocalDirectory(input.localDir, input.preserveLocalEntries);
    await copyDirectoryContents(stagingDir, input.localDir);
  } catch (error) {
    await progress?.fail();
    throw error;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Download exactly the listed repository-relative paths from the remote
 * workspace into `stagingDir`. This is the transfer half of the
 * changed-files sync-back: the caller lists what `git status --porcelain`
 * reported remotely, then merges the partial tree over the workspace with
 * `mergeChangedFilesWithBaseline`.
 *
 * The transfer shares the full sync-back's guards: the streaming size cap
 * aborts over-cap streams mid-transfer, and the post-extract staging check
 * bounds extracted bytes. Directory members archive recursively, so an
 * ignored-directory record transfers whole. A path list that would overflow
 * the remote command budget, or a listed path missing remotely, rejects so
 * the caller falls back to the full copy — a partial tree is never
 * silently delivered.
 */
export async function downloadChangedFilesFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  stagingDir: string;
  paths: readonly string[];
  exclude?: string[];
  capBytes?: number;
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  if (input.paths.length === 0) return;
  const remoteScript = buildSshChangedFilesDownloadScript({
    remoteDir: input.remoteDir,
    paths: input.paths,
    exclude: input.exclude,
  });
  if (sshScriptOuterQuotedBytes(remoteScript) > SSH_REMOTE_ARG_MAX_BYTES) {
    throw new Error(
      `SSH changed-files sync-back from ${input.remoteDir} lists ${input.paths.length} paths, ` +
        `which exceeds the remote command budget; falling back to the full copy`,
    );
  }
  const capBytes = input.capBytes ?? resolveSshSyncBackMaxBytes();
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Restoring",
      direction: "from",
      label: input.progressLabel,
      totalBytes: null,
      estimated: false,
    })
    : null;
  try {
    await extractRemoteTarStreamToStaging({
      spec: input.spec,
      remoteScript,
      stagingDir: input.stagingDir,
      capBytes,
      remoteDir: input.remoteDir,
      progress,
    });
    await progress?.finish();
    const stagedBytes = await measureDirectoryFileBytes(input.stagingDir);
    assertSshSyncBackSizeWithinCap({ sourceBytes: stagedBytes, capBytes, remoteDir: input.remoteDir });
  } catch (error) {
    await progress?.fail();
    throw error;
  }
}

/** How a git-backed SSH workspace seed moved its bytes. */
export type SshSeedMode =
  /** Same-host fast path: history via `git clone --shared` from a local bare
   * mirror (zero history bytes over the wire, dissociated right after
   * checkout) plus an overlay tar of only the files that differ from HEAD.
   * Git-ignored files never transfer. */
  | "shared-mirror"
  /** Legacy path: a full-history bundle plus a full-tree tar. */
  | "full-copy";

/**
 * Kill switch for every incremental SSH sync optimization. Set
 * `PAPERCLIP_SSH_INCREMENTAL_SYNC=0` to force the legacy full-copy behavior in
 * both directions. Any other value (including unset) enables the fast paths.
 */
export function isSshIncrementalSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCLIP_SSH_INCREMENTAL_SYNC?.trim() !== "0";
}

/**
 * Root directory for the local shared seed mirrors. A mirror is a bare
 * object cache, safe to delete at any time: a missing mirror is rebuilt from
 * the workspace on the next seed. Override with `PAPERCLIP_SSH_MIRROR_ROOT`
 * (tests point it at a temp directory).
 */
export function resolveSshSeedMirrorRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PAPERCLIP_SSH_MIRROR_ROOT?.trim();
  if (raw) return raw;
  return path.join(os.homedir(), ".cache", "paperclip", "ssh-seed-mirrors");
}

interface SshSeedMirrorInput {
  mirrorPath: string;
  /** Physical path of the workspace's shared object store (fetch source). */
  commonDir: string;
}

/**
 * Resolve the shared mirror for `localDir`, keyed by the physical path of its
 * git common dir so sibling worktrees of one repo share one mirror. Returns
 * null when the workspace is not a git checkout or the mirror would land
 * inside the workspace itself (a misconfigured `PAPERCLIP_SSH_MIRROR_ROOT`
 * must disable the fast path, not seed a repo into itself).
 */
async function readSshSeedMirrorInput(
  localDir: string,
  mirrorRoot: string = resolveSshSeedMirrorRoot(),
): Promise<SshSeedMirrorInput | null> {
  try {
    const result = await runLocalGit(localDir, ["rev-parse", "--git-common-dir"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    const raw = result.stdout.trim();
    if (!raw) return null;
    const absolute = path.isAbsolute(raw) ? raw : path.resolve(localDir, raw);
    const commonDir = await fs.realpath(absolute).catch(() => absolute);
    const key = createHash("sha256").update(commonDir).digest("hex").slice(0, 32);
    const mirrorPath = path.join(mirrorRoot, `${key}.git`);
    const workspacePhysical = await fs.realpath(localDir).catch(() => path.resolve(localDir));
    if (mirrorPath === workspacePhysical || mirrorPath.startsWith(`${workspacePhysical}${path.sep}`)) {
      return null;
    }
    return { mirrorPath, commonDir };
  } catch {
    return null;
  }
}

/**
 * Create the shared mirror on first use and fetch the workspace's branches
 * plus `headCommit` into it. Local disk only, incremental after the first
 * fetch; concurrent runs may fetch together (git ref updates are atomic and
 * last-writer-wins on mirror refs is harmless — the seed checks out an
 * explicit SHA, never a mirror branch).
 *
 * The mirror is append-only by construction: `gc.auto` is disabled at init so
 * fetched objects are never pruned, even across branch force-pushes. Seeded
 * clones are dissociated right after checkout (repacked, then alternates
 * dropped), so a deleted mirror can never break a running workspace.
 */
async function ensureSshSeedMirror(input: SshSeedMirrorInput & { headCommit: string }): Promise<void> {
  const initialized = await fs.stat(path.join(input.mirrorPath, "HEAD")).then(() => true, () => false);
  if (!initialized) {
    await execFileText("git", ["init", "--bare", "--quiet", input.mirrorPath], {
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    await execFileText("git", ["--git-dir", input.mirrorPath, "config", "gc.auto", "0"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
  } else {
    // Idempotent: mirrors predating the gc.auto guard get it now.
    await execFileText("git", ["--git-dir", input.mirrorPath, "config", "gc.auto", "0"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
  }
  // A local-path fetch: only objects missing from the mirror are copied, and a
  // bare SHA fetches detached-HEAD commits that no branch advertises.
  await execFileText(
    "git",
    [
      "--git-dir", input.mirrorPath,
      "fetch", "--no-tags", "--quiet", "--force",
      input.commonDir,
      "+refs/heads/*:refs/heads/*",
      input.headCommit,
    ],
    {
      // First fetch copies the whole object store over local disk; generous.
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

/**
 * Prove the SSH remote sees the same filesystem as this host: write a random
 * secret to a nonce file under the workspace's runtime dir, read it back
 * through the remote shell, and compare. Any failure — a different host, an
 * unreadable path, a timeout — returns false and the caller falls back to the
 * full copy. The nonce file is always removed locally.
 *
 * A path-exists check alone would be wrong: two different hosts can share a
 * path string (e.g. `/home/user/paperclip`). Only the secret round-trip
 * proves the remote `cat` read THIS host's bytes.
 */
async function verifySshSameFilesystem(
  spec: SshConnectionConfig,
  localDir: string,
): Promise<boolean> {
  const token = randomUUID();
  const secret = randomUUID();
  const filePath = path.join(localDir, ".paperclip-runtime", `ssh-same-host-${token}`);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, secret, { mode: 0o600 });
  } catch {
    return false;
  }
  try {
    const result = await runSshCommand(spec, `cat ${shellQuote(filePath)}`, {
      timeoutMs: 15_000,
      maxBuffer: 16 * 1024,
    });
    return result.stdout.trim() === secret;
  } catch {
    return false;
  } finally {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
}

/** File selection for a mirror seed: the working-tree delta over HEAD. */
interface SshSeedGitSnapshot {
  headCommit: string;
  branchName: string | null;
  /** Tracked modifications plus untracked-but-not-ignored files. */
  overlayPaths: string[];
  deletedPaths: string[];
  /** Git-ignored paths (`--directory`-collapsed), workspace-relative. */
  ignoredPaths: string[];
}

/**
 * The seed provenance a baseline restore needs to reconcile the
 * changed-files delta exactly: the local HEAD the seed started from, the
 * working-tree delta over it (dirty tracked files plus
 * untracked-but-not-ignored files, minus agent-local scratch), and the
 * tracked paths already deleted locally at seed time. Without the seed
 * head, a retried restore cannot tell an already-applied delta from an
 * interrupted one; without the overlay, a seeded file the run reverted to
 * HEAD (or deleted) is invisible to both the remote status and the
 * committed diff; without the deleted list, a seed-time deletion the run
 * restored remotely stays deleted locally for the same reason.
 *
 * `ignoredFingerprint` covers the one set git status cannot diff: the
 * ignored files a legacy full-copy seed carried. A remotely deleted
 * ignored file has no status record at all, so the restore re-proves this
 * fingerprint remotely and falls back to the full copy on any change; a
 * match proves names, kinds, modes, link targets, and raw bytes identical
 * and skips ignored reconciliation entirely. Mirror seeds omit ignored
 * files, so they leave this unset (their baseline excludes make the
 * records moot), as do legacy seeds whose scan found no ignored files
 * (remote creations are then plain `!!` transfers and deletes are
 * impossible). Returned by `prepareWorkspaceForSshExecution` for every
 * git-backed seed; a restore that omits it takes the full copy.
 */
export interface SshSyncBackSeedState {
  headCommit: string;
  overlayPaths: string[];
  /** Tracked paths deleted in the local worktree at seed time (already filtered against the overlay and scratch). */
  deletedPaths: string[];
  /** Fingerprint of the carried ignored files' names and contents; unset when the seed carried none. */
  ignoredFingerprint?: SshSeedIgnoredFingerprint;
}

/**
 * Opaque fingerprint of the git-ignored files a legacy seed carried:
 * `count` names how many, `digest` is two `git hash-object --stdin`
 * digests separated by a space — the content fold (per-file blob hashes of
 * raw bytes via `--no-filters`, in `git ls-files` order) and the meta fold
 * (one `f <mode> <name>` / `l <target> <name>` line per entry, same
 * order). Both sides compute it with git itself, so no hashing semantics
 * can drift; any name, kind, mode, link-target, or raw-content change
 * flips the digest and fails the restore closed to the full copy. Filtered
 * hashing would collide (a clean filter or autocrlf normalizes distinct
 * worktrees identically), bare blob hashes ignore modes and hash through
 * symlinks onto target bytes, and hashes alone miss renames — the pair
 * covers every dimension the merge compares.
 */
export interface SshSeedIgnoredFingerprint {
  count: number;
  digest: string;
}

/**
 * Read the working-tree delta over HEAD for a legacy (full-copy) seed: the
 * same selection the mirror seed calls its overlay. Null on any git
 * failure — the caller then omits the seed state and the restore fails
 * closed to the full copy. No toplevel check: a subdir workspace never
 * reaches the overlay read anyway, because the committed-delta reader
 * rejects non-toplevel checkouts first.
 *
 * The untracked scan uses the repository-owned `.gitignore` rules only, not
 * `--exclude-standard`: host-global excludes and `.git/info/exclude` differ
 * per machine, so a file ignored only locally would otherwise force every
 * restore into the ignored-set-changed fallback (it can never reproduce
 * remotely). Files ignored only by host rules ride the overlay instead —
 * still exact, since a remotely deleted candidate rejects the download
 * into the full-copy fallback.
 */
async function readSshSeedOverlayPaths(localDir: string): Promise<string[] | null> {
  try {
    const [overlayDiff, untracked] = await Promise.all([
      runLocalGit(localDir, ["diff", "--no-renames", "--name-only", "-z", "--ignore-submodules=none", "--diff-filter=ACMTUXB", "HEAD", "--"], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z"], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
    ]);
    return [
      ...parseNulPathList(overlayDiff.stdout),
      ...parseNulPathList(untracked.stdout),
    ].filter((entry) => !isSshSeedAgentLocalScratchPath(entry));
  } catch {
    return null;
  }
}

/** Paths per `git hash-object` argv batch: 1000 average-length paths stay far under ARG_MAX. */
const SSH_SEED_IGNORED_HASH_BATCH = 1000;

/**
 * Fingerprint the git-ignored files a legacy (full-copy) seed carries, for
 * {@link SshSyncBackSeedState.ignoredFingerprint}. The scan mirrors the
 * remote probe in {@link buildSshSeededIgnoredProbeScript} exactly: same
 * `ls-files` selection with the same scratch pathspec excludes (the seed
 * tar drops scratch, so the fingerprint must too), per-file blob hashes of
 * raw bytes plus one meta line per entry, in `ls-files` order, folded with
 * `git hash-object --stdin`. Null on any git failure, hash/count mismatch,
 * or unhashable entry — the caller then omits the seed state and the
 * restore fails closed to the full copy.
 *
 * The selection uses the repository-owned `.gitignore` rules only, matching
 * the probe and the legacy overlay scan: host-global excludes would select
 * different sets on each side and fail every restore closed.
 */
export async function readSshSeedIgnoredFingerprint(localDir: string): Promise<SshSeedIgnoredFingerprint | null> {
  try {
    const scan = await runLocalGit(
      localDir,
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-per-directory=.gitignore",
        "-z",
        "--",
        ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.map((root) => `:!${root}`),
      ],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const entries = parseNulPathList(scan.stdout);
    // Classify before hashing: git cannot hash what the merge distinguishes
    // (modes, symlink targets), and hash-object would block on a fifo or
    // fail on anything but a file or link — either way the set is
    // unprovable, so fail closed instead of minting a partial fingerprint.
    // The permission-bits mask matches the probe's `stat %a` rendering.
    const metaLines: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(localDir, entry);
      const stats = await fs.lstat(entryPath).catch(() => null);
      if (!stats) return null;
      if (stats.isSymbolicLink()) {
        const target = await fs.readlink(entryPath).catch(() => null);
        if (target === null) return null;
        metaLines.push(`l ${target} ${entry}\n`);
      } else if (stats.isFile()) {
        metaLines.push(`f ${(stats.mode & 0o7777).toString(8)} ${entry}\n`);
      } else {
        return null;
      }
    }
    const perFile: string[] = [];
    for (let index = 0; index < entries.length; index += SSH_SEED_IGNORED_HASH_BATCH) {
      const batch = await runLocalGit(
        localDir,
        ["hash-object", "--no-filters", "--", ...entries.slice(index, index + SSH_SEED_IGNORED_HASH_BATCH)],
        { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      );
      perFile.push(...batch.stdout.split("\n").filter(Boolean));
    }
    // A short batch (a file vanishing mid-scan) must not mint a fingerprint
    // the remote can never reproduce: fall closed instead.
    if (perFile.length !== entries.length) return null;
    const [contentFold, metaFold] = await Promise.all([
      runLocalGit(localDir, ["hash-object", "--stdin"], {
        timeout: 60_000,
        maxBuffer: 16 * 1024,
        stdin: perFile.length > 0 ? `${perFile.join("\n")}\n` : "",
      }),
      runLocalGit(localDir, ["hash-object", "--stdin"], {
        timeout: 60_000,
        maxBuffer: 16 * 1024,
        stdin: metaLines.join(""),
      }),
    ]);
    return {
      count: entries.length,
      digest: `${contentFold.stdout.trim()} ${metaFold.stdout.trim()}`,
    };
  } catch {
    return null;
  }
}

function isSafeGitRelativePath(value: string): boolean {
  return Boolean(value) && !value.includes("\0") && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    !value.split(/[\\/]/).some((part) => part === ".." || part === ".");
}

/**
 * True when a seed-snapshot path falls under the agent-local scratch roots.
 * The legacy seed excludes these unconditionally; the mirror seed must drop
 * them from its selection too, because un-ignored scratch (a missing
 * `.gitignore` entry — Paperclip and Claude Code create these directories
 * inside workspaces) would otherwise ride the overlay onto the remote,
 * including whole nested agent worktrees. Root-anchored, like the transfer
 * excludes: nested source merely named like scratch still transfers.
 */
function isSshSeedAgentLocalScratchPath(relative: string): boolean {
  return SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.some(
    (root) => relative === root || relative.startsWith(`${root}/`),
  );
}

function parseNulPathList(stdout: string): string[] {
  // No trimming: `git -z` emits byte-exact names, and a filename may legally
  // start or end with whitespace. Only the trailing empty entry is dropped
  // (a filename cannot be empty), which filter(Boolean) already does.
  return stdout.split("\0").filter(Boolean).filter(isSafeGitRelativePath);
}

/**
 * Read the working-tree delta directly from git. Returns null for non-git
 * directories, non-toplevel workspaces (a subdir of a checkout — overlay
 * paths are toplevel-relative, so only a toplevel seed can stage them), and
 * any git failure; every null falls back to the legacy full copy.
 *
 * Note: tracked files force-added under an ignored directory are listed by
 * the overlay scan when modified (so the seed carries them) but hidden from
 * the restore baseline by the ignored entry (so remote edits to them do not
 * merge back). The same trade-off as the sandbox lane's ignore handling.
 *
 * Returns null (full copy) for workspaces whose bytes a HEAD checkout plus
 * diff overlay cannot reproduce: submodules (gitlinks) and content filters
 * (smudge/clean drivers such as git-crypt or LFS). Agent-local scratch is
 * dropped from every selection, matching the legacy seed's unconditional
 * excludes.
 */
async function readSshSeedGitSnapshot(localDir: string): Promise<SshSeedGitSnapshot | null> {
  try {
    const insideWorkTree = await runLocalGit(localDir, ["rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (insideWorkTree.stdout.trim() !== "true") return null;
    const toplevel = await runLocalGit(localDir, ["rev-parse", "--show-toplevel"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    const [workspacePhysical, toplevelPhysical] = await Promise.all([
      fs.realpath(localDir).catch(() => path.resolve(localDir)),
      fs.realpath(toplevel.stdout.trim()).catch(() => ""),
    ]);
    if (!toplevelPhysical || workspacePhysical !== toplevelPhysical) return null;

    const [headResult, branchResult, overlayDiff, untracked, deleted, ignored, staged, tracked] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], { timeout: 10_000, maxBuffer: 16 * 1024 }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 10_000, maxBuffer: 16 * 1024 }),
      runLocalGit(localDir, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=ACMTUXB", "HEAD", "--"], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--others", "--exclude-standard", "-z"], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
      // --no-renames decomposes staged renames into delete+add so the remote
      // drops the old name instead of keeping a stale HEAD checkout of it.
      runLocalGit(localDir, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=D", "HEAD", "--"], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--stage", "-z"], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "-z"], {
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      }),
    ]);
    const headCommit = headResult.stdout.trim();
    if (!headCommit) return null;
    const branchName = branchResult.stdout.trim();
    // A clean gitlink appears in neither the diff nor the untracked scan, and
    // the mirror clone checks it out as an empty directory — the full copy
    // carries the submodule files instead. `--stage` entries are
    // `<mode> <sha> <stage>\t<path>`; 160000 is the gitlink mode.
    if (staged.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) return null;
    // A set `filter` attribute means the working bytes differ from the blob
    // (git-crypt, LFS, custom smudge/clean) while `git diff` reports the file
    // clean through the clean filter — the overlay would omit it, and the
    // clone (which has no filter config) would check out raw blob bytes. Any
    // value other than unset/unspecified falls back to the full copy, whose
    // tar carries the working bytes. `check-attr -z` emits path/attr/value
    // triples; a buffer overrun throws into the full-copy fallback below.
    const filterAttrs = await runLocalGit(localDir, ["check-attr", "-z", "filter", "--stdin"], {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      stdin: tracked.stdout,
    });
    const filterFields = filterAttrs.stdout.split("\0");
    for (let index = 2; index < filterFields.length; index += 3) {
      const value = filterFields[index];
      if (value && value !== "unset" && value !== "unspecified") return null;
    }
    const overlayPaths = [
      ...parseNulPathList(overlayDiff.stdout),
      ...parseNulPathList(untracked.stdout),
    ].filter((entry) => !isSshSeedAgentLocalScratchPath(entry));
    const overlaySet = new Set(overlayPaths);
    return {
      headCommit,
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      overlayPaths,
      // A path present in the working tree (e.g. `git rm --cached`, which the
      // D scan reports while the file is still on disk) must never be
      // deleted remotely: the overlay carries it, and deleting it after the
      // overlay would read back as a remote deletion of a local file.
      deletedPaths: parseNulPathList(deleted.stdout).filter(
        (entry) => !overlaySet.has(entry) && !isSshSeedAgentLocalScratchPath(entry),
      ),
      ignoredPaths: parseNulPathList(ignored.stdout)
        .map((entry) => entry.replace(/\/+$/, ""))
        .filter(Boolean)
        .filter((entry) => !isSshSeedAgentLocalScratchPath(entry)),
    };
  } catch {
    return null;
  }
}

/**
 * Copy exactly `overlay` (workspace-relative paths from a seed snapshot) out
 * of `sourceRoot` into an empty `targetDir`, creating parent directories.
 * Files that vanish mid-copy are skipped — the remote checkout already holds
 * the HEAD version, so the worst case is a briefly stale file, the same class
 * of race as the legacy full-tree tar. Returns the staged file count.
 */
async function stageSshOverlayPaths(
  sourceRoot: string,
  overlay: readonly string[],
  targetDir: string,
): Promise<number> {
  let count = 0;
  for (const relative of overlay) {
    if (!isSafeGitRelativePath(relative)) continue;
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetDir, relative);
    const stats = await fs.lstat(source).catch(() => null);
    if (!stats) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, {
      recursive: stats.isDirectory() && !stats.isSymbolicLink(),
      force: true,
      preserveTimestamps: true,
      // Without this, fs.cp resolves relative symlink targets against the
      // source dir: a staged `cur.txt -> two.txt` would tar to the remote as
      // an absolute link at a local path — silently pointing back at the
      // local workspace same-host, dangling cross-host.
      verbatimSymlinks: true,
    });
    count += 1;
  }
  return count;
}

/**
 * Seed a git workspace through the shared mirror. History arrives via a remote
 * `git clone --shared` of the mirror (same filesystem, verified by the
 * caller), so no history bytes cross the wire; the working tree is the HEAD
 * checkout plus an overlay tar of exactly the snapshot's overlay paths. The
 * clone is dissociated before return, so the mirror stays safe to delete at
 * any time without breaking the seeded run.
 * Returns the git-ignored paths so the caller can keep the restore baseline
 * blind to the files this seed deliberately omits.
 */
async function seedGitWorkspaceToSshViaMirror(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: SshSeedGitSnapshot;
  mirror: SshSeedMirrorInput;
  onProgress?: RuntimeProgressSink;
}): Promise<string[]> {
  await ensureSshSeedMirror({ ...input.mirror, headCommit: input.snapshot.headCommit });
  const originUrl = await readSanitizedOriginRemoteUrl(input.localDir);

  const remoteSetupScript = [
    "set -e",
    // Clone needs an absent or empty target: fresh per-run dirs satisfy this,
    // and a retry over an existing checkout fails into the legacy import,
    // which heals partial state. `git clone` creates the leaf but not its
    // parents, hence the mkdir.
    `mkdir -p ${shellQuote(input.remoteDir)}`,
    `git clone --shared --no-checkout --quiet ${shellQuote(input.mirror.mirrorPath)} ${shellQuote(input.remoteDir)}`,
    // Same origin/branch/reset/clean semantics as the bundle import below: the
    // fast path changes the transport, not the resulting checkout.
    ...(originUrl
      ? [
        `{ git -C ${shellQuote(input.remoteDir)} remote set-url origin ${shellQuote(originUrl)} >/dev/null 2>&1 || git -C ${shellQuote(input.remoteDir)} remote add origin ${shellQuote(originUrl)} >/dev/null 2>&1; } || true`,
      ]
      : []),
    input.snapshot.branchName
      ? `git -C ${shellQuote(input.remoteDir)} checkout --force -B ${shellQuote(input.snapshot.branchName)} ${shellQuote(input.snapshot.headCommit)} >/dev/null`
      : `git -C ${shellQuote(input.remoteDir)} -c advice.detachedHead=false checkout --force --detach ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
    `git -C ${shellQuote(input.remoteDir)} reset --hard ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
    `git -C ${shellQuote(input.remoteDir)} clean -fdx -e .paperclip-runtime >/dev/null`,
    // Dissociate from the mirror: the mirror is a deletable object cache, so
    // the seeded repo must not borrow from it past this script. `repack -a`
    // copies every reachable object (including alternates') into a local pack
    // before the alternates file is dropped. Without a workspace origin URL,
    // `origin` still names the mirror path after `clone --shared`, so drop it
    // (same as the bundle import's alternates branch): a push there would
    // write into the shared cache, and the remote breaks when the mirror is
    // deleted. Best-effort under `set -e`.
    `git -C ${shellQuote(input.remoteDir)} repack -a -d >/dev/null`,
    `rm -f ${shellQuote(path.posix.join(input.remoteDir, ".git", "objects", "info", "alternates"))}`,
    ...(originUrl
      ? []
      : [
        `git -C ${shellQuote(input.remoteDir)} remote remove origin >/dev/null 2>&1 || true`,
      ]),
  ].join("\n");

  // No history bytes cross the wire, but keep the phase's completion line so
  // logs still show where the history came from (0 B = mirror, not bundle).
  const historyProgress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Importing git history",
      direction: "to",
      totalBytes: 0,
      estimated: false,
    })
    : null;
  try {
    await runSshCommand(input.spec, remoteSetupScript, {
      timeoutMs: 300_000,
      maxBuffer: 256 * 1024,
    });
    await historyProgress?.finish();
  } catch (error) {
    await historyProgress?.fail();
    throw error;
  }

  const overlayDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-overlay-"));
  try {
    const staged = await stageSshOverlayPaths(input.localDir, input.snapshot.overlayPaths, overlayDir);
    if (staged > 0) {
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: overlayDir,
        remoteDir: input.remoteDir,
        onProgress: input.onProgress,
        progressLabel: "workspace",
      });
    }
  } finally {
    await fs.rm(overlayDir, { recursive: true, force: true }).catch(() => undefined);
  }

  await removeDeletedPathsOnSsh({
    spec: input.spec,
    remoteDir: input.remoteDir,
    deletedPaths: input.snapshot.deletedPaths,
  });

  return input.snapshot.ignoredPaths;
}

/**
 * Cap on the serialized restore-command bytes the seed's ignored-path
 * excludes may add. Every ignored entry becomes a quoted `--exclude` pair in
 * the sync-back tar script — twice over, since root-relative excludes ship
 * both the GNU and bsdtar dialects — and the whole script travels as one
 * `sh -c` argv entry with a 128 KiB per-string exec limit
 * (see `SSH_REMOTE_ARG_MAX_BYTES`). Keep the mirror seed's existing metadata
 * budget: longer lists select the full copy, which uses a file-list upload
 * and can stream long restore scripts without dropping exclusions.
 */
const SSH_SEED_MAX_IGNORED_EXCLUDE_BYTES = 32 * 1024;

/**
 * Estimate the final ssh-argument bytes the ignored excludes add to the
 * restore command: both tar dialect branches plus shell quoting, the outer
 * re-quote expansion, and entry separators. Conservative on purpose — an
 * over-estimate only selects the safe legacy copy.
 */
function sshSeedIgnoredExcludeBytes(ignoredPaths: readonly string[]): number {
  let total = 0;
  for (const entry of ignoredPaths) {
    total += 2 * Buffer.byteLength(`./${escapeTarExcludeLiteral(entry)}`, "utf8") + 64;
  }
  return total;
}

/**
 * Attempt the mirror seed. Returns the ignored paths on success, or null when
 * the fast path is unavailable (cross-host remote, non-toplevel workspace, an
 * unreadable checkout, or an ignored list too large for the restore command)
 * so the caller runs the legacy full copy instead. A throw means the fast
 * path started and failed partway — the caller still falls back, since the
 * legacy import heals any partial remote state (init-if-missing, forced
 * checkout, hard reset, clean).
 */
async function trySeedGitWorkspaceViaMirror(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  onProgress?: RuntimeProgressSink;
}): Promise<{ ignoredPaths: string[]; seedState: SshSyncBackSeedState } | null> {
  if (!(await verifySshSameFilesystem(input.spec, input.localDir))) return null;
  const mirror = await readSshSeedMirrorInput(input.localDir);
  if (!mirror) return null;
  const snapshot = await readSshSeedGitSnapshot(input.localDir);
  if (!snapshot) return null;
  if (sshSeedIgnoredExcludeBytes(snapshot.ignoredPaths) > SSH_SEED_MAX_IGNORED_EXCLUDE_BYTES) {
    console.warn(
      { ignoredEntries: snapshot.ignoredPaths.length },
      "[paperclip] SSH mirror seed skipped: ignored-path excludes exceed the restore command budget; falling back to full copy",
    );
    return null;
  }
  const ignoredPaths = await seedGitWorkspaceToSshViaMirror({ ...input, snapshot, mirror });
  return {
    ignoredPaths,
    // No ignored fingerprint: this seed omits ignored files, and the
    // baseline excludes above make their status records moot.
    seedState: {
      headCommit: snapshot.headCommit,
      overlayPaths: snapshot.overlayPaths,
      deletedPaths: snapshot.deletedPaths,
    },
  };
}

/**
 * Git supplies nested rules and negations, but only repository-owned rules:
 * host-global excludes and info/exclude must not change the transferred tree.
 * Collapse ignored directories unless they contain force-added tracked files,
 * which must remain visible to both the transfer and restore baseline.
 * Non-Git folders use an empty, temporary index outside the source directory.
 * Other scan errors fail closed rather than silently exporting ignored data.
 */
async function readSshFullCopyIgnoredPaths(localDir: string): Promise<string[]> {
  const args = [
    "--others", "--ignored", "-z", "--exclude-per-directory=.gitignore",
    "--", ".", ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.map((entry) => `:!${entry}`),
  ];
  const options = { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 };
  const readPaths = (stdout: string): string[] => {
    const paths = stdout.split("\0").filter(Boolean);
    if (paths.some((entry) => !isSafeGitRelativePath(entry))) {
      throw new Error("SSH ignore scan returned an unsupported path; refusing an unfiltered full copy");
    }
    return paths;
  };
  const scan = async (gitArgs: string[]): Promise<string[]> => {
    const [ignored, tracked] = await Promise.all([
      runLocalGit(localDir, [...gitArgs, "ls-files", "--directory", ...args], options),
      runLocalGit(localDir, [...gitArgs, "ls-files", "--cached", "-z", "--", "."], options),
    ]);
    const trackedAncestors = new Set<string>();
    for (const entry of readPaths(tracked.stdout)) {
      trackedAncestors.add(entry);
      for (let slash = entry.indexOf("/"); slash !== -1; slash = entry.indexOf("/", slash + 1)) {
        trackedAncestors.add(entry.slice(0, slash));
      }
    }
    const ignoredPaths = readPaths(ignored.stdout).map((entry) => entry.replace(/\/+$/, ""));
    const expanded = ignoredPaths.filter((entry) => trackedAncestors.has(entry));
    if (expanded.length === 0) return ignoredPaths;
    const leaves = readPaths((await runLocalGit(localDir, [...gitArgs, "ls-files", ...args], options)).stdout);
    return [
      ...ignoredPaths.filter((entry) => !expanded.includes(entry)),
      ...leaves.filter((entry) => expanded.some((root) => entry.startsWith(`${root}/`))),
    ];
  };
  try {
    return await scan([]);
  } catch (error) {
    // Exit 128 alone also covers broken metadata. Only a folder with no Git
    // marker in its physical ancestry may use an empty index; never classify
    // a repository by localized stderr or hide a timeout/output-limit error.
    if ((error as { code?: unknown }).code !== 128 || process.env.GIT_DIR || process.env.GIT_WORK_TREE) throw error;
    let ancestor = await fs.realpath(localDir);
    while (true) {
      const marker = await fs.lstat(path.join(ancestor, ".git")).catch((markerError: NodeJS.ErrnoException) => {
        if (markerError.code === "ENOENT") return null;
        throw markerError;
      });
      if (marker) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  const gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-ignore-index-"));
  try {
    const gitArgs = ["--git-dir", gitDir, "--work-tree", path.resolve(localDir)];
    await runLocalGit(localDir, [...gitArgs, "init", "--quiet"], options);
    return await scan(gitArgs);
  } finally {
    await fs.rm(gitDir, { recursive: true, force: true });
  }
}

export async function prepareWorkspaceForSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  onProgress?: RuntimeProgressSink;
}): Promise<{
  gitBacked: boolean;
  seedMode: SshSeedMode;
  ignoredPaths?: string[];
  seedState?: SshSyncBackSeedState;
}> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  if (isSshIncrementalSyncEnabled()) {
    try {
      const seeded = await trySeedGitWorkspaceViaMirror({
        spec: input.spec,
        localDir: input.localDir,
        remoteDir,
        onProgress: input.onProgress,
      });
      if (seeded) {
        return {
          gitBacked: true,
          seedMode: "shared-mirror",
          ignoredPaths: seeded.ignoredPaths,
          seedState: seeded.seedState,
        };
      }
    } catch (error) {
      console.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "[paperclip] SSH mirror seed failed; falling back to full copy",
      );
    }
  }
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);
  const ignoredPaths = await readSshFullCopyIgnoredPaths(input.localDir);
  const omitPaths = [".git", ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES, ...ignoredPaths];

  if (gitSnapshot) {
    const overlayPaths = await readSshSeedOverlayPaths(input.localDir);
    await importGitWorkspaceToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      snapshot: gitSnapshot,
      onProgress: input.onProgress,
    });
    await syncDirectoryToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      exclude: [".git", ...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES],
      omitPaths,
      onProgress: input.onProgress,
      progressLabel: "workspace",
    });
    await removeDeletedPathsOnSsh({
      spec: input.spec,
      remoteDir,
      deletedPaths: gitSnapshot.deletedPaths,
    });
    // No fingerprint is needed: ignored files stay local, as on mirror seeds.
    // An unreadable overlay still omits seed provenance for a full restore.
    const overlaySet = new Set(overlayPaths ?? []);
    return {
      gitBacked: true,
      seedMode: "full-copy",
      ignoredPaths,
      ...(overlayPaths
        ? {
            seedState: {
              headCommit: gitSnapshot.headCommit,
              overlayPaths,
              // `ls-files --deleted` is unfiltered raw output: apply the
              // mirror snapshot's guards (a worktree-present path is never
              // a delete, scratch never reconciles) before trusting it.
              deletedPaths: gitSnapshot.deletedPaths.filter(
                (entry) =>
                  isSafeGitRelativePath(entry) &&
                  !overlaySet.has(entry) &&
                  !isSshSeedAgentLocalScratchPath(entry),
              ),
            },
          }
        : {}),
    };
  }

  await clearRemoteDirectory({
    spec: input.spec,
    remoteDir,
    preserveEntries: [".paperclip-runtime"],
  });
  await syncDirectoryToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir,
    exclude: [...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES],
    omitPaths: omitPaths.filter((entry) => entry !== ".git"),
    onProgress: input.onProgress,
    progressLabel: "workspace",
  });
  return { gitBacked: false, seedMode: "full-copy", ignoredPaths };
}

/**
 * List the paths the run's new commits changed, as seen from the local
 * checkout that already fetched them: `git diff` of the seed head against
 * the imported head, split into transfer and delete sets. The seed head
 * (not the current local head, and not their merge-base) is the diff root:
 * the merge integration moves the local branch to the imported head before
 * any file is applied, so a retry after an interrupted merge would
 * merge-base to the imported head itself and report an empty delta while
 * the worktree still holds pre-run files. Rooting at the seed head names
 * the run's whole delta on every attempt, and is immune to concurrent
 * local commits for the same reason. Throws when the delta is unknowable —
 * a non-toplevel workspace or histories with no common ancestor — and the
 * caller falls back to the full copy.
 */
async function readSshSyncBackCommittedPaths(
  localDir: string,
  importedHead: string,
  seedHead: string,
): Promise<SshPorcelainChangedPaths> {
  const prefix = await runLocalGit(localDir, ["rev-parse", "--show-prefix"], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  if (prefix.stdout.trim() !== "") {
    throw new Error(`SSH changed-files sync-back requires a toplevel local checkout: ${localDir}`);
  }
  // Ancestry validation only: the diff itself always roots at the seed
  // head. Histories with no common ancestor (an unrelated remote, exit 1)
  // fail here so the caller falls back before spending a status round
  // trip; every other failure keeps its own error.
  const mergeBase = await runLocalGit(localDir, ["merge-base", seedHead, importedHead], {
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  }).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== 1) throw error;
    return null;
  });
  if (!mergeBase || !mergeBase.stdout.trim()) {
    throw new Error("SSH changed-files sync-back found no common ancestor for the committed delta");
  }
  const [transferDiff, deleteDiff] = await Promise.all([
    runLocalGit(
      localDir,
      ["diff", "--no-renames", "--name-only", "-z", "--ignore-submodules=none", "--diff-filter=ACMTUXB", seedHead, importedHead, "--"],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    ),
    runLocalGit(
      localDir,
      ["diff", "--no-renames", "--name-only", "-z", "--ignore-submodules=none", "--diff-filter=D", seedHead, importedHead, "--"],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    ),
  ]);
  return {
    changedPaths: parseNulPathList(transferDiff.stdout),
    deletedPaths: parseNulPathList(deleteDiff.stdout),
    ignoredPaths: [],
  };
}

/**
 * True when any path in the incremental delta is a submodule gitlink in the
 * local index. The superproject status and committed diff name only the
 * dirty gitlink root, never interior paths, so an interior delete or rename
 * is invisible to the changed-files delta while the full copy applies it —
 * an unknowable delta that must fall back. Both inputs pass
 * `--ignore-submodules=none`, so a tracked `ignore = dirty|all` cannot hide
 * the gitlink from this guard. Additions need no guard: a new submodule
 * transfers as one whole-dir member, exactly what the full copy merges.
 * `:(literal)` keeps glob metacharacters in real filenames from misfiring
 * the pathspec match; trailing slashes are stripped so an untracked-form
 * `sub/` still matches the indexed `sub`.
 */
async function sshSyncBackDeltaTouchesGitlink(
  localDir: string,
  paths: readonly string[],
): Promise<boolean> {
  const candidates = paths
    .map((entry) => entry.replace(/\/+$/, ""))
    .filter(Boolean)
    .map((entry) => `:(literal)${entry}`);
  if (candidates.length === 0) return false;
  const staged = await runLocalGit(localDir, ["ls-files", "--stage", "-z", "--", ...candidates], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  // `--stage` entries are `<mode> <sha> <stage>\t<path>`; 160000 is gitlink.
  return staged.stdout.split("\0").some((entry) => entry.startsWith("160000 "));
}

/**
 * List what the run left dirty in the remote worktree, parsed by
 * {@link parseSshPorcelainStatusV1Z}. The status script exits nonzero
 * anywhere but a toplevel checkout, and `runSshCommand` surfaces that as a
 * rejection, so every unusable remote falls back to the full copy.
 */
async function readSshRemoteSyncBackStatus(
  spec: SshRemoteExecutionSpec,
  remoteDir: string,
): Promise<SshPorcelainChangedPaths> {
  const result = await runSshCommand(spec, buildSshRemoteStatusScript(remoteDir), {
    timeoutMs: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseSshPorcelainStatusV1Z(result.stdout);
}

/**
 * Attempt the changed-files sync-back into `stagingDir`: transfer exactly
 * the remote status paths plus the run's committed paths, then merge the
 * partial tree over the workspace with explicit deletes. Returns true when
 * the incremental restore completed, false when the caller must run the
 * full copy instead (fast path disabled, seed state omitted, delta
 * unknowable, path list over the remote command budget, a changed seed
 * ignored set, or a listed path missing remotely).
 *
 * The fallback window ends at the merge: a failed download leaves nothing
 * the full copy cannot heal (staging is emptied before returning false, so
 * the full extract never mixes with a partial tree), but a failed merge
 * has no remedy in the full path — both merges share the target, the
 * baseline, and the history integration — so merge errors propagate. A
 * size-cap refusal also propagates instead of falling back: the delta is a
 * subset of the full tree under the same excludes, so the full copy would
 * refuse too, after burning a second transfer.
 */
async function tryRestoreChangedFilesFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  baseline: DirectorySnapshot;
  importedHead: string;
  stagingDir: string;
  exclude: string[];
  seedState: SshSyncBackSeedState | undefined;
  beforeApply?: () => Promise<void>;
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<boolean> {
  if (!isSshIncrementalSyncEnabled()) return false;
  // Fail closed without seed provenance: the committed delta cannot root at
  // the seed head and seeded-but-reverted paths cannot reconcile, so the
  // full copy (which needs neither) is the only exact restore.
  if (!input.seedState) return false;
  const fallBack = async (reason: string, error: unknown): Promise<false> => {
    console.warn(
      { reason, error: error instanceof Error ? error.message : String(error) },
      "[paperclip] SSH changed-files sync-back unavailable; falling back to full copy",
    );
    // Emptied, not abandoned: the caller's full extract lands in this same
    // staging directory, and a partial incremental tree mixed into it would
    // merge phantom deletes. If the clear itself fails the error propagates
    // instead of risking that mix.
    await clearLocalDirectory(input.stagingDir);
    return false;
  };
  // Local first: a workspace that cannot even name its committed delta must
  // not spend a remote round trip before falling back.
  const seedState = input.seedState;
  let committed: SshPorcelainChangedPaths;
  try {
    committed = await readSshSyncBackCommittedPaths(input.localDir, input.importedHead, seedState.headCommit);
  } catch (error) {
    return fallBack("committed-diff", error);
  }
  let status: SshPorcelainChangedPaths;
  try {
    status = await readSshRemoteSyncBackStatus(input.spec, input.remoteDir);
  } catch (error) {
    return fallBack("remote-status", error);
  }
  // A legacy seed carries the ignored files, so their seed-time fingerprint
  // must still match: a remotely deleted ignored file lists no status
  // record at all (absence is invisible even to `--ignored`), and neither
  // the committed diff nor the overlay can name it, so the full copy is the
  // only exact restore. A match proves names, kinds, modes, link targets,
  // and raw bytes identical, and the ignored records below are then all
  // unchanged files, so they are dropped instead of transferred.
  const ignoredFingerprint = seedState.ignoredFingerprint;
  if (ignoredFingerprint && ignoredFingerprint.count > 0) {
    let remoteDigest: string;
    try {
      const probe = await runSshCommand(input.spec, buildSshSeededIgnoredProbeScript(input.remoteDir), {
        timeoutMs: 60_000,
        maxBuffer: 16 * 1024,
      });
      remoteDigest = probe.stdout.trim();
    } catch (error) {
      return fallBack("ignored-probe", error);
    }
    if (remoteDigest !== ignoredFingerprint.digest) {
      return fallBack(
        "ignored-set-changed",
        new Error(
          `seeded ignored-file fingerprint changed remotely: expected ${ignoredFingerprint.digest}, found ${remoteDigest || "<empty>"}`,
        ),
      );
    }
    status = { ...status, ignoredPaths: [] };
  }
  const sets = resolveSshSyncBackTransferSets({ status, committed });
  // Baseline-excluded paths (agent-local scratch, seed-omitted ignored
  // files) would be skipped by the merge anyway; dropping them here keeps
  // them off the wire and out of the command budget. The safety filter is
  // defense in depth: git-sourced paths cannot be absolute or escape the
  // root, but a tar member that did would write outside staging.
  const keep = (entry: string): boolean =>
    isSafeGitRelativePath(entry) && !shouldExcludePath(entry, input.baseline.exclude);
  const transfer = new Set(sets.transferPaths.filter(keep));
  const deleted = new Set(sets.deletedPaths.filter(keep));
  // Seed-overlay reconciliation: a seeded dirty file the run reverted to
  // HEAD (or a seeded untracked file the run deleted) is clean in both the
  // remote status and the committed diff, so neither names it. Overlay
  // candidates already covered stay deduplicated; an explicit worktree
  // delete stays authoritative (the file is gone remotely — asking tar for
  // it would only fail the download). An overlay candidate missing remotely
  // rejects the download below and the full-copy fallback heals the tree.
  for (const entry of seedState.overlayPaths) {
    if (!keep(entry) || deleted.has(entry) || transfer.has(entry)) continue;
    transfer.add(entry);
  }
  // Seed-deletion reconciliation: a tracked file deleted locally at seed
  // time was removed remotely by the seed, so a run that restores it (e.g.
  // `git checkout -- delme.txt`) leaves no status record and no committed
  // diff. The seed's deleted list names it as a transfer candidate. The
  // still-deleted common case stays on the fast path: the remote status
  // reports ` D` (or the run committed the deletion, which lands in the
  // same set), and the guard below keeps it off the transfer list —
  // asking tar for a missing member would fail the download into a
  // spurious fallback.
  for (const entry of seedState.deletedPaths) {
    if (!keep(entry) || deleted.has(entry) || transfer.has(entry)) continue;
    transfer.add(entry);
  }
  // Remote ignored records (`!!`): the full copy restores an ignored file
  // that did not exist at seed time, so the delta must carry it too. A
  // baseline-present record the excludes did not already drop (a tracked
  // file the run uncached under an ignore rule, whose `D ` the delete below
  // must not honor) transfers as well: the merge no-ops byte-identical
  // content, and the seed-time masses never reach this loop — mirror seeds
  // exclude them from the baseline, and a matching legacy fingerprint
  // clears the records above.
  for (const entry of status.ignoredPaths) {
    if (!keep(entry) || transfer.has(entry)) continue;
    deleted.delete(entry);
    transfer.add(entry);
  }
  const transferPaths = [...transfer].sort();
  const deletedPaths = [...deleted].sort();
  // Submodule interiors are invisible to the superproject delta: a dirty or
  // moved gitlink in either set names the root, never the interior path, so
  // the full copy (which merges the whole tree) is the only exact restore.
  // Runs before the download so a fallback spends no transfer.
  let touchesGitlink = false;
  try {
    touchesGitlink = await sshSyncBackDeltaTouchesGitlink(input.localDir, [...transferPaths, ...deletedPaths]);
  } catch (error) {
    return fallBack("submodule-probe", error);
  }
  if (touchesGitlink) {
    return fallBack(
      "submodule-delta",
      new Error("SSH changed-files sync-back delta names a submodule gitlink, whose interior is invisible to the superproject status"),
    );
  }
  try {
    await downloadChangedFilesFromSsh({
      spec: input.spec,
      remoteDir: input.remoteDir,
      stagingDir: input.stagingDir,
      paths: transferPaths,
      exclude: input.exclude,
      onProgress: input.onProgress,
      progressLabel: input.progressLabel,
    });
  } catch (error) {
    if (error instanceof SshSyncBackSizeLimitExceededError) throw error;
    return fallBack("download", error);
  }
  await mergeChangedFilesWithBaseline({
    baseline: input.baseline,
    sourceDir: input.stagingDir,
    deletedPaths,
    targetDir: input.localDir,
    beforeApply: input.beforeApply,
  });
  return true;
}

export async function restoreWorkspaceFromSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  baselineSnapshot?: DirectorySnapshot;
  restoreGitHistory?: boolean;
  /**
   * Git-ignored paths the seed deliberately omitted (from
   * `prepareWorkspaceForSshExecution`). The caller also lists them in the
   * baseline exclude so the merge stays blind to them; this copy lets the
   * inner transfer prune them with root-anchored, glob-escaped patterns
   * instead of the unanchored passthrough `toSshTarExcludes` gives
   * non-scratch entries (an unanchored `nested` would also prune a tracked
   * `src/nested/` from the sync-back). The plain (no-baseline) paths honor
   * the same entries as download excludes plus preserved local entries, so
   * a mirror seed followed by a plain restore keeps local-only ignored
   * files instead of deleting them.
   */
  ignoredPaths?: string[];
  /**
   * Seed provenance from `prepareWorkspaceForSshExecution` (the local HEAD
   * the seed started from plus its working-tree overlay). Required for the
   * changed-files fast path: without it the committed delta cannot root at
   * the seed head and seeded-but-reverted paths cannot reconcile, so the
   * restore takes the full copy. Omit only for restores whose baseline did
   * not come from a seed.
   */
  seedState?: SshSyncBackSeedState;
  onProgress?: RuntimeProgressSink;
}): Promise<void> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  // Seed-omitted ignored paths, for the plain restores below: their remote
  // copies (if any) must not download over the local ones, and the local
  // ones must survive the clear that precedes the copy-back.
  const ignoredRestorePaths = (input.ignoredPaths ?? [])
    .map((entry) => entry.replace(/\/+$/, ""))
    .filter(Boolean);
  const ignoredRestoreTarExcludes = ignoredRestorePaths.map(
    (entry) => `./${escapeTarExcludeLiteral(entry)}`,
  );
  if (input.baselineSnapshot) {
    // The sync-back never carries the agent-local scratch, so the merge must
    // not read its absence as a remote deletion of the local copies.
    const baseline = withSshAgentLocalExcludes(input.baselineSnapshot);
    const ignored = new Set(input.ignoredPaths ?? []);
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
    const importedRef = input.restoreGitHistory
      ? `refs/paperclip/ssh-sync/imported/${randomUUID()}`
      : null;
    // The baseline exclude is merge grammar and may predate the SSH
    // agent-local scratch; `baseline` has it merged in, and tar needs the
    // scratch anchored to the root so this inner transfer (staging
    // directory into staging directory) carries neither nested worktrees
    // nor build outputs, yet keeps nested source named like them. Omitted
    // git-ignored entries get the same root anchoring (plus glob
    // escaping, since they are repository-controlled names) for the same
    // reason: an unanchored `nested` would also prune tracked
    // `src/nested/` from the sync-back.
    const transferExclude = toSshTarExcludes(
      baseline.exclude.map((entry) => ignored.has(entry) ? `./${escapeTarExcludeLiteral(entry)}` : entry),
    );
    try {
      const importedHead = input.restoreGitHistory
        ? await exportGitWorkspaceFromSsh({
          spec: input.spec,
          remoteDir,
          localDir: input.localDir,
          importedRef: importedRef ?? undefined,
          resetLocalWorkspace: false,
          onProgress: input.onProgress,
        })
        : null;
      // Git history advances via integrateImportedGitHead; the working tree
      // still comes from the remote file snapshot so dirty remote edits win.
      const beforeApply = importedHead
        ? async () => {
          await integrateImportedGitHead({
            localDir: input.localDir,
            importedHead,
          });
        }
        : undefined;
      // Changed-files fast path: without git history there is no committed
      // delta to name, so non-git workspaces always take the full copy.
      const restoredIncrementally = input.restoreGitHistory && importedHead
        ? await tryRestoreChangedFilesFromSsh({
          spec: input.spec,
          remoteDir,
          localDir: input.localDir,
          baseline,
          importedHead,
          stagingDir,
          exclude: transferExclude,
          seedState: input.seedState,
          beforeApply,
          onProgress: input.onProgress,
          progressLabel: "workspace",
        })
        : false;
      if (!restoredIncrementally) {
        await syncDirectoryFromSsh({
          spec: input.spec,
          remoteDir,
          localDir: stagingDir,
          exclude: transferExclude,
          onProgress: input.onProgress,
          progressLabel: "workspace",
        });
        await mergeDirectoryWithBaseline({
          baseline,
          sourceDir: stagingDir,
          targetDir: input.localDir,
          beforeApply,
        });
      }
    } finally {
      if (importedRef) {
        await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        }).catch(() => undefined);
      }
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return;
  }
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    await exportGitWorkspaceFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      onProgress: input.onProgress,
    });
    await syncDirectoryFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      exclude: [".git", ...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES, ...ignoredRestoreTarExcludes],
      // Excluded from the download, so nothing replaces them: keep the local copies.
      preserveLocalEntries: [".git", ...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES, ...ignoredRestorePaths],
      onProgress: input.onProgress,
      progressLabel: "workspace",
    });
    return;
  }

  await syncDirectoryFromSsh({
    spec: input.spec,
    remoteDir,
    localDir: input.localDir,
    exclude: [...SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES, ...ignoredRestoreTarExcludes],
    preserveLocalEntries: [...SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES, ...ignoredRestorePaths],
    onProgress: input.onProgress,
    progressLabel: "workspace",
  });
}

export async function ensureSshWorkspaceReady(
  config: SshConnectionConfig,
): Promise<{ remoteCwd: string }> {
  const result = await runSshCommand(
    config,
    `mkdir -p ${shellQuote(config.remoteWorkspacePath)} && cd ${shellQuote(config.remoteWorkspacePath)} && pwd`,
  );
  return {
    remoteCwd: result.stdout.trim(),
  };
}

const SSH_ENV_LAB_FIXTURE_PATH_FIELDS = [
  "rootDir",
  "workspaceDir",
  "statePath",
  "clientPrivateKeyPath",
  "clientPublicKeyPath",
  "hostPrivateKeyPath",
  "hostPublicKeyPath",
  "authorizedKeysPath",
  "knownHostsPath",
  "sshdConfigPath",
  "sshdLogPath",
] as const satisfies readonly (keyof SshEnvLabFixtureState)[];

// True when candidate is an absolute path equal to rootDir or nested under
// it. Used to reject a state file whose paths point outside the fixture
// root it was read from.
function isPathRootedAt(candidate: string, rootDir: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  if (candidate === rootDir) return true;
  const relative = path.relative(rootDir, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// The state file is untrusted input: any local process running as the same
// user can write one. A forged pid or an empty sshdConfigPath would weaken
// isSshEnvLabFixtureProcess's identity check — an empty string is a
// substring of every command line, so it would match any running process.
// Reject a state file that fails this check before any identity check or
// signal runs against it.
function isValidSshEnvLabFixtureState(
  raw: SshEnvLabFixtureState,
  expectedRootDir: string,
): boolean {
  if (!Number.isSafeInteger(raw.pid) || raw.pid <= 0) return false;
  if (raw.rootDir !== expectedRootDir) return false;

  for (const field of SSH_ENV_LAB_FIXTURE_PATH_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || !isPathRootedAt(value, expectedRootDir)) {
      return false;
    }
  }

  const expectedSshdConfigPath = path.join(expectedRootDir, "sshd_config");
  if (raw.sshdConfigPath.length === 0 || raw.sshdConfigPath !== expectedSshdConfigPath) {
    return false;
  }

  return true;
}

export async function readSshEnvLabFixtureState(
  statePath: string,
): Promise<SshEnvLabFixtureState | null> {
  try {
    // Resolve a relative statePath against the current working directory
    // before use. The state validator below only accepts absolute paths, and
    // a relative statePath must resolve to the same absolute directory every
    // time a caller reads it, no matter the process working directory.
    const resolvedStatePath = path.resolve(statePath);
    const raw = JSON.parse(await fs.readFile(resolvedStatePath, "utf8")) as SshEnvLabFixtureState;
    if (!raw || raw.kind !== "ssh_openbsd") return null;
    if (!isValidSshEnvLabFixtureState(raw, path.dirname(resolvedStatePath))) return null;
    return raw;
  } catch {
    return null;
  }
}

async function waitUntilFixtureProcessExits(
  state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const timeoutAt = Date.now() + timeoutMs;
  while (true) {
    if (!(await isSshEnvLabFixtureProcess(state))) return true;
    if (Date.now() >= timeoutAt) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Sends a signal to a pid and treats an already-dead process as success.
// The identity check that runs before this call is not free: it spawns
// `ps`, which opens a real gap between the check and the signal. If the
// process exits inside that gap, `process.kill` throws ESRCH even though
// the outcome the caller wants (the process is gone) already holds. Any
// other error, such as EPERM for a pid that belongs to another user, must
// still propagate.
function signalFixtureProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

// Bounded shutdown escalation shared by every caller that must stop a
// fixture process: send SIGTERM, wait, re-check process identity (the pid
// can be reused in the gap between two signals), then SIGKILL, then wait
// again. Returns true only when the listener is confirmed gone.
async function escalateSshEnvLabFixtureShutdown(
  state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">,
): Promise<boolean> {
  if (!(await isSshEnvLabFixtureProcess(state))) return true;

  if (!signalFixtureProcess(state.pid, "SIGTERM")) return true;
  if (await waitUntilFixtureProcessExits(state, 5_000)) return true;

  if (!(await isSshEnvLabFixtureProcess(state))) return true;
  if (!signalFixtureProcess(state.pid, "SIGKILL")) return true;
  if (await waitUntilFixtureProcessExits(state, 2_000)) return true;

  return !(await isSshEnvLabFixtureProcess(state));
}

// Accepts a state path or an already-read state so a caller that already
// holds the fixture state in memory does not have to depend on the state
// file, which a teardown step may have already removed.
export async function stopSshEnvLabFixture(
  stateOrPath: string | SshEnvLabFixtureState,
): Promise<boolean> {
  const state = typeof stateOrPath === "string"
    ? await readSshEnvLabFixtureState(stateOrPath)
    : stateOrPath;
  if (!state) return false;

  if (!(await escalateSshEnvLabFixtureShutdown(state))) {
    throw new Error(
      `SSH env-lab fixture did not stop: pid ${state.pid} on port ${state.port} is still running after SIGKILL.`,
    );
  }

  // Remove the root directory only after the listener process is confirmed
  // gone. Removing it earlier would delete the state file the process needs
  // for a later stop attempt to find and signal it.
  await fs.rm(state.rootDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

export async function startSshEnvLabFixture(input: {
  statePath: string;
  bindHost?: string;
  host?: string;
  // Test-only. Shortens the readiness wait below its 10 second default, so
  // a regression test can force the start-failure cleanup path without a
  // real 10 second wait.
  readinessTimeoutMs?: number;
}): Promise<SshEnvLabFixtureState> {
  // Resolve a relative statePath against the current working directory once,
  // up front. Every derived path (rootDir and the persisted statePath field)
  // must be absolute, so the state validator in readSshEnvLabFixtureState
  // accepts the file that this function writes.
  const statePath = path.resolve(input.statePath);
  const existing = await readSshEnvLabFixtureState(statePath);
  if (existing && await isSshEnvLabFixtureProcess(existing)) {
    return existing;
  }
  if (existing) {
    await fs.rm(existing.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    throw new Error(`SSH env-lab fixture is unavailable: ${support.reason}`);
  }
  const sshdPath = await resolveCommandPath("sshd");
  if (!sshdPath) {
    throw new Error("SSH env-lab fixture is unavailable: missing required command: sshd");
  }

  const bindHost = input.bindHost ?? "127.0.0.1";
  const host = input.host ?? bindHost;
  const rootDir = path.dirname(statePath);
  await fs.mkdir(rootDir, { recursive: true });

  const username = os.userInfo().username;
  const port = await allocateLoopbackPort(bindHost);
  const workspaceDir = path.join(rootDir, "workspace");
  const clientPrivateKeyPath = path.join(rootDir, "client_key");
  const clientPublicKeyPath = `${clientPrivateKeyPath}.pub`;
  const hostPrivateKeyPath = path.join(rootDir, "host_key");
  const hostPublicKeyPath = `${hostPrivateKeyPath}.pub`;
  const authorizedKeysPath = path.join(rootDir, "authorized_keys");
  const knownHostsPath = path.join(rootDir, "known_hosts");
  const sshdConfigPath = path.join(rootDir, "sshd_config");
  const sshdLogPath = path.join(rootDir, "sshd.log");
  const sshdPidPath = path.join(rootDir, "sshd.pid");

  await fs.mkdir(workspaceDir, { recursive: true });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientPrivateKeyPath], {
    timeout: 15_000,
  });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  });

  await fs.copyFile(clientPublicKeyPath, authorizedKeysPath);
  const hostPublicKey = (await execFileText("ssh-keygen", ["-y", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  })).stdout.trim();
  await fs.writeFile(
    knownHostsPath,
    `${buildKnownHostsEntry({ host, port, publicKey: hostPublicKey })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    sshdConfigPath,
    [
      `Port ${port}`,
      `ListenAddress ${bindHost}`,
      `HostKey ${hostPrivateKeyPath}`,
      `PidFile ${sshdPidPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      "PasswordAuthentication no",
      "ChallengeResponseAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitRootLogin no",
      "UsePAM no",
      "StrictModes no",
      `AllowUsers ${username}`,
      "LogLevel VERBOSE",
      "PrintMotd no",
      "UseDNS no",
      "Subsystem sftp internal-sftp",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const child = spawn(sshdPath, ["-D", "-f", sshdConfigPath, "-E", sshdLogPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const state: SshEnvLabFixtureState = {
    kind: "ssh_openbsd",
    bindHost,
    host,
    port,
    username,
    rootDir,
    workspaceDir,
    statePath,
    pid: child.pid ?? 0,
    createdAt: new Date().toISOString(),
    clientPrivateKeyPath,
    clientPublicKeyPath,
    hostPrivateKeyPath,
    hostPublicKeyPath,
    authorizedKeysPath,
    knownHostsPath,
    sshdConfigPath,
    sshdLogPath,
  };

  if (!state.pid) {
    throw new Error("Failed to start SSH env-lab fixture.");
  }

  try {
    await waitForCondition(async () => {
      if (!(await isPidRunning(state.pid))) {
        const logOutput = await fs.readFile(sshdLogPath, "utf8").catch(() => "");
        throw new Error(logOutput || "SSH env-lab fixture exited before becoming ready.");
      }
      const config = await buildSshEnvLabFixtureConfig(state);
      await ensureSshWorkspaceReady(config);
    }, { timeoutMs: input.readinessTimeoutMs ?? 10_000, intervalMs: 250 });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  } catch (error) {
    // No state file exists on this path yet, so a later stopSshEnvLabFixture
    // call can never find this pid. Escalate and wait for exit here, the
    // same way stopSshEnvLabFixture does, before the root directory goes
    // away — otherwise a slow-to-exit sshd survives as an orphan with its
    // root directory already gone.
    const stopped = await escalateSshEnvLabFixtureShutdown(state);
    if (stopped) {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      const survivalNote =
        `SSH env-lab fixture pid ${state.pid} on port ${state.port} is still running after SIGKILL. ` +
        `Kept ${rootDir} for inspection; no state file exists to target it with a later stop call.`;
      if (error instanceof Error) {
        error.message = `${error.message}\n${survivalNote}`;
      } else {
        console.error(survivalNote);
      }
    }
    throw error;
  }
}

export async function buildSshEnvLabFixtureConfig(
  state: SshEnvLabFixtureState,
): Promise<SshConnectionConfig> {
  const [privateKey, knownHosts] = await Promise.all([
    fs.readFile(state.clientPrivateKeyPath, "utf8"),
    fs.readFile(state.knownHostsPath, "utf8"),
  ]);
  return {
    host: state.host,
    port: state.port,
    username: state.username,
    remoteWorkspacePath: state.workspaceDir,
    privateKey,
    knownHosts,
    strictHostKeyChecking: true,
  };
}

export async function readSshEnvLabFixtureStatus(statePath: string): Promise<{
  running: boolean;
  state: SshEnvLabFixtureState | null;
}> {
  const state = await readSshEnvLabFixtureState(statePath);
  if (!state) {
    return { running: false, state: null };
  }
  return {
    running: await isSshEnvLabFixtureProcess(state),
    state,
  };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
