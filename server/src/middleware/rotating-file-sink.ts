// Size-rotated, append-only file sink for retained server logs.
//
// Crash forensics need log lines to survive both container recreates (the
// file lives under the instance logs dir on the retained /paperclip volume)
// and hard process crashes (every write is synchronous, so there is no user
// land buffer to lose when the process dies without running handlers).
// Rotation is size-based: `<name>` plus `<name>.1 .. <name>.(maxFiles-1)`,
// newest lines always in `<name>`.
//
// Security: retained logs have carried credential material (GitHub App
// installation-token JSON via helper stdio), and the logs dir sits on a
// shared volume. Every file this sink creates is owner-only (0600), newly
// created directories are 0700, and pre-existing files with group/other
// permission bits are tightened on open and as they shift through rotation
// (best-effort and never throwing, but not silent: a file the sink cannot
// make owner-only reports through the throttled diagnostic so the host
// knows to fix it).
// Rotation renames within the set, so it never produces a world-readable
// file. As defence in depth, every chunk passes through the shared text
// redaction before the retained write; stdout is untouched.
//
// The sink never throws into its caller: disk-full, permission, and rotation
// failures degrade to a throttled stderr diagnostic while stdout logging and
// request serving continue unchanged.

import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "../redaction.js";

export interface RotatingFileSinkOptions {
  /** Directory holding the log files. Created (recursively) on open. */
  dir: string;
  /** Live file name, e.g. `server.log`. Rotated files append `.<n>`. */
  filename: string;
  /** Rotate the live file once it would exceed this many bytes. */
  maxBytes: number;
  /** Total files to keep, including the live one. Clamped to >= 2. */
  maxFiles: number;
  /** First failure, then at most one report per minute. Must not throw. */
  onError?: (err: unknown, context: string) => void;
}

const ERROR_REPORT_INTERVAL_MS = 60_000;
// A transient reopen failure (EMFILE/ENOSPC/EACCES during rotation) must not
// disable the sink for the rest of the process: later writes retry the open,
// throttled so a persistently broken disk costs one syscall per interval.
const REOPEN_RETRY_INTERVAL_MS = 5_000;
// Owner-only log files: retained logs have carried credential material, so
// group/other must never gain read access through rotation or umask.
const LOG_FILE_MODE = 0o600;
const LOG_DIR_MODE = 0o700;

/**
 * Strip group/other permission bits from an open file. Best-effort and never
 * throws. Returns null when the file is now owner-only (or was already, or
 * the fd raced away); returns the caught error when the mode bits are still
 * set, so the caller can report a still-world-accessible file instead of
 * failing silent. Owner bits are preserved, never loosened.
 */
function tightenOpenFilePermissions(fd: number): unknown {
  let mode: number;
  try {
    mode = fs.fstatSync(fd).mode & 0o777;
  } catch {
    return null;
  }
  if ((mode & 0o077) === 0) return null;
  try {
    fs.fchmodSync(fd, mode & 0o700);
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * Strip group/other permission bits from a rotated generation by path. Same
 * contract as tightenOpenFilePermissions: a missing generation is normal
 * (fresh dir) and stays silent, while a failed chmod returns its error for
 * the throttled report path. Rotation touches each generation rarely, so a
 * stat+chmod pair per generation is affordable.
 */
function tightenRotatedFilePermissions(filePath: string): unknown {
  let mode: number;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
  if ((mode & 0o077) === 0) return null;
  try {
    fs.chmodSync(filePath, mode & 0o700);
    return null;
  } catch (err) {
    return err;
  }
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly onError?: (err: unknown, context: string) => void;
  private fd: number | null = null;
  private size = 0;
  private closed = false;
  private failures = 0;
  private lastReportAt = 0;
  private lastReopenAttemptAt = 0;

  constructor(opts: RotatingFileSinkOptions) {
    this.filePath = path.resolve(opts.dir, opts.filename);
    this.maxBytes = opts.maxBytes;
    this.maxFiles = Math.max(2, Math.floor(opts.maxFiles));
    this.onError = opts.onError;
    // Throws when the directory cannot be created (permissions, ENOTDIR):
    // the owner catches that and runs stdout-only instead of half-logging.
    // The mode applies to newly created directories only; a pre-existing
    // logs dir keeps its permissions (tightening a shared dir could lock
    // out other legitimate writers — files are the protected unit).
    fs.mkdirSync(opts.dir, { recursive: true, mode: LOG_DIR_MODE });
    try {
      this.size = fs.statSync(this.filePath).size;
    } catch {
      this.size = 0;
    }
    // The mode applies when the file is created; the tighten calls below
    // converge pre-existing world-readable files to owner-only. Failures
    // report through the throttled diagnostic: a still-world-accessible
    // file after open is degraded file logging, not a silent condition.
    this.fd = fs.openSync(this.filePath, "a", LOG_FILE_MODE);
    this.reportTightenFailure(
      tightenOpenFilePermissions(this.fd),
      this.filePath,
    );
    // Pre-existing generations converge here, not only on the next
    // rotation: a restart must not leave yesterday's world-readable files
    // in place for hours until traffic triggers a rotate. Every generation
    // present on disk is tightened, not just the ones inside the current
    // maxFiles window: an operator lowering the cap must not orphan stale
    // world-readable files above it (rotation never touches those again,
    // so open-time convergence is the only path that reaches them).
    for (const generation of this.listExistingGenerations()) {
      this.reportTightenFailure(
        tightenRotatedFilePermissions(generation),
        generation,
      );
    }
  }

  /** Absolute path of the live file. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Absolute paths of the `<name>.<n>` generations present on disk,
   * regardless of maxFiles. Falls back to the in-window generations when
   * the directory cannot be listed, so a listing failure degrades to the
   * old bounded convergence instead of none.
   */
  private listExistingGenerations(): string[] {
    const dir = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.`;
    try {
      return fs
        .readdirSync(dir)
        .filter((entry) => {
          if (!entry.startsWith(prefix)) return false;
          const suffix = entry.slice(prefix.length);
          return suffix.length > 0 && /^\d+$/.test(suffix);
        })
        .map((entry) => path.resolve(dir, entry));
    } catch {
      const generations: string[] = [];
      for (let i = 1; i < this.maxFiles; i += 1) {
        generations.push(`${this.filePath}.${i}`);
      }
      return generations;
    }
  }

  /** Append bytes. Never throws; failures are counted and reported. */
  write(chunk: string | Uint8Array): void {
    if (this.closed) return;
    if (this.fd === null) {
      this.maybeReopen();
      if (this.fd === null) {
        // Still down (throttled retry or persistent failure): count the loss
        // with the same throttled diagnostic as every other sink failure.
        this.report(new Error("live file unavailable"), "write dropped");
        return;
      }
    }
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text.length === 0) return;
    try {
      // Defence in depth: the retained file must never hold credential
      // material even if a writer passes it raw (helper stdio has carried
      // GitHub installation-token JSON). Stdout keeps the original bytes;
      // only the retained copy is redacted. A redaction failure drops the
      // retained line (fail closed) via the report below.
      const buf = Buffer.from(redactSensitiveText(text), "utf8");
      if (buf.length === 0) return;
      // A single line larger than maxBytes must not rotate an empty file in
      // a loop; it just lands in the live file oversized.
      if (this.size > 0 && this.size + buf.length > this.maxBytes) {
        this.rotate();
      }
      fs.writeSync(this.fd, buf);
      this.size += buf.length;
    } catch (err) {
      this.report(err, "write");
    }
  }

  /** Release the fd. Writes after close are dropped silently. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Closing: nothing left to preserve.
      }
      this.fd = null;
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Continue with the shift even if the close failed.
      }
      this.fd = null;
    }
    try {
      try {
        fs.rmSync(`${this.filePath}.${this.maxFiles - 1}`, { force: true });
      } catch {
        // Missing oldest generation: nothing to drop.
      }
      for (let i = this.maxFiles - 2; i >= 1; i -= 1) {
        try {
          fs.renameSync(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`);
        } catch {
          // Missing generation (fresh dir, concurrent rotator): skip it.
        }
      }
      try {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      } catch {
        // Live file vanished mid-rotation (external cleanup): reopen fresh.
      }
      // Generations created before owner-only files (or by a foreign
      // process) shift through here: tighten each so rotation converges
      // every generation to 0600 instead of preserving world-readable bits.
      for (let i = 1; i < this.maxFiles; i += 1) {
        const generation = `${this.filePath}.${i}`;
        this.reportTightenFailure(
          tightenRotatedFilePermissions(generation),
          generation,
        );
      }
      this.size = 0;
    } finally {
      // An unconditional attempt: rotations are rare by design, and a success
      // here means the triggering write below still lands. A failure leaves
      // fd null without touching the retry throttle, so the next write gets
      // its own immediate attempt via maybeReopen.
      this.openLiveFile("reopen");
    }
  }

  /** Retry a failed open on a later write, at most once per interval. */
  private maybeReopen(): void {
    const now = Date.now();
    if (now - this.lastReopenAttemptAt < REOPEN_RETRY_INTERVAL_MS) return;
    this.lastReopenAttemptAt = now;
    this.openLiveFile("reopen");
  }

  private openLiveFile(context: string): void {
    try {
      this.fd = fs.openSync(this.filePath, "a", LOG_FILE_MODE);
      this.reportTightenFailure(
        tightenOpenFilePermissions(this.fd),
        this.filePath,
      );
      try {
        this.size = fs.statSync(this.filePath).size;
      } catch {
        this.size = 0;
      }
    } catch (err) {
      this.fd = null;
      this.report(err, context);
    }
  }

  /** Report a file the sink could open but not make owner-only. */
  private reportTightenFailure(tightenError: unknown, filePath: string): void {
    if (tightenError === null || tightenError === undefined) return;
    this.report(tightenError, `permissions still world-accessible ${filePath}`);
  }

  private report(err: unknown, context: string): void {
    this.failures += 1;
    const now = Date.now();
    if (this.lastReportAt !== 0 && now - this.lastReportAt < ERROR_REPORT_INTERVAL_MS) {
      return;
    }
    this.lastReportAt = now;
    try {
      this.onError?.(err, `${context} ${this.filePath} (failure #${this.failures})`);
    } catch {
      // Error reporting must never break the logging path itself.
    }
  }
}
