import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultLogsDir } from "../home-paths.js";
import {
  __resetFileLoggingForTests,
  getFileLogging,
  initFileLogging,
  initServerFileLogging,
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
  it("defaults to enabled with the instance logs dir and 24MB x 12 caps", () => {
    // Hermetic: an ambient instance config must not redirect the default dir.
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(tempDir(), "no-config.json"));
    const config = parseFileLoggingConfig({});
    expect(config.enabled).toBe(true);
    expect(config.dir).toBe(resolveDefaultLogsDir());
    expect(config.serverMaxBytes).toBe(24 * 1024 * 1024);
    expect(config.serverMaxFiles).toBe(12);
    expect(config.accessMaxBytes).toBe(24 * 1024 * 1024);
    expect(config.accessMaxFiles).toBe(12);
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
    expect(config.serverMaxBytes).toBe(24 * 1024 * 1024);
    expect(config.serverMaxFiles).toBe(12);
    expect(config.accessMaxBytes).toBe(24 * 1024 * 1024);
  });

  it("rejects suffixed, scientific, and below-floor sizes (no partial parse)", () => {
    // parseInt would read 10 from "10MB" and 1 from "1e9": a byte-sized
    // rotation cap would then rotate on every line.
    const suffixed = parseFileLoggingConfig({
      PAPERCLIP_SERVER_LOG_MAX_BYTES: "10MB",
      PAPERCLIP_ACCESS_LOG_MAX_BYTES: "1e9",
      PAPERCLIP_SERVER_LOG_MAX_FILES: "5x",
    });
    expect(suffixed.serverMaxBytes).toBe(24 * 1024 * 1024);
    expect(suffixed.accessMaxBytes).toBe(24 * 1024 * 1024);
    expect(suffixed.serverMaxFiles).toBe(12);
    const tiny = parseFileLoggingConfig({
      PAPERCLIP_SERVER_LOG_MAX_BYTES: "100",
      PAPERCLIP_ACCESS_LOG_MAX_BYTES: "65535",
    });
    expect(tiny.serverMaxBytes).toBe(24 * 1024 * 1024);
    expect(tiny.accessMaxBytes).toBe(24 * 1024 * 1024);
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

  it("ignores the schema-default logDir when the config omits logging.logDir", () => {
    // Regression: readConfigFile returns the zod-parsed config, whose logDir
    // always carries the schema default (~/.paperclip/instances/default/logs
    // under the OS home), so an omitted logDir overrode the
    // PAPERCLIP_HOME/instance-aware default and landed logs off the retained
    // volume (shared across instances when homes coincide).
    const dir = tempDir();
    const home = path.join(dir, "paperclip-home");
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
        logging: { mode: "file" },
        server: {},
        telemetry: {},
      }),
    );
    vi.stubEnv("PAPERCLIP_CONFIG", configPath);
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "prod2");
    expect(parseFileLoggingConfig({}).dir).toBe(resolveDefaultLogsDir());
    expect(parseFileLoggingConfig({}).dir).toBe(
      path.join(home, "instances", "prod2", "logs"),
    );
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

  // All fixtures below are obviously fake: the shapes must match the
  // credential patterns (gh[pousr]_/github_pat_ + 20 chars, "token" JSON
  // field) while never resembling real token material.
  it("redacts a ghs-shaped value in tee lines before the retained write", () => {
    const dir = tempDir();
    initFileLogging({ ...parseFileLoggingConfig({}), dir });
    const marker = `tee-redact-ghs-${Date.now()}`;
    const fake = "ghs_faketestvalue000000000001";
    process.stdout.write(`${marker} token=${fake}\n`);
    const content = readFileSync(path.join(dir, "server.log"), "utf8");
    const matched = content.split("\n").find((line) => line.includes(marker));
    expect(matched).toBeDefined();
    expect(matched).not.toContain(fake);
    expect(matched).toContain("***REDACTED***");
  });

  it("redacts a github_pat-shaped value in tee lines before the retained write", () => {
    const dir = tempDir();
    initFileLogging({ ...parseFileLoggingConfig({}), dir });
    const marker = `tee-redact-pat-${Date.now()}`;
    const fake = "github_pat_faketestvalue00000002";
    process.stdout.write(`${marker} key=${fake}\n`);
    const content = readFileSync(path.join(dir, "server.log"), "utf8");
    const matched = content.split("\n").find((line) => line.includes(marker));
    expect(matched).toBeDefined();
    expect(matched).not.toContain(fake);
    expect(matched).toContain("***REDACTED***");
  });

  it.each(["stdout", "stderr"] as const)(
    "redacts credentials in a >64 KiB newline-less %s tee write before truncation",
    (stream) => {
      const dir = tempDir();
      initFileLogging({ ...parseFileLoggingConfig({}), dir });
      const marker = `tee-redact-truncated-${stream}`;
      const fakes = [
        "ghs_faketestvalue000000000001",
        "github_pat_faketestvalue00000002",
        "faketoken-json-test-value-0001",
      ];
      const prefix = `${marker} ${fakes[0]} ${fakes[1]} {"token":"${fakes[2]}"} `;
      // Cross the limit without a newline so only the truncation path can write.
      const maxLineBytes = 64 * 1024;
      const crossingToken = "github_pat_fakecrossingtestvalue";
      const line = `${prefix}${"x".repeat(maxLineBytes - prefix.length - 17)} ${crossingToken}`;
      process[stream].write(line);
      const content = readFileSync(path.join(dir, "server.log"), "utf8");
      expect(content).toContain(`${stream} ${marker}`);
      expect(content).toContain("…[truncated]\n");
      expect(content).toContain("***REDACTED***");
      for (const fake of fakes) expect(content).not.toContain(fake);
      // A token straddling the cut must be redacted before slicing, not after.
      expect(content).not.toContain("github_pat_");
    },
  );

  it("redacts a token JSON field in tee lines before the retained write", () => {
    const dir = tempDir();
    initFileLogging({ ...parseFileLoggingConfig({}), dir });
    const marker = `tee-redact-json-${Date.now()}`;
    const fake = "faketoken-json-test-value-0001";
    process.stdout.write(`${marker} {"token":"${fake}","app_id":1234}\n`);
    const content = readFileSync(path.join(dir, "server.log"), "utf8");
    const matched = content.split("\n").find((line) => line.includes(marker));
    expect(matched).toBeDefined();
    expect(matched).not.toContain(fake);
    expect(matched).toContain("***REDACTED***");
  });
});

describe("getFileLogging", () => {
  it("never initializes on its own: null sinks, no dir touched", () => {
    const sentinel = path.join(
      tmpdir(),
      `file-logging-never-init-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    vi.stubEnv("PAPERCLIP_LOG_DIR", sentinel);
    vi.stubEnv("PAPERCLIP_FILE_LOGGING", "true");
    const state = getFileLogging();
    expect(state.serverSink).toBeNull();
    expect(state.accessSink).toBeNull();
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe("initServerFileLogging", () => {
  it("stays stdout-only under unit tests unless explicitly enabled", () => {
    expect(process.env.VITEST_WORKER_ID).toBeDefined();
    const dir = tempDir();
    const state = initServerFileLogging({
      ...process.env,
      PAPERCLIP_LOG_DIR: dir,
      PAPERCLIP_FILE_LOGGING: undefined,
    });
    expect(state.config.enabled).toBe(false);
    expect(state.serverSink).toBeNull();
    expect(state.accessSink).toBeNull();
  });

  it("inits from env when explicitly enabled, even under unit tests", () => {
    const dir = tempDir();
    const state = initServerFileLogging({
      ...process.env,
      PAPERCLIP_LOG_DIR: dir,
      PAPERCLIP_FILE_LOGGING: "true",
      PAPERCLIP_CONFIG: path.join(dir, "no-config.json"),
    });
    expect(state.serverSink?.path).toBe(path.join(dir, "server.log"));
    expect(state.accessSink?.path).toBe(path.join(dir, "access.log"));
  });
});
