import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { startAdapterExecutionTargetPaperclipBridge } from "./execution-target.js";

// A local provider boundary: real generated bridge process and real queue,
// without SSH, VM access, production credentials or a database.
function fixtureRunner(): CommandManagedRuntimeRunner {
  return {
    execute: async (input) =>
      new Promise((resolve, reject) => {
        const startedAt = new Date().toISOString();
        const child = spawn(input.command, input.args ?? [], {
          cwd: input.cwd,
          env: { ...process.env, ...input.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.once("close", () => clearTimeout(killTimer));
        child.once("error", () => clearTimeout(killTimer));
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", reject);
        child.on("close", (exitCode, signal) =>
          resolve({
            exitCode,
            signal,
            timedOut: false,
            startedAt,
            pid: child.pid ?? null,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          }),
        );
        child.stdin.on("error", () => {});
        child.stdin.end(input.stdin ?? "");
      }),
  };
}

describe("shared sandbox bridge credential lifetime acceptance", () => {
  let root: string;
  let host: ReturnType<typeof createServer>;
  let bridge: Awaited<
    ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>
  >;
  let offsetFile: string;
  let forwards: number;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sandbox-mcp-lifetime-"));
    offsetFile = path.join(root, "offset");
    await writeFile(offsetFile, "0");
    const clockModule = path.join(root, "clock.cjs");
    await writeFile(
      clockModule,
      `
      const fs = require('node:fs');
      const OriginalDate = Date;
      const offset = () => Number(fs.readFileSync(${JSON.stringify(offsetFile)}, 'utf8'));
      global.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [OriginalDate.now() + offset()])); }
        static now() { return OriginalDate.now() + offset(); }
      };
    `,
    );
    vi.stubEnv("NODE_OPTIONS", `--require=${clockModule}`);
    forwards = 0;
    host = createServer((req, res) => {
      forwards++;
      const valid =
        req.headers.authorization === "Bearer synthetic-host-only-token" &&
        req.headers["x-paperclip-run-id"] === "lifetime-run";
      res.writeHead(valid ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: valid }));
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const address = host.address();
    if (!address || typeof address === "string")
      throw new Error("missing fixture listen address");
    const remote = path.join(root, "remote");
    await mkdir(remote);
    bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "lifetime-run",
      adapterKey: "shared-consumer",
      timeoutSec: 60,
      hostApiToken: "synthetic-host-only-token",
      hostApiUrl: `http://127.0.0.1:${address.port}`,
      runtimeRootDir: path.join(
        remote,
        ".paperclip-runtime",
        "shared-consumer",
      ),
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fixture",
        remoteCwd: remote,
        streamRunLogs: false,
        runner: fixtureRunner(),
      },
    });
    expect(bridge).not.toBeNull();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await writeFile(offsetFile, "0");
    await bridge?.stop();
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      host.close((error) => (error ? reject(error) : resolve())),
    );
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function getIdentity() {
    if (!bridge) throw new Error("fixture bridge was not started");
    return fetch(`${bridge.env.PAPERCLIP_API_URL}/api/agents/me`, {
      headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}` },
      signal: AbortSignal.timeout(3_000),
    });
  }

  it("rejects a copied bearer at the 60s-budget plus 900s-startup outer ceiling while listener and files survive", async () => {
    // Host turn launch, not gateway readiness, grants callback authority.
    (bridge as typeof bridge & { activate?: () => void })?.activate?.();
    const before = await getIdentity();
    expect(before.status).toBe(200);
    await before.arrayBuffer();
    expect(forwards).toBe(1);
    const baseline = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(baseline + 16 * 60_000);
    await writeFile(offsetFile, String(16 * 60_000));
    const after = await getIdentity();
    expect.soft([401, 403]).toContain(after.status);
    await after.arrayBuffer();
    expect
      .soft(forwards, "expired credential was forwarded to the host")
      .toBe(1);
    // Files are intentionally retained: deleting config is not token expiry.
    const source = await readFile(
      path.join(
        root,
        "remote",
        ".paperclip-runtime",
        "shared-consumer",
        "paperclip-bridge",
        "server",
        "paperclip-bridge-server.mjs",
      ),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(0);
  });

  it("stops authorizing a retained bearer when bridge.stop settles", async () => {
    // Host turn launch, not gateway readiness, grants callback authority.
    (bridge as typeof bridge & { activate?: () => void })?.activate?.();
    const before = await getIdentity();
    expect(before.status).toBe(200);
    await before.arrayBuffer();
    if (!bridge) throw new Error("fixture bridge was not started");
    await bridge.stop();
    await expect(getIdentity()).rejects.toMatchObject({
      cause: { code: "ECONNREFUSED" },
    });
    expect(forwards).toBe(1);
  });
});
