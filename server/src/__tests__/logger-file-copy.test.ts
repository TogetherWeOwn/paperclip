import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// NOTE: no static imports of the logger or file-logging modules here. The
// test stubs env first, then dynamically imports the real logger and
// explicitly inits file logging (the server-boot equivalent) against a
// temp dir: importing the logger alone never initializes.

describe("logger retained file copy", () => {
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

  it("keeps debug lines in server.log when file logging is on", async () => {
    // Regression: pino.multistream defaults a leg without a level to info,
    // which silently dropped debug/trace lines from BOTH stdout and the
    // file whenever file logging was enabled (the default).
    vi.resetModules();
    dir = mkdtempSync(path.join(tmpdir(), "logger-file-copy-test-"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAPERCLIP_LOG_LEVEL", "debug");
    vi.stubEnv("PAPERCLIP_FILE_LOGGING", "true");
    vi.stubEnv("PAPERCLIP_LOG_DIR", dir);
    // Hermetic: an ambient instance config must not redirect the logs dir.
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(dir, "no-config.json"));

    const { logger } = await import("../middleware/logger.js");
    // Explicit init, as server boot does: the logger's file leg resolves
    // the sink lazily, so init-after-import still retains this line.
    const { initFileLogging, parseFileLoggingConfig } = await import(
      "../middleware/file-logging.js"
    );
    initFileLogging(parseFileLoggingConfig());
    const marker = `debug-marker-${Date.now()}`;
    logger.debug(marker);

    const serverLog = path.join(dir, "server.log");
    const deadline = Date.now() + 2000;
    let content = "";
    while (Date.now() < deadline) {
      try {
        content = readFileSync(serverLog, "utf8");
      } catch {
        content = "";
      }
      if (content.includes(marker)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(content).toContain(marker);
  });
});
