import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

const ECHOED_HARNESS_INSTRUCTION =
  "For that case, explicitly address their exact Paperclip user ID, including any prefix. The server rejects unknown or unauthorized recipients. Do not guess IDs or infer authority from a title.";

function buildContext() {
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
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local terminal result cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the cleanup exit and does not classify an echoed instruction as login required", async () => {
    const unmanagedBackgroundTask = {
      kind: "terminal_result_cleanup",
      stopped: true,
      stopReason: "unmanaged_background_task_stopped",
      reason: "unmanaged background task stopped; no durable live path",
      terminalResultSeen: true,
      signal: "SIGTERM",
      forceKilled: false,
    };
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 143,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "session-1", model: "claude-sonnet" }),
        JSON.stringify({
          type: "user",
          session_id: "session-1",
          message: { content: [{ type: "text", text: ECHOED_HARNESS_INSTRUCTION }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "session-1",
          result: "Done.",
          terminal_reason: "completed",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
      terminalResultCleanup: unmanagedBackgroundTask,
    });

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBe(143);
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.resultJson).toMatchObject({
      is_error: false,
      stop_reason: "end_turn",
      unmanagedBackgroundTask,
    });
  });
});
