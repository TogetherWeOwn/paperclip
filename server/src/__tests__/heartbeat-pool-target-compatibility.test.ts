import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, aiConnectionRouterCursors, aiConnectionTaskPins, authUsers, companies, companyMemberships, createDb, environments, plugins } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { AiConnectionRouterRequest, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { aiConnectionRouterService } from "../services/ai-connection-router.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as agentRunnerSelection from "../services/agent-runner-selection.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "pool-target-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "pool-target");
  database = await startEmbeddedPostgresTestDatabase("pool-target-db-");
  db = createDb(database.connectionString);
}, 90_000);
afterAll(async () => {
  await waitForPendingRunFailureReports();
  await db?.$client.end();
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

describe("heartbeat pool target compatibility", () => {
  it("rejects an unsupported plugin environment before committing a pool pin or starting a provider", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pool target", issuePrefix: "PTC" });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const [environment] = await db.insert(environments).values({ companyId, name: "Plugin Runner", driver: "plugin", status: "active", config: { pluginKey: "fixture.environment", driverKey: "runner" } }).returning();
    const pluginKey = `fixture.pool-${companyId}`;
    const manifest: PaperclipPluginManifestV1 = { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Pool", description: "Fixture", author: "Tests", categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "Pool", description: "Fixture" }, entrypoints: { worker: "worker.js" } };
    await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0", manifestJson: manifest, status: "ready" });
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableNativeRunner: true, enableWorktreeRunExecution: true });
    const account = await aiConnectionService(db).save(companyId, userId, { provider: "openai", method: "api_key", ownership: "personal", name: "Chat", apiKey: "fixture", allAgents: true, agentIds: [], routing: { kind: "gateway", protocol: "chat", auth: "bearer", baseUrl: "https://gateway.example/v1", models: [] } }, "fixture");
    const pool = await aiConnectionRouterService(db).save(pluginKey, { companyId, config: { name: "Target pool", enabled: true, mode: "round_robin", thresholdPercent: 90, members: [{ id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...account }, profile: { provider: "opencode", model: "qwen" } }] } }, userId);
    await db.insert(agents).values({ id: agentId, companyId, name: "Target agent", adapterType: "paperclip_runner", defaultEnvironmentId: environment.id, adapterConfig: { provider: "opencode", model: "paperclip/qwen", cwd: home }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false, wakeOnDemand: true } } });
    const call = vi.fn(async (_id: string, _method: string, request: AiConnectionRouterRequest) => request.candidates[0]
      ? { kind: "selected", memberId: request.candidates[0].member.id }
      : { kind: "unavailable", skipped: {} });
    const worker = { isRunning: () => true, call } as unknown as PluginWorkerManager;
    const driver = vi.spyOn(agentRunnerSelection, "pluginEnvironmentRunnerTaskDriver").mockResolvedValue({ driverKey: "runner", supportsTasks: true } as NonNullable<Awaited<ReturnType<typeof agentRunnerSelection.pluginEnvironmentRunnerTaskDriver>>>);
    const provider = vi.fn(() => { throw new Error("Unexpected provider start"); });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {}, nativeSessionBackendFactory: provider });
    try {
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", reason: "manual", triggerDetail: "manual", contextSnapshot: { responsibleUserId: userId, wakeReason: "manual" } });
      expect(run).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      const saved = await heartbeat.getRun(run!.id);
      expect(saved?.status).toBe("failed");
      expect(saved?.errorCode).toBe("configuration_incomplete");
      expect(saved?.contextSnapshot?.aiRouterSelection).toBeUndefined();
      expect(call).toHaveBeenCalledOnce();
      expect(call.mock.calls[0]?.[2].candidates).toEqual([]);
      expect(driver).toHaveBeenCalledWith(db, expect.objectContaining({ id: environment.id, driver: "plugin" }));
      expect(provider).not.toHaveBeenCalled();
      expect(await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id))).toHaveLength(0);
      expect((await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)))[0]?.version).toBe(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      driver.mockRestore();
    }
  }, 30_000);
});
