import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";

export interface HeartbeatRunScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdAt: string;
}

export interface HeartbeatRunScratch {
  dir: string;
  markerPath: string;
  metadata: HeartbeatRunScratchMetadata;
}

export interface HeartbeatRunScratchEnvResult {
  env: Record<string, string>;
  tempKeysApplied: string[];
}

export type HeartbeatRunScratchCleanupResult =
  | { removed: true; dir: string }
  | { removed: false; dir: string; reason: "missing" | "unmarked" | "owner_mismatch" | "process_group_alive" };

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;

function sanitizePathSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ISSUE_SEGMENT_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return normalized || fallback;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseHeartbeatRunScratchMetadata(value: unknown): HeartbeatRunScratchMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (
    rec.version !== 1 ||
    typeof rec.companyId !== "string" ||
    typeof rec.agentId !== "string" ||
    typeof rec.runId !== "string" ||
    typeof rec.createdAt !== "string"
  ) {
    return null;
  }
  return {
    version: 1,
    companyId: rec.companyId,
    agentId: rec.agentId,
    runId: rec.runId,
    issueId: typeof rec.issueId === "string" ? rec.issueId : null,
    issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
    createdAt: rec.createdAt,
  };
}

async function readMarker(markerPath: string): Promise<HeartbeatRunScratchMetadata | null> {
  try {
    return parseHeartbeatRunScratchMetadata(JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function heartbeatRunScratchDirPrefix(issueIdentifier: string | null | undefined, runId: string): string {
  const issueSegment = sanitizePathSegment(issueIdentifier, "unassigned");
  const runSegment = sanitizePathSegment(runId.slice(0, 12), "run");
  return `paperclip-run-${issueSegment}-${runSegment}-`;
}

function buildHeartbeatRunScratchMetadata(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
}): HeartbeatRunScratchMetadata {
  return {
    version: 1,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    issueIdentifier: input.issueIdentifier ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export async function prepareHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
}): Promise<HeartbeatRunScratch> {
  const prefix = heartbeatRunScratchDirPrefix(input.issueIdentifier, input.runId);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
  const metadata = buildHeartbeatRunScratchMetadata(input);
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, markerPath, metadata };
}

export function buildHeartbeatRunScratchEnv(
  existingEnv: Record<string, unknown>,
  scratch: HeartbeatRunScratch,
): HeartbeatRunScratchEnvResult {
  const env: Record<string, string> = {
    PAPERCLIP_RUN_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TASK_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TMPDIR: scratch.dir,
  };
  const tempKeysApplied: string[] = [];
  for (const key of TEMP_ENV_KEYS) {
    const existing = existingEnv[key];
    if (typeof existing === "string" && existing.trim().length > 0) continue;
    env[key] = scratch.dir;
    tempKeysApplied.push(key);
  }
  return { env, tempKeysApplied };
}

export async function cleanupHeartbeatRunScratch(input: {
  scratch: HeartbeatRunScratch;
  processGroupId?: number | null;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
}): Promise<HeartbeatRunScratchCleanupResult> {
  const tmpRoot = path.resolve(os.tmpdir());
  const dir = path.resolve(input.scratch.dir);
  if (!isPathInside(tmpRoot, dir) || !path.basename(dir).startsWith("paperclip-run-")) {
    return { removed: false, dir, reason: "unmarked" };
  }
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) return { removed: false, dir, reason: "missing" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }

  const marker = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  if (
    marker.companyId !== input.scratch.metadata.companyId ||
    marker.agentId !== input.scratch.metadata.agentId ||
    marker.runId !== input.scratch.metadata.runId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }
  if (input.isProcessGroupAlive?.(input.processGroupId) === true) {
    return { removed: false, dir, reason: "process_group_alive" };
  }

  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

export interface RemoteHeartbeatRunScratchShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type RemoteHeartbeatRunScratchExec = (
  command: string,
) => Promise<RemoteHeartbeatRunScratchShellResult>;

function remoteScratchFailureDetail(result: RemoteHeartbeatRunScratchShellResult): string {
  const detail = (result.stderr || result.stdout).trim().split(/\r?\n/)[0]?.trim() ?? "";
  return detail.length > 0 ? `: ${detail.slice(0, 240)}` : "";
}

/**
 * Provision a per-run scratch directory on a remote (SSH/sandbox) execution
 * target through the existing execution-target shell channel. Remote heartbeat
 * runs previously received no `PAPERCLIP_RUN_SCRATCH_DIR`, so agents fell back
 * to fixed `/tmp` payload paths on hosts whose `/tmp` is shared across runs
 * and days — stale bytes from one run could then be POSTed by another.
 *
 * The directory is created atomically with remote `mktemp -d` (run-unique even
 * across concurrent runs on the same host) and carries the same ownership
 * marker file as local scratch. Callers apply `buildHeartbeatRunScratchEnv`
 * to the result exactly like the local path. Throws on any shell failure; the
 * heartbeat dispatch catches provisioning failures and continues without
 * scratch env, mirroring the local failure path.
 */
export async function prepareRemoteHeartbeatRunScratch(
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string | null;
    issueIdentifier?: string | null;
    now?: Date;
  },
  deps: { exec: RemoteHeartbeatRunScratchExec },
): Promise<HeartbeatRunScratch> {
  const prefix = heartbeatRunScratchDirPrefix(input.issueIdentifier, input.runId);
  // The trailing X's are the mktemp template; remote mktemp requires them at
  // the end. The prefix segments are sanitized to [a-z0-9._-], so the template
  // carries no shell metacharacters besides the intentional $TMPDIR expansion.
  const created = await deps.exec(`mktemp -d "\${TMPDIR:-/tmp}/${prefix}XXXXXX"`);
  if (created.timedOut) {
    throw new Error("Timed out creating the remote heartbeat run scratch directory.");
  }
  if (created.exitCode !== 0) {
    throw new Error(
      `Could not create the remote heartbeat run scratch directory${remoteScratchFailureDetail(created)}.`,
    );
  }
  const dir = created.stdout.split("\n")[0]?.trim() ?? "";
  if (!dir.startsWith("/") || !path.posix.basename(dir).startsWith("paperclip-run-")) {
    throw new Error(`Remote mktemp returned an unexpected scratch directory: ${dir || "(empty)"}`);
  }
  const metadata = buildHeartbeatRunScratchMetadata(input);
  const markerPath = `${dir}/${HEARTBEAT_RUN_SCRATCH_MARKER}`;
  // Base64 keeps the marker JSON free of shell metacharacters; the alphabet is
  // single-quote safe, and the paths are shell-quoted.
  const encoded = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8").toString("base64");
  // Best-effort rollback: a marker write that fails after mktemp succeeded
  // must not litter a marker-less remote dir. Swallowed — provisioning already
  // failed, and the heartbeat continues without scratch env either way.
  const rollbackDir = () => deps.exec(`rm -rf -- ${shellQuote(dir)}`).catch(() => undefined);
  let written: RemoteHeartbeatRunScratchShellResult;
  try {
    written = await deps.exec(
      `printf '%s' '${encoded}' | base64 -d > ${shellQuote(markerPath)} && chmod 600 ${shellQuote(markerPath)}`,
    );
  } catch (execError) {
    await rollbackDir();
    throw execError;
  }
  if (written.timedOut || written.exitCode !== 0) {
    await rollbackDir();
    if (written.timedOut) {
      throw new Error(`Timed out writing the remote run scratch marker: ${dir}`);
    }
    throw new Error(
      `Could not write the remote run scratch marker: ${dir}${remoteScratchFailureDetail(written)}.`,
    );
  }
  return { dir, markerPath, metadata };
}

/**
 * Remove a remote run scratch directory provisioned by
 * `prepareRemoteHeartbeatRunScratch`. Honors the same marker/owner checks as
 * local cleanup: only an absolute `paperclip-run-*` directory whose marker
 * matches the run's company/agent/run is removed. Unlike local cleanup there
 * is no process-group liveness check — a remote process group cannot be
 * observed through the shell channel — so callers must only invoke this at a
 * terminal run boundary, before the environment lease is released.
 */
export async function cleanupRemoteHeartbeatRunScratch(
  input: { scratch: HeartbeatRunScratch },
  deps: { exec: RemoteHeartbeatRunScratchExec },
): Promise<HeartbeatRunScratchCleanupResult> {
  const dir = input.scratch.dir;
  if (!dir.startsWith("/") || !path.posix.basename(dir).startsWith("paperclip-run-")) {
    return { removed: false, dir, reason: "unmarked" };
  }
  const markerPath = `${dir}/${HEARTBEAT_RUN_SCRATCH_MARKER}`;
  const read = await deps.exec(`cat ${shellQuote(markerPath)}`);
  if (read.timedOut || read.exitCode !== 0) {
    return { removed: false, dir, reason: "unmarked" };
  }
  let marker: HeartbeatRunScratchMetadata | null = null;
  try {
    marker = parseHeartbeatRunScratchMetadata(JSON.parse(read.stdout) as unknown);
  } catch {
    marker = null;
  }
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  if (
    marker.companyId !== input.scratch.metadata.companyId ||
    marker.agentId !== input.scratch.metadata.agentId ||
    marker.runId !== input.scratch.metadata.runId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }
  const removed = await deps.exec(`rm -rf -- ${shellQuote(dir)}`);
  if (removed.timedOut) {
    throw new Error(`Timed out removing the remote heartbeat run scratch directory: ${dir}`);
  }
  if (removed.exitCode !== 0) {
    throw new Error(
      `Could not remove the remote heartbeat run scratch directory: ${dir}${remoteScratchFailureDetail(removed)}.`,
    );
  }
  return { removed: true, dir };
}
