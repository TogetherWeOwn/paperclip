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

import { resolveDefaultLogsDir } from "../home-paths.js";
import { RotatingFileSink } from "./rotating-file-sink.js";

export const SERVER_LOG_FILENAME = "server.log";
export const ACCESS_LOG_FILENAME = "access.log";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
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

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 1) {
    process.stderr.write(
      `[paperclip] ignoring invalid ${label}=${JSON.stringify(raw)} (using ${fallback})\n`,
    );
    return fallback;
  }
  return value;
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
    dir: env.PAPERCLIP_LOG_DIR?.trim() || resolveDefaultLogsDir(),
    serverMaxBytes: parsePositiveInt(
      env.PAPERCLIP_SERVER_LOG_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      "PAPERCLIP_SERVER_LOG_MAX_BYTES",
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
    ),
    accessMaxFiles: parsePositiveInt(
      env.PAPERCLIP_ACCESS_LOG_MAX_FILES,
      DEFAULT_MAX_FILES,
      "PAPERCLIP_ACCESS_LOG_MAX_FILES",
    ),
  };
}

let state: FileLoggingState | null = null;
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
 * Process-wide singleton. Unit tests run with stdout-only logging unless
 * they opt in explicitly, so importing the server logger never writes to a
 * developer's real logs dir as a side effect.
 */
export function getFileLogging(): FileLoggingState {
  if (!state) {
    if (
      process.env.VITEST_WORKER_ID !== undefined &&
      process.env.PAPERCLIP_FILE_LOGGING === undefined
    ) {
      state = {
        config: { ...parseFileLoggingConfig(), enabled: false },
        serverSink: null,
        accessSink: null,
      };
      return state;
    }
    state = initFileLogging(parseFileLoggingConfig());
  }
  return state;
}

/** Test-only escape hatch. The stdio tee itself is process-lifetime. */
export function __resetFileLoggingForTests(): void {
  state?.serverSink?.close();
  state?.accessSink?.close();
  state = null;
  teeSink = null;
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
          sink.write(`${new Date().toISOString()} ${kind} ${clean}\n`);
        }
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_TEE_LINE_BYTES) {
        sink.write(
          `${new Date().toISOString()} ${kind} ${stripControlSequences(pending).slice(0, MAX_TEE_LINE_BYTES)}…[truncated]\n`,
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
