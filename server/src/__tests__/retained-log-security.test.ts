import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetFileLoggingForTests,
  initFileLogging,
  parseFileLoggingConfig,
} from "../middleware/file-logging.js";
import { RotatingFileSink } from "../middleware/rotating-file-sink.js";

// Deliberately fake credential-shaped values (same shapes the production
// redaction targets, zero chance of matching a real secret).
const FAKE_CLASSIC_TOKEN = "ghp_FAKECLASSICTOKEN00000000000001";
const FAKE_INSTALLATION_TOKEN = "ghs_FAKEINSTALLTOKEN00000000000002";
const FAKE_FINE_GRAINED_PAT = "github_pat_FAKEFINEGRAINED0000000003";
// The exact shape the GitHub helper printed to stdout on the live host
// (2026-10-22): an installation-token JSON object with a dotted token.
const FAKE_DOTTED_TOKEN =
  "ghs_FAKEHEADER00000001.eyJmYWtlIjoidGVzdCJ9.FAKEs1gnatur3s3gment00";
const FAKE_HELPER_TOKEN_JSON = JSON.stringify({
  token: FAKE_DOTTED_TOKEN,
  app_id: 1111111,
  installation_id: 222222222,
  expires_at: "2026-10-22T04:27:04Z",
});

const dirs: string[] = [];
const sinks: RotatingFileSink[] = [];

beforeEach(() => {
  __resetFileLoggingForTests();
});

afterEach(() => {
  __resetFileLoggingForTests();
  while (sinks.length > 0) sinks.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "retained-log-security-"));
  dirs.push(dir);
  return dir;
}

function track(sink: RotatingFileSink): RotatingFileSink {
  sinks.push(sink);
  return sink;
}

/** Group/other permission bits must never be set on retained log files. */
function expectOwnerOnly(file: string): void {
  const mode = statSync(file).mode & 0o777;
  expect(mode & 0o077).toBe(0);
}

describe("retained log file permissions", () => {
  it("creates owner-only log files and directories", () => {
    // Hermetic: force the common permissive umask so the owner-only modes
    // come from the sink, not from a strict ambient umask.
    const previousUmask = process.umask(0o022);
    try {
      const dir = path.join(tempDir(), "nested", "logs");
      const sink = track(
        new RotatingFileSink({ dir, filename: "server.log", maxBytes: 1024, maxFiles: 2 }),
      );
      sink.write("hello\n");
      expectOwnerOnly(path.join(dir, "server.log"));
      expectOwnerOnly(dir);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("tightens a pre-existing world-readable live file on open", () => {
    const dir = tempDir();
    const live = path.join(dir, "server.log");
    writeFileSync(live, "before\n");
    chmodSync(live, 0o644);
    const sink = track(
      new RotatingFileSink({ dir, filename: "server.log", maxBytes: 1024, maxFiles: 2 }),
    );
    sink.write("after\n");
    expectOwnerOnly(live);
    expect(readFileSync(live, "utf8")).toContain("before\n");
  });

  it("tightens pre-existing generations at open, before any rotation", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "server.log.1"), "old1\n");
    chmodSync(path.join(dir, "server.log.1"), 0o644);
    writeFileSync(path.join(dir, "server.log.2"), "old2\n");
    chmodSync(path.join(dir, "server.log.2"), 0o644);
    // maxBytes is huge: no rotation fires, so any tightening below comes
    // from the constructor, not from the rotation path.
    const sink = track(
      new RotatingFileSink({ dir, filename: "server.log", maxBytes: 65536, maxFiles: 4 }),
    );
    sink.write("live\n");
    expectOwnerOnly(path.join(dir, "server.log.1"));
    expectOwnerOnly(path.join(dir, "server.log.2"));
  });

  it("keeps every rotation generation owner-only, including legacy files", () => {
    const dir = tempDir();
    const sink = track(
      new RotatingFileSink({ dir, filename: "server.log", maxBytes: 64, maxFiles: 4 }),
    );
    // 41 bytes: two lines exceed the 64-byte cap and force a rotation.
    sink.write(`${"a".repeat(40)}\n`);
    // A pre-existing world-readable generation from before owner-only files.
    chmodSync(path.join(dir, "server.log"), 0o644);
    writeFileSync(path.join(dir, "server.log.1"), "legacy\n");
    chmodSync(path.join(dir, "server.log.1"), 0o644);
    sink.write(`${"b".repeat(40)}\n`);
    sink.write(`${"c".repeat(40)}\n`);
    sink.write(`${"d".repeat(40)}\n`);
    expectOwnerOnly(path.join(dir, "server.log"));
    expectOwnerOnly(path.join(dir, "server.log.1"));
    expectOwnerOnly(path.join(dir, "server.log.2"));
    expectOwnerOnly(path.join(dir, "server.log.3"));
  });
});

describe("retained log credential scrubbing", () => {
  it("redacts GitHub token shapes before the retained write", () => {
    const dir = tempDir();
    const sink = track(
      new RotatingFileSink({ dir, filename: "server.log", maxBytes: 65536, maxFiles: 2 }),
    );
    const control = "helper finished 3 repositories in 1200ms";
    // Tee-formatted the way helper stdio lines land in server.log.
    sink.write(`2026-10-22T03:27:04.541Z stdout ${FAKE_CLASSIC_TOKEN}\n`);
    sink.write(`2026-10-22T03:27:05.541Z stdout prefix ${FAKE_INSTALLATION_TOKEN} suffix\n`);
    sink.write(`2026-10-22T03:27:06.541Z stdout deploy key ${FAKE_FINE_GRAINED_PAT} active\n`);
    sink.write(`2026-10-22T03:27:07.541Z stdout GITHUB_TOKEN=${FAKE_CLASSIC_TOKEN}\n`);
    sink.write(`2026-10-22T03:27:08.541Z stdout ${FAKE_HELPER_TOKEN_JSON}\n`);
    sink.write(`2026-10-22T03:27:09.541Z stdout ${control}\n`);
    const content = readFileSync(path.join(dir, "server.log"), "utf8");
    expect(content).not.toContain(FAKE_CLASSIC_TOKEN);
    expect(content).not.toContain(FAKE_INSTALLATION_TOKEN);
    expect(content).not.toContain(FAKE_FINE_GRAINED_PAT);
    expect(content).not.toContain(FAKE_DOTTED_TOKEN);
    expect(content).not.toMatch(/gh[pousr]_|github_pat_/);
    expect(content).toContain("***REDACTED***");
    // Non-secret lines pass through byte-identical (no over-redaction).
    expect(content).toContain(control);
  });

  it("keeps helper token stdout out of the retained file (stdio tee end-to-end)", () => {
    const dir = tempDir();
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(dir, "no-config.json"));
    vi.stubEnv("PAPERCLIP_FILE_LOGGING", "true");
    vi.stubEnv("PAPERCLIP_LOG_DIR", dir);
    const { serverSink } = initFileLogging(parseFileLoggingConfig());
    expect(serverSink).not.toBeNull();
    // Simulate the GitHub operation helper printing its token JSON to
    // stdout: the stdio tee observes this write and retains a copy.
    process.stdout.write(`${FAKE_HELPER_TOKEN_JSON}\n`);
    process.stdout.write("plain helper line\n");
    const content = readFileSync(path.join(dir, "server.log"), "utf8");
    expect(content).not.toContain(FAKE_DOTTED_TOKEN);
    expect(content).not.toMatch(/ghs_|github_pat_/);
    expect(content).toContain("plain helper line");
  });
});
