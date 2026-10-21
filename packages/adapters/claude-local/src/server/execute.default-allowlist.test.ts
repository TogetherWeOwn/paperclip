import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  capturedSandboxOptions,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(
    async () => undefined,
  ),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session-1",
        model: "claude-sonnet",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  capturedSandboxOptions: [] as Array<{
    networkScope: unknown;
    networkAllowlist: unknown;
    networkTrustedUrls: unknown;
  }>,
}));

vi.mock("./acp.js", () => ({
  // Constructed at module scope; never invoked because engine always resolves to cli below.
  createClaudeAcpExecutor: () => async () => {
    throw new Error(
      "ACP executor must not run in the CLI default-allowlist tests.",
    );
  },
  resolveClaudeExecutionEngineForRun: async () => ({
    engine: "cli",
    explicit: true,
  }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<
    typeof import("@paperclipai/adapter-utils/execution-target")
  >("@paperclipai/adapter-utils/execution-target");
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/local-process-sandbox", async () => {
  const actual = await vi.importActual<
    typeof import("@paperclipai/adapter-utils/local-process-sandbox")
  >("@paperclipai/adapter-utils/local-process-sandbox");
  return {
    ...actual,
    buildLocalProcessSandboxSpawnTarget: async (
      input: Parameters<typeof actual.buildLocalProcessSandboxSpawnTarget>[0],
    ) => {
      capturedSandboxOptions.push({
        networkScope: input.options.networkScope,
        networkAllowlist: input.options.networkAllowlist,
        networkTrustedUrls: input.options.networkTrustedUrls,
      });
      return actual.buildLocalProcessSandboxSpawnTarget(input);
    },
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
    config: { engine: "cli", ...config },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

function spawnCommand(): string {
  const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
    string,
    unknown,
    string,
  ];
  if (!call)
    throw new Error(
      "expected runAdapterExecutionTargetProcess to have been called",
    );
  return call[2];
}

describe("claude_local default egress allowlist (B2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSandboxOptions.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.runIf(process.platform === "linux")(
    "defaults unset legacy scope to allowlist with provider and GitHub origins",
    async () => {
      await execute(buildContext() as never);

      expect(spawnCommand()).toBe("bwrap");
      expect(capturedSandboxOptions).toHaveLength(1);
      expect(capturedSandboxOptions[0]?.networkScope).toBe("allowlist");
      expect(capturedSandboxOptions[0]?.networkAllowlist).toEqual(
        expect.arrayContaining([
          "api.anthropic.com",
          "github.com",
          "api.github.com",
        ]),
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps explicit allowlist semantics exact (no silent defaults)",
    async () => {
      await execute(
        buildContext({
          networkScope: "allowlist",
          networkAllowlist: ["example.com"],
        }) as never,
      );

      expect(spawnCommand()).toBe("bwrap");
      expect(capturedSandboxOptions).toHaveLength(1);
      expect(capturedSandboxOptions[0]?.networkScope).toBe("allowlist");
      expect(capturedSandboxOptions[0]?.networkAllowlist).toEqual([
        "example.com",
      ]);
    },
  );

  it.runIf(process.platform === "linux")(
    "trusts a custom ANTHROPIC_BASE_URL origin in the default path",
    async () => {
      await execute(
        buildContext({
          env: { ANTHROPIC_BASE_URL: "https://proxy.internal:8443/v1" },
        }) as never,
      );

      expect(capturedSandboxOptions).toHaveLength(1);
      expect(capturedSandboxOptions[0]?.networkAllowlist).toEqual(
        expect.arrayContaining([
          "https://proxy.internal:8443",
          "api.anthropic.com",
        ]),
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "trusts the region Bedrock runtime endpoint when Bedrock auth is bound",
    async () => {
      await execute(
        buildContext({
          env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" },
        }) as never,
      );

      expect(capturedSandboxOptions).toHaveLength(1);
      expect(capturedSandboxOptions[0]?.networkAllowlist).toEqual(
        expect.arrayContaining(["bedrock-runtime.us-west-2.amazonaws.com"]),
      );
    },
  );

  it("fails closed with guidance when ANTHROPIC_BASE_URL is not an absolute HTTP(S) URL", async () => {
    await expect(
      execute(
        buildContext({ env: { ANTHROPIC_BASE_URL: "::not-a-url::" } }) as never,
      ),
    ).rejects.toThrow("ANTHROPIC_BASE_URL must be an absolute HTTP(S) URL");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "linux")(
    "refuses default local runs where Bubblewrap is unavailable",
    async () => {
      await expect(execute(buildContext() as never)).rejects.toThrow(
        "supported only on Linux",
      );
    },
  );
});
