import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Nested-pool regression test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "process",
      execute: mockAdapterExecute,
      supportsLocalAgentJwt: false,
    })),
  };
});

// Use an exclusively owned, disposable database on agent-testdb or a CI service
// container. This reads a dedicated variable, never the shared
// PAPERCLIP_TEST_DATABASE_URL, DATABASE_URL or the application instance, so an
// ordinary shared test URL skips this suite instead of failing collection.
const testDatabaseUrl = process.env.PAPERCLIP_NESTED_POOL_TEST_DATABASE_URL?.trim();
if (testDatabaseUrl) {
  const url = new URL(testDatabaseUrl);
  const allowedHost = url.hostname === "agent-testdb" ||
    (process.env.CI === "true" && ["localhost", "127.0.0.1", "postgres"].includes(url.hostname));
  if (!allowedHost || !/^\/paperclip_nested_pool_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error("Nested-pool tests require a dedicated paperclip_nested_pool_* database on agent-testdb or a CI PostgreSQL service");
  }
}
const describeDatabase = testDatabaseUrl ? describe : describe.skip;

describeDatabase("heartbeat wake nested-pool deadlock", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let sessionCwd: string | null = null;
  const transactionScope = new AsyncLocalStorage<{ active: boolean }>();

  beforeAll(async () => {
    await applyPendingMigrations(testDatabaseUrl!);
    db = createDb(testDatabaseUrl!, { maxConnections: 2 });

    // Fail fast on an outer-pool read instead of leaving a deadlocked pool
    // alive through teardown. AsyncLocalStorage distinguishes concurrent wakes
    // outside the transaction from reads made by the transaction itself.
    const select = db.select.bind(db);
    db.select = ((...args: Parameters<typeof db.select>) => {
      if (transactionScope.getStore()?.active) {
        throw new Error("Wake transaction attempted an outer-pool read instead of reusing tx");
      }
      return select(...args);
    }) as typeof db.select;
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation((callback, config) =>
      transaction(async (tx) => {
        const scope = { active: true };
        try {
          return await transactionScope.run(scope, () => callback(tx));
        } finally {
          scope.active = false;
        }
      }, config),
    );

    heartbeat = heartbeatService(db);
    sessionCwd = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(), "paperclip-nested-pool-session-"));
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentTaskSessions);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    vi.restoreAllMocks();
    if (sessionCwd) await rm(sessionCwd, { recursive: true, force: true });
  }, 60_000);

  async function seedIsolatedWorkspaceIssue(taskKey: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessWorker",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 4 },
      },
      permissions: {},
    });
    // A resolvable task session exercises getTaskSession inside the locked
    // workspace preflight. Null issue attribution also exercises the nested
    // responsible-user reads and company-default fallback.
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "process",
      taskKey,
      sessionParamsJson: { cwd: sessionCwd },
      sessionDisplayId: "session-before",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Isolated workspace wake",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceStrategy: { type: "adapter_managed" },
      },
    });
    return { companyId, agentId, issueId, taskKey };
  }

  it("reuses tx reads and completes four isolated-workspace wakes on a pool of two", async () => {
    const wakeCount = 4;
    const seeded = await Promise.all(
      Array.from({ length: wakeCount }, (_, index) =>
        seedIsolatedWorkspaceIssue(`nested-pool-issue-${index}`),
      ),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const wakes = await Promise.race([
        Promise.all(
          seeded.map(({ agentId, issueId, taskKey }) =>
            heartbeat.wakeup(agentId, {
              source: "on_demand",
              triggerDetail: "manual",
              reason: "manual",
              payload: { issueId },
              // Assignment wakes reset sessions and skip the affected read.
              contextSnapshot: { issueId, taskId: issueId, taskKey, wakeReason: "manual" },
              requestedByActorType: "system",
              requestedByActorId: "test",
            }),
          ),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Concurrent wakes deadlocked with maxConnections=2")), 20_000);
        }),
      ]);

      expect(wakes).toHaveLength(wakeCount);
      expect(wakes.every((run) => run !== null)).toBe(true);
      const runRows = await db
        .select({ id: heartbeatRuns.id, responsibleUserId: heartbeatRuns.responsibleUserId })
        .from(heartbeatRuns);
      expect(runRows).toHaveLength(wakeCount);
      expect(runRows.every((run) => run.responsibleUserId === "responsible-user")).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  }, 60_000);
});
