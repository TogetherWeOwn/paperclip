import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultLogsDir } from "../home-paths.js";
import {
  __resetFileLoggingForTests,
  getFileLogging,
  initFileLogging,
  parseFileLoggingConfig,
} from "../middleware/file-logging.js";

const dirs: string[] = [];

beforeEach(() => {
  __resetFileLoggingForTests();
});

afterEach(() => {
  __resetFileLoggingForTests();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "file-logging-test-"));
  dirs.push(dir);
  return dir;
}

function writeConfig(dir: string, logDir: string): string {
  const configPath = path.join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      $meta: {
        version: 1,
        updatedAt: new Date().toISOString(),
        source: "onboard",
      },
      database: {},
      logging: { mode: "file", logDir },
      server: {},
      telemetry: {},
    }),
  );
  return configPath;
}

describe("parseFileLoggingConfig", () => {
  it("defaults to enabled with the instance logs dir and 10MB x 5 caps", () => {
    // Hermetic: an ambient instance config must not redirect the default dir.
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(tempDir(), "no-config.json"));
    const config = parseFileLoggingConfig({});
    expect(config.enabled).toBe(true);
    expect(config.dir).toBe(resolveDefaultLogsDir());
    expect(config.serverMaxBytes).toBe(10 * 1024 * 1024);
    expect(config.serverMaxFiles).toBe(5);
    expect(config.accessMaxBytes).toBe(10 * 1024 * 1024);
    expect(config.accessMaxFiles).toBe(5);
  });

  it("honours explicit disable flags and a custom dir", () => {
    for (const flag of ["0", "false", "no", "off", "FALSE", " Off "]) {
      expect(parseFileLoggingConfig({ PAPERCLIP_FILE_LOGGING: flag }).enabled).toBe(false);
    }
    expect(parseFileLoggingConfig({ PAPERCLIP_FILE_LOGGING: "yes" }).enabled).toBe(true);
    expect(
      parseFileLoggingConfig({ PAPERCLIP_LOG_DIR: "/tmp/custom-logs" }).dir,
    ).toBe("/tmp/custom-logs");
  });

  it("falls back to defaults on invalid sizes", () => {
    const config = parseFileLoggingConfig({
      PAPERCLIP_SERVER_LOG_MAX_BYTES: "huge",
      PAPERCLIP_SERVER_LOG_MAX_FILES: "-2",
      PAPERCLIP_ACCESS_LOG_MAX_BYTES: "0",
    });
    expect(config.serverMaxBytes).toBe(10 * 1024 * 1024);
    expect(config.serverMaxFiles).toBe(5);
    expect(config.accessMaxBytes).toBe(10 * 1024 * 1024);
  });

  it("rejects suffixed, scientific, and below-floor sizes (no partial parse)", () => {
    // parseInt would read 10 from "10MB" and 1 from "1e9": a byte-sized
    // rotation cap would then rotate on every line.
    const suffixed = parseFileLoggingConfig({
      PAPERCLIP_SERVER_LOG_MAX_BYTES: "10MB",
      PAPERCLIP_ACCESS_LOG_MAX_BYTES: "1e9",
      PAPERCLIP_SERVER_LOG_MAX_FILES: "5x",
    });
    expect(suffixed.serverMaxBytes).toBe(10 * 1024 * 1024);
    expect(suffixed.accessMaxBytes).toBe(10 * 1024 * 1024);
    expect(suffixed.serverMaxFiles).toBe(5);
    const tiny = parseFileLoggingConfig({
      PAPERCLIP_SERVER_LOG_MAX_BYTES: "100",
      PAPERCLIP_ACCESS_LOG_MAX_BYTES: "65535",
    });
    expect(tiny.serverMaxBytes).toBe(10 * 1024 * 1024);
    expect(tiny.accessMaxBytes).toBe(10 * 1024 * 1024);
    const floor = parseFileLoggingConfig({
      PAPERCLIP_SERVER_LOG_MAX_BYTES: String(64 * 1024),
      PAPERCLIP_SERVER_LOG_MAX_FILES: "2",
    });
    expect(floor.serverMaxBytes).toBe(64 * 1024);
    expect(floor.serverMaxFiles).toBe(2);
  });

  it("honours the configured logging.logDir when no env dir is set", () => {
    const dir = tempDir();
    const logsDir = path.join(dir, "configured-logs");
    vi.stubEnv("PAPERCLIP_CONFIG", writeConfig(dir, logsDir));
    expect(parseFileLoggingConfig({}).dir).toBe(logsDir);
  });

  it("prefers explicit PAPERCLIP_LOG_DIR over the configured dir", () => {
    const dir = tempDir();
    vi.stubEnv(
      "PAPERCLIP_CONFIG",
      writeConfig(dir, path.join(dir, "configured-logs")),
    );
    expect(
      parseFileLoggingConfig({ PAPERCLIP_LOG_DIR: "/tmp/explicit-logs" }).dir,
    ).toBe("/tmp/explicit-logs");
  });

  it("ignores an unreadable config file instead of breaking logging setup", () => {
    const dir = tempDir();
    const badPath = path.join(dir, "config.json");
    writeFileSync(badPath, "{not json");
    vi.stubEnv("PAPERCLIP_CONFIG", badPath);
    expect(parseFileLoggingConfig({}).dir).toBe(resolveDefaultLogsDir());
  });
});

describe("initFileLogging", () => {
  it("opens both retained logs in the configured dir", () => {
    const dir = tempDir();
    const state = initFileLogging({
      ...parseFileLoggingConfig({}),
      dir,
    });
    expect(state.serverSink?.path).toBe(path.join(dir, "server.log"));
    expect(state.accessSink?.path).toBe(path.join(dir, "access.log"));
    state.serverSink?.write("server-line\n");
    state.accessSink?.write("access-line\n");
    expect(readFileSync(path.join(dir, "server.log"), "utf8")).toBe("server-line\n");
    expect(readFileSync(path.join(dir, "access.log"), "utf8")).toBe("access-line\n");
  });

  it("returns null sinks when disabled", () => {
    const state = initFileLogging({
      ...parseFileLoggingConfig({}),
      enabled: false,
      dir: tempDir(),
    });
    expect(state.serverSink).toBeNull();
    expect(state.accessSink).toBeNull();
  });

  it("degrades to null sinks when the dir cannot be created", () => {
    const dir = tempDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const state = initFileLogging({
      ...parseFileLoggingConfig({}),
      dir: path.join(blocker, "logs"),
    });
    expect(state.serverSink).toBeNull();
    expect(state.accessSink).toBeNull();
  });

  it("tees stdio writes into server.log with a timestamp prefix", () => {
    const dir = tempDir();
    const state = initFileLogging({ ...parseFileLoggingConfig({}), dir });
    expect(state.serverSink).not.toBeNull();
    // Write through process.stdout directly: under vitest, console.* is
    // intercepted by the runner and never reaches the stdio wrappers.
    const marker = `tee-marker-${Date.now()}`;
    process.stdout.write(`${marker}\n`);
    const content = readFileSync(path.join(dir, "server.log"), "utf8");
    const matched = content.split("\n").find((line) => line.includes(marker));
    expect(matched).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z stdout /);
  });
});

describe("getFileLogging", () => {
  it("stays stdout-only under unit tests unless explicitly enabled", () => {
    expect(process.env.VITEST_WORKER_ID).toBeDefined();
    const state = getFileLogging();
    expect(state.config.enabled).toBe(false);
    expect(state.serverSink).toBeNull();
    expect(state.accessSink).toBeNull();
  });
});
