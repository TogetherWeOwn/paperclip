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

  async function seed(): Promise<Fixture> {
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
      agentId: attentionAgentId,
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
        addresseeAgentId: attentionAgentId,
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
