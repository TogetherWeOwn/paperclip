import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
} from "@paperclipai/adapter-utils/execution-target";
import { type AcpRuntimeOptions, createAcpRuntime } from "acpx/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "../command-managed-runtime.js";
import type { AdapterExecutionResult } from "../types.js";

// Record real bridge handles, not substitutes. Only provider fault injection
// below replaces an external operation. ACPX, JSON-RPC, staging, shell/tar,
// callback queue and host forwarding all execute their production code.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@paperclipai/adapter-utils/execution-target")
    >();
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge: vi.fn(
      actual.startAdapterExecutionTargetPaperclipBridge,
    ),
    startAdapterExecutionTargetProcessSessionBridge: vi.fn(
      actual.startAdapterExecutionTargetProcessSessionBridge,
    ),
  };
});

import { createAcpxEngineExecutor } from "./execute.js";

const PROJECTS = "/api/mcp/project-tools";
const CONNECTIONS = "/mcp/runtime-tools";
const PLUGIN = `/mcp/gateways/gw_${"a".repeat(32)}`;
const BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/list",
  params: {},
});
const SYNTHETIC_HOST_TOKENS = [
  "fixture-host-run-a",
  "fixture-host-connections-a",
  "fixture-host-plugin-a",
];
type HttpMcp = {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
};
type Observation = {
  method: string;
  params: { sessionId?: string; cwd: string; mcpServers: HttpMcp[] };
  env: { apiUrl: string; apiKey: string; runId: string };
};
type Bridge = NonNullable<
  Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>>
>;
type HostCall = { url: string; headers: IncomingHttpHeaders; body: string };

// A synthetic HTTP-capable ACP provider. It records the actual session/new and
// session/load wire payload, so runtime-options-only rewrites cannot pass.
const AGENT = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  let request;
  try {
    request = JSON.parse(line);
    let result;
    switch (request.method) {
      case 'initialize':
        result = { protocolVersion: 1, agentCapabilities: {
          loadSession: true, mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { close: {} }
        }, agentInfo: { name: 'synthetic-mcp-acceptance', version: '1.0.0' } };
        break;
      case 'session/new':
      case 'session/load':
        appendFileSync(process.env.FIXTURE_OBSERVATIONS, JSON.stringify({
          method: request.method, params: request.params,
          env: { apiUrl: process.env.PAPERCLIP_API_URL, apiKey: process.env.PAPERCLIP_API_KEY,
            runId: process.env.PAPERCLIP_RUN_ID }
        }) + '\\n');
        result = request.method === 'session/new' ? { sessionId: 'fixture-provider-session' } : {};
        break;
      case 'session/prompt':
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture complete' } }
        } });
        result = { stopReason: 'end_turn' };
        break;
      case 'session/close':
      case 'session/set_mode':
      case 'session/set_config_option': result = {}; break;
      case 'session/cancel': return;
      default: throw new Error('Unexpected ACP method: ' + request.method);
    }
    if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id,
      error: { code: -32603, message: String(error.message) } });
  }
});
`;

function localRunner(): CommandManagedRuntimeRunner {
  return {
    execute: async (input) =>
      new Promise((resolve, reject) => {
        const startedAt = new Date().toISOString();
        const child = spawn(input.command, input.args ?? [], {
          cwd: input.cwd,
          env: { ...process.env, ...input.env, BASH_ENV: "" },
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

function bearer(server: HttpMcp): string {
  return (
    server.headers.find(
      (header) => header.name.toLowerCase() === "authorization",
    )?.value ?? ""
  );
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function fixtureValue<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("missing acceptance fixture value");
  return value;
}

describe("shared remote ACP MCP bridge acceptance (failing-first)", () => {
  let root: string;
  let localCwd: string;
  let remoteCwd: string;
  let observationsFile: string;
  let host: ReturnType<typeof createServer>;
  let hostUrl: string;
  let calls: HostCall[];
  let redirectTo: string | undefined;
  let redirectStatus: number;
  let activeTokens: string[];
  let activeRun: string;
  let bridges: Array<{ handle: Bridge; runtimeRoot: string }>;
  let runtimeOptions: AcpRuntimeOptions[];
  let duringSession:
    | ((observation: Observation, bridge: Bridge) => Promise<void>)
    | undefined;
  let failRuntimeConstruction: boolean;
  let configuredBudget: number;
  let beforeHostLaunch: ((bridge: Bridge) => Promise<void>) | undefined;
  let logs: string[];
  let execute: ReturnType<typeof createAcpxEngineExecutor>;
  const servers = () =>
    [PROJECTS, CONNECTIONS, PLUGIN].map((endpoint, index) => ({
      name: fixtureValue(
        ["Paperclip projects", "Paperclip connections", "Managed plugin"][
          index
        ],
      ),
      url: `${hostUrl}${endpoint}`,
      token: fixtureValue(activeTokens[index]),
      connectionId: fixtureValue(["projects", "connections", "plugin"][index]),
    }));

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "acp-mcp-acceptance-",
      ),
    );
    localCwd = path.join(root, "workspace");
    remoteCwd = path.join(root, "remote");
    observationsFile = path.join(root, "observations.jsonl");
    await mkdir(localCwd);
    await mkdir(remoteCwd);
    await writeFile(path.join(localCwd, "fixture-acp.mjs"), AGENT);
    await writeFile(observationsFile, "");
    activeTokens = [...SYNTHETIC_HOST_TOKENS];
    activeRun = "fixture-run-a";
    calls = [];
    bridges = [];
    runtimeOptions = [];
    logs = [];
    redirectTo = undefined;
    redirectStatus = 307;
    duringSession = undefined;
    failRuntimeConstruction = false;
    configuredBudget = 30;
    beforeHostLaunch = undefined;
    host = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      calls.push({
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (redirectTo) {
        res.writeHead(redirectStatus, {
          location: redirectTo,
          "content-type": "application/json",
        });
        res.end("{}");
        return;
      }
      const index = [PROJECTS, CONNECTIONS, PLUGIN].indexOf(req.url ?? "");
      const valid =
        index >= 0 &&
        req.headers.authorization === `Bearer ${activeTokens[index]}` &&
        req.headers["x-paperclip-run-id"] === activeRun;
      res.writeHead(valid ? 200 : 401, {
        "content-type": "application/json",
        "mcp-session-id": "fixture-session-header",
        "mcp-protocol-version": "2025-03-26",
      });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [] } }));
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const address = host.address();
    if (!address || typeof address === "string")
      throw new Error("missing fixture address");
    hostUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "127.0.0.1");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", String(address.port));
    vi.stubEnv("PAPERCLIP_API_URL", hostUrl);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    vi.stubEnv("HOME", path.join(root, "home"));
    const actual = await vi.importActual<
      typeof import("@paperclipai/adapter-utils/execution-target")
    >("@paperclipai/adapter-utils/execution-target");
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementation(
      async (input) => {
        const handle =
          await actual.startAdapterExecutionTargetPaperclipBridge(input);
        if (handle)
          bridges.push({
            handle,
            runtimeRoot: fixtureValue(input.runtimeRootDir),
          });
        if (handle) await beforeHostLaunch?.(handle);
        return handle;
      },
    );
    vi.mocked(
      startAdapterExecutionTargetProcessSessionBridge,
    ).mockImplementation(
      actual.startAdapterExecutionTargetProcessSessionBridge,
    );
    execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: (options) => {
        runtimeOptions.push(options);
        if (failRuntimeConstruction)
          throw new Error("fixture runtime setup failure");
        const runtime = createAcpRuntime(options);
        return new Proxy(runtime, {
          get(target, key) {
            if (key === "ensureSession")
              return async (
                ...args: Parameters<typeof runtime.ensureSession>
              ) => {
                const handle = await runtime.ensureSession(...args);
                const observations = await readObservations();
                const observation = observations.at(-1);
                if (!observation || !bridges.at(-1))
                  throw new Error("missing real ACP/bridge observation");
                await duringSession?.(
                  observation,
                  fixtureValue(bridges.at(-1)).handle,
                );
                return handle;
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
  });

  afterEach(async () => {
    for (const { handle } of bridges) await handle.stop();
    host?.closeAllConnections();
    if (host?.listening)
      await new Promise<void>((resolve, reject) =>
        host.close((error) => (error ? reject(error) : resolve())),
      );
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  async function readObservations(): Promise<Observation[]> {
    return (await readFile(observationsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function invoke(
    previous?: AdapterExecutionResult,
    expectSuccess = true,
  ) {
    const result = await execute({
      runId: activeRun,
      agent: {
        id: "fixture-agent",
        companyId: "fixture-company",
        name: "Fixture",
        adapterType: "acpx",
        adapterConfig: {},
      },
      runtime: {
        sessionId: previous?.sessionId ?? null,
        sessionParams: previous?.sessionParams ?? null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        agent: "custom",
        agentCommand: `${JSON.stringify(process.execPath)} ./fixture-acp.mjs`,
        stateDir: path.join(root, "state"),
        cwd: localCwd,
        mode: "persistent",
        timeoutSec: configuredBudget,
        env: { FIXTURE_OBSERVATIONS: observationsFile },
      },
      context: {},
      authToken: activeTokens[0],
      runtimeMcp: { getServers: servers },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fixture",
        remoteCwd,
        streamRunLogs: false,
        shellCommand: "sh",
        timeoutMs: 30_000,
        runner: localRunner(),
      },
      onLog: async (_stream, text) => {
        logs.push(text);
      },
    });
    if (expectSuccess) expect(result.exitCode, logs.join("")).toBe(0);
    return result;
  }

  async function post(
    bridge: Bridge,
    endpoint: string,
    contentType = "application/json",
  ) {
    return fetch(`${bridge.env.PAPERCLIP_API_URL}${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
        "content-type": contentType,
        accept: "application/json",
        "mcp-session-id": "client-session-header",
        "mcp-protocol-version": "2025-03-26",
        "x-paperclip-run-id": "caller-forged-run",
        cookie: "fixture-cookie=must-not-forward",
      },
      body: BODY,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  }

  function endpoint(server: HttpMcp): string {
    // Use the runtime-delivered path even if the bridge assigns a new opaque
    // path. On RED baseline only the authority is deliberately replaced: this
    // probes the real callback bridge, never the unscoped host URL.
    const url = new URL(server.url);
    return `${url.pathname}${url.search}`;
  }

  it("delivers only bridge credentials to actual remote ACP session/new for every managed server", async () => {
    await invoke();
    const wire = fixtureValue((await readObservations())[0]);
    expect(wire?.method).toBe("session/new");
    expect(wire?.params.cwd).toBe(remoteCwd);
    expect(wire?.params.mcpServers.map((server) => server.name).sort()).toEqual(
      servers()
        .map((server) => server.name)
        .sort(),
    );
    for (const server of wire.params.mcpServers) {
      expect
        .soft(new URL(server.url).origin)
        .toBe(new URL(wire.env.apiUrl).origin);
      expect.soft(bearer(server)).toBe(`Bearer ${wire.env.apiKey}`);
      for (const token of activeTokens)
        expect.soft(JSON.stringify(server)).not.toContain(token);
    }
    expect(runtimeOptions).toHaveLength(1);
    expect(runtimeOptions[0]?.mcpServers).toEqual(wire.params.mcpServers);
  }, 30_000);

  it("resumes via actual ACP session/load with fresh URLs and tokens, not stored session_options or cached credentials", async () => {
    const first = await invoke();
    const retiredWire = fixtureValue((await readObservations())[0]);
    const sessionsDir = path.join(root, "state", "sessions");
    const files = (await readdir(sessionsDir)).filter((file) =>
      file.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
    const recordFile = path.join(sessionsDir, fixtureValue(files[0]));
    const record = JSON.parse(await readFile(recordFile, "utf8")) as Record<
      string,
      unknown
    > & {
      acpx?: { session_options?: Record<string, unknown> };
    };
    // Deliberately seed the legacy/session-options replay path. A fresh runtime
    // options rewrite alone must not leave this credential active on session/load.
    const staleServers = servers().map((server) => ({
      type: "http" as const,
      name: server.name,
      url: `${hostUrl}/stale-session-only`,
      headers: [
        { name: "Authorization", value: "Bearer fixture-stored-stale-token" },
      ],
    }));
    await writeFile(
      recordFile,
      JSON.stringify({
        ...record,
        acpx: {
          ...record.acpx,
          session_options: {
            ...record.acpx?.session_options,
            mcpServers: staleServers,
          },
        },
      }),
    );
    activeRun = "fixture-run-b";
    activeTokens = [
      "fixture-host-run-b",
      "fixture-host-connections-b",
      "fixture-host-plugin-b",
    ];
    duringSession = async (wire, bridge) => {
      // A saved provider session/config is data, not authority for the new epoch.
      for (const server of wire.params.mcpServers) {
        const stale = await fetch(server.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${retiredWire.env.apiKey}`,
            "content-type": "application/json",
          },
          body: BODY,
          signal: AbortSignal.timeout(3_000),
        });
        expect
          .soft([401, 403], "retired bearer accepted by replacement listener")
          .toContain(stale.status);
        await stale.arrayBuffer();
      }
      expect
        .soft(calls, "old-epoch request dispatched under new owner")
        .toHaveLength(0);
      for (const server of wire.params.mcpServers) {
        const response = await post(bridge, endpoint(server));
        expect.soft(response.status, `resumed ${server.name}`).toBe(200);
        await response.arrayBuffer();
      }
      expect.soft(calls).toHaveLength(3);
      for (let index = 0; index < 3; index++) {
        expect
          .soft(calls[index]?.headers.authorization)
          .toBe(`Bearer ${activeTokens[index]}`);
        expect
          .soft(calls[index]?.headers["x-paperclip-run-id"])
          .toBe("fixture-run-b");
      }
    };
    const second = await invoke(first);
    const observations = await readObservations();
    const initial = fixtureValue(observations[0]);
    const resumed = fixtureValue(observations[1]);
    expect(resumed?.method).toBe("session/load");
    expect(resumed?.params.sessionId).toBe(
      initial ? "fixture-provider-session" : "missing-first-session",
    );
    expect(second.sessionId).toBe(first.sessionId);
    expect(bridges).toHaveLength(2);
    expect(runtimeOptions).toHaveLength(2);
    expect
      .soft(JSON.stringify(resumed?.params.mcpServers))
      .not.toContain("fixture-stored-stale-token");
    expect
      .soft(JSON.stringify(resumed?.params.mcpServers))
      .not.toContain("/stale-session-only");
    expect(resumed?.env.apiKey).not.toBe(initial?.env.apiKey);
    expect(resumed?.env.apiUrl).not.toBe(initial?.env.apiUrl);
    for (const server of resumed.params.mcpServers) {
      expect
        .soft(new URL(server.url).origin)
        .toBe(new URL(resumed.env.apiUrl).origin);
      expect.soft(bearer(server)).toBe(`Bearer ${resumed.env.apiKey}`);
      expect
        .soft(bearer(server))
        .not.toBe(
          bearer(
            fixtureValue(
              initial.params.mcpServers.find(
                (entry) => entry.name === server.name,
              ),
            ),
          ),
        );
    }
    for (const token of [...SYNTHETIC_HOST_TOKENS, ...activeTokens]) {
      expect
        .soft(JSON.stringify(resumed.params.mcpServers))
        .not.toContain(token);
    }
  }, 45_000);

  async function prepareSandboxClock() {
    const module = path.join(root, "sandbox-clock.cjs");
    const offset = path.join(root, "sandbox-clock-offset");
    await writeFile(offset, "0");
    await writeFile(
      module,
      `
      const fs = require('node:fs');
      const RealDate = Date;
      const offset = () => Number(fs.readFileSync(${JSON.stringify(offset)}, 'utf8'));
      global.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset()])); }
        static now() { return RealDate.now() + offset(); }
      };
    `,
    );
    vi.stubEnv("NODE_OPTIONS", `--require=${module}`);
    return offset;
  }

  it.each(["new", "load"] as const)(
    "actual ACP session/%s keeps its delivered static headers at +16m and near D, including a rolled-back sandbox clock",
    async (sessionKind) => {
      const previous = sessionKind === "load" ? await invoke() : undefined;
      if (previous) {
        activeRun = "fixture-run-b";
        activeTokens = [
          "fixture-host-run-b",
          "fixture-host-connections-b",
          "fixture-host-plugin-b",
        ];
      }
      configuredBudget = 14_400;
      const issuance = Date.now();
      const sandboxOffset = await prepareSandboxClock();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(issuance);
      let elapsed = 0;
      const mono = process.hrtime.bigint();
      const perf = performance.now();
      // Do not freeze ACPX's session-recovery polling while it loads a record.
      // Bridge issuance is fixed; only request dispatch uses the elapsed clock.
      beforeHostLaunch = async () => {
        vi.useRealTimers();
      };
      const installDispatchClock = () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(issuance);
        vi.spyOn(process.hrtime, "bigint").mockImplementation(
          () => mono + BigInt(elapsed) * 1_000_000n,
        );
        vi.spyOn(performance, "now").mockImplementation(() => perf + elapsed);
      };
      calls = [];
      duringSession = async (wire) => {
        expect(wire.method).toBe(`session/${sessionKind}`);
        installDispatchClock();
        await writeFile(sandboxOffset, "-86400000");
        const cached = structuredClone(wire.params.mcpServers);
        for (const ms of [960_000, 14_399_999]) {
          elapsed = ms;
          vi.setSystemTime(issuance + elapsed);
          for (const server of cached) {
            const response = await fetch(server.url, {
              method: "POST",
              headers: {
                ...Object.fromEntries(
                  server.headers.map((h) => [h.name, h.value]),
                ),
                "content-type": "application/json",
              },
              body: BODY,
              signal: AbortSignal.timeout(3_000),
            });
            expect
              .soft(response.status, `${wire.method} ${server.name} +${ms}ms`)
              .toBe(200);
            await response.arrayBuffer();
          }
        }
        expect.soft(calls).toHaveLength(6);
        expect(wire.params.mcpServers).toEqual(cached);
        for (const call of calls)
          expect.soft(call.headers["x-paperclip-run-id"]).toBe(activeRun);
        for (let i = 0; i < calls.length; i++)
          expect
            .soft(calls[i]?.headers.authorization)
            .toBe(`Bearer ${activeTokens[i % 3]}`);
        // Advance only around bridge dispatch. ACPX's unrelated scheduler and
        // filesystem locks settle on real elapsed time, never a four-hour jump.
        await writeFile(sandboxOffset, "0");
        elapsed = 0;
        vi.setSystemTime(issuance);
        vi.useRealTimers();
        vi.restoreAllMocks();
      };
      await invoke(previous);
    },
    45_000,
  );

  it.each([15_300_000])(
    "actual ACP wire bearer is denied at the immutable outer ceiling +%ims with zero dispatches despite sandbox and host wall rollback",
    async (cutoff) => {
      configuredBudget = 14_400;
      const issuance = Date.now();
      const sandboxOffset = await prepareSandboxClock();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(issuance);
      let elapsed = 0;
      const mono = process.hrtime.bigint();
      const perf = performance.now();
      // Do not freeze ACPX's session-recovery polling while it loads a record.
      // Bridge issuance is fixed; only request dispatch uses the elapsed clock.
      beforeHostLaunch = async () => {
        vi.useRealTimers();
      };
      const installDispatchClock = () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(issuance);
        vi.spyOn(process.hrtime, "bigint").mockImplementation(
          () => mono + BigInt(elapsed) * 1_000_000n,
        );
        vi.spyOn(performance, "now").mockImplementation(() => perf + elapsed);
      };
      duringSession = async (wire, bridge) => {
        installDispatchClock();
        await writeFile(sandboxOffset, "-86400000");
        elapsed = cutoff;
        // Host wall and sandbox wall remain at issuance. Only trusted host
        // monotonic time advances: a sandbox-side expiry check cannot pass this.
        const before = calls.length;
        for (const server of wire.params.mcpServers) {
          const response = await fetch(server.url, {
            method: "POST",
            headers: {
              authorization: bearer(server),
              "content-type": "application/json",
            },
            body: BODY,
            signal: AbortSignal.timeout(3_000),
          });
          expect
            .soft([401, 403], "host elapsed deadline, not sandbox clock")
            .toContain(response.status);
          await response.arrayBuffer();
        }
        expect
          .soft(calls.length - before, "dispatch after immutable cutoff")
          .toBe(0);
        expect
          .soft(
            await exists(fixtureValue(bridge.env.PAPERCLIP_BRIDGE_QUEUE_DIR)),
          )
          .toBe(true);
        await writeFile(sandboxOffset, "0");
        elapsed = 0;
        vi.setSystemTime(issuance);
        vi.useRealTimers();
        vi.restoreAllMocks();
      };
      await invoke(undefined, false);
    },
    30_000,
  );

  it("ACP transport readiness is not authority before host turn launch", async () => {
    beforeHostLaunch = async (bridge) => {
      const response = await fetch(
        `${bridge.env.PAPERCLIP_API_URL}/api/agents/me`,
        {
          headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}` },
          signal: AbortSignal.timeout(3_000),
        },
      );
      expect.soft([401, 403]).toContain(response.status);
      await response.arrayBuffer();
      expect.soft(calls, "pre-activation dispatch").toHaveLength(0);
    };
    await invoke();
  }, 30_000);

  it.each([14_401, -1, Number.POSITIVE_INFINITY, Number.NaN])(
    "ACP refuses unsupported budget %s before any session/new or prompt",
    async (budget) => {
      configuredBudget = budget;
      const outcome = await invoke(undefined, false).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      expect
        .soft(
          (await readObservations()).map((wire) => wire.method),
          "unsupported lifetime launched the ACP provider session",
        )
        .toEqual([]);
      expect.soft(calls).toHaveLength(0);
      const diagnostic = "error" in outcome ? outcome.error : outcome.value;
      const fields =
        diagnostic && typeof diagnostic === "object"
          ? (diagnostic as Record<string, unknown>)
          : {};
      expect
        .soft(
          fields.errorCode ?? fields.code,
          "stable unsupported-lifetime code",
        )
        .toEqual(expect.any(String));
      expect
        .soft(
          fields.remediation ?? fields.nextAction ?? fields.next_action,
          "actionable lifetime remediation",
        )
        .toEqual(expect.any(String));
    },
    30_000,
  );

  it("registered endpoints preserve their own host token/run and MCP protocol/session headers", async () => {
    duringSession = async (wire, bridge) => {
      expect(wire.params.mcpServers).toHaveLength(3);
      for (const server of wire.params.mcpServers) {
        const response = await post(bridge, endpoint(server));
        expect.soft(response.status, server.name).toBe(200);
        expect
          .soft(response.headers.get("mcp-session-id"))
          .toBe("fixture-session-header");
        expect
          .soft(response.headers.get("mcp-protocol-version"))
          .toBe("2025-03-26");
        await response.arrayBuffer();
      }
      expect.soft(calls).toHaveLength(3);
      for (let index = 0; index < 3; index++) {
        expect
          .soft(calls[index]?.url)
          .toBe([PROJECTS, CONNECTIONS, PLUGIN][index]);
        expect
          .soft(calls[index]?.headers.authorization)
          .toBe(`Bearer ${activeTokens[index]}`);
        expect
          .soft(calls[index]?.headers["x-paperclip-run-id"])
          .toBe(activeRun);
        expect
          .soft(calls[index]?.headers["mcp-session-id"])
          .toBe("client-session-header");
        expect
          .soft(calls[index]?.headers["mcp-protocol-version"])
          .toBe("2025-03-26");
        expect.soft(calls[index]?.headers.cookie).toBeUndefined();
        expect.soft(calls[index]?.body).toBe(BODY);
      }
    };
    await invoke();
  }, 30_000);

  it("refuses unregistered opaque endpoints and raw path/query/authority tricks at the HOST queue boundary", async () => {
    duringSession = async (wire, bridge) => {
      const registered = endpoint(fixtureValue(wire.params.mcpServers[2]));
      const attacks = [
        { path: `/mcp/gateways/gw_${"b".repeat(32)}`, query: "" },
        { path: `${registered}/extra`, query: "" },
        { path: `${registered}%2fextra`, query: "" },
        { path: `${registered}%3fextra`, query: "" },
        { path: `${registered}/../other`, query: "" },
        { path: `/${registered}`, query: "" },
        { path: `${registered}?endpoint=other`, query: "" },
        { path: `${registered}/%2e%2e/other`, query: "" },
        { path: `${registered}%252fextra`, query: "" },
        { path: registered, query: "?endpoint=other" },
        { path: `${hostUrl}${registered}`, query: "" },
        { path: `//127.0.0.1:9${registered}`, query: "" },
        { path: `/\\127.0.0.1:9${registered}`, query: "" },
      ];
      for (const attack of attacks) {
        const id = randomUUID();
        const queue = fixtureValue(bridge.env.PAPERCLIP_BRIDGE_QUEUE_DIR);
        expect(queue).toBeTruthy();
        const destination = path.join(queue, "requests", `${id}.json`);
        await writeFile(
          `${destination}.part`,
          JSON.stringify({
            id,
            method: "POST",
            ...attack,
            headers: { "content-type": "application/json" },
            body: BODY,
            createdAt: new Date().toISOString(),
          }),
        );
        await rename(`${destination}.part`, destination);
        const responseFile = path.join(queue, "responses", `${id}.json`);
        await vi.waitFor(
          async () => expect(await exists(responseFile)).toBe(true),
          { timeout: 5_000 },
        );
        const response = JSON.parse(await readFile(responseFile, "utf8")) as {
          status: number;
        };
        expect
          .soft([400, 403, 404], JSON.stringify(attack))
          .toContain(response.status);
        expect.soft(calls, "denied endpoint sent host credentials").toEqual([]);
      }
    };
    await invoke();
  }, 45_000);

  it.each([301, 302, 303, 307, 308])(
    "refuses a %i redirect from a registered MCP endpoint without forwarding credentials or body",
    async (status) => {
      const foreignCalls: HostCall[] = [];
      const foreign = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        foreignCalls.push({
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((resolve) =>
        foreign.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = foreign.address();
        if (!address || typeof address === "string")
          throw new Error("missing redirect fixture address");
        redirectTo = `http://127.0.0.1:${address.port}/collect`;
        redirectStatus = status;
        duringSession = async (wire, bridge) => {
          const response = await post(
            bridge,
            endpoint(fixtureValue(wire.params.mcpServers[2])),
          );
          await response.arrayBuffer();
          expect
            .soft(
              calls,
              "positive control: registered MCP request must reach pinned host",
            )
            .toHaveLength(1);
          expect.soft(response.status).toBe(502);
          expect.soft(response.headers.get("location")).toBeNull();
          expect.soft(foreignCalls).toEqual([]);
        };
        await invoke();
      } finally {
        foreign.closeAllConnections();
        await new Promise<void>((resolve) => foreign.close(() => resolve()));
      }
    },
    30_000,
  );

  it("keeps the JSON-only write gate on MCP and ordinary API routes", async () => {
    duringSession = async (wire, bridge) => {
      for (const route of [
        endpoint(fixtureValue(wire.params.mcpServers[0])),
        "/api/issues/fixture-issue/comments",
      ]) {
        for (const type of [
          "text/plain",
          "application/x-www-form-urlencoded",
        ]) {
          const response = await post(bridge, route, type);
          await response.arrayBuffer();
          expect.soft([400, 403, 415]).toContain(response.status);
        }
      }
      expect(calls).toEqual([]);
    };
    await invoke();
  }, 30_000);

  async function plantPartialUpload(runtimeRoot: string) {
    await mkdir(path.join(runtimeRoot, "mcp-config"), { recursive: true });
    await writeFile(
      path.join(runtimeRoot, "mcp-config", "partial.json"),
      "synthetic MCP upload",
    );
    for (const suffix of ["", ".part", ".b64"]) {
      await writeFile(
        path.join(runtimeRoot, `mcp-config-upload.tar${suffix}`),
        "synthetic archive fragment",
      );
    }
    await writeFile(
      path.join(runtimeRoot, "unrelated.txt"),
      "preserve unrelated runtime assets",
    );
  }

  async function assertRevokedAndScrubbed() {
    expect(bridges).toHaveLength(1);
    const { handle, runtimeRoot } = fixtureValue(bridges[0]);
    // Check before fixture cleanup: execute must not return a live capability or
    // leave provider-side MCP artifacts after abandoning setup.
    let responseStatus: number | null = null;
    try {
      const response = await post(handle, "/api/issues/fixture-issue/comments");
      responseStatus = response.status;
      await response.arrayBuffer();
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
    }
    if (responseStatus !== null)
      expect.soft([401, 403]).toContain(responseStatus);
    expect.soft(calls).toEqual([]);
    expect.soft(await exists(path.join(runtimeRoot, "mcp-config"))).toBe(false);
    for (const suffix of ["", ".part", ".b64"]) {
      expect
        .soft(
          await exists(
            path.join(runtimeRoot, `mcp-config-upload.tar${suffix}`),
          ),
        )
        .toBe(false);
    }
    expect
      .soft(await readFile(path.join(runtimeRoot, "unrelated.txt"), "utf8"))
      .toBe("preserve unrelated runtime assets");
  }

  it("revokes the bridge and scrubs MCP remnants before returning a runtime setup failure", async () => {
    const start = fixtureValue(
      vi
        .mocked(startAdapterExecutionTargetPaperclipBridge)
        .getMockImplementation(),
    );
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementation(
      async (input) => {
        const bridge = await start(input);
        await plantPartialUpload(fixtureValue(input.runtimeRootDir));
        return bridge;
      },
    );
    failRuntimeConstruction = true;
    await expect(invoke()).rejects.toThrow("fixture runtime setup failure");
    await assertRevokedAndScrubbed();
  }, 30_000);

  it("revokes the already-started bridge and scrubs a partial MCP upload when concurrent transport setup fails", async () => {
    const start = fixtureValue(
      vi
        .mocked(startAdapterExecutionTargetPaperclipBridge)
        .getMockImplementation(),
    );
    let ready!: () => void;
    const bridgeReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementation(
      async (input) => {
        const bridge = await start(input);
        ready();
        return bridge;
      },
    );
    vi.mocked(
      startAdapterExecutionTargetProcessSessionBridge,
    ).mockImplementation(async () => {
      await bridgeReady;
      await plantPartialUpload(fixtureValue(bridges[0]).runtimeRoot);
      throw new Error("fixture partial MCP sync failed");
    });
    await expect(invoke()).rejects.toThrow("fixture partial MCP sync failed");
    await assertRevokedAndScrubbed();
  }, 30_000);
});
