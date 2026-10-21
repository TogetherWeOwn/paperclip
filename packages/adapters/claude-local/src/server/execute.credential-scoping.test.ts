/**
 * Credential-to-destination scoping acceptance tests: legacy child-env
 * separation (T1), missing-skill fail-closed at launch (T6 execute half),
 * and required sandbox default (T7.5).
 *
 * M1 (the credential control): the legacy/local child env must hold a
 * host-worthless bridge token plus a loopback bridge URL; the host JWT must
 * never enter the child env. These tests call the real `execute()` with the
 * child spawn intercepted (`runChildProcess` mock) and assert on the exact
 * env the child would receive.
 *
 * The `startAdapterExecutionTargetPaperclipBridge` mock below pins the
 * execute-level env *wiring*, not bridge internals: legacy never calls it
 * today (remote-only gate), so T1.1–T1.3 fail on the wiring gap; after B1
 * extends the gate, the mocked bridge supplies the loopback env and they
 * pass. Real bridge behavior is pinned unmocked in
 * execution-target.credential-scoping.test.ts. Builder must not edit this file.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]): Promise<RunProcessResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: args.includes("--version")
      ? "2.1.280 (Claude Code)\n"
      : [
          JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
          JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }),
          JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "SYNTHETIC-BRIDGE-TOKEN-0001",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

// Synthetic credentials. The host JWT is JWT-shaped (three dot segments);
// nothing here is a real credential and nothing leaves the test process.
const SYNTHETIC_HOST_JWT = "c3ludGhldGljLWxlZ2FjeS1ob3N0.SU5KRy1IQ09TVC1UT0tFTg.c3ludGhldGljLXNpZ25hdHVyZQ";
const SYNTHETIC_HOST_URL = "https://paperclip-host.invalid";

describe("legacy child-env credential separation", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function localWorkspace() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-credscoping-legacy-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const instructionsPath = path.join(rootDir, "instructions.md");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(instructionsPath, "Do the scoped task.\n", "utf8");
    return { rootDir, workspaceDir, instructionsPath };
  }

  function childSpawnEnv(): Record<string, string> {
    const calls = runChildProcess.mock.calls as unknown as Array<[string, string, string[], { env?: Record<string, string> }]>;
    const main = calls.find((call) => call[2].includes("--add-dir")) ?? calls.at(-1);
    if (!main?.[3]?.env) throw new Error("Expected the child spawn env to be captured by the runChildProcess mock.");
    return main[3].env;
  }

  function childSpawnCommand(): { command: string; args: string[] } {
    const calls = runChildProcess.mock.calls as unknown as Array<[string, string, string[], { env?: Record<string, string> }]>;
    const main = calls.find((call) => call[2].includes("--add-dir")) ?? calls.at(-1);
    if (!main) throw new Error("Expected a child spawn call.");
    return { command: main[1], args: main[2] };
  }

  async function executeLocal(input?: {
    authToken?: string;
    apiUrl?: string;
    paperclipRuntimeSkills?: unknown;
    networkScope?: unknown;
  }) {
    // buildPaperclipEnv seeds PAPERCLIP_API_URL from the harness process env
    // and runtime PAPERCLIP_* wins over config, so stub the host URL for a
    // deterministic synthetic host origin (afterEach unstubs).
    vi.stubEnv("PAPERCLIP_API_URL", input?.apiUrl ?? SYNTHETIC_HOST_URL);
    const { workspaceDir, instructionsPath } = await localWorkspace();
    return execute({
      runId: "run-scoping",
      authToken: input?.authToken ?? SYNTHETIC_HOST_JWT,
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
      config: {
        engine: "cli",
        command: "claude",
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: input?.paperclipRuntimeSkills ?? [],
        networkScope: input?.networkScope,
        env: {
          PAPERCLIP_API_URL: input?.apiUrl ?? SYNTHETIC_HOST_URL,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/scoping",
          worktreePath: workspaceDir,
        },
      },
      onLog: async () => {},
    });
  }

  it("T1.1: the legacy child env carries a bridge token, never the host JWT", async () => {
    await executeLocal();
    const env = childSpawnEnv();
    expect(env.PAPERCLIP_API_KEY).toBeDefined();
    expect(env.PAPERCLIP_API_KEY).not.toBe(SYNTHETIC_HOST_JWT);
    expect(env.PAPERCLIP_API_KEY).not.toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("T1.2: the legacy child env points PAPERCLIP_API_URL at the loopback bridge", async () => {
    await executeLocal();
    const env = childSpawnEnv();
    const apiUrl = new URL(env.PAPERCLIP_API_URL ?? "invalid:");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(apiUrl.hostname);
    expect(env.PAPERCLIP_API_URL).not.toBe(SYNTHETIC_HOST_URL);
  });

  it("T1.3: the host-JWT canary is absent from the entire legacy child env snapshot", async () => {
    await executeLocal();
    const env = childSpawnEnv();
    const snapshot = JSON.stringify(env);
    expect(snapshot).not.toContain(SYNTHETIC_HOST_JWT);
    expect(snapshot).not.toContain("SYNTH-CANARY");
  });

  it("T1.4 (remote parity control): the remote child env holds a bridge token plus a loopback URL", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", SYNTHETIC_HOST_URL);
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-credscoping-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const instructionsPath = path.join(rootDir, "instructions.md");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(instructionsPath, "Use the remote workspace.\n", "utf8");

    await execute({
      runId: "run-scoping-remote",
      authToken: SYNTHETIC_HOST_JWT,
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
      config: {
        engine: "cli",
        command: "claude",
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [],
        env: {
          PAPERCLIP_API_URL: SYNTHETIC_HOST_URL,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/scoping",
          worktreePath: workspaceDir,
        },
      },
      executionTransport: {
        remoteExecution: {
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
      onLog: async () => {},
    });

    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalled();
    const env = childSpawnEnv();
    expect(env.PAPERCLIP_API_KEY).toBe("SYNTHETIC-BRIDGE-TOKEN-0001");
    expect(env.PAPERCLIP_API_KEY).not.toBe(SYNTHETIC_HOST_JWT);
    const apiUrl = new URL(env.PAPERCLIP_API_URL ?? "invalid:");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(apiUrl.hostname);
    expect(env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(JSON.stringify(env)).not.toContain(SYNTHETIC_HOST_JWT);
  });

  it("T6-exec: a desired skill with missing source refuses to launch instead of running unguided", async () => {
    await expect(
      executeLocal({
        paperclipRuntimeSkills: [
          {
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: path.join(os.tmpdir(), "paperclip-scoping-missing-skill"),
            sourceStatus: "missing",
            missingDetail: "synthetic fixture: skill files unavailable",
          },
        ],
      }),
    ).rejects.toThrow(/skill/i);
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("T7.5: the legacy default confines the child (no open network without an explicit scope)", async () => {
    await executeLocal();
    const spawn = childSpawnCommand();
    const argv = JSON.stringify([spawn.command, ...spawn.args]);
    expect(argv).toMatch(/bwrap|--unshare-net/);
  });
});
