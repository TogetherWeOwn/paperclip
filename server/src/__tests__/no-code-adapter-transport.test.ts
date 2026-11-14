import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async (_input: { localDir: string }) => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: Buffer.from("{}").toString("base64"),
    stderr: "",
  })),
  runChildProcess: vi.fn(
    async (_runId: string, _command: string, args: string[]) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: args.includes("--version")
        ? "2.1.280 (Claude Code)\n"
        : [
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "fixture-session",
            }),
            JSON.stringify({
              type: "result",
              session_id: "fixture-session",
              result: "done",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    }),
  ),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "fixture-bridge",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<
    typeof import("@paperclipai/adapter-utils/server-utils")
  >("@paperclipai/adapter-utils/server-utils");
  return {
    ...actual,
    runChildProcess: transport.runChildProcess,
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "/fixture/provider"),
  };
});
vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<
    typeof import("@paperclipai/adapter-utils/ssh")
  >("@paperclipai/adapter-utils/ssh");
  return {
    ...actual,
    prepareWorkspaceForSshExecution: transport.prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution:
      transport.restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh: transport.syncDirectoryToSsh,
    runSshCommand: transport.runSshCommand,
  };
});
vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<
    typeof import("@paperclipai/adapter-utils/execution-target")
  >("@paperclipai/adapter-utils/execution-target");
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge:
      transport.startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute as executeClaude } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";

// Real adapter and managed-runtime code, fake process/SSH I/O only. This catches
// an adapter which ignores the task's no-code mode and still bundles/tars a cwd.
describe.each([
  { adapterType: "codex_local", execute: executeCodex },
  { adapterType: "claude_local", execute: executeClaude },
])("$adapterType no-code transport", ({ adapterType, execute }) => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function invoke(mode: string | null) {
    const root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "no-code-transport-",
      ),
    );
    const cwd = path.join(root, "ordinary-directory");
    const home = path.join(root, "isolated-provider-home");
    await mkdir(cwd);
    await mkdir(home);
    const result = await execute({
      runId: `transport-${adapterType}-${mode ?? "unspecified"}`,
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
        taskKey: "fixture-task",
      },
      config: {
        engine: "cli",
        command: adapterType === "codex_local" ? "codex" : "claude",
        env: { CODEX_HOME: home },
      },
      context: {
        issueId: "fixture-task",
        paperclipWorkspace: {
          cwd,
          source: "agent_home",
          ...(mode ? { mode } : {}),
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/ordinary",
          remoteCwd: "/remote/ordinary",
          privateKey: "fixture-private-key-not-a-credential",
          knownHosts: "fixture-known-hosts",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });
    return { result, cwd };
  }

  it("executes explicit no-code without repository seed, restore, git/bundle/tar workspace transfer", async () => {
    const { result, cwd } = await invoke("no_code");

    expect(result.exitCode).toBe(0);
    expect(transport.runChildProcess).toHaveBeenCalled();
    expect(transport.prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(transport.restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    // Runtime instruction/auth/skill assets remain allowed. The working tree isn't an asset.
    expect(
      transport.syncDirectoryToSsh.mock.calls.some(
        (args) => (args[0] as { localDir?: string })?.localDir === cwd,
      ),
    ).toBe(false);
  });

  it.each([null, "isolated_workspace", "agent_default"])(
    "retains workspace transfers for ordinary mode %s",
    async (mode) => {
      const { result, cwd } = await invoke(mode);

      expect(result.exitCode).toBe(0);
      expect(transport.prepareWorkspaceForSshExecution).toHaveBeenCalledWith(
        expect.objectContaining({ localDir: cwd }),
      );
      expect(transport.restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(
        expect.objectContaining({ localDir: cwd }),
      );
    },
  );
});
