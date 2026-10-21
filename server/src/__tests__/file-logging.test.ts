import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("parseFileLoggingConfig", () => {
  it("defaults to enabled with the instance logs dir and 10MB x 5 caps", () => {
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
