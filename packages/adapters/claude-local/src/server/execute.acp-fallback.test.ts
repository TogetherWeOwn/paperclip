import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  prepareAdapterExecutionTargetRuntime,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(async (_input: Record<string, unknown>): Promise<never> => { throw new Error("STOP_AT_REMOTE_STAGING"); }),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
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

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    prepareAdapterExecutionTargetRuntime,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not start CLI after default ACP fails", async () => {
    const ctx = buildContext();
    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ engine: "cli", networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("does not forward ambient controller credentials to certified SSH probes", async () => {
    vi.stubEnv("GH_TOKEN", "PRIMARY_GITHUB_SECRET");
    vi.stubEnv("DATABASE_URL", "PRIMARY_DATABASE_SECRET");
    vi.stubEnv("ANTHROPIC_API_KEY", "PRIMARY_MODEL_SECRET");
    vi.stubEnv("PAPERCLIP_API_URL", "https://controller.example.test");
    const ctx = {
      ...buildContext({ engine: "cli", env: { HOME: "/home/paperclip-shadow/run", CLAUDE_CONFIG_DIR: "/home/paperclip-shadow/run/.claude",
        ANTHROPIC_AUTH_TOKEN: "explicit-shadow-token" } }),
      executionTarget: { kind: "remote", transport: "ssh", remoteCwd: "/home/paperclip-shadow/run/workspace",
        githubCandidateIsolation: { namespace: "run", home: "/home/paperclip-shadow/run" },
        spec: { host: "127.0.0.1", port: 22, username: "paperclip-shadow", remoteWorkspacePath: "/home/paperclip-shadow/run/workspace",
          remoteCwd: "/home/paperclip-shadow/run/workspace", privateKey: null, knownHosts: "fixture", strictHostKeyChecking: true } },
    };
    ensureAdapterExecutionTargetCommandResolvable.mockImplementationOnce(async (...args: unknown[]) => {
      const env = args[3];
      expect(JSON.stringify(env)).not.toContain("PRIMARY_");
      expect(env).toMatchObject({ HOME: "/home/paperclip-shadow/run", ANTHROPIC_AUTH_TOKEN: "explicit-shadow-token", PAPERCLIP_API_URL: "http://127.0.0.1:3100" });
      throw new Error("STOP_BEFORE_REMOTE_STAGING");
    });
    await expect(execute(ctx as never)).rejects.toThrow("STOP_BEFORE_REMOTE_STAGING");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("never syncs or restores over a certified candidate's materialised checkout", async () => {
    const spec = { host: "127.0.0.1", port: 22, username: "paperclip-shadow", remoteWorkspacePath: "/home/paperclip-shadow/run/workspace",
      remoteCwd: "/home/paperclip-shadow/run/workspace", privateKey: null, knownHosts: "fixture", strictHostKeyChecking: true };
    const base = buildContext({ engine: "cli", env: { HOME: "/home/paperclip-shadow/run", CLAUDE_CONFIG_DIR: "/home/paperclip-shadow/run/.claude",
      ANTHROPIC_AUTH_TOKEN: "explicit-shadow-token" } });
    for (const candidate of [true, false]) {
      prepareAdapterExecutionTargetRuntime.mockClear();
      await expect(execute({ ...base, executionTarget: { kind: "remote", transport: "ssh", remoteCwd: spec.remoteCwd, environmentId: "env",
        ...(candidate ? { githubCandidateIsolation: { namespace: "run", home: "/home/paperclip-shadow/run" } } : {}), spec } } as never))
        .rejects.toThrow("STOP_AT_REMOTE_STAGING");
      expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledOnce();
      expect(prepareAdapterExecutionTargetRuntime.mock.calls[0]![0].syncWorkspace).toBe(candidate ? false : undefined);
    }
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
