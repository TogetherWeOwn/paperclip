import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Regression: any process importing the server logger used to initialize
// retained file logging as an import side effect — hourly CLI subcommands
// then teed credential-bearing stdout into server.log and churned rotation.
// A bare logger import must now be side-effect-free: only explicit
// initFileLogging() (server boot) opens sinks or installs the tee.

describe("logger import from a CLI context", () => {
  let dir: string | null = null;

  afterEach(async () => {
    try {
      const { __resetFileLoggingForTests } = await import(
        "../middleware/file-logging.js"
      );
      __resetFileLoggingForTests();
    } catch {
      // Logger was never imported; nothing to reset.
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it(
    "touches no log dir and installs no tee in a bare CLI subprocess",
    async () => {
      dir = mkdtempSync(path.join(tmpdir(), "logger-cli-context-test-"));
      // Sentinel: a log dir that must never be created. Explicitly enabled
      // file logging must not matter — no init call, no side effects.
      const sentinel = path.join(dir, "logs-that-must-not-exist");
      const loggerUrl = new URL("../middleware/logger.js", import.meta.url)
        .href;
      const fileLoggingUrl = new URL(
        "../middleware/file-logging.js",
        import.meta.url,
      ).href;
      const code = `
        const before = process.stdout.write;
        const { logger } = await import(${JSON.stringify(loggerUrl)});
        const { getFileLogging } = await import(${JSON.stringify(fileLoggingUrl)});
        logger.info("cli-probe-log-line");
        const state = getFileLogging();
        console.log("PROBE_RESULT " + JSON.stringify({
          writeUnchanged: process.stdout.write === before,
          serverSinkNull: state.serverSink === null,
          accessSinkNull: state.accessSink === null,
        }));
      `;
      // CLI fidelity: drop every vitest worker var so the child cannot
      // tell it was spawned from a test.
      const childEnv: Record<string, string | undefined> = { ...process.env };
      for (const key of Object.keys(childEnv)) {
        if (key.startsWith("VITEST")) delete childEnv[key];
      }
      childEnv.NODE_ENV = "production";
      childEnv.PAPERCLIP_FILE_LOGGING = "true";
      childEnv.PAPERCLIP_LOG_DIR = sentinel;
      childEnv.PAPERCLIP_CONFIG = path.join(dir, "no-config.json");

      const output = await new Promise<{ stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              fileURLToPath(
                new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url),
              ),
              "--input-type=module",
              "-e",
              code,
            ],
            {
              env: childEnv as Record<string, string>,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("exit", (exitCode) =>
            exitCode === 0
              ? resolve({ stdout, stderr })
              : reject(
                  new Error(
                    `cli probe exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
                  ),
                ),
          );
        },
      );

      const resultLine = output.stdout
        .split("\n")
        .find((line) => line.includes("PROBE_RESULT"));
      expect(resultLine).toBeDefined();
      expect(JSON.parse(resultLine!.slice(resultLine!.indexOf("{")))).toEqual({
        writeUnchanged: true,
        serverSinkNull: true,
        accessSinkNull: true,
      });
      // The server-boot startup line must never come from a CLI process.
      expect(output.stdout).not.toContain("retained file logging enabled");
      expect(output.stderr).not.toContain("retained file logging enabled");
      expect(existsSync(sentinel)).toBe(false);
    },
    30000,
  );

  it("installs no stdio tee on bare logger import", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const before = process.stdout.write;
    await import("../middleware/logger.js");
    expect(process.stdout.write).toBe(before);
    const { getFileLogging } = await import("../middleware/file-logging.js");
    expect(getFileLogging().serverSink).toBeNull();
    expect(getFileLogging().accessSink).toBeNull();
  });
});
