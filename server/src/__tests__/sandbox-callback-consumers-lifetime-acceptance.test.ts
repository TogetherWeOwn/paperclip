import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import type { heartbeatRuns } from "@paperclipai/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  run: vi.fn<(...args: unknown[]) => Promise<RunProcessResult>>(),
  ready:
    vi.fn<
      (bridge: {
        env: Record<string, string>;
        stop(): Promise<void>;
      }) => Promise<void>
    >(),
}));

// Only external CLI execution/probing is doubled. The actual consumer, asset
// preparation, generated queue gateway and host dispatcher execute real code.
// These assertions cover API callbacks, NOT full MCP asset isolation for these
// other adapters; that inventory remains a separately disclosed security gap.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@paperclipai/adapter-utils/execution-target")
    >();
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: async () => {},
    ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
    resolveAdapterExecutionTargetCommandForLogs: async (command: string) =>
      command,
    runAdapterExecutionTargetProcess: boundary.run,
    startAdapterExecutionTargetPaperclipBridge: async (
      input: Parameters<
        typeof actual.startAdapterExecutionTargetPaperclipBridge
      >[0],
    ) => {
      const bridge =
        await actual.startAdapterExecutionTargetPaperclipBridge(input);
      if (bridge) await boundary.ready(bridge);
      return bridge;
    },
  };
});

import { execute as cursor } from "../../../packages/adapters/cursor-local/src/server/execute.js";
import { execute as gemini } from "../../../packages/adapters/gemini-local/src/server/execute.js";
import { execute as kimi } from "../../../packages/adapters/kimi-local/src/server/execute.js";
import { execute as opencode } from "../../../packages/adapters/opencode-local/src/server/execute.js";
import { execute as pi } from "../../../packages/adapters/pi-local/src/server/execute.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import {
  legacyControllerBootId,
  watchLegacyControllerLease,
} from "../services/legacy-controller-lease.js";

const CONSUMERS = [
  ["gemini", gemini],
  ["cursor", cursor],
  ["pi", pi],
  ["opencode", opencode],
  ["kimi", kimi],
] as const;
type Consumer = (typeof CONSUMERS)[number][0];
type CallbackEnv = Record<string, string>;

function exited(): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    pid: null,
    startedAt: new Date().toISOString(),
    stderr: "",
    stdout: JSON.stringify({
      type: "result",
      status: "success",
      result: "synthetic",
      session_id: "fixture-session",
    }),
  };
}

async function callback(env: CallbackEnv) {
  const res = await fetch(`${env.PAPERCLIP_API_URL}/api/agents/me`, {
    headers: { authorization: `Bearer ${env.PAPERCLIP_API_KEY}` },
    signal: AbortSignal.timeout(3_000),
  });
  await res.arrayBuffer();
  return res.status;
}

describe("all direct sandbox callback consumers use host-owned activation", () => {
  let root: string;
  let host: ReturnType<typeof createServer>;
  let hostUrl: string;
  let jwt: string;
  let forwards: Array<{ authorization?: string; runId?: string }>;
  let prelaunch: number[];
  let issuedEnv: CallbackEnv | undefined;
  let duringRun: ((env: CallbackEnv) => Promise<void>) | undefined;
  let signal: AbortSignal | undefined;
  let wall: number;
  let elapsed: number;
  let issuance: number;
  let agentId: string;
  let companyId: string;
  let runId: string;

  beforeEach(async () => {
    boundary.run.mockReset();
    boundary.ready.mockReset();
    root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "consumer-lifetime-",
      ),
    );
    prelaunch = [];
    forwards = [];
    duringRun = undefined;
    signal = undefined;
    issuedEnv = undefined;
    const bin = path.join(root, "bin");
    await mkdir(bin);
    for (const command of [
      "gemini",
      "cursor",
      "agent",
      "pi",
      "opencode",
      "kimi",
    ]) {
      await writeFile(
        path.join(bin, command),
        "#!/bin/sh\nprintf 'synthetic CLI 1.0.0\\n'\n",
        { mode: 0o700 },
      );
    }
    // Runtime installation must never reach a package registry in this fixture.
    for (const command of ["npm", "curl", "wget"]) {
      await writeFile(
        path.join(bin, command),
        "#!/bin/sh\nprintf 'unexpected external installer\\n' >&2\nexit 97\n",
        { mode: 0o700 },
      );
    }
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    issuance = Date.now();
    wall = issuance;
    elapsed = 0;
    vi.stubEnv("HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    vi.stubEnv(
      "PAPERCLIP_AGENT_JWT_SECRET",
      "synthetic-consumer-signing-secret",
    );
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    agentId = randomUUID();
    companyId = randomUUID();
    runId = randomUUID();
    jwt =
      createLocalAgentJwt(
        agentId,
        companyId,
        "gemini_local",
        runId,
        "synthetic-user",
      ) ?? "";
    expect(jwt).not.toBe("");
    host = createServer((req, res) => {
      forwards.push({
        authorization: req.headers.authorization,
        runId: req.headers["x-paperclip-run-id"] as string | undefined,
      });
      req.resume();
      res.writeHead(req.headers.authorization === `Bearer ${jwt}` ? 200 : 401, {
        "content-type": "application/json",
      });
      res.end('{"fixture":true}');
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const address = host.address();
    if (!address || typeof address === "string")
      throw new Error("fixture address missing");
    hostUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("PAPERCLIP_LISTEN_HOST", "127.0.0.1");
    vi.stubEnv("PAPERCLIP_LISTEN_PORT", String(address.port));
    vi.stubEnv("PAPERCLIP_API_URL", hostUrl);
    const clock = path.join(root, "sandbox-clock.cjs");
    await writeFile(
      clock,
      `const OriginalDate=Date; global.Date=class extends OriginalDate {
      constructor(...args) { super(...(args.length?args:[${issuance}])); } static now(){return ${issuance};}
    };`,
    );
    vi.stubEnv("NODE_OPTIONS", `--require=${clock}`);
    boundary.ready.mockImplementation(async (bridge) => {
      issuedEnv = { ...bridge.env };
      prelaunch.push(await callback(bridge.env));
    });
    boundary.run.mockImplementation(async (...args) => {
      const argv = args[3] as string[];
      if (argv[0] === "models")
        return { ...exited(), stdout: "synthetic/model\n" };
      const options = args[4] as { env: CallbackEnv };
      await duringRun?.(options.env);
      return exited();
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
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

  function independentClocks() {
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

  const runner: CommandManagedRuntimeRunner = {
    execute: async (input) =>
      new Promise((resolve, reject) => {
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
            pid: child.pid ?? null,
            startedAt: new Date().toISOString(),
            stdout: Buffer.concat(stdout).toString(),
            stderr: Buffer.concat(stderr).toString(),
          });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input.stdin ?? "");
      }),
  };

  async function invoke(name: Consumer = "gemini", budget = 14_400) {
    const workspace = path.join(root, "workspace");
    const remote = path.join(root, "remote");
    await mkdir(workspace, { recursive: true });
    await mkdir(remote, { recursive: true });
    const execute = CONSUMERS.find(([key]) => key === name)?.[1];
    if (!execute) throw new Error("unknown fixture consumer");
    return execute({
      runId,
      agent: {
        id: agentId,
        companyId,
        name: "Fixture",
        adapterType: `${name}_local`,
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      authToken: jwt,
      config: {
        engine: "cli",
        command: name,
        timeoutSec: budget,
        ...(name === "opencode" ? { model: "synthetic/model" } : {}),
        env: {
          GEMINI_API_KEY: "synthetic-only",
          CURSOR_API_KEY: "synthetic-only",
          OPENAI_API_KEY: "synthetic-only",
          KIMI_API_KEY: "synthetic-only",
          OPENCODE_SKIP_MODEL_PREFLIGHT: "1",
        },
      },
      context: {
        paperclipWorkspace: { cwd: workspace, source: "project_primary" },
      },
      signal,
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fixture",
        remoteCwd: remote,
        streamRunLogs: false,
        shellCommand: "sh",
        timeoutMs: 15_000,
        runner,
      },
      onLog: async () => {},
    } as unknown as AdapterExecutionContext);
  }

  it.each(CONSUMERS)(
    "%s denies at transport readiness, then authorizes callbacks at actual CLI execution",
    async (name) => {
      duringRun = async (env) => {
        expect(prelaunch).toHaveLength(1);
        expect.soft([401, 403]).toContain(prelaunch[0]);
        expect
          .soft(
            await callback(env),
            "consumer forgot host activation before CLI launch",
          )
          .toBe(200);
        expect.soft(env.PAPERCLIP_API_KEY).not.toBe(jwt);
      };
      const result = await invoke(name);
      expect(result.exitCode).toBe(0);
      expect.soft(forwards).toHaveLength(1);
      expect(
        forwards.every(
          (call) =>
            call.authorization === `Bearer ${jwt}` && call.runId === runId,
        ),
      ).toBe(true);
    },
    30_000,
  );

  it("control: healthy Gemini callback uses the host credential/run and completion retires its bearer", async () => {
    boundary.ready.mockImplementation(async (bridge) => {
      issuedEnv = { ...bridge.env };
    });
    duringRun = async (env) => {
      expect(await callback(env)).toBe(200);
    };
    expect((await invoke("gemini", 60)).exitCode).toBe(0);
    expect(forwards).toHaveLength(1);
    expect(
      forwards.every(
        (call) =>
          call.authorization === `Bearer ${jwt}` && call.runId === runId,
      ),
    ).toBe(true);
    expect(await callback(issuedEnv ?? {}).catch(() => 0)).not.toBe(200);
    expect(forwards).toHaveLength(1);
  }, 30_000);

  it("real Gemini consumer keeps static API callbacks beyond +16m and near its admitted four-hour D after ten-minute setup", async () => {
    independentClocks();
    boundary.ready.mockImplementation(async (bridge) => {
      issuedEnv = { ...bridge.env };
      prelaunch.push(await callback(bridge.env));
      // I=0, A=600,000ms. A+B-1=14,999,999ms exceeds I+B.
      wall = issuance + 600_000;
      elapsed = 600_000;
    });
    duringRun = async (env) => {
      for (const offset of [1_560_000, 14_999_999]) {
        wall = issuance + offset;
        elapsed = offset;
        expect.soft(await callback(env), `callback at +${offset}ms`).toBe(200);
      }
    };
    expect((await invoke("gemini")).exitCode).toBe(0);
    expect.soft(forwards).toHaveLength(2);
  }, 30_000);

  it("ctx.signal revokes callbacks before CLI settlement, not only when finally runs", async () => {
    const controller = new AbortController();
    signal = controller.signal;
    duringRun = async (env) => {
      expect(await callback(env)).toBe(200);
      const before = forwards.length;
      controller.abort(new Error("synthetic user cancellation"));
      expect
        .soft(
          await callback(env).catch(() => 0),
          "callback authority survived observed cancellation",
        )
        .not.toBe(200);
      expect.soft(forwards).toHaveLength(before);
    };
    await invoke("gemini");
  }, 30_000);

  it("real legacy-controller lease replacement aborts ctx.signal and retires existing callback authority", async () => {
    const controller = new AbortController();
    signal = controller.signal;
    // An in-memory row boundary, not a mocked ownership boolean: the real lease
    // watcher builds the production SQL and observes the replacement row owner.
    let storedBootId = legacyControllerBootId;
    const db = {
      update: () => ({
        set: () => ({
          where: (condition: SQL) => ({
            returning: async () => {
              const params = new PgDialect().sqlToQuery(condition).params;
              expect(params).toContain(runId);
              expect(params).toContain(companyId);
              expect(params).toContain(legacyControllerBootId);
              return params.includes(storedBootId) ? [{ id: runId }] : [];
            },
          }),
        }),
      }),
    };
    const row = {
      id: runId,
      companyId,
      runtimeMode: "legacy",
      status: "running",
      controllerBootId: legacyControllerBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const watcher = watchLegacyControllerLease(
      db as never,
      row as typeof heartbeatRuns.$inferSelect,
      controller,
    );
    try {
      await watcher.assertOwned("dispatching");
      duringRun = async (env) => {
        expect(await callback(env)).toBe(200);
        const before = forwards.length;
        storedBootId = randomUUID();
        await expect(watcher.assertOwned()).rejects.toThrow(
          "Legacy controller lease lost",
        );
        expect(controller.signal.aborted).toBe(true);
        expect
          .soft(
            await callback(env).catch(() => 0),
            "observed controller loss retained bridge authority",
          )
          .not.toBe(200);
        expect.soft(forwards).toHaveLength(before);
      };
      await invoke("gemini");
    } finally {
      watcher.stop();
    }
  }, 30_000);

  it.each(["uncertain-monotonic", "suspension"] as const)(
    "%s clock loss is terminal in the final adapter result, never retryable 502/success",
    async (kind) => {
      independentClocks();
      duringRun = async (env) => {
        expect(await callback(env)).toBe(200);
        const before = forwards.length;
        if (kind === "uncertain-monotonic") {
          vi.mocked(performance.now).mockReturnValue(Number.NaN);
          vi.mocked(process.hrtime.bigint).mockReturnValue(-1n);
        } else {
          wall = issuance + 120_000;
          elapsed = 1;
        }
        const status = await callback(env).catch(() => 0);
        expect
          .soft(
            [0, 401, 403],
            "clock loss must be a terminal authority denial, not retryable 502",
          )
          .toContain(status);
        expect.soft(forwards).toHaveLength(before);
      };
      const outcome = await invoke("gemini", 60).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      expect
        .soft(
          "value" in outcome,
          "clock infrastructure failure must reach final result",
        )
        .toBe(true);
      if ("value" in outcome) {
        expect
          .soft(
            outcome.value.exitCode,
            "zero provider exit concealed clock failure",
          )
          .not.toBe(0);
        expect
          .soft(outcome.value.errorCode)
          .toEqual(expect.stringMatching(/\S/));
        expect
          .soft(outcome.value.errorMessage)
          .toEqual(expect.stringMatching(/clock|deadline|suspend|lifetime/i));
      }
      expect(issuedEnv).toBeDefined();
    },
    30_000,
  );
});
