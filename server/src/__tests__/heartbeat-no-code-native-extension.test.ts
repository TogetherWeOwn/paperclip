import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  agents,
  environmentLeases,
  environments,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureNativeCompletionContract } from "../services/native-runtime/completion-contracts.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  noCodeSettings,
  openNoCodeTestDatabase,
  seedNoCodeWorkspaceFixture,
} from "./helpers/no-code-workspace-fixtures.js";

const external = vi.hoisted(() => ({
  acquire: vi.fn(),
  realize: vi.fn(),
  release: vi.fn(async () => ({ released: [], errors: [] })),
  workspaceSync: vi.fn(async () => null),
  adapter: vi.fn(),
}));
vi.mock("../services/environment-run-orchestrator.js", async () => ({
  ...(await vi.importActual<
    typeof import("../services/environment-run-orchestrator.js")
  >("../services/environment-run-orchestrator.js")),
  environmentRunOrchestrator: () => ({
    acquireForRun: external.acquire,
    realizeForRun: external.realize,
    releaseForRun: external.release,
  }),
}));
vi.mock("../services/native-runtime/native-workspace-sync.js", async () => ({
  ...(await vi.importActual<
    typeof import("../services/native-runtime/native-workspace-sync.js")
  >("../services/native-runtime/native-workspace-sync.js")),
  // This is the forbidden working-tree seed/restore boundary. Keep the heartbeat
  // native selection, immutable-input persistence and recovery path real.
  prepareNativeWorkspaceSync: external.workspaceSync,
}));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "paperclip_runner",
    execute: external.adapter,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "paperclip_runner",
    execute: external.adapter,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

function scratchRunner(home: string): CommandManagedRuntimeRunner {
  return {
    execute: async (input) =>
      new Promise((resolve, reject) => {
        const child = spawn(input.command, input.args ?? [], {
          cwd: input.cwd,
          env: { PATH: process.env.PATH, HOME: home, ...input.env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data.toString();
        });
        child.stderr.on("data", (data) => {
          stderr += data.toString();
        });
        child.on("error", reject);
        child.on("close", (exitCode, signal) =>
          resolve({
            exitCode,
            signal,
            timedOut: false,
            stdout,
            stderr,
            pid: child.pid ?? null,
            startedAt: new Date().toISOString(),
          }),
        );
        if (input.stdin != null) child.stdin.write(input.stdin);
        child.stdin.end();
      }),
  };
}

type NativeInput = {
  binding: { runId: string; executionWorkspaceId: string };
  workspace: {
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  session: { normalizedSessionId: string | null };
};

// Focused production heartbeat seam, not live sandbox/native qualification.
// Wrongly calling native workspace sync or requiring a durable code binding for
// immutable transient no-code recovery must fail without opening any provider.
describe("native no-code dispatch and immutable-input recovery extension", () => {
  let temporary: Awaited<ReturnType<typeof openNoCodeTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;
  const providerInputs: NativeInput[] = [];
  const factory = vi.fn((input: NativeInput) => {
    providerInputs.push(input);
    throw new Error("acceptance_provider_boundary_reached");
  });

  beforeAll(async () => {
    root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "no-code-native-extension-",
      ),
    );
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    temporary = await openNoCodeTestDatabase();
    await instanceSettingsService(temporary.db).updateExperimental({
      enableNativeRunner: true,
      enableIsolatedWorkspaces: true,
      enableManagedSandboxOnly: false,
    });
    external.acquire.mockImplementation(
      async (input: {
        companyId: string;
        selectedEnvironmentId: string;
        issueId: string;
        heartbeatRunId: string;
      }) => {
        const [environment] = await temporary.db
          .select()
          .from(environments)
          .where(eq(environments.id, input.selectedEnvironmentId));
        const [lease] = await temporary.db
          .insert(environmentLeases)
          .values({
            companyId: input.companyId,
            environmentId: input.selectedEnvironmentId,
            issueId: input.issueId,
            heartbeatRunId: input.heartbeatRunId,
            provider: "test-only",
            providerLeaseId: "scratch-provider-lease",
          })
          .returning();
        return {
          environment,
          lease,
          leaseContext: { executionWorkspaceId: null },
          executionTransport: null,
        };
      },
    );
    external.realize.mockImplementation(
      async (input: {
        lease: unknown;
        heartbeatRunId: string;
        executionWorkspace: { cwd: string };
      }) => {
        const remoteCwd = path.join(
          root,
          "authorized-environment-root",
          input.heartbeatRunId,
        );
        await mkdir(remoteCwd, { recursive: true });
        const home = path.join(root, "sandbox-home");
        await mkdir(home, { recursive: true });
        return {
          lease: input.lease,
          workspaceRealization: { mode: "copy", authoritativeRoot: remoteCwd },
          persistedExecutionWorkspace: null,
          remoteExecution: null,
          executionTarget: {
            kind: "remote",
            transport: "sandbox",
            providerKey: "test-only",
            remoteCwd,
            sandboxLeaseAcquisition: {
              outcome: "created",
              providerLeaseId: "scratch-provider-lease",
            },
            runner: scratchRunner(home),
          },
        };
      },
    );
    heartbeat = heartbeatService(temporary.db, {
      runtimeEnv: {},
      nativeSessionBackendFactory: factory,
    });
  }, 120_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(temporary.db, heartbeat);
    vi.clearAllMocks();
    providerInputs.length = 0;
  });
  afterAll(async () => {
    if (temporary && heartbeat)
      await drainHeartbeatRunsToQuiescence(temporary.db, heartbeat);
    await temporary?.close();
    vi.unstubAllEnvs();
  }, 60_000);

  async function fresh() {
    const f = await seedNoCodeWorkspaceFixture(temporary.db);
    const environmentId = randomUUID();
    await temporary.db.insert(environments).values({
      id: environmentId,
      name: `Scratch native environment ${environmentId}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "daytona" },
    });
    await temporary.db
      .update(agents)
      .set({
        adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
        defaultEnvironmentId: environmentId,
      })
      .where(eq(agents.id, f.agentId));
    await temporary.db
      .update(issues)
      .set({ executionWorkspaceSettings: noCodeSettings })
      .where(eq(issues.id, f.issueId));
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      contextSnapshot: {
        issueId: f.issueId,
        taskId: f.issueId,
        taskKey: f.issueId,
        projectId: f.projectId,
        wakeReason: "manual",
      },
    });
    if (!run) throw new Error("Expected admitted native fixture run");
    await heartbeat.drainActiveRunExecutions();
    const settled = await heartbeat.getRun(run.id);
    if (!settled) throw new Error("Expected persisted native fixture run");
    return { ...f, run: settled };
  }

  it("fresh paperclip_runner no-code never prepares a native working-tree seed/restore", async () => {
    const f = await fresh();
    expect(providerInputs).toHaveLength(1);
    expect(f.run.error).toContain("acceptance_provider_boundary_reached");
    expect(providerInputs[0]?.workspace).toMatchObject({
      repoUrl: null,
      repoRef: null,
      branchName: null,
    });
    expect(external.workspaceSync).not.toHaveBeenCalled();
    expect(external.adapter).not.toHaveBeenCalled();
  }, 30_000);

  async function queuedNativeInput(codeBinding = false) {
    const f = await seedNoCodeWorkspaceFixture(temporary.db);
    const runId = randomUUID();
    const environmentId = randomUUID();
    const sessionId = randomUUID();
    await temporary.db.insert(environments).values({
      id: environmentId,
      name: `Recovery native environment ${environmentId}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "daytona" },
    });
    await temporary.db
      .update(agents)
      .set({
        adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
        defaultEnvironmentId: environmentId,
      })
      .where(eq(agents.id, f.agentId));
    const [issue] = await temporary.db
      .update(issues)
      .set({ executionWorkspaceSettings: noCodeSettings })
      .where(eq(issues.id, f.issueId))
      .returning();
    if (!issue) throw new Error("Expected recovery fixture issue");
    const completion = await ensureNativeCompletionContract({
      db: temporary.db,
      companyId: f.companyId,
      issue,
      actorId: f.agentId,
    });
    const cwd = path.join(
      resolveDefaultAgentWorkspaceDir(f.agentId),
      "no-code",
      f.issueId,
    );
    await mkdir(cwd, { recursive: true });
    const execution = buildNativeExecutionInput({
      companyId: f.companyId,
      runId,
      agentId: f.agentId,
      issue,
      taskPrompt:
        "Resume the admitted report without adopting any repository workspace",
      workspace: {
        id: codeBinding ? f.executionWorkspaceId : runId,
        cwd,
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      normalizedSessionId: sessionId,
      provider: "codex",
      model: "gpt-5.6-luna",
      completionContract: {
        id: completion.row.id,
        sha256: completion.row.canonicalSha256,
        schemaVersion: "paperclip.run-result.v1",
        contract: completion.contract,
      },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    // Simulate restart after immutable admission, before provider work. There is
    // no failed previous execution or live PID to bypass or replay.
    await temporary.db.insert(heartbeatRuns).values({
      id: runId,
      companyId: f.companyId,
      agentId: f.agentId,
      status: "queued",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      runnerInstanceId: randomUUID(),
      nativeSessionId: sessionId,
      nativeIssueId: f.issueId,
      completionContractId: completion.row.id,
      completionContractSha256: completion.row.canonicalSha256,
      runnerProfileJson: { nativeExecutionInput: execution },
      contextSnapshot: {
        issueId: f.issueId,
        taskId: f.issueId,
        taskKey: f.issueId,
        projectId: f.projectId,
        wakeReason: "manual",
      },
    });
    await temporary.db.insert(nativeRunFinalizations).values({
      companyId: f.companyId,
      issueId: f.issueId,
      runId,
      phase: "observed",
    });
    return { ...f, runId, execution };
  }

  it("queued native recovery retains its own immutable transient no-code input without adopting code binding/checkpoint", async () => {
    const f = await queuedNativeInput();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const recovered = await heartbeat.getRun(f.runId);
    expect(recovered?.error).toContain("acceptance_provider_boundary_reached");
    expect(providerInputs).toHaveLength(1);
    expect(providerInputs[0]).toEqual(f.execution);
    expect(recovered?.runnerProfileJson?.nativeExecutionInput).toEqual(
      f.execution,
    );
    expect(recovered?.runnerProfileJson?.sessionCheckpoint).toBeUndefined();
    expect(external.workspaceSync).not.toHaveBeenCalled();
    expect(
      (
        await temporary.db.select().from(issues).where(eq(issues.id, f.issueId))
      )[0]?.executionWorkspaceId,
    ).toBeNull();
  }, 30_000);

  it("native no-code recovery refuses a checkpoint belonging to an earlier code-provider run", async () => {
    const f = await queuedNativeInput();
    const checkpoint = {
      backendKind: "codex_app_server",
      sessionId: "old-code-driver-session",
      identity: {
        companyId: f.companyId,
        agentId: f.agentId,
        issueId: f.issueId,
        runId: randomUUID(),
        sessionId: randomUUID(),
      },
      providerSessionId: "old-code-provider-session",
      cursor: "1",
      activeTurnId: null,
      pendingRuntimeRequests: [],
      lineage: [],
    };
    await temporary.db
      .update(heartbeatRuns)
      .set({
        runnerProfileJson: {
          nativeExecutionInput: f.execution,
          sessionCheckpoint: checkpoint,
        },
      })
      .where(eq(heartbeatRuns.id, f.runId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const recovered = await heartbeat.getRun(f.runId);
    expect(recovered?.error).toMatch(/no.code|checkpoint|session|workspace/i);
    expect(providerInputs).toHaveLength(0);
    expect(external.workspaceSync).not.toHaveBeenCalled();
    expect(recovered?.runnerProfileJson?.nativeExecutionInput).toEqual(
      f.execution,
    );
    expect(recovered?.runnerProfileJson?.sessionCheckpoint).toEqual(checkpoint);
  }, 30_000);

  it("native no-code recovery rejects an immutable code-workspace binding before environment/provider work", async () => {
    const f = await queuedNativeInput(true);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const recovered = await heartbeat.getRun(f.runId);
    expect(recovered?.error).toMatch(/no.code|conflict|workspace/i);
    expect(providerInputs).toHaveLength(0);
    expect(external.acquire).not.toHaveBeenCalled();
    expect(external.workspaceSync).not.toHaveBeenCalled();
    expect(recovered?.runnerProfileJson?.nativeExecutionInput).toEqual(
      f.execution,
    );
  }, 30_000);
});
