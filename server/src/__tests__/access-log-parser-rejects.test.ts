import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

// NOTE: no static imports of the app or file-logging modules here. The test
// stubs env first, then dynamically imports the real createApp and
// explicitly inits file logging (the server-boot equivalent) against a
// temp dir: importing the app alone never initializes.

describe("access log parser rejects", () => {
  let dir: string | null = null;

  afterEach(async () => {
    try {
      const { __resetFileLoggingForTests } = await import(
        "../middleware/file-logging.js"
      );
      __resetFileLoggingForTests();
    } catch {
      // App was never imported; nothing to reset.
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("logs body-parser rejects (malformed and oversized) through createApp", async () => {
    // Regression: the access logger used to mount after the body parsers,
    // and a parser rejection calls next(err), which skips all downstream
    // non-error middleware — so malformed/oversized floods left zero lines.
    vi.resetModules();
    dir = mkdtempSync(path.join(tmpdir(), "access-log-rejects-test-"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAPERCLIP_FILE_LOGGING", "true");
    vi.stubEnv("PAPERCLIP_LOG_DIR", dir);
    // Hermetic: an ambient instance config must not redirect the logs dir.
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(dir, "no-config.json"));

    const { createApp } = await import("../app.js");
    // Explicit init, as server boot does: the access logger resolves its
    // sink per request, so init-before-requests retains the reject lines.
    const { initFileLogging, parseFileLoggingConfig } = await import(
      "../middleware/file-logging.js"
    );
    initFileLogging(parseFileLoggingConfig());
    const app = await createApp({} as never, {
      uiMode: "none",
      serverPort: 3100,
      storageService: {} as never,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: false,
      companyDeletionEnabled: false,
      decisionServiceOptions: {
        wakeOriginAgent: async () => {},
      } as never,
    } as never);

    await request(app)
      .post("/api/health")
      .set("content-type", "application/json")
      .send("{bad json")
      .expect(400);
    // Global JSON limit is 10mb; an 11mb body is rejected by the parser. The
    // app error handler maps only malformed-JSON to 400 and everything else
    // to 500 (pre-existing mapping, not this feature's concern) — what
    // matters here is that the reject yields an access line either way.
    await request(app)
      .post("/api/health")
      .set("content-type", "application/json")
      .send(`{"pad":"${"x".repeat(11 * 1024 * 1024)}"}`)
      .expect(500);

    const lines = readFileSync(path.join(dir, "access.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.s).sort()).toEqual([400, 500]);
    for (const line of lines) {
      expect(line.m).toBe("POST");
      expect(line.p).toBe("/api/health");
    }
  }, 60000);
});
