import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  issueTreeHolds,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.ts";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const ADAPTER = "claim_cancellation_test";

if (!support.supported) {
  console.warn(
    `Skipping claim cancellation tests: ${support.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(condition: () => boolean) {
  const deadline = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() >= deadline)
      throw new Error("Timed out waiting for adapter dispatch");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describePostgres("queued-run claim cancellation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const dispatched: string[] = [];
  const runIssues = new Map<string, string>();
  let gate = Promise.withResolvers<void>();
  let inFlight = 0;
  let maxInFlight = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-claim-cancellation-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
    registerServerAdapter({
      type: ADAPTER,
      execute: async (input) => {
        dispatched.push(input.runId);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await gate.promise;
          const issueId = runIssues.get(input.runId);
          if (!issueId) throw new Error("Missing test issue");
          await db.insert(issueComments).values({
            companyId: input.agent.companyId,
            issueId,
            authorAgentId: input.agent.id,
            authorType: "agent",
            createdByRunId: input.runId,
            body: "Claim cancellation test complete.",
          });
          await db
            .update(issues)
            .set({ status: "done" })
            .where(eq(issues.id, issueId));
          return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
        } finally {
          inFlight -= 1;
        }
      },
      testEnvironment: async () => ({
        adapterType: ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    gate.resolve();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    dispatched.length = 0;
    runIssues.clear();
    gate = Promise.withResolvers<void>();
    inFlight = 0;
    maxInFlight = 0;
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedQueue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaimCancellationAgent",
      role: "engineer",
      status: "idle",
      adapterType: ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    const runs = [];
    for (let index = 0; index < 3; index += 1) {
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Queued work ${index}`,
        // The held run is first even without the separate aging change.
        status: "in_progress",
        priority: index === 0 ? "high" : "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      });
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        reason: "issue_assigned",
        status: "queued",
        payload: { issueId },
      });
      const createdAt = new Date(Date.now() - (3 - index) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        wakeupRequestId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        createdAt,
        updatedAt: createdAt,
      });
      runIssues.set(runId, issueId);
      runs.push({ runId, issueId, wakeupRequestId });
    }
    const [rejected, first, second] = runs as [
      (typeof runs)[number],
      (typeof runs)[number],
      (typeof runs)[number],
    ];
    await db
      .update(issues)
      .set({
        executionRunId: rejected.runId,
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, rejected.issueId));
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: rejected.issueId,
      mode: "pause",
      status: "active",
      reason: "Claim-time cancellation regression",
      releasePolicy: { strategy: "manual" },
    });
    return { companyId, agentId, rejected, first, second };
  }

  it("rejects a held head-of-queue run without a lock stall or a single-slot overrun", async () => {
    const { agentId, rejected, first, second } = await seedQueue();
    const warn = vi.spyOn(logger, "warn");
    const started = performance.now();
    await heartbeat.resumeQueuedRuns();
    const elapsedMs = performance.now() - started;
    await waitFor(() => dispatched.length > 0);

    // Assert state before timing so the pre-fix double admission is visible too.
    const running = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    expect(running.map((run) => run.id)).toEqual([first.runId]);
    expect(dispatched).toEqual([first.runId]);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(
      warn.mock.calls.filter((args) =>
        args.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("continuing queued-run start"),
        ),
      ),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, rejected.runId)),
    ).toEqual([
      expect.objectContaining({ status: "cancelled", startedAt: null }),
    ]);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, rejected.wakeupRequestId)),
    ).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(
      await db.select().from(issues).where(eq(issues.id, rejected.issueId)),
    ).toEqual([
      expect.objectContaining({
        executionRunId: null,
        executionLockedAt: null,
      }),
    ]);
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, rejected.runId));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "run cancelled" }),
      ]),
    );

    gate.resolve();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(dispatched).toEqual([first.runId, second.runId]);
    expect(maxInFlight).toBe(1);
  }, 45_000);

  it("still dispatches a successor after cancellation outside the scheduler claim loop", async () => {
    const { rejected, first, second } = await seedQueue();
    await heartbeat.cancelRun(rejected.runId, "Cancelled by test operator");
    await waitFor(() => dispatched.length > 0);
    expect(dispatched).toEqual([first.runId]);
    gate.resolve();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(dispatched).toEqual([first.runId, second.runId]);
    expect(maxInFlight).toBe(1);
  }, 15_000);
});
