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

const BEARER = "Bearer";
const PROJECT_SECRETS = {
  GH_APP_ID: "123",
  GH_APP_ORG: "acme",
  GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
  GH_APP_TOKEN_SOURCE: "broker",
  GH_APP_REPOS: "a,b",
  GH_APP_PERMISSIONS: "contents:write",
  GIT_CONFIG_GLOBAL: "/x/gitconfig",
  GH_CONFIG_DIR: "/x/gh",
};

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

describe("codex execute — isolateRuntime", () => {
  const saved: Record<string, string | undefined> = {};
  let root: string;
  let workspaceDir: string;
  let codexHome: string;

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
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: "codex",
          engine: input.engine ?? "cli",
          outputInactivityTimeoutMs: null,
          ...(input.isolate ? { isolateRuntime: true } : {}),
          env: { OPENAI_API_KEY: "sk-agent", CODEX_HOME: codexHome, ...PROJECT_SECRETS },
        },
        context: {
          taskId: "task-1",
          wakeReason: "issue_assigned",
          paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
          paperclipManagedMcp: {
            managedMcpOnly: true,
            gateways: [{ name: "native-one", endpointPath: "/mcp/gateways/gw_1", bearerToken: "managed-secret" }],
          },
        },
        runtimeMcp: {
          getServers: () => [
            { name: "Paperclip projects", url: "/api/mcp/project-tools", token: "jwt-in-mcp", connectionId: "p" },
          ],
        },
        authToken: "run-jwt",
        executionTarget: input.executionTarget,
        onMeta,
        onLog: vi.fn(async () => {}),
      },
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-isolate-"));
    workspaceDir = path.join(root, "workspace");
    codexHome = path.join(root, "agent-codex-home");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const sharedHome = path.join(root, "shared-codex-home");
    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(path.join(sharedHome, "auth.json"), '{"OPENAI_API_KEY":"sk-shared"}\n', { mode: 0o600 });
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME", "SERVER_ONLY_SECRET_X"]) {
      saved[key] = process.env[key];
    }
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    delete process.env.PAPERCLIP_INSTANCE_ID;
    process.env.CODEX_HOME = sharedHome;
    process.env.SERVER_ONLY_SECRET_X = "server-secret";
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("control: without the flag the run carries the token, project secrets and gateways", async () => {
    let duringRun = "";
    runAdapterExecutionTargetProcess.mockImplementation(async () => {
      duringRun = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
      return exited(0);
    });
    const { ctx } = buildContext({});

    await execute(ctx as never);

    const opts = runAdapterExecutionTargetProcess.mock.calls[0]![4] as {
      env: Record<string, string>;
      inheritServerEnv?: boolean;
    };
    expect(opts.env.PAPERCLIP_API_KEY).toBe("run-jwt");
    expect(opts.env.GH_APP_PRIVATE_KEY).toBe(PROJECT_SECRETS.GH_APP_PRIVATE_KEY);
    expect(opts.inheritServerEnv).toBe(true);
    expect(duringRun).toContain(BEARER);
    expect(duringRun).toContain("jwt-in-mcp");
  });

  it("starts the child from an empty env holding only the allowlist", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(async () => exited(0));
    const { ctx, onMeta } = buildContext({ isolate: true });

    await execute(ctx as never);

    const opts = runAdapterExecutionTargetProcess.mock.calls[0]![4] as {
      env: Record<string, string>;
      inheritServerEnv?: boolean;
    };
    expect(opts.inheritServerEnv).toBe(false);
    expect(opts.env.CODEX_HOME).toBe(codexHome);
    expect(opts.env.OPENAI_API_KEY).toBe("sk-agent");
    expect(opts.env.PAPERCLIP_RUN_ID).toBe("run-iso");
    expect(opts.env.PAPERCLIP_TASK_ID).toBe("task-1");
    for (const key of [...Object.keys(PROJECT_SECRETS), "PAPERCLIP_API_KEY", "PAPERCLIP_API_URL", "SERVER_ONLY_SECRET_X"]) {
      expect(opts.env).not.toHaveProperty(key);
    }
    expect(JSON.stringify(opts.env)).not.toContain("run-jwt");

    // The adapter.invoke record carries the same narrowed key set.
    const meta = onMeta.mock.calls[0]![0] as { env: Record<string, string> };
    expect(Object.keys(meta.env)).not.toContain("GH_APP_PRIVATE_KEY");
    expect(Object.keys(meta.env)).not.toContain("PAPERCLIP_API_KEY");
    expect(Object.keys(meta.env)).toEqual(expect.arrayContaining(["CODEX_HOME", "OPENAI_API_KEY"]));
  });

  it("writes no gateway to config.toml, during or after the run", async () => {
    let duringRun = "";
    runAdapterExecutionTargetProcess.mockImplementation(async () => {
      duringRun = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
      return exited(0);
    });
    const { ctx } = buildContext({ isolate: true });

    await execute(ctx as never);

    const after = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    for (const text of [duringRun, after]) {
      expect(text).not.toContain("mcp_servers");
      expect(text).not.toContain(BEARER);
      expect(text).not.toContain("jwt-in-mcp");
      expect(text).not.toContain("managed-secret");
    }
  });

  it("strips a managed block an earlier build left in the home, keeping user config", async () => {
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        'model = "gpt-5"',
        "",
        "# BEGIN PAPERCLIP MANAGED MCP",
        '[mcp_servers."stale"]',
        'url = "https://x/mcp"',
        'headers = { Authorization = "Bearer stale-token" }',
        "# END PAPERCLIP MANAGED MCP",
        "",
      ].join("\n"),
    );
    runAdapterExecutionTargetProcess.mockImplementation(async () => exited(0));
    const { ctx } = buildContext({ isolate: true });

    await execute(ctx as never);

    const after = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(after).toContain('model = "gpt-5"');
    expect(after).not.toContain("stale-token");
    expect(after).not.toContain("mcp_servers");
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

  it("refuses the ACP engine, which would not apply it", async () => {
    const { ctx } = buildContext({ isolate: true, engine: "acp" });

    const result = await execute(ctx as never);

    expect(result.errorCode).toBe("adapter_engine_unavailable");
    expect(result.errorMessage).toContain("isolateRuntime");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
