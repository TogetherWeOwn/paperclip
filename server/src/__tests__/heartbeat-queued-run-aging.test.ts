import { randomUUID } from "node:crypto";
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
  issueRelations,
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
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Acceptance battery for bounded aging in the queued-run scheduler.
//
// Contract under test: a dependency-ready queued assignment that has waited at
// least 30 minutes since its original queue time joins the in-progress tier.
// Inside that tier runs order by issue priority, then by original queue time,
// with ties broken deterministically. Below the bound the existing order is
// unchanged, and age never lets a run past a dependency, pause, hold or
// concurrency guard.
//
// Every case drives the real scheduler through resumeQueuedRuns() or through
// the slot release at the end of executeRun, and observes which run the
// adapter is handed. The process clock is frozen with fake Date only: queue
// age must be measured against Date.now(), so an exact 30-minute boundary is
// testable without sleeping.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;
const ADAPTER = "queued_run_aging_test";
const MINUTE_MS = 60_000;
const AGING_BOUND_MS = 30 * MINUTE_MS;
const TEST_TIMEOUT_MS = 60_000;
// Covers the 30s agent start-lock staleness wait plus normal run time.
const START_LOCK_WAIT_TEST_TIMEOUT_MS = 90_000;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queued-run aging tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The clock is frozen, so poll a bounded number of real macrotasks instead of
// comparing against a Date.now() deadline that would never pass.
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  attempts = 800,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

// Freeze Date an hour behind the wall clock. Controller leases are written
// with the database clock, and a frozen process clock ahead of it would expire
// them. Advances in these tests stay well under the 60s lease and the 30s
// agent start-lock staleness window.
function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Math.floor(Date.now() / 1000) * 1000 - 60 * MINUTE_MS);
}

function advanceClock(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

type Fixture = {
  companyId: string;
  agentId: string;
  issuePrefix: string;
  nextIssueNumber: number;
};

type QueuedRun = { runId: string };
type QueuedIssueRun = QueuedRun & { issueId: string };

describeEmbeddedPostgres("queued run aging in the agent scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const dispatched: string[] = [];
  const labels = new Map<string, string>();
  const runIssueIds = new Map<string, string>();
  const gates = new Map<string, PromiseWithResolvers<void>>();
  let releaseEverything = false;
  let inFlight = 0;
  let maxInFlight = 0;

  function gateFor(runId: string) {
    let gate = gates.get(runId);
    if (!gate) {
      gate = Promise.withResolvers<void>();
      if (releaseEverything) gate.resolve();
      gates.set(runId, gate);
    }
    return gate;
  }

  function releaseAll() {
    releaseEverything = true;
    for (const gate of gates.values()) gate.resolve();
  }

  function labelOf(runId: string | undefined) {
    return runId ? (labels.get(runId) ?? runId) : "nothing";
  }

  function dispatchedLabels() {
    return dispatched.map(labelOf);
  }

  async function resetDatabase() {
    releaseAll();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRelations);
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
    labels.clear();
    runIssueIds.clear();
    gates.clear();
    releaseEverything = false;
    inFlight = 0;
    maxInFlight = 0;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-queued-run-aging-",
    );
    db = createDb(tempDb.connectionString);
    // Pin scheduling suppression off with the runtimeEnv test seam. An ambient
    // PAPERCLIP_IN_WORKTREE would make startNextQueuedRunForAgent a no-op.
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
    registerServerAdapter({
      type: ADAPTER,
      execute: async (input) => {
        dispatched.push(input.runId);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await gateFor(input.runId).promise;
          // Finish the turn like an agent: post a comment and record a
          // disposition. Otherwise finalization queues missing-comment and
          // disposition-repair follow-up wakes into the order under test.
          const issueId = runIssueIds.get(input.runId);
          if (issueId) {
            await db.insert(issueComments).values({
              companyId: input.agent.companyId,
              issueId,
              authorAgentId: input.agent.id,
              authorType: "agent",
              createdByRunId: input.runId,
              body: "Queued-run aging test turn complete.",
            });
            await db
              .update(issues)
              .set({ status: "done" })
              .where(eq(issues.id, issueId));
          }
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
    // Drain under the frozen clock, then restore it: a jump back to the wall
    // clock mid-run would read as a lost controller lease.
    await resetDatabase();
    vi.useRealTimers();
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedAgent(
    options: {
      companyId?: string;
      agentId?: string;
      status?: string;
      maxConcurrentRuns?: number;
    } = {},
  ): Promise<Fixture> {
    const companyId = options.companyId ?? randomUUID();
    const agentId = options.agentId ?? randomUUID();
    const issuePrefix = `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QueueAgingAgent",
      role: "engineer",
      status: options.status ?? "idle",
      adapterType: ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: options.maxConcurrentRuns ?? 1,
        },
      },
      permissions: {},
    });
    return { companyId, agentId, issuePrefix, nextIssueNumber: 1 };
  }

  async function seedIssue(
    fixture: Fixture,
    options: {
      status: string;
      priority?: string;
      id?: string;
      assigned?: boolean;
    },
  ) {
    const id = options.id ?? randomUUID();
    const issueNumber = fixture.nextIssueNumber;
    fixture.nextIssueNumber += 1;
    await db.insert(issues).values({
      id,
      companyId: fixture.companyId,
      title: `Aging issue ${issueNumber}`,
      status: options.status,
      priority: options.priority ?? "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: options.assigned === false ? null : fixture.agentId,
      issueNumber,
      identifier: `${fixture.issuePrefix}-${issueNumber}`,
    });
    return id;
  }

  async function insertQueuedRun(
    fixture: Fixture,
    options: {
      label: string;
      issueId: string | null;
      queuedAgoMs: number;
      invocationSource: string;
      wakeReason: string;
      runId?: string;
      createdAt?: Date;
    },
  ): Promise<QueuedRun> {
    const runId = options.runId ?? randomUUID();
    const createdAt =
      options.createdAt ?? new Date(Date.now() - options.queuedAgoMs);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: options.invocationSource,
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: options.issueId
        ? { issueId: options.issueId, wakeReason: options.wakeReason }
        : { wakeReason: options.wakeReason },
      createdAt,
      updatedAt: createdAt,
    });
    labels.set(runId, options.label);
    if (options.issueId) runIssueIds.set(runId, options.issueId);
    return { runId };
  }

  // A todo issue assigned to the agent, with its assignment wake queued.
  async function queueAssignment(
    fixture: Fixture,
    options: {
      label: string;
      queuedAgoMs: number;
      priority?: string;
      issueId?: string;
      runId?: string;
      createdAt?: Date;
    },
  ): Promise<QueuedIssueRun> {
    const issueId = await seedIssue(fixture, {
      status: "todo",
      priority: options.priority,
      id: options.issueId,
    });
    const { runId } = await insertQueuedRun(fixture, {
      ...options,
      issueId,
      invocationSource: "assignment",
      wakeReason: "issue_assigned",
    });
    return { runId, issueId };
  }

  // An in-progress issue assigned to the agent, with a new wake queued for it.
  // Seeded rows use the assignment source: automation-sourced rows must carry
  // a verified continuation proof that only the real wake path writes.
  async function queueInProgressWake(
    fixture: Fixture,
    options: {
      label: string;
      queuedAgoMs: number;
      priority?: string;
      issueId?: string;
      runId?: string;
      createdAt?: Date;
    },
  ): Promise<QueuedIssueRun> {
    const issueId = await seedIssue(fixture, {
      status: "in_progress",
      priority: options.priority,
      id: options.issueId,
    });
    const { runId } = await insertQueuedRun(fixture, {
      ...options,
      issueId,
      invocationSource: "assignment",
      wakeReason: "issue_status_changed",
    });
    return { runId, issueId };
  }

  async function queueTimerRun(
    fixture: Fixture,
    options: { label: string; queuedAgoMs: number },
  ) {
    return insertQueuedRun(fixture, {
      ...options,
      issueId: null,
      invocationSource: "timer",
      wakeReason: "heartbeat_timer",
    });
  }

  async function runRow(runId: string) {
    const [row] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    if (!row) throw new Error(`heartbeat run ${runId} not found`);
    return row;
  }

  async function runningLabels(fixture: Fixture) {
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, fixture.agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    return rows.map((row) => labelOf(row.id));
  }

  async function startHolder(fixture: Fixture) {
    const holder = await queueInProgressWake(fixture, {
      label: "slot holder",
      queuedAgoMs: 120 * MINUTE_MS,
    });
    await heartbeat.resumeQueuedRuns();
    await waitFor(() => dispatched.includes(holder.runId));
    return holder;
  }

  // Finish one gated run and return the run the freed slot was handed to.
  async function releaseAndAwaitNext(runId: string) {
    const before = dispatched.length;
    gateFor(runId).resolve();
    await waitFor(() => dispatched.length > before);
    return labelOf(dispatched[before]);
  }

  // Let every run finish as soon as it starts and wait for `count` dispatches.
  // With one slot, the dispatch sequence is the scheduler's selection order.
  async function dispatchSequentially(count: number) {
    releaseAll();
    await heartbeat.resumeQueuedRuns();
    await waitFor(() => dispatched.length >= count);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return dispatchedLabels();
  }

  it(
    "gives a freed slot to a ready assignment once it has waited 30 minutes, even as newer in-progress wakes keep arriving",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      const holder = await startHolder(fixture);

      // Under the bound, the existing in-progress preference still applies.
      const assignment = await queueAssignment(fixture, {
        label: "aged assignment",
        queuedAgoMs: AGING_BOUND_MS - 10_000,
      });
      const firstWake = await queueInProgressWake(fixture, {
        label: "in-progress wake 1",
        queuedAgoMs: 5 * MINUTE_MS,
      });
      expect(await releaseAndAwaitNext(holder.runId)).toBe(
        "in-progress wake 1",
      );
      expect(await runningLabels(fixture)).toEqual(["in-progress wake 1"]);

      // The assignment crosses the bound while the slot is busy, and another
      // in-progress wake arrives before the slot frees.
      advanceClock(20_000);
      const secondWake = await queueInProgressWake(fixture, {
        label: "in-progress wake 2",
        queuedAgoMs: MINUTE_MS,
      });
      expect(await releaseAndAwaitNext(firstWake.runId)).toBe(
        "aged assignment",
      );
      expect(await runningLabels(fixture)).toEqual(["aged assignment"]);

      const thirdWake = await queueInProgressWake(fixture, {
        label: "in-progress wake 3",
        queuedAgoMs: 0,
      });
      expect(await releaseAndAwaitNext(assignment.runId)).toBe(
        "in-progress wake 2",
      );
      expect(await releaseAndAwaitNext(secondWake.runId)).toBe(
        "in-progress wake 3",
      );
      releaseAll();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      expect(dispatchedLabels()).toEqual([
        "slot holder",
        "in-progress wake 1",
        "aged assignment",
        "in-progress wake 2",
        "in-progress wake 3",
      ]);
      expect(maxInFlight).toBe(1);
      expect((await runRow(assignment.runId)).status).toBe("succeeded");
      expect((await runRow(thirdWake.runId)).status).toBe("succeeded");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the in-progress preference for an assignment queued just under 30 minutes ago",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      const assignment = await queueAssignment(fixture, {
        label: "assignment just under the bound",
        queuedAgoMs: AGING_BOUND_MS - 1,
      });
      await queueInProgressWake(fixture, {
        label: "in-progress wake",
        queuedAgoMs: MINUTE_MS,
      });

      await heartbeat.resumeQueuedRuns();
      await waitFor(() => dispatched.length >= 1);

      expect(dispatchedLabels()).toEqual(["in-progress wake"]);
      expect((await runRow(assignment.runId)).status).toBe("queued");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "promotes an assignment queued exactly 30 minutes ago into the in-progress tier",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      await queueAssignment(fixture, {
        label: "assignment at the bound",
        queuedAgoMs: AGING_BOUND_MS,
      });
      const wake = await queueInProgressWake(fixture, {
        label: "in-progress wake",
        queuedAgoMs: MINUTE_MS,
      });

      await heartbeat.resumeQueuedRuns();
      await waitFor(() => dispatched.length >= 1);

      expect(dispatchedLabels()).toEqual(["assignment at the bound"]);
      expect((await runRow(wake.runId)).status).toBe("queued");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "orders the merged tier by issue priority first, so higher-priority work still wins",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      await queueInProgressWake(fixture, {
        label: "high in-progress wake",
        priority: "high",
        queuedAgoMs: MINUTE_MS,
      });
      await queueAssignment(fixture, {
        label: "high aged assignment",
        priority: "high",
        queuedAgoMs: 40 * MINUTE_MS,
      });
      await queueAssignment(fixture, {
        label: "medium aged assignment",
        priority: "medium",
        queuedAgoMs: 45 * MINUTE_MS,
      });
      await queueInProgressWake(fixture, {
        label: "medium in-progress wake",
        priority: "medium",
        queuedAgoMs: 2 * MINUTE_MS,
      });

      expect(await dispatchSequentially(4)).toEqual([
        "high aged assignment",
        "high in-progress wake",
        "medium aged assignment",
        "medium in-progress wake",
      ]);
      expect(maxInFlight).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "orders equal priorities in the merged tier by original queue time",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      await queueInProgressWake(fixture, {
        label: "older in-progress wake",
        queuedAgoMs: 50 * MINUTE_MS,
      });
      await queueAssignment(fixture, {
        label: "aged assignment",
        queuedAgoMs: 45 * MINUTE_MS,
      });
      await queueInProgressWake(fixture, {
        label: "newer in-progress wake",
        queuedAgoMs: 2 * MINUTE_MS,
      });
      await queueAssignment(fixture, {
        label: "fresh assignment",
        queuedAgoMs: 10 * MINUTE_MS,
      });

      expect(await dispatchSequentially(4)).toEqual([
        "older in-progress wake",
        "aged assignment",
        "newer in-progress wake",
        "fresh assignment",
      ]);
      expect(maxInFlight).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "breaks equal priority and queue-time ties the same way whatever order the rows were written in",
    async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const contenders = [
        { label: "in-progress wake A", kind: "in_progress" },
        { label: "in-progress wake B", kind: "in_progress" },
        { label: "aged assignment C", kind: "assignment" },
      ].map((contender) => ({
        ...contender,
        issueId: randomUUID(),
        runId: randomUUID(),
      }));

      async function trial(order: typeof contenders) {
        freezeClock();
        const fixture = await seedAgent({
          companyId,
          agentId,
          maxConcurrentRuns: 1,
        });
        const sharedQueueTime = new Date(Date.now() - 40 * MINUTE_MS);
        for (const contender of order) {
          const queue =
            contender.kind === "in_progress"
              ? queueInProgressWake
              : queueAssignment;
          await queue(fixture, {
            label: contender.label,
            issueId: contender.issueId,
            runId: contender.runId,
            queuedAgoMs: 40 * MINUTE_MS,
            createdAt: sharedQueueTime,
          });
        }
        const sequence = await dispatchSequentially(order.length);
        await resetDatabase();
        vi.useRealTimers();
        return sequence;
      }

      const writtenForward = await trial(contenders);
      const writtenBackward = await trial([...contenders].reverse());

      expect(writtenForward).toHaveLength(3);
      expect(writtenBackward).toEqual(writtenForward);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "measures age from the original queue time, so a later wake for the same assignment does not reset it",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      const holder = await startHolder(fixture);
      const assignment = await queueAssignment(fixture, {
        label: "aged assignment",
        queuedAgoMs: 45 * MINUTE_MS,
      });
      await queueInProgressWake(fixture, {
        label: "in-progress wake",
        queuedAgoMs: 10 * MINUTE_MS,
      });
      const queuedAt = (await runRow(assignment.runId)).createdAt;

      // A new wake for the same issue coalesces into the queued run and touches
      // the row; its original queue time is unchanged.
      const coalesced = await heartbeat.wakeup(fixture.agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: assignment.issueId },
        contextSnapshot: {
          issueId: assignment.issueId,
          wakeReason: "issue_assigned",
        },
      });
      expect(coalesced?.id).toBe(assignment.runId);
      const touched = await runRow(assignment.runId);
      expect(touched.status).toBe("queued");
      expect(touched.createdAt.getTime()).toBe(queuedAt.getTime());
      expect(touched.updatedAt.getTime()).toBeGreaterThan(queuedAt.getTime());

      expect(await releaseAndAwaitNext(holder.runId)).toBe("aged assignment");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never promotes aged work whose dependencies are unresolved",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      const blockerIssueId = await seedIssue(fixture, {
        status: "todo",
        assigned: false,
      });
      const blocked = await queueAssignment(fixture, {
        label: "aged blocked assignment",
        queuedAgoMs: 120 * MINUTE_MS,
      });
      await db.insert(issueRelations).values({
        companyId: fixture.companyId,
        issueId: blockerIssueId,
        relatedIssueId: blocked.issueId,
        type: "blocks",
      });
      const wake = await queueInProgressWake(fixture, {
        label: "in-progress wake",
        queuedAgoMs: MINUTE_MS,
      });

      await heartbeat.resumeQueuedRuns();
      await waitFor(() => dispatched.length >= 1);
      // The blocked run keeps its place behind every ready run.
      expect(dispatchedLabels()).toEqual(["in-progress wake"]);
      expect((await runRow(blocked.runId)).status).toBe("queued");

      releaseAll();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(dispatchedLabels()).toEqual(["in-progress wake"]);
      expect((await runRow(wake.runId)).status).toBe("succeeded");
      expect((await runRow(blocked.runId)).status).not.toBe("succeeded");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never starts aged work for a paused agent",
    async () => {
      freezeClock();
      const fixture = await seedAgent({
        status: "paused",
        maxConcurrentRuns: 1,
      });
      const assignment = await queueAssignment(fixture, {
        label: "aged assignment",
        queuedAgoMs: 120 * MINUTE_MS,
      });
      const wake = await queueInProgressWake(fixture, {
        label: "in-progress wake",
        queuedAgoMs: MINUTE_MS,
      });

      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      expect(dispatched).toEqual([]);
      expect((await runRow(assignment.runId)).status).toBe("queued");
      expect((await runRow(wake.runId)).status).toBe("queued");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never starts aged work under an active subtree pause hold, and its rejection never admits a second run",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      const held = await queueAssignment(fixture, {
        label: "aged held assignment",
        queuedAgoMs: 120 * MINUTE_MS,
      });
      await db.insert(issueTreeHolds).values({
        companyId: fixture.companyId,
        rootIssueId: held.issueId,
        mode: "pause",
        status: "active",
        reason: "queued-run aging hold",
        releasePolicy: { strategy: "manual" },
      });
      await queueInProgressWake(fixture, {
        label: "in-progress wake 1",
        queuedAgoMs: 2 * MINUTE_MS,
      });
      await queueInProgressWake(fixture, {
        label: "in-progress wake 2",
        queuedAgoMs: MINUTE_MS,
      });

      await heartbeat.resumeQueuedRuns();
      await waitFor(() => dispatched.length >= 1);
      // Rejecting the held run at claim time must not leave two runs admitted
      // on the agent's single slot.
      expect(await runningLabels(fixture)).toEqual(["in-progress wake 1"]);
      expect(dispatchedLabels()).toEqual(["in-progress wake 1"]);

      // Claim-time rejection re-enters the scheduler under the agent start
      // lock and waits out its 30s staleness window, so drain inside the test.
      releaseAll();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(dispatchedLabels()).toEqual([
        "in-progress wake 1",
        "in-progress wake 2",
      ]);
      expect(maxInFlight).toBe(1);
      expect((await runRow(held.runId)).status).not.toBe("succeeded");
    },
    START_LOCK_WAIT_TEST_TIMEOUT_MS,
  );

  it(
    "never admits aged work past a full slot, however often the queue is resumed",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      const holder = await startHolder(fixture);
      const assignment = await queueAssignment(fixture, {
        label: "aged assignment",
        queuedAgoMs: 90 * MINUTE_MS,
      });
      const wake = await queueInProgressWake(fixture, {
        label: "in-progress wake",
        queuedAgoMs: MINUTE_MS,
      });

      await Promise.all([
        heartbeat.resumeQueuedRuns(),
        heartbeat.resumeQueuedRuns(),
        heartbeat.resumeQueuedRuns(),
      ]);
      expect(dispatchedLabels()).toEqual(["slot holder"]);
      expect(await runningLabels(fixture)).toEqual(["slot holder"]);
      expect((await runRow(assignment.runId)).status).toBe("queued");
      expect((await runRow(wake.runId)).status).toBe("queued");

      const before = dispatched.length;
      gateFor(holder.runId).resolve();
      await waitFor(() => dispatched.length > before);
      await heartbeat.resumeQueuedRuns();
      const next = dispatched[before];
      expect(dispatched).toHaveLength(2);
      expect([assignment.runId, wake.runId]).toContain(next);
      expect(await runningLabels(fixture)).toEqual([labelOf(next)]);
      expect(maxInFlight).toBe(1);
      expect(new Set(dispatched).size).toBe(dispatched.length);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the existing order while no queued run has reached the bound",
    async () => {
      freezeClock();
      const fixture = await seedAgent({ maxConcurrentRuns: 1 });
      const blockerIssueId = await seedIssue(fixture, {
        status: "todo",
        assigned: false,
      });
      const blocked = await queueAssignment(fixture, {
        label: "blocked assignment",
        queuedAgoMs: 28 * MINUTE_MS,
      });
      await db.insert(issueRelations).values({
        companyId: fixture.companyId,
        issueId: blockerIssueId,
        relatedIssueId: blocked.issueId,
        type: "blocks",
      });
      await queueInProgressWake(fixture, {
        label: "medium in-progress wake",
        queuedAgoMs: 20 * MINUTE_MS,
      });
      await queueInProgressWake(fixture, {
        label: "high in-progress wake",
        priority: "high",
        queuedAgoMs: MINUTE_MS,
      });
      await queueAssignment(fixture, {
        label: "medium assignment",
        queuedAgoMs: AGING_BOUND_MS - MINUTE_MS,
      });
      await queueAssignment(fixture, {
        label: "critical assignment",
        priority: "critical",
        queuedAgoMs: 5 * MINUTE_MS,
      });
      await queueTimerRun(fixture, {
        label: "timer run",
        queuedAgoMs: 25 * MINUTE_MS,
      });

      expect(await dispatchSequentially(5)).toEqual([
        "high in-progress wake",
        "medium in-progress wake",
        "critical assignment",
        "medium assignment",
        "timer run",
      ]);
      expect(maxInFlight).toBe(1);
      expect((await runRow(blocked.runId)).status).not.toBe("succeeded");
    },
    TEST_TIMEOUT_MS,
  );
});
