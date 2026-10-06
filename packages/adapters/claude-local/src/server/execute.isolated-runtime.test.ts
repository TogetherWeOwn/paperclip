import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", async () => {
  const actual = await vi.importActual<typeof import("./acp.js")>("./acp.js");
  return {
    ...actual,
    createClaudeAcpExecutor: () => actual.createClaudeAcpExecutor(),
    resolveClaudeExecutionEngineForRun: async (input: { config: Record<string, unknown> }) =>
      actual.resolveClaudeExecutionEngineForRun(input),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";
import { resolveClaudeExecutionEngineForRun } from "./acp.js";

const PROJECT_SECRETS = {
  GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
  GH_APP_TOKEN_SOURCE: "broker",
  DATABASE_URL: "postgres://server-secret",
};

type SpawnOpts = {
  env: Record<string, string>;
  inheritServerEnv?: boolean;
};

function spawnCall(): [string, unknown, string, string[], SpawnOpts] {
  const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
    | [string, unknown, string, string[], SpawnOpts]
    | undefined;
  if (!call) throw new Error("expected runAdapterExecutionTargetProcess to have been called");
  return call;
}

function spawnOpts(): SpawnOpts {
  return spawnCall()[4];
}

function buildContext(input: { isolate?: boolean; engine?: string; executionTarget?: unknown }) {
  const onMeta = vi.fn(async (_meta: unknown) => {});
  return {
    onMeta,
    ctx: {
      runId: "run-iso",
      agent: {
        id: "agent-iso",
        companyId: "company-1",
        name: "Review Bot",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        engine: input.engine ?? "cli",
        ...(input.isolate ? { isolateRuntime: true } : {}),
        env: { ANTHROPIC_API_KEY: "sk-agent", ...PROJECT_SECRETS },
      },
      context: {
        taskId: "task-1",
        wakeReason: "issue_assigned",
      },
      authToken: "run-jwt",
      executionTarget: input.executionTarget,
      onMeta,
      onLog: vi.fn(async () => {}),
    },
  };
}

describe("claude execute — isolateRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SERVER_ONLY_SECRET_X", "server-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("control: without the flag the child inherits the server env and carries the token", async () => {
    const { ctx } = buildContext({});

    await execute(ctx as never);

    const opts = spawnOpts();
    expect(opts.inheritServerEnv).toBe(true);
    expect(opts.env.PAPERCLIP_API_KEY).toBe("run-jwt");
    expect(opts.env.GH_APP_PRIVATE_KEY).toBe(PROJECT_SECRETS.GH_APP_PRIVATE_KEY);
  });

  it("starts the child from an allowlist holding the token, and logs the narrowed key set", async () => {
    const { ctx, onMeta } = buildContext({ isolate: true });

    await execute(ctx as never);

    const opts = spawnOpts();
    expect(opts.inheritServerEnv).toBe(false);
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-agent");
    // The harness-minted run token stays exactly as today (codex drops it; claude keeps it).
    expect(opts.env.PAPERCLIP_API_KEY).toBe("run-jwt");
    expect(opts.env.PAPERCLIP_RUN_ID).toBe("run-iso");
    expect(opts.env.PAPERCLIP_TASK_ID).toBe("task-1");
    for (const key of [...Object.keys(PROJECT_SECRETS), "SERVER_ONLY_SECRET_X"]) {
      expect(opts.env).not.toHaveProperty(key);
    }
    expect(JSON.stringify(opts.env)).not.toContain("BEGIN RSA PRIVATE KEY");

    // The adapter.invoke record carries the same narrowed key set.
    const meta = onMeta.mock.calls[0]![0] as { env: Record<string, string> };
    expect(Object.keys(meta.env)).not.toContain("GH_APP_PRIVATE_KEY");
    expect(Object.keys(meta.env)).not.toContain("SERVER_ONLY_SECRET_X");
    expect(meta.env.PAPERCLIP_API_KEY).not.toBe("run-jwt"); // redacted in logs, present in process
    expect(Object.keys(meta.env)).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_RESOLVED_COMMAND"]),
    );
  });

  it("decides model and billing from the narrowed env, not server-held keys", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-server-only");
    vi.stubEnv("ANTHROPIC_MODEL", "server-model");
    const onMeta = vi.fn(async (_meta: unknown) => {});
    const ctx = {
      runId: "run-iso",
      agent: {
        id: "agent-iso",
        companyId: "company-1",
        name: "Review Bot",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        engine: "cli",
        isolateRuntime: true,
        env: {},
      },
      context: {
        taskId: "task-1",
        wakeReason: "issue_assigned",
      },
      authToken: "run-jwt",
      onMeta,
      onLog: vi.fn(async () => {}),
    };

    const result = await execute(ctx as never);

    // The server-held key must not bill `api` for a child that never gets it.
    expect(result.billingType).toBe("subscription");
    // The server-held model must not reach `--model`; the default does.
    const args = spawnCall()[3];
    const modelFlag = args.indexOf("--model");
    expect(modelFlag).toBeGreaterThanOrEqual(0);
    expect(args[modelFlag + 1]).not.toBe("server-model");
    expect(JSON.stringify(args)).not.toContain("server-model");
  });

  it("refuses the ACP engine, which would not apply it", async () => {
    const selection = await resolveClaudeExecutionEngineForRun({
      config: { engine: "acp", isolateRuntime: true },
    });
    expect(selection.unavailableReason).toContain("isolateRuntime");

    const { ctx } = buildContext({ isolate: true, engine: "acp" });
    const result = await execute(ctx as never);
    expect(result.errorCode).toBe("adapter_engine_unavailable");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("refuses a remote execution target instead of running un-isolated", async () => {
    const { ctx } = buildContext({
      isolate: true,
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
    });

    const result = await execute(ctx as never);

    expect(result.errorCode).toBe("adapter_isolation_unsupported");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
