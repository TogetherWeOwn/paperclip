import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// TOG-28460: force overlapping schedulers. The in-process start lock lapses
// 30 s after registration (agent-start-lock.ts) and never chains across
// processes, so concurrent startNextQueuedRunForAgent calls can both pass a
// separate recount-then-claim. The passthrough reproduces that overlap
// deterministically: without an atomic claim (agents-row lock + recount on
// the claim connection) the burst overruns the cap.
vi.mock("../services/agent-start-lock.js", () => ({
  withAgentStartLock: async (_agentId: string, fn: () => Promise<unknown>) =>
    fn(),
}));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Burst overlap test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres burst overlap tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(
  fn: () => Promise<boolean>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat burst overlap (TOG-28460)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-burst-overlap-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some(
        (run) => run.status === "queued" || run.status === "running",
      );
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((runs) => runs.map((run) => run.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Burst overlap test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("holds maxConcurrentRuns when start schedulers overlap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const CAP = 2;
    const BURST = 6;
    const issueIds = Array.from({ length: BURST }, () => randomUUID());
    let releaseRuns!: () => void;
    const runsReleased = new Promise<void>((resolve) => {
      releaseRuns = resolve;
    });

    // Block every adapter execution until released, so claimed runs stay
    // running while the burst lands and the queued remainder is observable.
    mockAdapterExecute.mockImplementation(async () => {
      await runsReleased;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Burst overlap run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BurstCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: CAP,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values(
      issueIds.map((issueId, index) => ({
        id: issueId,
        companyId,
        title: `Burst assignment ${index}`,
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      })),
    );

    try {
      // Fire all wakes at once with no in-process start serialization, like
      // overlapping schedulers after the 30 s lock lapse or on two processes.
      const wakes = await Promise.all(
        issueIds.map((issueId) =>
          heartbeat.wakeup(agentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_assigned",
            payload: { issueId },
            contextSnapshot: { issueId, wakeReason: "issue_assigned" },
          }),
        ),
      );
      expect(wakes.every((wake) => wake !== null)).toBe(true);
      for (const [index, wake] of wakes.entries()) {
        await db.insert(issueComments).values({
          companyId,
          issueId: issueIds[index]!,
          authorAgentId: agentId,
          authorType: "agent",
          createdByRunId: wake!.id,
          body: `Burst assignment ${index} run completed.`,
        });
      }

      // Exactly CAP running and the rest queued: no burst overrun even with
      // overlapping schedulers.
      const burstCapped = await waitForCondition(async () => {
        const rows = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        const running = rows.filter((run) => run.status === "running").length;
        const queued = rows.filter((run) => run.status === "queued").length;
        return rows.length === BURST && running === CAP && queued === BURST - CAP;
      }, 10_000);
      expect(burstCapped).toBe(true);

      // Release the blocked executions: every burst run drains and the cap
      // holds while queued runs start as slots free. Completions can queue
      // issue-disposition repair retries for the still-todo issues; those are
      // separate rows, so track the 6 wake runs by id and observe the cap
      // agent-wide.
      releaseRuns();
      const burstRunIds = wakes.map((wake) => wake!.id);
      let maxObservedRunning = 0;
      const allSucceeded = await waitForCondition(async () => {
        const agentRows = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        maxObservedRunning = Math.max(
          maxObservedRunning,
          agentRows.filter((run) => run.status === "running").length,
        );
        const burstRows = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, burstRunIds));
        return (
          burstRows.length === BURST &&
          burstRows.every((run) => run.status === "succeeded")
        );
      }, 90_000);
      if (!allSucceeded) {
        const rows = await db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            errorCode: heartbeatRuns.errorCode,
            error: heartbeatRuns.error,
            scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
            retryOfRunId: heartbeatRuns.retryOfRunId,
            createdAt: heartbeatRuns.createdAt,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        console.log(
          "TOG-28460 burst drain states:",
          JSON.stringify(
            rows.map((row) => ({
              ...row,
              error: row.error?.slice(0, 200) ?? null,
            })),
          ),
        );
      }
      expect(allSucceeded).toBe(true);
      expect(maxObservedRunning).toBeLessThanOrEqual(CAP);
    } finally {
      releaseRuns();
    }
  }, 150_000);
});
