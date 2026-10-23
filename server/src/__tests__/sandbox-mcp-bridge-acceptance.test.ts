import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  agents,
  heartbeatRuns,
  toolMcpGateways,
  toolMcpGatewayTokens,
} from "@paperclipai/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processBoundary = vi.hoisted(() => ({
  run: vi.fn<(...args: unknown[]) => Promise<RunProcessResult>>(),
  bridgeReady:
    vi.fn<
      (bridge: {
        env: Record<string, string>;
        mcpServers?: Array<{ name: string; url: string; token: string }>;
      }) => Promise<void>
    >(),
}));

// Only the provider CLI is replaced. Asset generation, archives, bridge, HTTP
// forwarding and host authentication execute their production code.
vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<
    typeof import("@paperclipai/adapter-utils/execution-target")
  >("@paperclipai/adapter-utils/execution-target");
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: async () => {},
    resolveAdapterExecutionTargetCommandForLogs: async (command: string) =>
      command,
    runAdapterExecutionTargetProcess: processBoundary.run,
    startAdapterExecutionTargetPaperclipBridge: async (
      input: Parameters<
        typeof actual.startAdapterExecutionTargetPaperclipBridge
      >[0],
    ) => {
      const bridge =
        await actual.startAdapterExecutionTargetPaperclipBridge(input);
      if (bridge) await processBoundary.bridgeReady(bridge);
      return bridge;
    },
  };
});

import { resetClaudeCliCapabilitiesCacheForTests } from "../../../packages/adapters/claude-local/src/server/cli-capabilities.js";
import { execute as executeClaude } from "../../../packages/adapters/claude-local/src/server/execute.js";
import { execute as executeCodex } from "../../../packages/adapters/codex-local/src/server/execute.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createToolGatewayService } from "../services/tool-gateway.js";

const PROJECTS = "/api/mcp/project-tools";
const CONNECTIONS = "/mcp/runtime-tools";
const PLUGIN = `/mcp/gateways/gw_${"a".repeat(32)}`;
const CONNECTION_TOKEN = "fixture-connections-host-bearer";
const PLUGIN_TOKEN = "fixture-managed-plugin-host-bearer";

type Entry = { name: string; url: string; token: string; connectionId: string };
type Observed = { entries: Entry[]; serialized: string; runtimeRoot: string };

function exited(): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderr: "",
    pid: null,
    startedAt: new Date().toISOString(),
    stdout: JSON.stringify({
      type: "result",
      result: "fixture",
      session_id: "fixture-session",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  };
}

function collectBearers(
  value: unknown,
  location = "root",
): Array<{ location: string; token: string }> {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (key.toLowerCase() === "authorization" && typeof child === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(child);
      expect(
        match,
        `non-bearer Authorization at ${location}.${key}`,
      ).not.toBeNull();
      return [{ location: `${location}.${key}`, token: match?.[1] ?? "" }];
    }
    return collectBearers(child, `${location}.${key}`);
  });
}

async function allFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? allFiles(file) : Promise.resolve([file]);
      }),
    )
  ).flat();
}

// Real shell/tar/base64 behavior, but only within disposable local directories.
function localRunner(
  bin: string,
  beforeCommand?: (
    input: Parameters<CommandManagedRuntimeRunner["execute"]>[0],
  ) => Promise<void>,
): CommandManagedRuntimeRunner {
  return {
    async execute(input) {
      await beforeCommand?.(input);
      const startedAt = new Date().toISOString();
      return new Promise((resolve, reject) => {
        const child = spawn(input.command, input.args ?? [], {
          cwd: input.cwd,
          env: {
            ...process.env,
            ...input.env,
            PATH: `${bin}:${process.env.PATH}`,
            BASH_ENV: "",
          },
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
            pid: child.pid ?? null,
            startedAt,
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          }),
        );
        child.stdin.on("error", () => {});
        child.stdin.end(input.stdin ?? "");
      });
    },
  };
}

// Same in-memory Drizzle boundary as agent-auth-middleware.test.ts; no DB starts.
function authDb(agentId: string, companyId: string, runId: string) {
  const rows = (table: unknown) =>
    table === agents
      ? [{ id: agentId, companyId, status: "active" }]
      : table === heartbeatRuns
        ? [
            {
              id: runId,
              companyId,
              agentId,
              status: "running",
              responsibleUserId: "fixture-user",
            },
          ]
        : [];
  return {
    select: () => ({
      from: (table: unknown) => ({ where: () => Promise.resolve(rows(table)) }),
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
    insert: () => ({ values: async () => [] }),
  };
}

// Gateway auth must validate its own token; the actor middleware deliberately
// does not authenticate the public MCP gateway path.
function gatewayDb(companyId: string, agentId: string) {
  const tokenHash = createHash("sha256").update(PLUGIN_TOKEN).digest("hex");
  const gateway = {
    id: randomUUID(),
    companyId,
    agentId,
    gatewayPublicId: `gw_${"a".repeat(32)}`,
    status: "active",
    name: "Fixture managed plugin",
    issueId: null,
    projectId: null,
    profileId: null,
  };
  const token = {
    id: randomUUID(),
    gatewayId: gateway.id,
    companyId,
    tokenHash,
    subjectType: "agent",
    subjectId: agentId,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    allowedActions: ["tools/list"],
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        let selected: unknown[] = [];
        const chain = {
          innerJoin: () => chain,
          where: (condition: SQL) => {
            const params = new PgDialect().sqlToQuery(condition).params;
            selected =
              table === toolMcpGatewayTokens
                ? params.includes(tokenHash)
                  ? [{ gateway, token }]
                  : []
                : table === toolMcpGateways
                  ? [gateway]
                  : [];
            return chain;
          },
          limit: async () => selected,
        };
        return chain;
      },
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
    delete: () => ({ where: async () => [] }),
    execute: async () => [{ count: 1 }],
  };
}

describe("sandbox MCP credential acceptance (frozen failing-first)", () => {
  let root: string;
  let bin: string;
  let hostUrl: string;
  let hostJwt: string;
  let agentId: string;
  let companyId: string;
  let runId: string;
  let host: ReturnType<typeof createServer>;
  let observed: Observed;
  let runnerCommandHook:
    | ((
        input: Parameters<CommandManagedRuntimeRunner["execute"]>[0],
      ) => Promise<void>)
    | undefined;
  let holdUpstream: boolean;
  let upstreamClosed: boolean;
  let hostCalls: Array<{
    path: string;
    authorization: string | undefined;
    runId: string | undefined;
  }>;

  beforeEach(async () => {
    processBoundary.run.mockReset();
    processBoundary.bridgeReady.mockReset();
    root = await mkdtemp(path.join(os.tmpdir(), "sandbox-mcp-acceptance-"));
    bin = path.join(root, "bin");
    await mkdir(bin);
    for (const name of ["claude", "codex"]) {
      await writeFile(
        path.join(bin, name),
        "#!/bin/sh\nprintf 'fixture CLI\\n'\n",
        { mode: 0o700 },
      );
    }
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    vi.stubEnv("HOME", path.join(root, "home"));
    vi.stubEnv(
      "PAPERCLIP_AGENT_JWT_SECRET",
      "sandbox-mcp-synthetic-signing-secret",
    );
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    agentId = randomUUID();
    companyId = randomUUID();
    runId = randomUUID();
    hostJwt =
      createLocalAgentJwt(
        agentId,
        companyId,
        "claude_local",
        runId,
        "fixture-user",
      ) ?? "";
    expect(hostJwt).not.toBe("");
    hostCalls = [];
    runnerCommandHook = undefined;
    holdUpstream = false;
    upstreamClosed = false;
    host = createServer((req, res) => {
      hostCalls.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        runId: req.headers["x-paperclip-run-id"] as string | undefined,
      });
      const want =
        req.url === CONNECTIONS
          ? CONNECTION_TOKEN
          : req.url === PLUGIN
            ? PLUGIN_TOKEN
            : hostJwt;
      req.resume();
      req.on("end", () => {
        if (holdUpstream) {
          res.on("close", () => {
            upstreamClosed = true;
          });
          return;
        }
        res.writeHead(
          req.headers.authorization === `Bearer ${want}` ? 200 : 401,
          { "content-type": "application/json" },
        );
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { fixture: true } }),
        );
      });
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const address = host.address();
    if (!address || typeof address === "string")
      throw new Error("missing fixture address");
    hostUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "127.0.0.1");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", String(address.port));
    vi.stubEnv("PAPERCLIP_API_URL", hostUrl);
    observed = { entries: [], serialized: "", runtimeRoot: "" };
    resetClaudeCliCapabilitiesCacheForTests();
  });

  afterEach(async () => {
    host?.closeAllConnections();
    if (host?.listening)
      await new Promise<void>((resolve, reject) =>
        host.close((error) => (error ? reject(error) : resolve())),
      );
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    await rm(root, { recursive: true, force: true });
  });

  async function invoke(
    adapter: "claude" | "codex",
    remote = true,
    duringRun?: () => Promise<void>,
    outcome: "success" | "error" | "cancel" | "timeout" = "success",
    timeoutSec: unknown = 30,
  ) {
    const workspace = path.join(root, `workspace-${adapter}`);
    const remoteDir = path.join(root, `remote-${adapter}`);
    const configDir = path.join(root, `config-${adapter}`);
    await Promise.all(
      [workspace, remoteDir, configDir].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await writeFile(path.join(configDir, "auth.json"), "{}\n");
    const servers: Entry[] = [
      {
        name: "Paperclip projects",
        url: `${hostUrl}${PROJECTS}`,
        token: hostJwt,
        connectionId: "projects",
      },
      {
        name: "Paperclip connections",
        url: `${hostUrl}${CONNECTIONS}`,
        token: CONNECTION_TOKEN,
        connectionId: "connections",
      },
      {
        name: "Managed plugin",
        url: `${hostUrl}${PLUGIN}`,
        token: PLUGIN_TOKEN,
        connectionId: "plugin",
      },
    ];
    processBoundary.run.mockImplementation(async (...args) => {
      const argv = args[3] as string[];
      const options = args[4] as { env: Record<string, string> };
      if (adapter === "claude") {
        const file = argv[argv.indexOf("--mcp-config") + 1];
        observed.runtimeRoot = path.dirname(path.dirname(file));
        observed.serialized = await readFile(file, "utf8");
        const config = JSON.parse(observed.serialized) as {
          mcpServers: Record<
            string,
            { url: string; headers: Record<string, string> }
          >;
        };
        observed.entries = Object.entries(config.mcpServers).map(
          ([name, entry]) => ({
            name,
            url: entry.url,
            connectionId: name,
            token: collectBearers(entry)[0]?.token ?? "",
          }),
        );
        expect(collectBearers(config)).toHaveLength(3);
      } else {
        const file = path.join(options.env.CODEX_HOME, "config.toml");
        observed.runtimeRoot = path.dirname(options.env.CODEX_HOME);
        observed.serialized = await readFile(file, "utf8");
        const tokens = [
          ...observed.serialized.matchAll(
            /Authorization\s*=\s*"Bearer ([^"]+)"/g,
          ),
        ].map((match) => match[1]);
        const urls = [
          ...observed.serialized.matchAll(/^url\s*=\s*"([^"]+)"/gm),
        ].map((match) => match[1]);
        observed.entries = tokens.map((token, index) => ({
          name: `codex-${index}`,
          url: urls[index],
          token,
          connectionId: String(index),
        }));
        expect(tokens).toHaveLength(3);
      }
      // Seed both complete and interrupted transfer remnants. The real teardown
      // must remove them before execute resolves and its caller can release a lease.
      if (remote) {
        const runtimeRoot = observed.runtimeRoot;
        await mkdir(path.join(runtimeRoot, "mcp-config"), { recursive: true });
        await writeFile(
          path.join(runtimeRoot, "mcp-config", "surviving.json"),
          observed.serialized,
        );
        await writeFile(
          path.join(runtimeRoot, "mcp-config-upload.tar"),
          "synthetic archive",
        );
        await writeFile(
          path.join(runtimeRoot, "mcp-config-upload.tar.part"),
          "synthetic interrupted upload",
        );
        await writeFile(
          path.join(runtimeRoot, "mcp-config-upload.tar.b64"),
          "synthetic base64 upload",
        );
      }
      await duringRun?.();
      if (outcome === "cancel")
        throw new DOMException("fixture run cancelled", "AbortError");
      if (outcome === "timeout")
        return {
          ...exited(),
          timedOut: true,
          exitCode: null,
          signal: "SIGTERM",
        };
      return outcome === "error"
        ? { ...exited(), exitCode: 1, stderr: "fixture provider failure" }
        : exited();
    });
    const ctx = {
      runId,
      agent: {
        id: agentId,
        companyId,
        name: "Fixture",
        adapterType: `${adapter}_local`,
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      authToken: hostJwt,
      config: {
        engine: "cli",
        command: adapter,
        timeoutSec,
        env: { CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: configDir },
      },
      context: {
        paperclipWorkspace: { cwd: workspace, source: "project_primary" },
      },
      runtimeMcp: { getServers: () => servers },
      ...(remote
        ? {
            executionTarget: {
              kind: "remote",
              transport: "sandbox",
              providerKey: "fixture",
              remoteCwd: remoteDir,
              streamRunLogs: false,
              timeoutMs: 30_000,
              shellCommand: "sh",
              runner: localRunner(bin, async (input) => {
                await runnerCommandHook?.(input);
              }),
            },
          }
        : {}),
      onLog: async () => {},
    } as unknown as AdapterExecutionContext;
    return await (adapter === "claude"
      ? executeClaude(ctx)
      : executeCodex(ctx));
  }

  it.each(["claude", "codex"] as const)(
    "%s remote assets contain only bridge-scoped bearers",
    async (adapter) => {
      await invoke(adapter);
      expect(observed.entries).toHaveLength(3);
      for (const credential of [hostJwt, CONNECTION_TOKEN, PLUGIN_TOKEN]) {
        expect
          .soft(
            observed.serialized,
            "host credential in actual synced MCP asset",
          )
          .not.toContain(credential);
      }
      for (const entry of observed.entries) {
        expect.soft(entry.token).not.toBe("");
        expect.soft(new URL(entry.url).origin, entry.name).not.toBe(hostUrl);
      }
    },
  );

  it("every Authorization bearer read from Claude's remote asset is denied by host API and gateway auth", async () => {
    const app = express();
    app.use(
      actorMiddleware(authDb(agentId, companyId, runId) as never, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/api/agents/me", (req, res) =>
      res.status(req.actor.type === "agent" ? 200 : 401).json(req.actor),
    );
    app.use(errorHandler);
    const control = await request(app)
      .get("/api/agents/me")
      .set("Authorization", `Bearer ${hostJwt}`);
    expect(control.status).toBe(200);
    const gateway = createToolGatewayService(
      gatewayDb(companyId, agentId) as never,
    );
    await expect(
      gateway.initializeNamedGatewayProtocol({
        gatewayPublicId: `gw_${"a".repeat(32)}`,
        bearerToken: PLUGIN_TOKEN,
      }),
    ).resolves.toMatchObject({
      companyId,
      gatewayPublicId: `gw_${"a".repeat(32)}`,
    });
    await invoke("claude");
    for (const entry of observed.entries) {
      const response = await request(app)
        .get("/api/agents/me")
        .set("Authorization", `Bearer ${entry.token}`);
      expect
        .soft([401, 403], `host API accepted ${entry.name}`)
        .toContain(response.status);
      let gatewayStatus = 200;
      try {
        await gateway.initializeNamedGatewayProtocol({
          gatewayPublicId: `gw_${"a".repeat(32)}`,
          bearerToken: entry.token,
        });
      } catch (error) {
        gatewayStatus = (error as { status: number }).status;
      }
      expect
        .soft([401, 403], `host gateway accepted ${entry.name}`)
        .toContain(gatewayStatus);
    }
  });

  it.each(["claude", "codex"] as const)(
    "%s bridge forwards each MCP endpoint with its own host-side credential",
    async (adapter) => {
      await invoke(adapter, true, async () => {
        for (const entry of observed.entries) {
          const response = await fetch(entry.url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${entry.token}`,
              "content-type": "application/json",
              "x-paperclip-run-id": "spoofed-run",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
            }),
          });
          expect.soft(response.status, entry.name).toBe(200);
          await response.arrayBuffer();
        }
      });
      expect(hostCalls).toHaveLength(3);
      for (const call of hostCalls) expect.soft(call.runId).toBe(runId);
      expect(hostCalls.map(({ authorization }) => authorization)).toEqual([
        `Bearer ${hostJwt}`,
        `Bearer ${CONNECTION_TOKEN}`,
        `Bearer ${PLUGIN_TOKEN}`,
      ]);
    },
  );

  it.each(["claude", "codex"] as const)(
    "%s cached CLI headers work at +16m and just before the full 4h deadline, but never at D or O",
    async (adapter) => {
      // Security contract: B=14,400s, A=I, D=I+14,400s, O=I+15,300s.
      // The sandbox clock is deliberately wrong; only host time can authorize.
      const baseline = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(baseline);
      let elapsed = 0;
      const mono = process.hrtime.bigint();
      const perf = performance.now();
      vi.spyOn(process.hrtime, "bigint").mockImplementation(
        () => mono + BigInt(elapsed) * 1_000_000n,
      );
      vi.spyOn(performance, "now").mockImplementation(() => perf + elapsed);
      await invoke(
        adapter,
        true,
        async () => {
          const cached = structuredClone(observed.entries);
          const callbacks = [
            ...cached,
            {
              ...cached[0],
              name: "API comment callback",
              token: cached[0]?.token ?? "",
              url: `${new URL(cached[0]?.url ?? "").origin}/api/issues/fixture-issue/comments`,
            },
          ];
          for (const sample of [
            { ms: 0, allow: true },
            { ms: 960_000, allow: true },
            { ms: 14_399_999, allow: true },
            { ms: 14_400_000, allow: false },
            { ms: 15_300_000, allow: false },
          ]) {
            elapsed = sample.ms;
            vi.setSystemTime(baseline + elapsed);
            const before = hostCalls.length;
            for (const entry of callbacks) {
              const response = await fetch(entry.url, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${entry.token}`,
                  "content-type": "application/json",
                },
                body: "{}",
                signal: AbortSignal.timeout(3_000),
              });
              if (sample.allow)
                expect
                  .soft(response.status, `${entry.name} +${elapsed}ms`)
                  .toBe(200);
              else
                expect
                  .soft([401, 403], `cutoff ${entry.name} +${elapsed}ms`)
                  .toContain(response.status);
              await response.arrayBuffer();
            }
            expect
              .soft(hostCalls.length - before, `dispatch count +${elapsed}ms`)
              .toBe(sample.allow ? 4 : 0);
          }
          const retained = await allFiles(path.join(root, `remote-${adapter}`));
          expect(retained.some((file) => file.endsWith("surviving.json"))).toBe(
            true,
          );
          expect(observed.entries).toEqual(cached);
          vi.useRealTimers();
        },
        "success",
        14_400,
      );
    },
    30_000,
  );

  it.each(["claude", "codex"] as const)(
    "%s transport readiness cannot authorize API forwarding before the host launches the turn",
    async (adapter) => {
      processBoundary.bridgeReady.mockImplementation(async (bridge) => {
        const response = await fetch(
          `${bridge.env.PAPERCLIP_API_URL}/api/agents/me`,
          {
            headers: {
              authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
            },
            signal: AbortSignal.timeout(3_000),
          },
        );
        expect
          .soft([401, 403], "ready is not host activation")
          .toContain(response.status);
        await response.arrayBuffer();
        expect
          .soft(hostCalls, "pre-activation upstream dispatch")
          .toHaveLength(0);
      });
      await invoke(
        adapter,
        true,
        async () => {
          for (const entry of observed.entries) {
            const response = await fetch(entry.url, {
              method: "POST",
              headers: {
                authorization: `Bearer ${entry.token}`,
                "content-type": "application/json",
              },
              body: "{}",
              signal: AbortSignal.timeout(3_000),
            });
            expect
              .soft(
                response.status,
                "host launch activates the admitted attempt",
              )
              .toBe(200);
            await response.arrayBuffer();
          }
        },
        "success",
        14_400,
      );
    },
    30_000,
  );

  it.each([
    ["claude", "success"],
    ["claude", "error"],
    ["claude", "cancel"],
    ["codex", "success"],
    ["codex", "error"],
    ["codex", "cancel"],
  ] as const)(
    "%s credentials cannot be reused after %s, even when copied out of the asset",
    async (adapter, outcome) => {
      const execution = invoke(adapter, true, undefined, outcome);
      if (outcome === "cancel")
        await expect(execution).rejects.toMatchObject({ name: "AbortError" });
      else await execution;
      expect(observed.entries).toHaveLength(3);
      for (const entry of observed.entries) {
        let status: number;
        try {
          const response = await fetch(entry.url, {
            method: "POST",
            headers: { authorization: `Bearer ${entry.token}` },
            body: "{}",
            signal: AbortSignal.timeout(2_000),
          });
          status = response.status;
          await response.arrayBuffer();
        } catch (error) {
          // A stopped bridge is unreachable, not a bearer accepted by the host.
          const cause = (error as { cause?: { code?: string } }).cause;
          if (cause?.code !== "ECONNREFUSED" && cause?.code !== "ECONNRESET")
            throw error;
          status = 401;
        }
        expect
          .soft(
            [401, 403],
            `reusable ${adapter} credential after ${outcome}: ${entry.name}`,
          )
          .toContain(status);
      }
    },
  );

  it.each([
    ["claude", "success"],
    ["claude", "error"],
    ["claude", "cancel"],
    ["codex", "success"],
    ["codex", "error"],
    ["codex", "cancel"],
  ] as const)(
    "%s scrubs remote MCP files and upload fragments before returning on %s",
    async (adapter, outcome) => {
      const execution = invoke(adapter, true, undefined, outcome);
      if (outcome === "cancel")
        await expect(execution).rejects.toMatchObject({ name: "AbortError" });
      else await execution;
      // execute has settled; a provider lease may now be released by the caller.
      const remaining = await allFiles(path.join(root, `remote-${adapter}`));
      const configDirectory = await lstat(
        path.join(observed.runtimeRoot, "mcp-config"),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      expect
        .soft(
          configDirectory,
          "remote mcp-config directory must be removed, not merely emptied",
        )
        .toBeNull();
      expect
        .soft(
          remaining.filter(
            (file) =>
              file.includes(`${path.sep}mcp-config${path.sep}`) ||
              path.basename(file).startsWith("mcp-config-upload.tar"),
          ),
        )
        .toEqual([]);
      if (adapter === "codex") {
        const remainingConfig = path.join(
          root,
          "remote-codex",
          ".paperclip-runtime",
          "codex",
          "home",
          "config.toml",
        );
        const text = await readFile(remainingConfig, "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return "";
          },
        );
        for (const token of [
          hostJwt,
          CONNECTION_TOKEN,
          PLUGIN_TOKEN,
          ...observed.entries.map((entry) => entry.token),
        ]) {
          expect
            .soft(text, "remote Codex config retains a bearer after teardown")
            .not.toContain(token);
        }
      }
    },
  );

  it.each([
    ["claude", 899_999, true],
    ["claude", 900_000, true],
    ["claude", 900_001, false],
    ["codex", 899_999, true],
    ["codex", 900_000, true],
    ["codex", 900_001, false],
  ] as const)(
    "%s startup at +%ims preserves full B or refuses before launch (allowed=%s)",
    async (adapter, startupMs, allowed) => {
      const issuance = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(issuance);
      let elapsed = 0;
      const mono = process.hrtime.bigint();
      const perf = performance.now();
      vi.spyOn(process.hrtime, "bigint").mockImplementation(
        () => mono + BigInt(elapsed) * 1_000_000n,
      );
      vi.spyOn(performance, "now").mockImplementation(() => perf + elapsed);
      processBoundary.bridgeReady.mockImplementation(async () => {
        elapsed = startupMs;
        vi.setSystemTime(issuance + elapsed);
      });
      let launched = false;
      const outcome = await invoke(
        adapter,
        true,
        async () => {
          launched = true;
          if (!allowed) return;
          const cached = structuredClone(observed.entries);
          for (const [ms, allow] of [
            [startupMs + 960_000, true],
            [startupMs + 14_399_999, true],
            [startupMs + 14_400_000, false],
            [15_300_000, false],
          ] as const) {
            elapsed = ms;
            vi.setSystemTime(issuance + elapsed);
            const before = hostCalls.length;
            for (const entry of cached) {
              const response = await fetch(entry.url, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${entry.token}`,
                  "content-type": "application/json",
                },
                body: "{}",
                signal: AbortSignal.timeout(3_000),
              });
              if (allow)
                expect.soft(response.status, `full B at +${ms}ms`).toBe(200);
              else
                expect
                  .soft([401, 403], `immutable cutoff at +${ms}ms`)
                  .toContain(response.status);
              await response.arrayBuffer();
            }
            expect
              .soft(hostCalls.length - before, `dispatches +${ms}ms`)
              .toBe(allow ? 3 : 0);
          }
        },
        "success",
        14_400,
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      expect
        .soft(launched, "late startup must not launch an agent turn")
        .toBe(allowed);
      if (!allowed) {
        expect.soft(hostCalls).toHaveLength(0);
        expect
          .soft(
            "error" in outcome ||
              ("value" in outcome && outcome.value.exitCode !== 0),
            "late-start refusal must be explicit",
          )
          .toBe(true);
      }
      vi.useRealTimers();
    },
    30_000,
  );

  it.each([
    ["claude", 14_401],
    ["claude", -1],
    ["claude", Number.POSITIVE_INFINITY],
    ["claude", Number.NaN],
    ["codex", 14_401],
    ["codex", -1],
    ["codex", Number.POSITIVE_INFINITY],
    ["codex", Number.NaN],
  ] as const)(
    "%s refuses unsupported budget %s before launching instead of silently truncating a turn",
    async (adapter, budget) => {
      let launched = false;
      const outcome = await invoke(
        adapter,
        true,
        async () => {
          launched = true;
        },
        "success",
        budget,
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      expect.soft(launched, "unsupported budget launched provider").toBe(false);
      expect.soft(hostCalls).toHaveLength(0);
      expect
        .soft(
          "error" in outcome ||
            ("value" in outcome && outcome.value.exitCode !== 0),
          "unsupported lifetime must fail explicitly",
        )
        .toBe(true);
      // The decision requires semantic fields but does not name their spelling.
      const diagnostic = "error" in outcome ? outcome.error : outcome.value;
      const fields =
        diagnostic && typeof diagnostic === "object"
          ? (diagnostic as Record<string, unknown>)
          : {};
      expect
        .soft(
          fields.errorCode ?? fields.code,
          "stable machine-readable refusal code",
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

  it.each(["claude", "codex"] as const)(
    "%s refuses before launch if the actual host run JWT cannot cover admitted B",
    async (adapter) => {
      vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "60");
      hostJwt =
        createLocalAgentJwt(
          agentId,
          companyId,
          `${adapter}_local`,
          runId,
          "fixture-user",
        ) ?? "";
      let launched = false;
      const outcome = await invoke(
        adapter,
        true,
        async () => {
          launched = true;
        },
        "success",
        14_400,
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      expect
        .soft(launched, "short-lived host credential launched a four-hour turn")
        .toBe(false);
      expect.soft(hostCalls).toHaveLength(0);
      const diagnostic = "error" in outcome ? outcome.error : outcome.value;
      const fields =
        diagnostic && typeof diagnostic === "object"
          ? (diagnostic as Record<string, unknown>)
          : {};
      expect
        .soft(
          fields.errorCode ?? fields.code,
          "machine-readable credential lifetime failure",
        )
        .toEqual(expect.any(String));
      expect
        .soft(
          fields.remediation ?? fields.nextAction ?? fields.next_action,
          "credential preflight remediation",
        )
        .toEqual(expect.any(String));
    },
    30_000,
  );

  it.each([
    ["claude", 60],
    ["claude", 600],
    ["codex", 60],
    ["codex", 600],
  ] as const)(
    "%s admits the full shorter %is budget but denies at D and B+900s, not a fixed max TTL",
    async (adapter, budget) => {
      const issuance = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(issuance);
      let elapsed = 0;
      const mono = process.hrtime.bigint();
      const perf = performance.now();
      vi.spyOn(process.hrtime, "bigint").mockImplementation(
        () => mono + BigInt(elapsed) * 1_000_000n,
      );
      vi.spyOn(performance, "now").mockImplementation(() => perf + elapsed);
      await invoke(
        adapter,
        true,
        async () => {
          for (const [ms, allowed] of [
            [budget * 1000 - 1, true],
            [budget * 1000, false],
            [(budget + 900) * 1000, false],
          ] as const) {
            elapsed = ms;
            vi.setSystemTime(issuance + ms);
            const before = hostCalls.length;
            for (const entry of observed.entries) {
              const response = await fetch(entry.url, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${entry.token}`,
                  "content-type": "application/json",
                },
                body: "{}",
                signal: AbortSignal.timeout(3_000),
              });
              if (allowed)
                expect
                  .soft(response.status, `admitted shorter budget +${ms}ms`)
                  .toBe(200);
              else
                expect
                  .soft([401, 403], `shorter immutable cutoff +${ms}ms`)
                  .toContain(response.status);
              await response.arrayBuffer();
            }
            expect.soft(hostCalls.length - before).toBe(allowed ? 3 : 0);
          }
          vi.useRealTimers();
        },
        "success",
        budget,
      );
    },
    30_000,
  );

  it.each([
    ["claude", "success"],
    ["claude", "error"],
    ["claude", "cancel"],
    ["claude", "timeout"],
    ["codex", "success"],
    ["codex", "error"],
    ["codex", "cancel"],
    ["codex", "timeout"],
  ] as const)(
    "%s %s revokes and aborts upstream before blocked remote credential cleanup can finish",
    async (adapter, terminal) => {
      let enterCleanup!: () => void;
      const entered = new Promise<void>((resolve) => {
        enterCleanup = resolve;
      });
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let providerStarted = false;
      runnerCommandHook = async (input) => {
        const script = input.args?.at(-1) ?? "";
        if (
          providerStarted &&
          script.includes("/mcp-config") &&
          /\brm\s/.test(script) &&
          !/\b(?:tar|mkdir|base64)\s/.test(script)
        ) {
          enterCleanup();
          await cleanupGate;
        }
      };
      let inFlight: Promise<unknown> | undefined;
      const execution = invoke(
        adapter,
        true,
        async () => {
          providerStarted = true;
          holdUpstream = true;
          const entry = observed.entries[0];
          if (!entry) throw new Error("missing generated MCP entry");
          inFlight = fetch(entry.url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${entry.token}`,
              "content-type": "application/json",
            },
            body: "{}",
            signal: AbortSignal.timeout(8_000),
          }).then(
            async (response) => {
              await response.arrayBuffer();
              return response.status;
            },
            () => "closed",
          );
          await vi.waitFor(() => expect(hostCalls).toHaveLength(1), {
            timeout: 3_000,
          });
        },
        terminal,
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await Promise.race([
          entered,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("fixture cleanup boundary not reached")),
              5_000,
            ),
          ),
        ]);
        expect
          .soft(
            (await allFiles(path.join(root, `remote-${adapter}`))).some(
              (file) => file.endsWith("surviving.json"),
            ),
            "cleanup is still blocked with copied files present",
          )
          .toBe(true);
        await vi.waitFor(
          () =>
            expect(
              upstreamClosed,
              "in-flight upstream socket survived terminal revocation",
            ).toBe(true),
          { timeout: 3_000 },
        );
        const before = hostCalls.length;
        for (const entry of observed.entries) {
          const status = await fetch(entry.url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${entry.token}`,
              "content-type": "application/json",
            },
            body: "{}",
            signal: AbortSignal.timeout(2_000),
          }).then(
            async (response) => {
              await response.arrayBuffer();
              return response.status;
            },
            (error) => {
              const code = (error as { cause?: { code?: string } }).cause?.code;
              if (
                code !== "ECONNREFUSED" &&
                code !== "ECONNRESET" &&
                (error as Error).name !== "TimeoutError" &&
                (error as Error).name !== "AbortError"
              )
                throw error;
              return 401;
            },
          );
          expect
            .soft([401, 403], "retained credential during pending cleanup")
            .toContain(status);
        }
        expect
          .soft(
            hostCalls.length - before,
            "dispatch while terminal cleanup blocked",
          )
          .toBe(0);
      } finally {
        releaseCleanup();
        await execution;
        await inFlight;
      }
    },
    30_000,
  );

  it.each(["claude", "codex"] as const)(
    "trusted local %s keeps the established MCP endpoint credentials",
    async (adapter) => {
      await invoke(adapter, false);
      expect(observed.entries.map(({ token }) => token)).toEqual([
        hostJwt,
        CONNECTION_TOKEN,
        PLUGIN_TOKEN,
      ]);
      expect(observed.entries.map(({ url }) => url)).toEqual([
        `${hostUrl}${PROJECTS}`,
        `${hostUrl}${CONNECTIONS}`,
        `${hostUrl}${PLUGIN}`,
      ]);
    },
  );
});
