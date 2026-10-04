import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => vi.fn(),
  formatCodexAcpFallbackMessage: (reason: string) => reason,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

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

const BEARER_LINE = 'Authorization = "Bearer';

function exited(exitCode: number) {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: exitCode === 0 ? "" : "Error: boom",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("codex execute — managed MCP block does not outlive the run", () => {
  const saved: Record<string, string | undefined> = {};
  let root: string;
  let workspaceDir: string;

  function managedConfigPath(companyId: string): string {
    return path.join(root, "paperclip-home", "instances", "default", "companies", companyId, "codex-home", "config.toml");
  }

  function readConfig(configPath: string): Promise<string> {
    return fs.readFile(configPath, "utf8");
  }

  function buildContext(input: {
    runId: string;
    companyId?: string;
    agentId?: string;
    token: string;
    env?: Record<string, string>;
  }) {
    return {
      runId: input.runId,
      agent: {
        id: input.agentId ?? "agent-1",
        companyId: input.companyId ?? "company-1",
        name: "Codex Coder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        engine: "cli",
        outputInactivityTimeoutMs: null,
        env: { OPENAI_API_KEY: "test-key", ...input.env },
      },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
        paperclipManagedMcp: {
          managedMcpOnly: true,
          gateways: [{
            name: "Paperclip projects",
            endpointPath: "/api/tool-gateway/gateways/projects/mcp",
            bearerToken: `token-${input.runId}`,
          }],
        },
      },
      onLog: vi.fn(async () => {}),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-scrub-"));
    workspaceDir = path.join(root, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sharedHome = path.join(root, "shared-codex-home");
    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(path.join(sharedHome, "auth.json"), '{"OPENAI_API_KEY":"sk-shared"}\n', { mode: 0o600 });
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME"]) saved[key] = process.env[key];
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    delete process.env.PAPERCLIP_INSTANCE_ID;
    process.env.CODEX_HOME = sharedHome;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is present while the run is live and gone after a successful run", async () => {
    const configPath = managedConfigPath("company-1");
    let duringRun = "";
    runAdapterExecutionTargetProcess.mockImplementation(async () => {
      duringRun = await readConfig(configPath);
      return exited(0);
    });

    await execute(buildContext({ runId: "run-ok", token: "t" }) as never);

    expect(duringRun).toContain(`${BEARER_LINE} token-run-ok"`);
    const after = await readConfig(configPath);
    expect(after).not.toContain(BEARER_LINE);
    expect(after).not.toContain("token-run-ok");
    expect(after).not.toContain("PAPERCLIP MANAGED MCP");
  });

  it("is removed after a failed run", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(async () => exited(1));

    const result = await execute(buildContext({ runId: "run-fail", token: "t" }) as never);

    expect(result.exitCode).toBe(1);
    expect(await readConfig(managedConfigPath("company-1"))).not.toContain(BEARER_LINE);
  });

  it("is removed when the run throws or is cancelled mid-flight", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(async () => {
      throw new Error("run cancelled");
    });

    await expect(execute(buildContext({ runId: "run-cancel", token: "t" }) as never)).rejects.toThrow(
      "run cancelled",
    );

    expect(await readConfig(managedConfigPath("company-1"))).not.toContain(BEARER_LINE);
  });

  it("keeps user-authored config and removes only the managed block", async () => {
    const configPath = managedConfigPath("company-1");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'model = "gpt-5"\n\n[mcp_servers.mine]\nurl = "https://mine.example/mcp"\n');
    runAdapterExecutionTargetProcess.mockImplementation(async () => exited(0));

    await execute(buildContext({ runId: "run-keep", token: "t" }) as never);

    const after = await readConfig(configPath);
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain("[mcp_servers.mine]");
    expect(after).not.toContain(BEARER_LINE);
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("leaves the block of a run that is still live when another run on the same home ends first", async () => {
    const configPath = managedConfigPath("company-1");
    const aStarted = deferred();
    const aMayFinish = deferred();
    let configSeenByLiveRunAfterB = "";
    runAdapterExecutionTargetProcess.mockImplementation(async (...args: unknown[]) => {
      const runId = String(args[0]);
      if (runId === "run-a") {
        aStarted.resolve();
        await aMayFinish.promise;
        configSeenByLiveRunAfterB = await readConfig(configPath);
      }
      return exited(0);
    });

    const runA = execute(buildContext({ runId: "run-a", agentId: "agent-a", token: "a" }) as never);
    await aStarted.promise;
    await execute(buildContext({ runId: "run-b", agentId: "agent-b", token: "b" }) as never);

    // B has finished while A is still running on the shared home: the block must survive.
    expect(await readConfig(configPath)).toContain(BEARER_LINE);
    aMayFinish.resolve();
    await runA;

    expect(configSeenByLiveRunAfterB).toContain(BEARER_LINE);
    const after = await readConfig(configPath);
    expect(after).not.toContain(BEARER_LINE);
    expect(after).not.toContain("PAPERCLIP MANAGED MCP");
  });

  it("does not touch a user-supplied CODEX_HOME", async () => {
    const externalHome = path.join(root, "external-codex-home");
    await fs.mkdir(externalHome, { recursive: true });
    await fs.writeFile(path.join(externalHome, "auth.json"), '{"OPENAI_API_KEY":"sk-external"}\n', { mode: 0o600 });
    runAdapterExecutionTargetProcess.mockImplementation(async () => exited(0));

    await execute(buildContext({ runId: "run-ext", token: "t", env: { CODEX_HOME: externalHome } }) as never);

    // Unchanged contract: Paperclip wrote the block for this run and does not clean up a home it does not own.
    expect(await readConfig(path.join(externalHome, "config.toml"))).toContain(`${BEARER_LINE} token-run-ext"`);
  });
});
