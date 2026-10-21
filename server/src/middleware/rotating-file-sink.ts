// Size-rotated, append-only file sink for retained server logs.
//
// Crash forensics need log lines to survive both container recreates (the
// file lives under the instance logs dir on the retained /paperclip volume)
// and hard process crashes (every write is synchronous, so there is no user
// land buffer to lose when the process dies without running handlers).
// Rotation is size-based: `<name>` plus `<name>.1 .. <name>.(maxFiles-1)`,
// newest lines always in `<name>`.
//
// The sink never throws into its caller: disk-full, permission, and rotation
// failures degrade to a throttled stderr diagnostic while stdout logging and
// request serving continue unchanged.

import fs from "node:fs";
import path from "node:path";

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

  constructor(opts: RotatingFileSinkOptions) {
    this.filePath = path.resolve(opts.dir, opts.filename);
    this.maxBytes = opts.maxBytes;
    this.maxFiles = Math.max(2, Math.floor(opts.maxFiles));
    this.onError = opts.onError;
    // Throws when the directory cannot be created (permissions, ENOTDIR):
    // the owner catches that and runs stdout-only instead of half-logging.
    fs.mkdirSync(opts.dir, { recursive: true });
    try {
      this.size = fs.statSync(this.filePath).size;
    } catch {
      this.size = 0;
    }
    this.fd = fs.openSync(this.filePath, "a");
  }

  /** Absolute path of the live file. */
  get path(): string {
    return this.filePath;
  }

  /** Append bytes. Never throws; failures are counted and reported. */
  write(chunk: string | Uint8Array): void {
    if (this.closed || this.fd === null) return;
    const buf =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (buf.length === 0) return;
    try {
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
      this.size = 0;
    } finally {
      try {
        this.fd = fs.openSync(this.filePath, "a");
      } catch (err) {
        this.fd = null;
        this.report(err, "reopen");
      }
    }
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
