import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { type ClientHttp2Session, connect } from "node:http2";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { type Duplex, duplexPair } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import { createAcpRuntime } from "acpx/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CommandManagedDuplexChannel,
  type CommandManagedRuntimeRunner,
  prepareCommandManagedRuntime,
} from "./command-managed-runtime.js";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "./types.js";

// Only CLI process execution/probing is replaced: no vendor CLI, VM, DB or
// provider network is needed. Bridge handles, staging, shell commands, queue
// worker, generated gateway, ACP runtime and HTTP/2 framing stay real.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@paperclipai/adapter-utils/execution-target")
    >();
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: async () => {},
    ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
    resolveAdapterExecutionTargetCommandForLogs: async () => "fixture-cli",
    runAdapterExecutionTargetProcess: vi.fn(),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(
      actual.startAdapterExecutionTargetPaperclipBridge,
    ),
  };
});

import { createAcpxEngineExecutor } from "./acpx-engine/execute.js";

const PRIMARY = "fixture provider execution failed";
const STARTUP = "fixture callback startup failed after listener creation";
const SCRUB = "fixture remote MCP scrub denied";
type Bridge = NonNullable<
  Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>>
>;
type RunInput = Parameters<CommandManagedRuntimeRunner["execute"]>[0];
type Outcome = { value?: unknown; error?: unknown };

async function observe(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

// Inspect public error/cause/aggregate/structured result fields, not Error's
// non-enumerable JSON representation. Logs are also an allowed error contract.
function evidence(outcome: Outcome, logs: string[]): string {
  const seen = new Set<unknown>();
  const flatten = (value: unknown): string => {
    if (value === null || typeof value !== "object") return String(value);
    if (seen.has(value)) return "";
    seen.add(value);
    const own = Object.getOwnPropertyNames(value).filter(
      (key) => key !== "stack",
    );
    return own
      .map((key) => flatten((value as Record<string, unknown>)[key]))
      .join("\n");
  };
  return `${flatten(outcome)}\n${logs.join("")}`;
}

function failed(outcome: Outcome): boolean {
  const result = outcome.value as AdapterExecutionResult | undefined;
  return (
    outcome.error !== undefined ||
    (typeof result?.exitCode === "number" && result.exitCode !== 0) ||
    result?.timedOut === true
  );
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function requireValue<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("missing acceptance fixture value");
  return value;
}

// A complete synthetic ACP peer: failures are actual JSON-RPC provider errors,
// not a replacement settlement or transport implementation.
const AGENT = `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  let result = {};
  switch (request.method) {
    case 'initialize': result = { protocolVersion: 1, agentCapabilities: {
      mcpCapabilities: { http: true }, sessionCapabilities: { close: {} }
    }, agentInfo: { name: 'cleanup-fixture', version: '1' } }; break;
    case 'session/new': result = { sessionId: 'cleanup-session' }; break;
    case 'session/prompt':
      if (process.env.FIXTURE_FAIL_PROMPT === '1') {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: '${PRIMARY}' } });
        return;
      }
      result = { stopReason: 'end_turn' }; break;
    case 'session/cancel': return;
  }
  if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result });
});
`;

describe("fail-closed sandbox MCP cleanup acceptance (immutable test-only handoff)", () => {
  let root: string;
  let localCwd: string;
  let remoteCwd: string;
  let host: ReturnType<typeof createServer>;
  let hostUrl: string;
  let forwards: number;
  let logs: string[];
  let handles: Bridge[];
  let scrubFault: "none" | "first-rm" | "throw";
  let failQueueReadiness: boolean;
  let scrubAttempts: number;
  let rmTrace: string;
  let queueIdentity:
    | { baseUrl: string; token: string; pid: number }
    | undefined;
  let runner: CommandManagedRuntimeRunner;
  let peers: Duplex[];
  let http2Client: ClientHttp2Session | undefined;

  const runtimeRoot = (key = "fixture") =>
    path.join(remoteCwd, ".paperclip-runtime", key);

  async function runShell(input: RunInput) {
    return new Promise<
      Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>
    >((resolve, reject) => {
      const startedAt = new Date().toISOString();
      const child = spawn(input.command, input.args ?? [], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env, BASH_ENV: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
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
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "mcp-cleanup-",
      ),
    );
    localCwd = path.join(root, "workspace");
    remoteCwd = path.join(root, "remote");
    rmTrace = path.join(root, "rm-trace");
    await mkdir(localCwd);
    await mkdir(remoteCwd);
    await writeFile(path.join(localCwd, "fixture-acp.mjs"), AGENT);
    logs = [];
    handles = [];
    peers = [];
    forwards = 0;
    scrubAttempts = 0;
    scrubFault = "none";
    failQueueReadiness = false;
    queueIdentity = undefined;
    http2Client = undefined;
    host = createServer((_req, res) => {
      forwards++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const address = requireValue(host.address());
    if (typeof address === "string")
      throw new Error("missing loopback address");
    hostUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    vi.stubEnv("HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_API_URL", hostUrl);
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "127.0.0.1");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", String(address.port));
    vi.stubEnv("CODEX_HOME", path.join(root, "codex-home"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-home"));
    await mkdir(path.join(root, "codex-home"));
    await mkdir(path.join(root, "claude-home"));
    await writeFile(
      path.join(root, "codex-home", "auth.json"),
      '{"OPENAI_API_KEY":"synthetic-only"}',
    );
    runner = {
      execute: async (input) => {
        const script = input.args?.at(-1) ?? "";
        // Fault at the provider's shell boundary, not inside scrubMcpAssets.
        const isScrub =
          script.includes("/mcp-config") &&
          /\brm\s/.test(script) &&
          !/\b(?:tar|mkdir|base64)\s/.test(script);
        if (isScrub) {
          scrubAttempts++;
          if (scrubFault === "throw") throw new Error(SCRUB);
          if (scrubFault === "first-rm") {
            const prefix = `rm() {
  for arg do
    case "$arg" in
      */mcp-config) printf 'config-denied\\n' >> ${JSON.stringify(rmTrace)}; return 73 ;;
    esac
  done
  printf 'remaining-delete\\n' >> ${JSON.stringify(rmTrace)}
  command rm "$@"
}\n`;
            return runShell({ ...input, args: ["-c", prefix + script] });
          }
        }
        const token = input.env?.PAPERCLIP_BRIDGE_TOKEN;
        if (token && script.includes("nohup")) {
          queueIdentity = { baseUrl: "", token, pid: 0 };
        }
        const result = await runShell(input);
        if (
          script.includes("Timed out waiting for bridge readiness.") &&
          result.exitCode === 0
        ) {
          const ready = JSON.parse(result.stdout) as {
            baseUrl: string;
            pid: number;
          };
          queueIdentity = {
            ...ready,
            token: requireValue(queueIdentity).token,
          };
          if (failQueueReadiness) throw new Error(STARTUP);
        }
        return result;
      },
    };
    const actual = await vi.importActual<
      typeof import("@paperclipai/adapter-utils/execution-target")
    >("@paperclipai/adapter-utils/execution-target");
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementation(
      async (input) => {
        const handle =
          await actual.startAdapterExecutionTargetPaperclipBridge(input);
        if (handle) handles.push(handle);
        return handle;
      },
    );
  });

  afterEach(async () => {
    // Test-owned emergency cleanup is deliberately AFTER assertions: never let
    // a leaked pre-handle resource make the acceptance checks pass accidentally.
    scrubFault = "none";
    for (const handle of handles) await handle.stop().catch(() => {});
    http2Client?.destroy();
    for (const peer of peers) peer.destroy();
    if (queueIdentity?.pid) {
      try {
        process.kill(queueIdentity.pid, "SIGKILL");
      } catch {}
    }
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      host.close((error) => (error ? reject(error) : resolve())),
    );
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  function target() {
    return {
      kind: "remote" as const,
      transport: "sandbox" as const,
      providerKey: "fixture",
      remoteCwd,
      streamRunLogs: false,
      shellCommand: "sh" as const,
      timeoutMs: 15_000,
      runner,
    };
  }

  const onLog: AdapterExecutionContext["onLog"] = async (_stream, text) => {
    logs.push(text);
  };

  async function seedAssets(key = "fixture") {
    const dir = runtimeRoot(key);
    await mkdir(path.join(dir, "mcp-config"), { recursive: true });
    await writeFile(
      path.join(dir, "mcp-config", "stale.json"),
      "synthetic-stale-credential",
    );
    await writeFile(
      path.join(dir, "mcp-config-upload.tar"),
      "synthetic-stale-archive",
    );
    await writeFile(
      path.join(dir, "mcp-config-upload.tar.part"),
      "synthetic-stale-part",
    );
    await writeFile(path.join(dir, "keep.txt"), "unrelated-runtime-state");
    return dir;
  }

  async function startBridge(
    extra: Partial<
      Parameters<typeof startAdapterExecutionTargetPaperclipBridge>[0]
    > = {},
  ) {
    return requireValue(
      await startAdapterExecutionTargetPaperclipBridge({
        runId: "cleanup-fixture-run",
        adapterKey: "fixture",
        target: target(),
        runtimeRootDir: runtimeRoot(),
        hostApiUrl: hostUrl,
        hostApiToken: "synthetic-host-token",
        mcpServers: [
          {
            name: "fixture",
            connectionId: "fixture-projects",
            url: `${hostUrl}/api/mcp/project-tools`,
            token: "synthetic-mcp-token",
          },
        ],
        onLog,
        ...extra,
      }),
    );
  }

  async function request(bridge: Bridge) {
    const response = await fetch(
      `${bridge.env.PAPERCLIP_API_URL}/api/agents/me`,
      {
        headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}` },
        signal: AbortSignal.timeout(800),
      },
    );
    await response.arrayBuffer();
    return response.status;
  }

  async function assertRevoked(bridge: Bridge, before: number) {
    const outcome = await observe(request(bridge));
    expect
      .soft(
        outcome.value,
        "retained bearer still authorizes after failed cleanup",
      )
      .not.toBe(200);
    expect
      .soft(forwards, "revoked bridge still forwarded to host")
      .toBe(before);
  }

  it("rejects a first mcp-config rm failure even when the following archive rm succeeds", async () => {
    const dir = await seedAssets();
    const bridge = await startBridge();
    expect(await request(bridge)).toBe(200);
    scrubFault = "first-rm";
    const outcome = await observe(bridge.stop());
    expect
      .soft(
        outcome.error,
        "first rm failure was masked by the last command's exit status",
      )
      .toBeDefined();
    expect(
      await readFile(path.join(dir, "mcp-config", "stale.json"), "utf8"),
    ).toBe("synthetic-stale-credential");
    expect(await exists(path.join(dir, "mcp-config-upload.tar"))).toBe(false);
    expect(await exists(path.join(dir, "mcp-config-upload.tar.part"))).toBe(
      false,
    );
    expect(await readFile(rmTrace, "utf8")).toContain("config-denied");
    expect(await readFile(rmTrace, "utf8")).toContain("remaining-delete");
    expect(await readFile(path.join(dir, "keep.txt"), "utf8")).toBe(
      "unrelated-runtime-state",
    );
    await assertRevoked(bridge, 1);
  });

  it("control: successful stop removes only MCP assets and revokes the copied bearer", async () => {
    const dir = await seedAssets();
    const bridge = await startBridge();
    expect(await request(bridge)).toBe(200);
    await bridge.stop();
    expect(await exists(path.join(dir, "mcp-config"))).toBe(false);
    expect(await exists(path.join(dir, "mcp-config-upload.tar.part"))).toBe(
      false,
    );
    expect(await readFile(path.join(dir, "keep.txt"), "utf8")).toBe(
      "unrelated-runtime-state",
    );
    await assertRevoked(bridge, 1);
  });

  it("control: an unambiguous scrub rejection is fatal but forwarding is already revoked", async () => {
    await seedAssets();
    const bridge = await startBridge();
    expect(await request(bridge)).toBe(200);
    scrubFault = "throw";
    const outcome = await observe(bridge.stop());
    expect(evidence(outcome, logs)).toContain(SCRUB);
    await assertRevoked(bridge, 1);
  });

  it("cleans stale MCP files and closes the queue listener when readiness fails before a handle returns", async () => {
    const dir = await seedAssets();
    failQueueReadiness = true;
    const outcome = await observe(startBridge());
    expect(evidence(outcome, logs)).toContain(STARTUP);
    expect(handles).toHaveLength(0);
    expect
      .soft(scrubAttempts, "pre-handle failure never attempted remote scrub")
      .toBeGreaterThan(0);
    expect.soft(await exists(path.join(dir, "mcp-config"))).toBe(false);
    expect
      .soft(await exists(path.join(dir, "mcp-config-upload.tar.part")))
      .toBe(false);
    expect(await readFile(path.join(dir, "keep.txt"), "utf8")).toBe(
      "unrelated-runtime-state",
    );
    const port = Number(new URL(requireValue(queueIdentity).baseUrl).port);
    const listening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(800, () => {
        socket.destroy();
        resolve(false);
      });
    });
    expect
      .soft(listening, "partially started generated queue listener leaked")
      .toBe(false);
    expect(forwards).toBe(0);
  });

  it("retains both queue startup and scrub failures instead of silently settling cleanup", async () => {
    await seedAssets();
    failQueueReadiness = true;
    scrubFault = "throw";
    const outcome = await observe(startBridge());
    const diagnostic = evidence(outcome, logs);
    expect.soft(diagnostic).toContain(STARTUP);
    expect.soft(diagnostic).toContain(SCRUB);
    expect.soft(scrubAttempts).toBeGreaterThan(0);
    expect(handles).toHaveLength(0);
    expect(forwards).toBe(0);
  });

  for (const failScrub of [false, true]) {
    it(`managed runtime retains restore failure and attempts later assets (scrub fault: ${failScrub})`, async () => {
      const assetsDir = path.join(root, "asset-source");
      await mkdir(assetsDir);
      await writeFile(path.join(assetsDir, "fixture.txt"), "fixture-asset");
      const prepared = await prepareCommandManagedRuntime({
        runner,
        spec: { remoteCwd, shellCommand: "sh", timeoutMs: 15_000 },
        adapterKey: "restore-fixture",
        workspaceLocalDir: localCwd,
        assets: [
          {
            key: "first",
            localDir: assetsDir,
            restore: async () => {
              throw new Error(PRIMARY);
            },
          },
          {
            key: "second",
            localDir: assetsDir,
            restore: async () => {
              await writeFile(
                path.join(root, "second-restore-ran"),
                "remaining-asset-restored",
              );
            },
          },
        ],
      });
      scrubFault = failScrub ? "throw" : "none";
      const outcome = await observe(prepared.restoreWorkspace());
      expect.soft(evidence(outcome, logs)).toContain(PRIMARY);
      if (failScrub) expect.soft(evidence(outcome, logs)).toContain(SCRUB);
      expect(outcome.error).toBeDefined();
      expect(await exists(path.join(root, "second-restore-ran"))).toBe(true);
      expect(scrubAttempts).toBeGreaterThan(0);
    });
  }

  function context(adapterType: string): AdapterExecutionContext {
    return {
      runId: "cleanup-fixture-run",
      agent: {
        id: "fixture-agent",
        companyId: "fixture-company",
        name: "Fixture",
        adapterType,
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "fixture-cli",
        timeoutSec: 15,
        paperclipRuntimeSkills: [],
        env: { OPENAI_API_KEY: "synthetic-only" },
      },
      context: {
        paperclipWorkspace: { cwd: localCwd, source: "project_primary" },
      },
      authToken: "synthetic-host-token",
      runtimeMcp: {
        getServers: () => [
          {
            name: "fixture",
            connectionId: "fixture-projects",
            url: `${hostUrl}/api/mcp/project-tools`,
            token: "synthetic-mcp-token",
          },
        ],
      },
      executionTarget: target(),
      onLog,
    };
  }

  for (const adapter of ["claude", "codex"]) {
    it(`${adapter} CLI preserves execution plus scrub errors and still copies workspace changes back`, async () => {
      // Dynamic test import keeps adapter-utils' production dependency graph
      // acyclic; this acceptance file deliberately spans the two consumers.
      const entry = fileURLToPath(
        new URL(
          `../../adapters/${adapter}-local/src/server/execute.ts`,
          import.meta.url,
        ),
      );
      const cli = await vi.importActual<{
        execute: (
          ctx: AdapterExecutionContext,
        ) => Promise<AdapterExecutionResult>;
      }>(entry);
      vi.mocked(runAdapterExecutionTargetProcess).mockImplementation(
        async (_runId, _command, args) => {
          if (args.includes("--version"))
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "2.1.280",
              stderr: "",
              pid: null,
              startedAt: new Date().toISOString(),
            };
          await writeFile(
            path.join(remoteCwd, "provider-edit.txt"),
            "preserve-even-on-failure",
          );
          scrubFault = "throw";
          throw new Error(PRIMARY);
        },
      );
      const outcome = await observe(cli.execute(context(`${adapter}_local`)));
      const diagnostic = evidence(outcome, logs);
      expect.soft(diagnostic).toContain(PRIMARY);
      expect.soft(diagnostic).toContain(SCRUB);
      expect
        .soft(
          failed(outcome),
          "cleanup failure must not produce a successful CLI verdict",
        )
        .toBe(true);
      expect
        .soft(
          await exists(path.join(localCwd, "provider-edit.txt")),
          "remaining workspace copy-back was skipped",
        )
        .toBe(true);
      const bridge = requireValue(handles[0]);
      await assertRevoked(bridge, forwards);
    }, 30_000);
  }

  async function invokeAcp(failure: "construction" | "prompt" | "none") {
    await writeFile(
      path.join(root, "staged-owned"),
      "owned-temporary-resource",
    );
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      prepareRemoteManagedHome: async ({ stage }) => ({
        stagedRuntime: await stage([]),
        teardown: async () => {
          await writeFile(
            path.join(root, "copy-back-ran"),
            "remaining-cleanup-attempted",
          );
          return { ok: true };
        },
        disposeStaged: async () => {
          await rm(path.join(root, "staged-owned"), { force: true });
        },
      }),
      createRuntime: (options) => {
        if (failure === "construction") throw new Error(PRIMARY);
        return createAcpRuntime(options);
      },
    });
    const ctx = context("acpx");
    ctx.config = {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath)} ./fixture-acp.mjs`,
      cwd: localCwd,
      stateDir: path.join(root, "state"),
      mode: "persistent",
      timeoutSec: 15,
      env: { FIXTURE_FAIL_PROMPT: failure === "prompt" ? "1" : "0" },
    };
    return execute(ctx);
  }

  for (const failure of ["construction", "prompt"] as const) {
    it(`ACP ${failure} failure preserves scrub diagnostics and revokes transport`, async () => {
      scrubFault = "throw";
      const outcome = await observe(invokeAcp(failure));
      const diagnostic = evidence(outcome, logs);
      expect.soft(diagnostic).toContain(PRIMARY);
      expect
        .soft(
          failed(outcome),
          "provider plus cleanup failure must not be successful",
        )
        .toBe(true);
      expect
        .soft(diagnostic, "ACPX must not silently discard rejected cleanup")
        .toContain(SCRUB);
      expect.soft(scrubAttempts).toBeGreaterThan(0);
      expect
        .soft(
          await exists(path.join(root, "copy-back-ran")),
          "remaining ACP copy-back was skipped",
        )
        .toBe(true);
      expect
        .soft(
          await exists(path.join(root, "staged-owned")),
          "failed ACP run leaked its disposable staged resource",
        )
        .toBe(false);
      await assertRevoked(requireValue(handles[0]), forwards);
    }, 30_000);
  }

  it("ACP cannot report a successful turn when MCP scrub fails during settlement", async () => {
    scrubFault = "throw";
    const outcome = await observe(invokeAcp("none"));
    expect
      .soft(
        failed(outcome),
        "successful turn concealed failed credential cleanup",
      )
      .toBe(true);
    expect.soft(evidence(outcome, logs)).toContain(SCRUB);
    await assertRevoked(requireValue(handles[0]), forwards);
  }, 30_000);

  it("control: real ACP prompt and settlement succeed without a scrub fault", async () => {
    const outcome = await observe(invokeAcp("none"));
    expect(outcome.error, evidence(outcome, logs)).toBeUndefined();
    expect((outcome.value as AdapterExecutionResult).exitCode).toBe(0);
    expect(scrubAttempts).toBeGreaterThan(0);
    await assertRevoked(requireValue(handles[0]), forwards);
  }, 30_000);

  it("revokes a bound HTTP2 channel and scrubs stale files if startup fails before its handle returns", async () => {
    const dir = await seedAssets();
    let bridgeToken = "";
    runner.openDuplexChannel = async ({
      command,
    }): Promise<CommandManagedDuplexChannel> => {
      const launch = command.join(" ");
      const nonce = requireValue(
        /PAPERCLIP_BRIDGE_NONCE='([^']*)'/.exec(launch)?.[1],
      );
      bridgeToken = requireValue(
        /PAPERCLIP_BRIDGE_TOKEN='([^']*)'/.exec(launch)?.[1],
      );
      const [hostSide, sandboxSide] = duplexPair();
      peers.push(hostSide, sandboxSide);
      const dataListeners: Array<(data: Uint8Array) => void> = [];
      hostSide.on("error", () => {});
      sandboxSide.on("error", () => {});
      hostSide.on("data", (data: Buffer) => {
        for (const listener of dataListeners) listener(data);
      });
      setImmediate(() => {
        sandboxSide.write(
          `${JSON.stringify({ version: 2, type: "ready", nonce })}\n`,
        );
        http2Client = connect("http://fixture.invalid", {
          createConnection: () => sandboxSide,
        });
        http2Client.on("error", () => {});
      });
      return {
        write: (data) => {
          hostSide.write(data);
        },
        onData: (listener) => {
          dataListeners.push(listener);
        },
        onExit: (listener) => {
          hostSide.on("end", () => listener({ exitCode: 0 }));
        },
        stop: () => {
          hostSide.destroy();
        },
        close: async () => {
          hostSide.end();
        },
      };
    };
    const http2Request = async () =>
      new Promise<number>((resolve, reject) => {
        const client = requireValue(http2Client);
        const req = client.request({
          ":method": "GET",
          ":path": "/api/agents/me",
          authorization: `Bearer ${bridgeToken}`,
        });
        const timer = setTimeout(() => {
          req.close();
          reject(new Error("fixture request timeout"));
        }, 800);
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
    const outcome = await observe(
      startBridge({
        target: {
          ...target(),
          effectiveCapabilities: {
            reusableLeases: false,
            nativeSyncIn: false,
            nativeSyncOut: false,
            persistentProcessSessions: false,
            independentControlCommands: false,
            incrementalSessionOutput: false,
            concurrentSyncOperations: false,
            duplexCommandStream: true,
            runnerWebSocketIngress: false,
          },
        },
        enableSandboxDuplexBridge: true,
        onLog: async (stream, text) => {
          await onLog(stream, text);
          if (text.includes("HTTP/2 transport ready")) {
            expect(await http2Request()).toBe(200);
            throw new Error(STARTUP);
          }
        },
      }),
    );
    expect(evidence(outcome, logs)).toContain(STARTUP);
    expect(handles).toHaveLength(0);
    expect
      .soft(scrubAttempts, "HTTP2 startup abandonment omitted MCP scrub")
      .toBeGreaterThan(0);
    expect.soft(await exists(path.join(dir, "mcp-config"))).toBe(false);
    expect
      .soft(await exists(path.join(dir, "mcp-config-upload.tar.part")))
      .toBe(false);
    expect(await readFile(path.join(dir, "keep.txt"), "utf8")).toBe(
      "unrelated-runtime-state",
    );
    const after = await observe(http2Request());
    expect
      .soft(after.value, "failed startup left an authorizing HTTP2 channel")
      .not.toBe(200);
    expect.soft(forwards).toBe(1);
  }, 15_000);
});
