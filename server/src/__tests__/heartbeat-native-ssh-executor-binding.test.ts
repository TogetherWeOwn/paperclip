import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The SSH transport itself is out of scope for this binding test: the
// heartbeat's pre-dispatch Git-context probe would run a shell over real SSH.
// Everything else in the module stays real, including the dispatch gate.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>()),
  prepareGitHubExecutionEnvironment: async () => ({}),
}));
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  environments,
  issues,
  plugins,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  getActiveNativeSshHostExecutor,
  createEd25519NativeSshEnvelopeVerifier,
} from "@paperclipai/adapter-utils/host-executor";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { aiConnectionService } from "../services/ai-connections.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping native SSH heartbeat binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat native SSH executor binding", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // What the fake adapter observed inside adapter.execute.
  const observed: Array<ReturnType<typeof getActiveNativeSshHostExecutor>> = [];
  const execute = vi.fn<ServerAdapterModule["execute"]>(async () => {
    observed.push(getActiveNativeSshHostExecutor());
    await new Promise((resolve) => setTimeout(resolve, 10));
    observed.push(getActiveNativeSshHostExecutor());
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "test",
      model: "test-model",
      summary: "Fake adapter summary.",
      resultJson: {},
    };
  });

  const keys = generateKeyPairSync("ed25519");
  const signerCalls: unknown[] = [];

  function fakeRuntime() {
    return {
      acquireRunLease: async () => ({
        lease: {
          id: randomUUID(),
          provider: "ssh",
          providerLeaseId: "test-ssh-lease",
          metadata: { remoteCwd: "/srv/paperclip/run" },
        },
        leaseContext: { executionWorkspaceId: null, executionWorkspaceMode: null },
      }),
      realizeWorkspace: async () => ({ cwd: "/srv/paperclip/run", metadata: {} }),
      execute: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      getDriver: () => ({ releaseRunLease: async () => undefined }),
      releaseRunLeases: async () => [],
      destroyRunLease: async () => undefined,
      syncIn: async () => ({}),
      syncOut: async () => ({}),
    };
  }

  function managerWithDecide() {
    return {
      isRunning: () => true,
      call: async (_pluginId: string, method: string) => {
        expect(method).toBe("resolveRunModel");
        return { kind: "decide", decisionId: "test-decision-1", model: "claude-opus-5", source: "test" };
      },
    } as unknown as PluginWorkerManager;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-native-ssh-binding-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: "claude_local",
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({
        adapterType: "claude_local",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    observed.length = 0;
    signerCalls.length = 0;
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "environment_leases",
        "environments",
        "issues",
        "plugins",
        "agents",
        "ai_connection_defaults",
        "tool_connection_installs",
        "tool_connections",
        "connection_grants",
        "company_memberships",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    unregisterServerAdapter("claude_local");
    await tempDb?.cleanup();
  });

  async function seedSshAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const [environment] = await db
      .insert(environments)
      .values({
        name: "Binding SSH",
        driver: "ssh",
        status: "active",
        config: {
          host: "ssh.example.test",
          port: 22,
          username: "paperclip",
          remoteWorkspacePath: "/srv/paperclip/run",
          privateKey: null,
          privateKeySecretRef: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      })
      .returning();
    await db.insert(companies).values({
      id: companyId,
      name: "Binding Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Binding Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      defaultEnvironmentId: environment.id,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Binding issue",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId, environmentId: environment.id };
  }

  async function seedModelRouterPlugin() {
    const manifest = {
      id: "test.model-router",
      version: "1.0.0",
      name: "Test model router",
      capabilities: ["run.model.resolve"],
      modelRouting: { envKeys: [] },
    };
    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: manifest.id,
        packageName: "@test/model-router",
        version: manifest.version,
        apiVersion: 1,
        categories: [],
        manifestJson: manifest as never,
        status: "ready",
      })
      .returning();
    return plugin;
  }

  it("binds the run's executor around adapter.execute on SSH targets", async () => {
    const { agentId, issueId } = await seedSshAgent();
    await seedModelRouterPlugin();
    const settings = instanceSettingsService(db);
    const previousExperimental = await settings.getExperimental();
    const previousSwitch = process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY;
    process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY = "required";
    await settings.updateExperimental({ requireRunModelDecision: true });
    try {
      const heartbeat = heartbeatService(db, {
        environmentRuntime: fakeRuntime() as never,
        pluginWorkerManager: managerWithDecide(),
        nativeSshSigner: {
          requestEnvelope: async (request: unknown) => {
            signerCalls.push(request);
            throw new Error("signer must not be called: the fake adapter launches nothing");
          },
        },
        nativeSshEnvelopeVerifier: createEd25519NativeSshEnvelopeVerifier(
          keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        ),
      });
      const queued = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);

      expect(execute).toHaveBeenCalledOnce();
      expect(finished?.status).toBe("succeeded");
      // The run's executor is bound for the whole adapter call: non-null, the
      // same object across an await, and nothing launched through the signer.
      expect(observed).toHaveLength(2);
      expect(observed[0]).not.toBeNull();
      expect(observed[0]).toBe(observed[1]);
      expect(observed[0]).toMatchObject({ kind: "native_ssh" });
      expect(signerCalls).toHaveLength(0);
    } finally {
      if (previousSwitch === undefined) delete process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY;
      else process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY = previousSwitch;
      await settings.updateExperimental({
        requireRunModelDecision: previousExperimental.requireRunModelDecision,
      });
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    }
  });

  it("surfaces a refused managed-AI probe as a native SSH failure, not an AI-connection conflict", async () => {
    const { agentId, issueId, companyId } = await seedSshAgent();
    await seedModelRouterPlugin();
    const connectionSvc = aiConnectionService(db);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      membershipRole: "member",
      status: "active",
    });
    const account = await connectionSvc.save(
      companyId,
      "responsible-user",
      { provider: "anthropic", method: "api_key", ownership: "personal", name: "Binding account", apiKey: "fixture-key", agentIds: [agentId], allAgents: false },
      "fixture-key",
    );
    await connectionSvc.setDefault(companyId, "responsible-user", account.grantId);
    await db
      .update(agents)
      .set({ runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } } })
      .where(eq(agents.id, agentId));
    const settings = instanceSettingsService(db);
    const previousExperimental = await settings.getExperimental();
    const previousSwitch = process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY;
    process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY = "required";
    await settings.updateExperimental({ requireRunModelDecision: true });
    try {
      const heartbeat = heartbeatService(db, {
        environmentRuntime: fakeRuntime() as never,
        pluginWorkerManager: managerWithDecide(),
        // The project-auth probe refuses before any child exists; the run
        // must report the native SSH refusal, not a managed-AI conflict.
        nativeSshSigner: {
          requestEnvelope: async () => Promise.reject(new Error("signer down")),
        },
        nativeSshEnvelopeVerifier: createEd25519NativeSshEnvelopeVerifier(
          keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        ),
      });
      const queued = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);

      expect(execute).not.toHaveBeenCalled();
      expect(finished?.status).toBe("failed");
      expect(String(finished?.error ?? "")).toMatch(/signer down/i);
    } finally {
      if (previousSwitch === undefined) delete process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY;
      else process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY = previousSwitch;
      await settings.updateExperimental({
        requireRunModelDecision: previousExperimental.requireRunModelDecision,
      });
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    }
  });

  it("fails the run before the adapter is entered when no model was decided", async () => {
    const { agentId, issueId } = await seedSshAgent();
    // No model-router plugin and no manager: the run has no authoritative
    // assigned model to bind an authority to.
    const settings = instanceSettingsService(db);
    const previousExperimental = await settings.getExperimental();
    const previousSwitch = process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY;
    process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY = "required";
    await settings.updateExperimental({ requireRunModelDecision: true });
    try {
      const heartbeat = heartbeatService(db, {
        environmentRuntime: fakeRuntime() as never,
        nativeSshEnvelopeVerifier: createEd25519NativeSshEnvelopeVerifier(
          keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        ),
      });
      const queued = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);

      expect(execute).not.toHaveBeenCalled();
      expect(finished?.status).toBe("failed");
      expect(String(finished?.error ?? "")).toMatch(/assigned model/i);
    } finally {
      if (previousSwitch === undefined) delete process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY;
      else process.env.PAPERCLIP_NATIVE_SSH_AUTHORITY = previousSwitch;
      await settings.updateExperimental({
        requireRunModelDecision: previousExperimental.requireRunModelDecision,
      });
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    }
  });
});
