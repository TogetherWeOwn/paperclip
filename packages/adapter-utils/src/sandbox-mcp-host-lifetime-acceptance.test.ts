import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { type ClientHttp2Session, connect } from "node:http2";
import os from "node:os";
import path from "node:path";
import { type Duplex, duplexPair } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { startAdapterExecutionTargetPaperclipBridge } from "./execution-target.js";

// Real queue/gateway and real HTTP/2 framing; only the external provider transport
// is replaced. No invented activate()/owner-generation API: these tests deliberately
// never launch an agent and therefore must never forward upstream. Post-activation
// CLI/ACP and exact deadlines are exercised by the consumer acceptance suites.
type Bridge = NonNullable<
  Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>>
>;
const capabilities = {
  reusableLeases: false,
  nativeSyncIn: false,
  nativeSyncOut: false,
  persistentProcessSessions: false,
  independentControlCommands: false,
  incrementalSessionOutput: false,
  concurrentSyncOperations: false,
  duplexCommandStream: true,
  runnerWebSocketIngress: false,
};

function bounded<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | "fixture-timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<"fixture-timeout">((resolve) => {
      timer = setTimeout(() => resolve("fixture-timeout"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe("host-owned sandbox activation at real transport boundaries", () => {
  let root: string;
  let remote: string;
  let host: ReturnType<typeof createServer>;
  let hostUrl: string;
  let forwards: number;
  let runner: CommandManagedRuntimeRunner;
  let handles: Bridge[];
  let peers: Duplex[];
  let client: ClientHttp2Session | undefined;

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "host-lifetime-",
      ),
    );
    remote = path.join(root, "remote");
    await mkdir(remote);
    handles = [];
    peers = [];
    client = undefined;
    forwards = 0;
    host = createServer((req, res) => {
      forwards++;
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"fixture":true}');
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const address = host.address();
    if (!address || typeof address === "string")
      throw new Error("missing fixture address");
    hostUrl = `http://127.0.0.1:${address.port}`;
    runner = {
      execute: (input) =>
        new Promise((resolve, reject) => {
          const startedAt = new Date().toISOString();
          const child = spawn(input.command, input.args ?? [], {
            cwd: input.cwd,
            env: { ...process.env, ...input.env, BASH_ENV: "" },
            stdio: ["pipe", "pipe", "pipe"],
          });
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
          child.stdout.on("data", (data: Buffer) => stdout.push(data));
          child.stderr.on("data", (data: Buffer) => stderr.push(data));
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("close", (exitCode, signal) => {
            clearTimeout(timer);
            resolve({
              exitCode,
              signal,
              timedOut: signal === "SIGKILL",
              startedAt,
              pid: child.pid ?? null,
              stdout: Buffer.concat(stdout).toString(),
              stderr: Buffer.concat(stderr).toString(),
            });
          });
          child.stdin.on("error", () => {});
          child.stdin.end(input.stdin ?? "");
        }),
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    client?.destroy();
    for (const peer of peers) peer.destroy();
    for (const handle of handles)
      await bounded(
        handle.stop().catch(() => {}),
        5_000,
      );
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      host.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  async function start(duplex = false) {
    const handle = await startAdapterExecutionTargetPaperclipBridge({
      runId: "fixture-unlaunched-run",
      adapterKey: "fixture",
      timeoutSec: 14_400,
      hostApiUrl: hostUrl,
      hostApiToken: "synthetic-host-token",
      runtimeRootDir: path.join(remote, ".paperclip-runtime", "fixture"),
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fixture",
        remoteCwd: remote,
        streamRunLogs: false,
        shellCommand: "sh",
        timeoutMs: 15_000,
        runner,
        ...(duplex ? { effectiveCapabilities: capabilities } : {}),
      },
      enableSandboxDuplexBridge: duplex,
    });
    if (!handle) throw new Error("fixture transport did not return a bridge");
    handles.push(handle);
    return handle;
  }

  async function request(bridge: Bridge) {
    const response = await fetch(
      `${bridge.env.PAPERCLIP_API_URL}/api/agents/me`,
      {
        headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}` },
        signal: AbortSignal.timeout(2_000),
      },
    );
    await response.arrayBuffer();
    return response.status;
  }

  it("a live queue gateway is not authority before host turn launch", async () => {
    const bridge = await start();
    expect
      .soft([401, 403], "transport readiness is not activation")
      .toContain(await request(bridge));
    expect.soft(forwards, "pre-activation host dispatch").toBe(0);
  });

  it("actual HTTP2 READY and observed owner-channel loss never authorize an unlaunched turn", async () => {
    let bearer = "";
    const exits: Array<(result: { exitCode: number }) => void> = [];
    runner.openDuplexChannel = async ({ command }) => {
      const launch = command.join(" ");
      const nonce = /PAPERCLIP_BRIDGE_NONCE='([^']*)'/.exec(launch)?.[1];
      bearer = /PAPERCLIP_BRIDGE_TOKEN='([^']*)'/.exec(launch)?.[1] ?? "";
      if (!nonce || !bearer)
        throw new Error("missing synthetic channel bootstrap");
      const [hostSide, sandboxSide] = duplexPair();
      peers.push(hostSide, sandboxSide);
      const listeners: Array<(data: Uint8Array) => void> = [];
      hostSide.on("error", () => {});
      sandboxSide.on("error", () => {});
      hostSide.on("data", (data: Buffer) => {
        for (const listener of listeners) listener(data);
      });
      setImmediate(() => {
        sandboxSide.write(
          `${JSON.stringify({ version: 2, type: "ready", nonce })}\n`,
        );
        client = connect("http://fixture.invalid", {
          createConnection: () => sandboxSide,
        });
        client.on("error", () => {});
      });
      return {
        write: (data) => {
          hostSide.write(data);
        },
        onData: (listener) => {
          listeners.push(listener);
        },
        onExit: (listener) => {
          exits.push(listener);
        },
        stop: () => {
          hostSide.destroy();
        },
        close: async () => {
          hostSide.end();
        },
      };
    };
    await start(true);
    const get = () =>
      new Promise<number>((resolve, reject) => {
        if (!client) return reject(new Error("missing real HTTP2 client"));
        const req = client.request({
          ":method": "GET",
          ":path": "/api/agents/me",
          authorization: `Bearer ${bearer}`,
        });
        const timer = setTimeout(() => {
          req.close();
          reject(new Error("HTTP2 fixture timeout"));
        }, 2_000);
        req.on("response", (headers) => {
          clearTimeout(timer);
          req.resume();
          resolve(Number(headers[":status"]));
        });
        req.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        req.end();
      });
    expect
      .soft([401, 403], "H2 READY is not host activation")
      .toContain(await get());
    expect.soft(forwards).toBe(0);
    // Provider exit is observed through the production runner's real onExit seam.
    // Leave the byte stream alive: disconnect alone must not be our denial oracle.
    for (const exit of exits) exit({ exitCode: 1 });
    const after = await bounded(
      get().catch(() => 401),
      3_000,
    );
    expect
      .soft([401, 403], "observed loss must deny before cleanup")
      .toContain(after);
    expect.soft(forwards, "observed-loss host dispatch").toBe(0);
  }, 20_000);

  it("a genuine H2-to-queue fallback cannot reset issuance or revive a bearer after the startup allowance", async () => {
    const issuance = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(issuance);
    let opens = 0;
    runner.openDuplexChannel = async () => {
      opens++;
      vi.setSystemTime(issuance + 900_001);
      throw new Error("synthetic provider H2 startup failure");
    };
    const outcome = await start(true).then(
      (bridge) => ({ bridge }),
      (error) => ({ error }),
    );
    expect(opens, "fixture must attempt real H2 setup before fallback").toBe(1);
    if ("bridge" in outcome) {
      expect(
        outcome.bridge.env.PAPERCLIP_BRIDGE_QUEUE_DIR,
        "real queue fallback",
      ).toBeTruthy();
      expect
        .soft([401, 403], "fallback is not activation")
        .toContain(await request(outcome.bridge));
      vi.setSystemTime(issuance);
      expect
        .soft([401, 403], "fallback cannot renew by resetting its clock")
        .toContain(await request(outcome.bridge));
    }
    expect
      .soft(forwards, "fallback dispatched without host activation")
      .toBe(0);
  }, 20_000);
});
