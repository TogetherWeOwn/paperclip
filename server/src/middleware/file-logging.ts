// Retained file logging: server stdout/stderr plus a minimal access log,
// written under the instance logs dir so they survive container recreates.
//
// Two files, both size-rotated by RotatingFileSink:
// - `server.log`: everything the process logs. Pino output arrives through a
//   multistream destination (see logger.ts); direct stdout/stderr writes
//   (console.*, Node fatal prints) arrive through the stdio tee installed
//   here. Stdout itself is untouched: `docker logs` keeps working as before.
// - `access.log`: one JSON line per HTTP request (timestamp, method, path,
//   status, duration). Unlike the pino-http lines, nothing is silenced, so
//   request counts around an incident window stay reconstructible.
//
// Crash-safety comes from synchronous appends, not flush handlers: there is
// no userspace buffer to lose, so no uncaughtException/unhandledRejection
// listener is registered here (adding one would also suppress the crash
// behavior the server relies on). Anything that fails during setup degrades
// to stdout-only logging; logging must never break request serving.

import { readRawConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { redactSensitiveText } from "../redaction.js";
import { RotatingFileSink } from "./rotating-file-sink.js";

export const SERVER_LOG_FILENAME = "server.log";
export const ACCESS_LOG_FILENAME = "access.log";

// Retention sizing (measured 2026-10-22 on the live host: server.log grows
// ~10 MiB/h, access.log ~4 MiB/h): 24 MiB x 12 generations = 288 MiB per
// stream, roughly 24h+ of server.log and several days of access.log.
// Worst-case disk: 576 MiB across both streams. Re-measure with
// `ls -l --time-style=full-iso` plus first-line timestamps before resizing.
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_FILES = 12;
// A pathological writer (progress bar with no newline) must not grow the tee
// buffer without bound; flush the backlog as one truncated line instead.
const MAX_TEE_LINE_BYTES = 64 * 1024;
// Full CSI matcher: strip color/control sequences the pretty logger emits so
// the retained file stays greppable plain text.
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Pino writes to its destination fd directly, bypassing process.stdout.write,
// so the tee normally never sees pino lines. If a future pino version routes
// through the stdio wrappers, skip its JSON here: the multistream leg
// already wrote the identical line, and duplicates would corrupt counts.
const PINO_JSON_PREFIX = /^\{"level":\d+,"time":/;

export interface FileLoggingConfig {
  enabled: boolean;
  dir: string;
  serverMaxBytes: number;
  serverMaxFiles: number;
  accessMaxBytes: number;
  accessMaxFiles: number;
}

export interface FileLoggingState {
  config: FileLoggingConfig;
  serverSink: RotatingFileSink | null;
  accessSink: RotatingFileSink | null;
}

const MIN_LOG_BYTES = 64 * 1024;

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  min = 1,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  // Strict digits only: parseInt would silently turn "10MB" into 10 and
  // "1e9" into 1, and a byte-sized rotation cap would then rotate on every
  // line, churning the forensic history away.
  const trimmed = raw.trim();
  const value = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isFinite(value) || value < min) {
    process.stderr.write(
      `[paperclip] ignoring invalid ${label}=${JSON.stringify(raw)} (using ${fallback})\n`,
    );
    return fallback;
  }
  return value;
}

/**
 * The operator's explicitly configured log dir (onboarding "Log directory"
 * prompt, stored as `logging.logDir`), or null when there is no config file,
 * the file is unreadable, or no dir was explicitly configured. Reads the raw
 * (pre-validation) config: the zod schema fills a hardcoded default-instance
 * logDir, which must not override the PAPERCLIP_HOME/instance-aware default.
 * logging.logDir is a plain string in the schema, so an explicitly set value
 * needs no further validation. Never throws and never warns: the server's
 * own config load stays authoritative for validity errors, and logging setup
 * must never break serving.
 */
function configFileLogDir(): string | null {
  let raw: unknown;
  try {
    raw = readRawConfigFile();
  } catch {
    return null;
  }
  const logging =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).logging
      : undefined;
  const logDir =
    typeof logging === "object" && logging !== null
      ? (logging as Record<string, unknown>).logDir
      : undefined;
  if (typeof logDir !== "string" || logDir.trim() === "") return null;
  try {
    return resolveHomeAwarePath(logDir.trim());
  } catch {
    return null;
  }
}

export function parseFileLoggingConfig(
  env: NodeJS.ProcessEnv = process.env,
): FileLoggingConfig {
  const rawFlag = env.PAPERCLIP_FILE_LOGGING?.trim().toLowerCase();
  const enabled =
    rawFlag === undefined || rawFlag === ""
      ? true
      : !["0", "false", "no", "off"].includes(rawFlag);
  return {
    enabled,
    // Explicit env wins, then the operator's configured dir, then the default
    // instance logs dir (see doc/file-logging.md for the precedence).
    dir:
      env.PAPERCLIP_LOG_DIR?.trim() ||
      configFileLogDir() ||
      resolveDefaultLogsDir(),
    serverMaxBytes: parsePositiveInt(
      env.PAPERCLIP_SERVER_LOG_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      "PAPERCLIP_SERVER_LOG_MAX_BYTES",
      MIN_LOG_BYTES,
    ),
    serverMaxFiles: parsePositiveInt(
      env.PAPERCLIP_SERVER_LOG_MAX_FILES,
      DEFAULT_MAX_FILES,
      "PAPERCLIP_SERVER_LOG_MAX_FILES",
    ),
    accessMaxBytes: parsePositiveInt(
      env.PAPERCLIP_ACCESS_LOG_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      "PAPERCLIP_ACCESS_LOG_MAX_BYTES",
      MIN_LOG_BYTES,
    ),
    accessMaxFiles: parsePositiveInt(
      env.PAPERCLIP_ACCESS_LOG_MAX_FILES,
      DEFAULT_MAX_FILES,
      "PAPERCLIP_ACCESS_LOG_MAX_FILES",
    ),
  };
}

let state: FileLoggingState | null = null;
// Cached pre-init answer for getFileLogging(): parsing the config reads the
// config file, which is too expensive to repeat on every log line through
// the logger's lazily-resolved file leg.
let uninitializedState: FileLoggingState | null = null;
let teeInstalled = false;
let teeSink: RotatingFileSink | null = null;
// Captured before the tee wraps the stdio writers, so sink diagnostics can
// never recurse back through the tee.
const rawStderrWrite = process.stderr.write.bind(process.stderr);

function reportSinkFailure(err: unknown, context: string): void {
  const detail = err instanceof Error ? err.message : String(err);
  rawStderrWrite(`[paperclip] file logging degraded: ${context}: ${detail}\n`);
}

export function initFileLogging(config: FileLoggingConfig): FileLoggingState {
  if (!config.enabled) {
    state = { config, serverSink: null, accessSink: null };
    teeSink = null;
    return state;
  }
  let serverSink: RotatingFileSink | null = null;
  let accessSink: RotatingFileSink | null = null;
  try {
    serverSink = new RotatingFileSink({
      dir: config.dir,
      filename: SERVER_LOG_FILENAME,
      maxBytes: config.serverMaxBytes,
      maxFiles: config.serverMaxFiles,
      onError: reportSinkFailure,
    });
  } catch (err) {
    reportSinkFailure(err, `open ${SERVER_LOG_FILENAME} in ${config.dir}`);
  }
  try {
    accessSink = new RotatingFileSink({
      dir: config.dir,
      filename: ACCESS_LOG_FILENAME,
      maxBytes: config.accessMaxBytes,
      maxFiles: config.accessMaxFiles,
      onError: reportSinkFailure,
    });
  } catch (err) {
    reportSinkFailure(err, `open ${ACCESS_LOG_FILENAME} in ${config.dir}`);
  }
  state = { config, serverSink, accessSink };
  teeSink = serverSink;
  if (serverSink && !teeInstalled) {
    installStdioTee();
    teeInstalled = true;
  }
  return state;
}

/**
 * Server-boot entry point: parse the env config and init. Only the server
 * entrypoint calls this; CLI/subcommand processes never do, so they stay
 * stdout-only. Unit tests keep the opt-out: stdout-only unless
 * PAPERCLIP_FILE_LOGGING is set explicitly.
 */
export function initServerFileLogging(
  env: NodeJS.ProcessEnv = process.env,
): FileLoggingState {
  const config = parseFileLoggingConfig(env);
  if (
    env.VITEST_WORKER_ID !== undefined &&
    env.PAPERCLIP_FILE_LOGGING === undefined
  ) {
    return initFileLogging({ ...config, enabled: false });
  }
  return initFileLogging(config);
}

/**
 * Process-wide singleton. Never initializes: before an explicit
 * initFileLogging() call (server boot only) this returns null sinks without
 * touching the log dir, opening files, or installing the stdio tee — so a
 * bare logger import in a CLI/subcommand process is side-effect-free.
 */
export function getFileLogging(): FileLoggingState {
  if (!state) {
    if (!uninitializedState) {
      uninitializedState = {
        config: parseFileLoggingConfig(),
        serverSink: null,
        accessSink: null,
      };
    }
    return uninitializedState;
  }
  return state;
}

/** Test-only escape hatch. The stdio tee itself is process-lifetime. */
export function __resetFileLoggingForTests(): void {
  state?.serverSink?.close();
  state?.accessSink?.close();
  state = null;
  teeSink = null;
  uninitializedState = null;
}

type StdioWrite = (
  chunk: unknown,
  encoding?: unknown,
  callback?: unknown,
) => boolean;

function stripControlSequences(line: string): string {
  return line.replace(CSI_PATTERN, "").replace(/\r$/, "");
}

function teeFd(kind: "stdout" | "stderr"): void {
  const stream = process[kind];
  const original = stream.write.bind(stream) as StdioWrite;
  let pending = "";
  const write = function (
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown,
  ): boolean {
    // The original write runs first and its result is authoritative: the tee
    // observes, it never changes stdio behavior.
    const result = original(chunk, encoding, callback);
    try {
      const sink = teeSink;
      if (sink === null || sink === undefined) return result;
      const text =
        typeof chunk === "string"
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString("utf8")
            : String(chunk);
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const clean = stripControlSequences(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (clean.length > 0 && !PINO_JSON_PREFIX.test(clean)) {
          // Redact BEFORE the retained write: raw process output has carried
          // credential material (GitHub App token JSON); it must never reach
          // the file. The console copy above is untouched.
          sink.write(
            `${new Date().toISOString()} ${kind} ${redactSensitiveText(clean)}\n`,
          );
        }
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_TEE_LINE_BYTES) {
        sink.write(
          `${new Date().toISOString()} ${kind} ${redactSensitiveText(stripControlSequences(pending)).slice(0, MAX_TEE_LINE_BYTES)}…[truncated]\n`,
        );
        pending = "";
      }
    } catch {
      // A tee failure must never surface to the original writer.
    }
    return result;
  };
  stream.write = write as typeof stream.write;
}

function installStdioTee(): void {
  teeFd("stdout");
  teeFd("stderr");
}
