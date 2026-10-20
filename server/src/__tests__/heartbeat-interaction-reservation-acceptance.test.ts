import { randomUUID } from "node:crypto";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { heartbeatService } from "../services/heartbeat.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const adapterExecute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: () => ({
      supportsLocalAgentJwt: false,
      execute: adapterExecute,
    }),
  };
});

// Never consume DATABASE_URL or a shared application/test database. Local agent
// runs use an exclusively owned database; ordinary CI can use the native helper.
const testDatabaseUrl =
  process.env.PAPERCLIP_INTERACTION_RESERVATION_TEST_DATABASE_URL;
if (testDatabaseUrl) {
  const url = new URL(testDatabaseUrl);
  const allowedHost =
    url.hostname === process.env.PAPERCLIP_INTERACTION_RESERVATION_TEST_HOST ||
    (process.env.CI === "true" &&
      ["localhost", "127.0.0.1", "postgres"].includes(url.hostname));
  if (
    !allowedHost ||
    !/^\/paperclip_interaction_reservation_[a-z0-9_]+$/.test(url.pathname)
  ) {
    throw new Error(
      "Interaction reservation tests require an exclusively owned paperclip_interaction_reservation_* test database",
    );
  }
}

type Fixture = {
  companyId: string;
  issueId: string;
  assigneeId: string;
  attentionAgentId: string;
  busyRunId: string;
  interactionId: string;
};

const lockedAt = new Date("2026-06-01T12:00:00.000Z");

describe("resolved queued interaction reservation acceptance", () => {
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let temporary:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | undefined;
  let releaseExecution: (() => void) | undefined;

  beforeAll(async () => {
    if (testDatabaseUrl) {
      await applyPendingMigrations(testDatabaseUrl);
      db = createDb(testDatabaseUrl);
    } else {
      temporary = await startEmbeddedPostgresTestDatabase(
        "paperclip-interaction-reservation-",
      );
      db = createDb(temporary.connectionString);
    }
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 60_000);

  afterEach(async () => {
    releaseExecution?.();
    releaseExecution = undefined;
    await heartbeat.drainActiveRunExecutions();
    // All rows belong to this disposable fixture database, including the
    // deliberately occupied lane. No running process or provider is attached.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL client_min_messages = WARNING`);
      await tx.execute(
        sql.raw(`TRUNCATE TABLE companies RESTART IDENTITY CASCADE`),
      );
    });
    adapterExecute.mockReset();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(
    addressee: "assignee" | "recipient" = "recipient",
  ): Promise<Fixture> {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const assigneeId = randomUUID();
    const attentionAgentId = randomUUID();
    const busyRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Reservation fixture",
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "local-board",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [
        { id: assigneeId, name: "Task assignee" },
        { id: attentionAgentId, name: "Interaction recipient" },
      ].map((agent) => ({
        ...agent,
        companyId,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        permissions: {},
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        },
      })),
    );
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue the assigned task",
      status: "todo",
      assigneeAgentId: assigneeId,
      responsibleUserId: "local-board",
    });
    // Keep the recipient's lane full. Cleanup cannot depend on the obsolete
    // attention run reaching the front of that agent's queue.
    await db.insert(heartbeatRuns).values({
      id: busyRunId,
      companyId,
      agentId: addressee === "assignee" ? assigneeId : attentionAgentId,
      status: "running",
      invocationSource: "on_demand",
      startedAt: new Date(),
      contextSnapshot: {},
    });
    const interaction = await issueThreadInteractionService(db).create(
      { id: issueId, companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        addresseeAgentId:
          addressee === "assignee" ? assigneeId : attentionAgentId,
        resolverPolicy: "anyone",
        payload: { version: 1, prompt: "Continue the bounded task?" },
      },
      { userId: "local-board" },
    );
    return {
      companyId,
      issueId,
      assigneeId,
      attentionAgentId,
      busyRunId,
      interactionId: interaction.id,
    };
  }

  async function resolve(f: Fixture) {
    return issueThreadInteractionService(db).acceptInteraction(
      {
        id: f.issueId,
        companyId: f.companyId,
        projectId: null,
        goalId: null,
      },
      f.interactionId,
      {},
      { agentId: f.attentionAgentId, runId: f.busyRunId },
    );
  }

  function attentionWake(f: Fixture) {
    return {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "interaction_pending",
      idempotencyKey: `interaction-pending:${f.interactionId}`,
      payload: {
        issueId: f.issueId,
        interactionId: f.interactionId,
        interactionKind: "request_confirmation",
      },
      contextSnapshot: {
        issueId: f.issueId,
        taskId: f.issueId,
        taskKey: f.issueId,
        wakeReason: "interaction_pending",
        interactionId: f.interactionId,
        interactionKind: "request_confirmation",
        source: "issue.interaction.created",
      },
    };
  }

  async function queuedReservation(
    f: Fixture,
    agentId = f.attentionAgentId,
    reason = "interaction_pending",
    reserve = true,
  ) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const wake = attentionWake(f);
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: f.companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason,
      status: "queued",
      payload: wake.payload,
      idempotencyKey: wake.idempotencyKey,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: f.companyId,
      agentId,
      wakeupRequestId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      startedAt: null,
      contextSnapshot:
        reason === "interaction_pending"
          ? wake.contextSnapshot
          : { issueId: f.issueId, wakeReason: reason },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    if (reserve) {
      await db
        .update(issues)
        .set({
          executionRunId: runId,
          executionAgentNameKey:
            agentId === f.assigneeId
              ? "task assignee"
              : "interaction recipient",
          executionLockedAt: lockedAt,
        })
        .where(eq(issues.id, f.issueId));
    }
    return { runId, wakeupRequestId };
  }

  async function issue(f: Fixture) {
    const [row] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, f.issueId));
    return row;
  }

  async function run(runId: string) {
    const [row] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return row;
  }

  function holdAdapter() {
    const gate = new Promise<void>((release) => {
      releaseExecution = release;
    });
    adapterExecute.mockImplementation(async () => {
      await gate;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Fixture execution complete",
        provider: "test",
        model: "test",
      };
    });
  }

  async function requestAssignee(f: Fixture) {
    holdAdapter();
    return heartbeat.wakeup(f.assigneeId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      idempotencyKey: `assignment:${f.issueId}`,
      payload: { issueId: f.issueId },
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" },
    });
  }

  async function expectAssigneeStarted(f: Fixture) {
    await expect
      .poll(
        async () => {
          const owner = (await issue(f)).executionRunId;
          if (!owner) return null;
          const current = await run(owner);
          return current
            ? { agentId: current.agentId, status: current.status }
            : null;
        },
        { timeout: 3_000 },
      )
      .toEqual({ agentId: f.assigneeId, status: "running" });
    expect((await issue(f)).assigneeAgentId).toBe(f.assigneeId);
  }

  // Catches late creation-event delivery: resolving before enqueue must not
  // create a new non-assignee reservation, even when that recipient is busy.
  it("does not reserve the task when a pending-attention event arrives after acceptance, including replay", async () => {
    const f = await seed();
    await resolve(f);
    await heartbeat.wakeup(f.attentionAgentId, attentionWake(f));
    await heartbeat.wakeup(f.attentionAgentId, attentionWake(f));
    expect
      .soft(
        (await issue(f)).executionRunId,
        "resolved attention must not acquire an execution reservation",
      )
      .toBeNull();
    await requestAssignee(f);
    await expectAssigneeStarted(f);
  });

  // Catches lock-holder validation happening only after recipient lane admission.
  it("retires an already queued resolved attention reservation so the current assignee can start", async () => {
    const f = await seed();
    const obsolete = await queuedReservation(f);
    await resolve(f);
    await queuedReservation(f, f.assigneeId, "issue_assigned", false);
    holdAdapter();
    await heartbeat.resumeQueuedRuns();
    expect
      .soft(
        (await run(obsolete.runId)).status,
        "never-started obsolete attention must leave queued state",
      )
      .toBe("cancelled");
    expect.soft((await run(obsolete.runId)).startedAt).toBeNull();
    const [receipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, obsolete.wakeupRequestId));
    expect.soft(["skipped", "cancelled"]).toContain(receipt.status);
    await expectAssigneeStarted(f);
  });

  it("keeps a pending interaction governed and retains its queued attention reservation", async () => {
    const f = await seed();
    const pending = await queuedReservation(f);
    const before = await issue(f);
    await queuedReservation(f, f.assigneeId, "issue_assigned", false);
    holdAdapter();
    await heartbeat.resumeQueuedRuns();
    const [interaction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.interactionId));
    expect(interaction.status).toBe("pending");
    expect((await run(pending.runId)).status).toBe("queued");
    expect(await issue(f)).toMatchObject({
      assigneeAgentId: f.assigneeId,
      executionRunId: pending.runId,
      executionAgentNameKey: before.executionAgentNameKey,
      executionLockedAt: before.executionLockedAt,
    });
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("does not turn reservation cleanup into authority to answer a human-only interaction", async () => {
    const f = await seed();
    const humanOnly = await issueThreadInteractionService(db).create(
      { id: f.issueId, companyId: f.companyId },
      {
        kind: "request_confirmation",
        resolverPolicy: "human_only",
        payload: { version: 1, prompt: "Human decision required" },
      },
      { userId: "local-board" },
    );
    await expect(
      issueThreadInteractionService(db).acceptInteraction(
        {
          id: f.issueId,
          companyId: f.companyId,
          projectId: null,
          goalId: null,
        },
        humanOnly.id,
        {},
        { agentId: f.attentionAgentId, runId: f.busyRunId },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const [unchanged] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, humanOnly.id));
    expect(unchanged).toMatchObject({
      status: "pending",
      resolvedAt: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
    });
  });

  it("does not steal a running execution that has started", async () => {
    const status = "running";
    const f = await seed();
    const active = await queuedReservation(f);
    const startedAt = new Date("2026-06-01T12:01:00.000Z");
    await db
      .update(heartbeatRuns)
      .set({ status, startedAt })
      .where(eq(heartbeatRuns.id, active.runId));
    await resolve(f);
    await requestAssignee(f);
    expect(await issue(f)).toMatchObject({
      executionRunId: active.runId,
      executionAgentNameKey: "interaction recipient",
      executionLockedAt: lockedAt,
    });
    expect(await run(active.runId)).toMatchObject({ status, startedAt });
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("keeps a queued legitimate assignee run's reservation after the interaction resolves", async () => {
    const f = await seed();
    await db
      .update(heartbeatRuns)
      .set({ agentId: f.assigneeId })
      .where(eq(heartbeatRuns.id, f.busyRunId));
    const legitimate = await queuedReservation(
      f,
      f.assigneeId,
      "issue_assigned",
    );
    await resolve(f);
    await requestAssignee(f);
    await heartbeat.resumeQueuedRuns();
    expect(await issue(f)).toMatchObject({
      assigneeAgentId: f.assigneeId,
      executionRunId: legitimate.runId,
      executionAgentNameKey: "task assignee",
      executionLockedAt: lockedAt,
    });
    expect((await run(legitimate.runId)).status).toBe("queued");
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  // Removing only the cancellation adapter's cross-assignee predicate must not
  // turn this resolved attention notification into a cancelled assignee run.
  it("preserves the current assignee's resolved attention reservation while their lane is full", async () => {
    const f = await seed("assignee");
    const legitimate = await queuedReservation(f, f.assigneeId);
    const beforeRun = await run(legitimate.runId);
    const [beforeReceipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, legitimate.wakeupRequestId));
    expect(beforeRun).toMatchObject({
      agentId: f.assigneeId,
      status: "queued",
      startedAt: null,
      contextSnapshot: {
        wakeReason: "interaction_pending",
        interactionId: f.interactionId,
      },
    });
    expect(await issue(f)).toMatchObject({
      assigneeAgentId: f.assigneeId,
      executionRunId: legitimate.runId,
      executionAgentNameKey: "task assignee",
      executionLockedAt: lockedAt,
    });
    const accepted = await issueThreadInteractionService(db).acceptInteraction(
      {
        id: f.issueId,
        companyId: f.companyId,
        projectId: null,
        goalId: null,
      },
      f.interactionId,
      {},
      { userId: "local-board" },
    );
    expect(accepted.interaction).toMatchObject({
      status: "accepted",
      addresseeAgentId: f.assigneeId,
      resolvedByUserId: "local-board",
    });

    await heartbeat.resumeQueuedRuns();

    expect.soft(await run(legitimate.runId)).toEqual(beforeRun);
    const [afterReceipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, legitimate.wakeupRequestId));
    expect.soft(afterReceipt).toEqual(beforeReceipt);
    expect.soft(await issue(f)).toMatchObject({
      assigneeAgentId: f.assigneeId,
      executionRunId: legitimate.runId,
      executionAgentNameKey: "task assignee",
      executionLockedAt: lockedAt,
    });
    expect(await run(f.busyRunId)).toMatchObject({
      agentId: f.assigneeId,
      status: "running",
    });
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  // The real pending interaction is addressed to A, but B is the task assignee
  // and has capacity. Removing only admission's recipient predicate must fail
  // on persisted admission, not merely on an adapter that has not started yet.
  it("skips a pending attention wake delivered to an agent other than its named recipient", async () => {
    const f = await seed();
    const beforeRuns = await db.select().from(heartbeatRuns);
    const [beforeInteraction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.interactionId));
    expect(beforeInteraction).toMatchObject({
      status: "pending",
      addresseeAgentId: f.attentionAgentId,
    });
    holdAdapter();

    const wake = attentionWake(f);
    // Match the creation route's real envelope. Without mutation: interaction,
    // context normalization drops interactionId and masks the recipient guard.
    const realAttentionWake = {
      ...wake,
      requestedByActorType: "user" as const,
      requestedByActorId: "local-board",
      payload: {
        ...wake.payload,
        sourceCommentId: null,
        sourceRunId: null,
        mutation: "interaction",
      },
      contextSnapshot: {
        ...wake.contextSnapshot,
        sourceCommentId: null,
        sourceRunId: null,
      },
    };
    const result = await heartbeat.wakeup(f.assigneeId, realAttentionWake);

    expect.soft(result).toBeNull();
    expect.soft(await db.select().from(heartbeatRuns)).toEqual(beforeRuns);
    expect.soft(await issue(f)).toMatchObject({
      assigneeAgentId: f.assigneeId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    const receipts = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, f.assigneeId));
    expect(receipts.every((receipt) => receipt.status === "skipped")).toBe(
      true,
    );
    const [afterInteraction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, f.interactionId));
    expect(afterInteraction).toEqual(beforeInteraction);
    expect(adapterExecute).not.toHaveBeenCalled();

    // A positive control prevents an unrelated admission gate from making the
    // negative assertions vacuous: the same event is admitted for its addressee.
    const addressed = await heartbeat.wakeup(
      f.attentionAgentId,
      realAttentionWake,
    );
    if (!addressed) {
      throw new Error("Correctly addressed pending attention was not admitted");
    }
    expect(addressed).toMatchObject({
      agentId: f.attentionAgentId,
      status: "queued",
      startedAt: null,
    });
    expect(await run(addressed.id)).toMatchObject({
      agentId: f.attentionAgentId,
      status: "queued",
      contextSnapshot: { interactionId: f.interactionId },
    });
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  // A fixture-only trigger faults exactly one queued -> cancelled transition.
  // Sequence increments survive transaction rollback, proving the fault fired
  // without depending on candidate order, logger mocks, timers, or live rows.
  // Removing the per-candidate try/catch must reject the same resume pass.
  it("isolates a queued attention retirement fault so an unrelated queued agent still starts", async () => {
    const faulty = await seed();
    const obsolete = await queuedReservation(faulty);
    await resolve(faulty);
    const unrelated = await seed();
    const eligible = await queuedReservation(
      unrelated,
      unrelated.assigneeId,
      "issue_assigned",
    );
    holdAdapter();
    await db.execute(
      sql`CREATE SEQUENCE reservation_retirement_fault_attempts`,
    );
    try {
      await db.execute(sql`
        CREATE FUNCTION reservation_retirement_fault() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM nextval('reservation_retirement_fault_attempts');
          RAISE EXCEPTION 'synthetic queued attention retirement fault';
        END;
        $$
      `);
      await db.execute(
        sql.raw(`
        CREATE TRIGGER reservation_retirement_fault_trigger
        BEFORE UPDATE ON heartbeat_runs
        FOR EACH ROW
        WHEN (OLD.id = '${obsolete.runId}'::uuid
          AND OLD.status = 'queued' AND NEW.status = 'cancelled')
        EXECUTE FUNCTION reservation_retirement_fault()
      `),
      );

      await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

      const attempts = await db.execute<{
        last_value: string;
        is_called: boolean;
      }>(
        sql`SELECT last_value, is_called FROM reservation_retirement_fault_attempts`,
      );
      expect(attempts[0]).toMatchObject({ is_called: true });
      expect(Number(attempts[0].last_value)).toBe(1);
      expect(await run(obsolete.runId)).toMatchObject({
        status: "queued",
        startedAt: null,
      });
      expect(await issue(faulty)).toMatchObject({
        executionRunId: obsolete.runId,
        executionAgentNameKey: "interaction recipient",
        executionLockedAt: lockedAt,
      });
      const [receipt] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, obsolete.wakeupRequestId));
      expect(receipt.status).toBe("queued");
      await expectAssigneeStarted(unrelated);
      expect(await run(eligible.runId)).toMatchObject({
        agentId: unrelated.assigneeId,
        status: "running",
      });
      await expect.poll(() => adapterExecute.mock.calls.length).toBe(1);
      expect(adapterExecute.mock.calls[0][0]).toMatchObject({
        runId: eligible.runId,
        agent: { id: unrelated.assigneeId },
      });
    } finally {
      await db.execute(sql`
        DROP TRIGGER IF EXISTS reservation_retirement_fault_trigger
        ON heartbeat_runs
      `);
      await db.execute(
        sql`DROP FUNCTION IF EXISTS reservation_retirement_fault()`,
      );
      await db.execute(
        sql`DROP SEQUENCE reservation_retirement_fault_attempts`,
      );
    }
  });

  // The task row is locked before the stale wake enters admission. A successor
  // wins the lock before admission resumes; cleanup must compare-and-clear the
  // obsolete run, never erase this successor's reservation tuple.
  it("preserves a newer reservation when stale resolution loses the issue-row race", async () => {
    const f = await seed();
    const obsolete = await queuedReservation(f);
    await resolve(f);
    const successorId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: successorId,
      companyId: f.companyId,
      agentId: f.assigneeId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: f.issueId },
    });
    const successorLockedAt = new Date("2026-06-01T12:02:00.000Z");
    let pending: ReturnType<typeof requestAssignee> | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM issues WHERE id = ${f.issueId} FOR UPDATE`,
        );
        pending = requestAssignee(f);
        await expect
          .poll(
            async () => {
              const result = await tx.execute<{ waiting: boolean }>(sql`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
            ) AS waiting
          `);
              return result[0]?.waiting;
            },
            { timeout: 3_000 },
          )
          .toBe(true);
        await tx
          .update(issues)
          .set({
            executionRunId: successorId,
            executionAgentNameKey: "successor",
            executionLockedAt: successorLockedAt,
          })
          .where(eq(issues.id, f.issueId));
      });
    } finally {
      await pending;
    }
    await heartbeat.wakeup(f.attentionAgentId, attentionWake(f));
    await heartbeat.wakeup(f.attentionAgentId, attentionWake(f));
    expect(await issue(f)).toMatchObject({
      executionRunId: successorId,
      executionAgentNameKey: "successor",
      executionLockedAt: successorLockedAt,
    });
    expect((await run(successorId)).status).toBe("running");
    expect((await run(obsolete.runId)).startedAt).toBeNull();
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("retires the same stale queued wake at most once across concurrent admission and replay", async () => {
    const f = await seed();
    const obsolete = await queuedReservation(f);
    await resolve(f);
    await requestAssignee(f);
    await expectAssigneeStarted(f);
    const observations = async () => ({
      run: await run(obsolete.runId),
      receipts: await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, obsolete.wakeupRequestId)),
      interactions: await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, f.interactionId)),
      events: await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, obsolete.runId)),
      activity: await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, "heartbeat_run"),
            eq(activityLog.entityId, obsolete.runId),
          ),
        ),
    });
    const before = await observations();
    expect(before.run.status).toBe("cancelled");
    expect(before.receipts).toHaveLength(1);
    expect(before.interactions).toHaveLength(1);
    expect(before.interactions[0].status).toBe("accepted");
    await expect(resolve(f)).rejects.toMatchObject({ status: 409 });
    await Promise.all([
      heartbeat.wakeup(f.attentionAgentId, attentionWake(f)),
      heartbeat.wakeup(f.attentionAgentId, attentionWake(f)),
    ]);
    await heartbeat.resumeQueuedRuns();
    expect(await observations()).toEqual(before);
    expect((await run(obsolete.runId)).status).toBe("cancelled");
    const assigneeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, f.assigneeId));
    expect(assigneeRuns).toHaveLength(1);
    expect(assigneeRuns[0].status).toBe("running");
  });
});
