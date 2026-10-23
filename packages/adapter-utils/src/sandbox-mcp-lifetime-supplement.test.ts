import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { type ClientHttp2Session, connect } from "node:http2";
import os from "node:os";
import path from "node:path";
import { type Duplex, duplexPair } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { startAdapterExecutionTargetPaperclipBridge } from "./execution-target.js";

// These tests catch renewed deadlines, wall-only accounting, queue admission
// after revocation and timer-less in-flight expiry. Only the external sandbox
// runner is replaced: generated queue gateway and HTTP/2 framing stay real.
// activate is the host-only handle seam described in the independent handoff;
// optional invocation keeps RED on old runtime behavioral, not a TypeError.
type Bridge = NonNullable<
  Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>>
> & {
  activate?: () => void;
};
type Transport = "queue" | "http2" | "fallback";
const TRANSPORTS: Transport[] = ["queue", "http2", "fallback"];
const CAPABILITIES = {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(
  promise: Promise<T>,
  ms = 3_000,
): Promise<T | "fixture-timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<"fixture-timeout">((resolve) => {
      timer = setTimeout(() => resolve("fixture-timeout"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe("host-owned sandbox lifetime supplement on real dispatch seams", () => {
  let root: string;
  let remote: string;
  let host: ReturnType<typeof createServer>;
  let hostUrl: string;
  let runner: CommandManagedRuntimeRunner;
  let bridges: Bridge[];
  let peers: Duplex[];
  let client: ClientHttp2Session | undefined;
  let h2Bearer: string;
  let exits: Array<(result: { exitCode: number }) => void>;
  let forwards: number;
  let hang: boolean;
  let dispatched: ReturnType<typeof deferred<void>>;
  let closed: ReturnType<typeof deferred<void>>;
  let wall: number;
  let elapsed: number;
  let issuance: number;
  let beforeShell:
    | ((
        input: Parameters<CommandManagedRuntimeRunner["execute"]>[0],
      ) => Promise<void>)
    | undefined;
  let fallbackDelay: number;

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "lifetime-supplement-",
      ),
    );
    remote = path.join(root, "remote");
    await mkdir(remote);
    bridges = [];
    peers = [];
    client = undefined;
    exits = [];
    h2Bearer = "";
    forwards = 0;
    hang = false;
    beforeShell = undefined;
    fallbackDelay = 0;
    dispatched = deferred<void>();
    closed = deferred<void>();
    issuance = Date.now();
    wall = issuance;
    elapsed = 0;
    // Keep the generated gateway's wall clock fixed independently of host time.
    // Authorization must be host-owned even if sandbox files/clock survive.
    const clock = path.join(root, "sandbox-clock.cjs");
    await writeFile(
      clock,
      `const RealDate = Date; global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [${issuance}])); }
      static now() { return ${issuance}; }
    };`,
    );
    vi.stubEnv("NODE_OPTIONS", `--require=${clock}`);
    host = createServer((req, res) => {
      forwards++;
      req.resume();
      req.on("end", () => {
        dispatched.resolve();
        if (hang) {
          res.on("close", () => closed.resolve());
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"fixture":true}');
      });
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const address = host.address();
    if (!address || typeof address === "string")
      throw new Error("fixture address missing");
    hostUrl = `http://127.0.0.1:${address.port}`;
    runner = {
      execute: async (input) => {
        await beforeShell?.(input);
        return new Promise((resolve, reject) => {
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
        });
      },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    client?.destroy();
    for (const peer of peers) peer.destroy();
    for (const bridge of bridges)
      await bounded(
        bridge.stop().catch(() => {}),
        5_000,
      );
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      host.close((error) => (error ? reject(error) : resolve())),
    );
    vi.unstubAllEnvs();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  function independentHostClocks() {
    const performanceBase = performance.now();
    const hrBase = process.hrtime.bigint();
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    vi.spyOn(performance, "now").mockImplementation(
      () => performanceBase + elapsed,
    );
    vi.spyOn(process.hrtime, "bigint").mockImplementation(
      () => hrBase + BigInt(Math.trunc(elapsed * 1_000_000)),
    );
  }

  async function start(transport: Transport, budget = 60) {
    if (transport !== "queue")
      runner.openDuplexChannel = async ({ command }) => {
        if (transport === "fallback") {
          // Delay is observed before queue fallback, never a new issuance epoch.
          wall += fallbackDelay;
          elapsed += fallbackDelay;
          throw new Error("synthetic H2 unavailable");
        }
        const launch = command.join(" ");
        const nonce = /PAPERCLIP_BRIDGE_NONCE='([^']*)'/.exec(launch)?.[1];
        h2Bearer = /PAPERCLIP_BRIDGE_TOKEN='([^']*)'/.exec(launch)?.[1] ?? "";
        if (!nonce || !h2Bearer)
          throw new Error("missing H2 fixture bootstrap");
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
    const bridge = (await startAdapterExecutionTargetPaperclipBridge({
      runId: "supplement-attempt",
      adapterKey: "fixture",
      timeoutSec: budget,
      hostApiUrl: hostUrl,
      hostApiToken: "synthetic-host-only-token",
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
        ...(transport !== "queue"
          ? { effectiveCapabilities: CAPABILITIES }
          : {}),
      },
      enableSandboxDuplexBridge: transport !== "queue",
      forwardTimeoutMs: 20_000,
    })) as Bridge | null;
    if (!bridge) throw new Error("bridge fixture did not start");
    bridges.push(bridge);
    if (transport === "fallback")
      expect(bridge.env.PAPERCLIP_BRIDGE_QUEUE_DIR).toBeTruthy();
    return bridge;
  }

  async function request(bridge: Bridge, transport: Transport) {
    if (transport !== "http2") {
      const response = await fetch(
        `${bridge.env.PAPERCLIP_API_URL}/api/agents/me`,
        {
          headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}` },
          signal: AbortSignal.timeout(4_000),
        },
      );
      return { status: response.status, body: await response.text() };
    }
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      if (!client) return reject(new Error("missing real H2 client"));
      const req = client.request({
        ":method": "GET",
        ":path": "/api/agents/me",
        authorization: `Bearer ${h2Bearer}`,
      });
      let status = 0;
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        req.close();
        reject(new Error("fixture H2 timeout"));
      }, 4_000);
      req.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      req.on("data", (data: Buffer) => chunks.push(data));
      req.on("end", () => {
        clearTimeout(timer);
        resolve({ status, body: Buffer.concat(chunks).toString() });
      });
      req.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.end();
    });
  }

  it.each(TRANSPORTS)(
    "%s: full-budget callbacks survive +16m and near D, then exact D/O deny",
    async (transport) => {
      independentHostClocks();
      const bridge = await start(transport, 14_400);
      bridge.activate?.();
      for (const offset of [960_000, 14_399_999]) {
        wall = issuance + offset;
        elapsed = offset;
        expect
          .soft(
            (await request(bridge, transport)).status,
            `healthy callback at +${offset}ms`,
          )
          .toBe(200);
      }
      const before = forwards;
      for (const offset of [14_400_000, 15_300_000]) {
        wall = issuance;
        elapsed = offset;
        expect
          .soft([401, 403], `exact host cutoff +${offset}ms`)
          .toContain((await request(bridge, transport)).status);
        expect.soft(forwards).toBe(before);
      }
    },
    20_000,
  );

  it.each(TRANSPORTS)(
    "%s: invalid host monotonic samples deny terminally rather than retryable 502",
    async (transport) => {
      independentHostClocks();
      const bridge = await start(transport);
      bridge.activate?.();
      expect((await request(bridge, transport)).status).toBe(200);
      const before = forwards;
      vi.mocked(performance.now).mockReturnValue(Number.NaN);
      vi.mocked(process.hrtime.bigint).mockReturnValue(-1n);
      const result = await request(bridge, transport).catch(() => ({
        status: 0,
        body: "closed",
      }));
      expect
        .soft(
          [0, 401, 403],
          "clock uncertainty is not a retryable transport failure",
        )
        .toContain(result.status);
      expect.soft(forwards).toBe(before);
    },
    20_000,
  );

  it.each(TRANSPORTS)(
    "%s: repeated host activation cannot reset D; monotonic-only exact D rejects",
    async (transport) => {
      independentHostClocks();
      const bridge = await start(transport);
      wall += 10_000;
      elapsed = 10_000;
      bridge.activate?.(); // A=I+10s, D=I+70s, O=I+960s.
      expect((await request(bridge, transport)).status).toBe(200);
      wall += 30_000;
      elapsed = 40_000;
      // Duplicate activation may be an idempotent no-op or an explicit host
      // misuse error; neither is permission to assign a new A or D.
      try {
        bridge.activate?.();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      wall = issuance + 10_000;
      elapsed = 69_999;
      expect
        .soft(
          (await request(bridge, transport)).status,
          "full original budget remains available",
        )
        .toBe(200);
      const before = forwards;
      elapsed = 70_000;
      expect
        .soft([401, 403], "D equality is expired; no second activation grant")
        .toContain((await request(bridge, transport)).status);
      expect
        .soft(forwards, "monotonic D admitted another upstream dispatch")
        .toBe(before);
    },
    20_000,
  );

  it.each(TRANSPORTS)(
    "%s: forward wall jump before activation then rollback cannot add a second B",
    async (transport) => {
      independentHostClocks();
      const bridge = await start(transport);
      wall = issuance + 60_000; // wall and monotonic deliberately diverge BEFORE A.
      let refused: unknown;
      try {
        bridge.activate?.();
      } catch (error) {
        refused = error;
      }
      if (refused) {
        // A conservative clock-uncertainty policy may refuse before launch.
        // Do not reject that compliant choice or accept a generic fixture error.
        const error = refused as Record<string, unknown>;
        expect
          .soft(error.code ?? error.errorCode)
          .toEqual(expect.stringMatching(/\S/));
        expect
          .soft(error.remediation ?? error.nextAction ?? error.next_action)
          .toEqual(expect.stringMatching(/\S/));
      }
      wall = issuance;
      elapsed = 59_999;
      const near = (await request(bridge, transport)).status;
      expect.soft(refused ? [401, 403] : [200, 401, 403]).toContain(near);
      const before = forwards;
      elapsed = 60_000;
      expect
        .soft(
          [401, 403],
          "60s of actual activated monotonic execution exhausted B",
        )
        .toContain((await request(bridge, transport)).status);
      expect.soft(forwards).toBe(before);
    },
    20_000,
  );

  it.each(TRANSPORTS)(
    "%s: monotonic outer O survives sandbox/host rollback without activation",
    async (transport) => {
      independentHostClocks();
      const bridge = await start(transport);
      elapsed = 960_000;
      wall = issuance - 86_400_000; // B=60s + S=900s.
      expect
        .soft([401, 403], "unactivated O is a host ceiling")
        .toContain((await request(bridge, transport)).status);
      const activation = (() => {
        try {
          bridge.activate?.();
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect
        .soft(activation, "expired startup must refuse activation explicitly")
        .toBeInstanceOf(Error);
      expect
        .soft([401, 403])
        .toContain((await request(bridge, transport)).status);
      expect.soft(forwards).toBe(0);
    },
    20_000,
  );

  it.each(TRANSPORTS)(
    "%s: activation at S retains B but exact O/D equality denies",
    async (transport) => {
      independentHostClocks();
      const bridge = await start(transport);
      wall += 900_000;
      elapsed = 900_000;
      bridge.activate?.();
      wall += 59_999;
      elapsed = 959_999;
      expect.soft((await request(bridge, transport)).status).toBe(200);
      const before = forwards;
      wall++;
      elapsed++;
      expect
        .soft([401, 403])
        .toContain((await request(bridge, transport)).status);
      expect.soft(forwards).toBe(before);
    },
    20_000,
  );

  it("fallback does not reset I/O when H2 setup consumes the startup allowance", async () => {
    independentHostClocks();
    fallbackDelay = 900_001;
    const outcome = await start("fallback").then(
      (bridge) => ({ bridge }),
      (error) => ({ error }),
    );
    if ("bridge" in outcome) {
      let refused = false;
      try {
        outcome.bridge.activate?.();
      } catch {
        refused = true;
      }
      expect
        .soft(refused, "fallback reset I and admitted late activation")
        .toBe(true);
      wall = issuance;
      elapsed = 900_001;
      expect
        .soft([401, 403])
        .toContain((await request(outcome.bridge, "fallback")).status);
    } else {
      const failure = outcome.error as Record<string, unknown>;
      expect
        .soft(
          failure?.errorCode ?? failure?.code,
          "startup refusal is machine-readable",
        )
        .toEqual(expect.stringMatching(/\S/));
      expect
        .soft(
          failure?.remediation ?? failure?.nextAction ?? failure?.next_action,
          "startup refusal is actionable",
        )
        .toEqual(expect.stringMatching(/\S/));
    }
    expect.soft(forwards).toBe(0);
  }, 20_000);

  it.each(TRANSPORTS)(
    "%s: timer alone aborts an already-dispatched hanging forward at D",
    async (transport) => {
      const bridge = await start(transport, 1);
      bridge.activate?.();
      hang = true;
      const pending = request(bridge, transport).catch(() => ({
        status: 0,
        body: "closed",
      }));
      expect(
        await bounded(dispatched.promise, 800),
        "forward must really be in flight before expiry",
      ).not.toBe("fixture-timeout");
      // No second request and no explicit stop: only the lifetime timer can abort.
      expect
        .soft(
          await bounded(closed.promise, 1_800),
          "upstream socket survived D",
        )
        .not.toBe("fixture-timeout");
      expect(forwards).toBe(1);
      expect
        .soft(
          (await pending).status,
          "expired in-flight request cannot report success",
        )
        .not.toBe(200);
    },
    15_000,
  );

  it("queued-before-cancel work cannot dispatch after host revocation", async () => {
    const bridge = await start("queue");
    bridge.activate?.();
    const blocked = deferred<void>();
    const release = deferred<void>();
    beforeShell = async (input) => {
      const command = input.args?.at(-1) ?? "";
      if (command.includes("/requests/") && command.includes("| base64")) {
        blocked.resolve();
        await release.promise;
      }
    };
    const pending = request(bridge, "queue").catch(() => ({
      status: 0,
      body: "closed",
    }));
    try {
      expect(
        await bounded(blocked.promise),
        "real queue read seam not reached",
      ).not.toBe("fixture-timeout");
      // stop synchronously revokes, even though remote cleanup is still pending.
      const stopping = bridge.stop();
      release.resolve();
      await bounded(stopping.catch(() => {}));
      expect.soft((await pending).status).not.toBe(200);
      expect
        .soft(forwards, "queued request was grandfathered across revoke")
        .toBe(0);
    } finally {
      release.resolve();
    }
  }, 15_000);

  it("observed H2 owner-channel loss invalidates an activated bearer even with the byte stream retained", async () => {
    const bridge = await start("http2");
    bridge.activate?.();
    expect((await request(bridge, "http2")).status).toBe(200);
    expect(exits.length).toBeGreaterThan(0);
    for (const exit of exits) exit({ exitCode: 1 });
    const after = await request(bridge, "http2").catch(() => ({
      status: 0,
      body: "closed",
    }));
    expect.soft(after.status).not.toBe(200);
    expect.soft(forwards).toBe(1);
    // Source assets remain: transport/socket close is not a substitute for the
    // acceptance-state assertion made above while the peer is retained.
    const source = await readFile(
      path.join(
        remote,
        ".paperclip-runtime",
        "fixture",
        "paperclip-bridge",
        "server",
        "paperclip-bridge-server.mjs",
      ),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(0);
  }, 15_000);
});
