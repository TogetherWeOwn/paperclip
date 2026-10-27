import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentRuntimeState, agentWakeupRequests, agents, companies, createDb, heartbeatRunEvents,
  heartbeatRuns, issueRecoveryActions, issues, plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ADAPTER = "model_decision_test";
const pluginId = randomUUID();
const manifest: PaperclipPluginManifestV1 = {
  id: "fixture.model-router", apiVersion: 1, version: "1.0.0", displayName: "Router",
  description: "Synthetic router that always defers", author: "Tests", categories: ["connector"],
  capabilities: ["run.model.resolve"], entrypoints: { worker: "worker.mjs" },
};

describeEmbeddedPostgres("deferred model decision", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, resultJson: {} }));
  const call = vi.fn(async () => ({ kind: "defer", reason: "pace guard: codex ahead of plan", retryAfterMs: 1000 }));
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-model-decision-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { pluginWorkerManager: { isRunning: () => true, call } as never });
    registerServerAdapter({
      type: ADAPTER, execute,
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: manifest.id, packageName: manifest.id, version: "1.0.0", manifestJson: manifest, status: "ready",
    });
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    execute.mockClear();
    call.mockClear();
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Deferred", role: "engineer", status: "active", adapterType: ADAPTER, adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Wait for the model router", status: "todo", assigneeAgentId: agentId,
      responsibleUserId: "responsible-user", createdByUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  it("retries a deferred model decision instead of parking the card for reconciliation", async () => {
    const f = await seed();
    const run = await heartbeat.invoke(f.agentId, "assignment", { issueId: f.issueId, wakeReason: "issue_assigned" }, "system");
    expect(run).not.toBeNull();
    await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("cancelled");
    await heartbeat.drainActiveRunExecutions();

    const cancelled = await heartbeat.getRun(run!.id);
    expect(cancelled).toMatchObject({
      errorCode: "model_decision_pending",
      resultJson: {
        executionRecovery: { kind: "model_decision_pending", providerWorkStarted: false },
        cancellation: { source: "control_plane", expected: true },
      },
    });
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "model_decision_pending" });
    expect(retries[0]!.scheduledRetryAttempt).toBeGreaterThan(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue!.status).not.toBe("blocked");
    expect(issue!.executionRunId).toBe(retries[0]!.id);
    expect(execute).not.toHaveBeenCalled();
  });

  it("hands the card to a recovery owner once the bounded retries are exhausted", async () => {
    const f = await seed();
    const run = await heartbeat.invoke(f.agentId, "assignment", { issueId: f.issueId, wakeReason: "issue_assigned" }, "system");
    await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toBe("cancelled");
    await heartbeat.drainActiveRunExecutions();
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(retry).toBeDefined();
    await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 12, scheduledRetryAt: new Date(Date.now() - 1000) })
      .where(eq(heartbeatRuns.id, retry!.id));
    await heartbeat.promoteDueScheduledRetries(new Date());
    await heartbeat.resumeQueuedRuns();
    await expect.poll(async () => (await heartbeat.getRun(retry!.id))?.status, { timeout: 20_000 }).toBe("cancelled");
    await heartbeat.drainActiveRunExecutions();

    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry!.id))).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue!.status).toBe("blocked");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.ownerAgentId ?? actions[0]!.returnOwnerAgentId).not.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
