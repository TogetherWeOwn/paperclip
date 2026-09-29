import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake nested-pool tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat wake nested-pool deadlock (TOG-9736)", () => {
  // Small pool on purpose: with the pre-fix code each wake transaction holds
  // its only connection while the inner task-session read waits for a second
  // pooled connection, so N concurrent wakes deadlock a pool of size N.
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sessionCwd: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wake-nested-pool-");
    // Pool of 2 with 4+ concurrent wakes is the regression shape: every wake
    // holds one connection in its issue-lock transaction, so any nested
    // pooled read deadlocks once all connections are held in-transaction.
    db = createDb(tempDb.connectionString, { maxConnections: 2 });
    heartbeat = heartbeatService(db);
    sessionCwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-nested-pool-session-"));
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
    await db?.$client.end({ timeout: 0 }).catch(() => undefined);
    await tempDb?.cleanup();
    if (sessionCwd) await rm(sessionCwd, { recursive: true, force: true });
  }, 60_000);

  async function seedIsolatedWorkspaceIssue(opts: { taskKey: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
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
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 4,
        },
      },
      permissions: {},
    });
    // A task session with a resolvable cwd forces the wake's isolated-
    // workspace preflight down the getTaskSession read inside the issue-lock
    // transaction — the exact nested-pool path from the incident.
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "process",
      taskKey: opts.taskKey,
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
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceStrategy: { type: "adapter_managed" },
      },
    });
    return { companyId, agentId, issueId };
  }

  it("completes concurrent isolated-workspace wakes on a pool of 2 without deadlock", async () => {
    const wakeCount = 4;
    const seeded = await Promise.all(
      Array.from({ length: wakeCount }, (_, index) =>
        seedIsolatedWorkspaceIssue({ taskKey: `nested-pool-issue-${index}` }),
      ),
    );

    const deadlineMs = 20_000;
    const wakes = await Promise.race([
      Promise.all(
        seeded.map(({ agentId, issueId }) =>
          heartbeat.wakeup(agentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_assigned",
            payload: { issueId },
            contextSnapshot: {
              issueId,
              taskId: issueId,
              taskKey: `nested-pool-issue-${seeded.findIndex((s) => s.issueId === issueId)}`,
              wakeReason: "issue_assigned",
            },
            requestedByActorType: "system",
            requestedByActorId: "test",
          }),
        ),
      ),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`concurrent wakes deadlocked with maxConnections=2 after ${deadlineMs}ms`)),
          deadlineMs,
        );
      }),
    ]);

    // Every wake queues a run: none stalled inside the issue-lock transaction
    // waiting for a second pooled connection.
    expect(wakes).toHaveLength(wakeCount);
    for (const run of wakes) {
      expect(run).not.toBeNull();
    }

    const runRows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns);
    expect(runRows).toHaveLength(wakeCount);
  }, 60_000);
});
