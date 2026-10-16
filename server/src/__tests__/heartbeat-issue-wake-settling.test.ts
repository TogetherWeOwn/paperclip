import { randomUUID } from "node:crypto";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

// Regression tests: comment bursts on one card must not fan out
// into one run per comment, and every held wake must stay attributable to
// its trigger reason in `agent_wakeup_requests`.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue wake settling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

interface SettlingWorld {
  companyId: string;
  agentId: string;
  issueId: string;
  issuePrefix: string;
}

async function seedCompanyAndAgent(
  db: ReturnType<typeof createDb>,
): Promise<Pick<SettlingWorld, "companyId" | "agentId" | "issuePrefix">> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

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
    name: "Settling Agent",
    role: "engineer",
    status: "running",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    permissions: {},
  });

  return { companyId, agentId, issuePrefix };
}

async function seedIssue(
  db: ReturnType<typeof createDb>,
  world: Pick<SettlingWorld, "companyId" | "agentId" | "issuePrefix">,
  fields: {
    title: string;
    status: string;
    issueNumber: number;
    executionRunId?: string | null;
  },
): Promise<string> {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    companyId: world.companyId,
    title: fields.title,
    status: fields.status,
    priority: "medium",
    responsibleUserId: "responsible-user",
    assigneeAgentId: world.agentId,
    executionRunId: fields.executionRunId ?? null,
    executionAgentNameKey: fields.executionRunId ? "settling agent" : null,
    executionLockedAt: fields.executionRunId ? new Date() : null,
    issueNumber: fields.issueNumber,
    identifier: `${world.issuePrefix}-${fields.issueNumber}`,
  });
  return issueId;
}

async function postUserComment(
  db: ReturnType<typeof createDb>,
  companyId: string,
  issueId: string,
  body: string,
) {
  return db
    .insert(issueComments)
    .values({ companyId, issueId, authorUserId: "user-1", body })
    .returning()
    .then((rows) => rows[0]);
}

function commentWake(commentId: string, issueId: string) {
  return {
    source: "automation" as const,
    triggerDetail: "system",
    reason: "issue_commented",
    payload: { issueId, commentId },
    contextSnapshot: {
      issueId,
      taskId: issueId,
      commentId,
      wakeReason: "issue_commented",
    },
    requestedByActorType: "user" as const,
    requestedByActorId: "user-1",
  };
}

describeEmbeddedPostgres("issue wake settling window", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-issue-wake-settling-",
    );
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  afterEach(() => {
    runningProcesses.clear();
  });

  it("coalesces rapid comment wakes behind a queued run and keeps the trigger reason", async () => {
    const base = await seedCompanyAndAgent(db);
    // Occupy the agent's only run slot on another card so the queued run
    // below stays undispatched while the burst arrives.
    const blockerRunId = randomUUID();
    const blockerIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId: base.companyId,
      agentId: base.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId: blockerIssueId,
        taskId: blockerIssueId,
        wakeReason: "issue_assigned",
      },
    });
    runningProcesses.set(blockerRunId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });
    await seedIssue(db, base, {
      title: "Blocker issue",
      status: "in_progress",
      issueNumber: 1,
      executionRunId: blockerRunId,
    });
    const issueId = await seedIssue(db, base, {
      title: "Storm-burst issue",
      status: "todo",
      issueNumber: 2,
    });
    const heartbeat = heartbeatService(db);

    const comment1 = await postUserComment(
      db,
      base.companyId,
      issueId,
      "First burst comment",
    );
    const firstRun = await heartbeat.wakeup(
      base.agentId,
      commentWake(comment1.id, issueId),
    );
    expect(firstRun).not.toBeNull();
    expect(firstRun?.status).toBe("queued");

    const comment2 = await postUserComment(
      db,
      base.companyId,
      issueId,
      "Second burst comment",
    );
    const secondRun = await heartbeat.wakeup(
      base.agentId,
      commentWake(comment2.id, issueId),
    );

    expect(secondRun?.id).toBe(firstRun?.id);

    const cardRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, base.agentId),
          eq(heartbeatRuns.status, "queued"),
        ),
      );
    expect(cardRuns).toHaveLength(1);

    const receipts = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, base.companyId),
          eq(agentWakeupRequests.agentId, base.agentId),
          eq(agentWakeupRequests.status, "coalesced"),
        ),
      );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.runId).toBe(firstRun?.id);
    expect(receipts[0]?.coalescedCount).toBe(1);
    expect(
      (receipts[0]?.payload as Record<string, unknown> | null)?.requestedReason,
    ).toBe("issue_commented");

    expect(firstRun?.id).toBeDefined();
    const mergedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, firstRun?.id ?? "missing-run-id"))
      .then((rows) => rows[0]);
    const mergedIds =
      ((mergedRun?.contextSnapshot as Record<string, unknown> | null)
        ?.wakeCommentIds as string[] | undefined) ?? [];
    expect([...mergedIds].sort()).toEqual([comment1.id, comment2.id].sort());
  });

  it("holds comment wakes behind a running run as one attributable deferred wake", async () => {
    const base = await seedCompanyAndAgent(db);
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId,
      companyId: base.companyId,
      agentId: base.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId: "pending-issue",
        taskId: "pending-issue",
        wakeReason: "issue_assigned",
      },
    });
    runningProcesses.set(liveRunId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });
    const issueId = await seedIssue(db, base, {
      title: "Busy issue",
      status: "in_progress",
      issueNumber: 1,
      executionRunId: liveRunId,
    });
    // Point the live run at this card so the comment wakes defer behind it.
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
        },
      })
      .where(eq(heartbeatRuns.id, liveRunId));
    const heartbeat = heartbeatService(db);

    const comment1 = await postUserComment(
      db,
      base.companyId,
      issueId,
      "First held comment",
    );
    const comment2 = await postUserComment(
      db,
      base.companyId,
      issueId,
      "Second held comment",
    );
    expect(
      await heartbeat.wakeup(base.agentId, commentWake(comment1.id, issueId)),
    ).toBeNull();
    expect(
      await heartbeat.wakeup(base.agentId, commentWake(comment2.id, issueId)),
    ).toBeNull();

    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, base.companyId),
          eq(agentWakeupRequests.agentId, base.agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      );
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.coalescedCount).toBe(1);
    expect(
      (deferred[0]?.payload as Record<string, unknown> | null)?.requestedReason,
    ).toBe("issue_commented");

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, base.agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(liveRunId);
  });

  it("waits its turn instead of merging when a wake opts out of coalescing", async () => {
    const base = await seedCompanyAndAgent(db);
    const blockerRunId = randomUUID();
    const blockerIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId: base.companyId,
      agentId: base.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId: blockerIssueId,
        taskId: blockerIssueId,
        wakeReason: "issue_assigned",
      },
    });
    runningProcesses.set(blockerRunId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });
    await seedIssue(db, base, {
      title: "Blocker issue",
      status: "in_progress",
      issueNumber: 1,
      executionRunId: blockerRunId,
    });
    const issueId = await seedIssue(db, base, {
      title: "Opt-out issue",
      status: "todo",
      issueNumber: 2,
    });
    const heartbeat = heartbeatService(db);

    const comment1 = await postUserComment(
      db,
      base.companyId,
      issueId,
      "First comment",
    );
    const firstRun = await heartbeat.wakeup(
      base.agentId,
      commentWake(comment1.id, issueId),
    );
    expect(firstRun).not.toBeNull();

    const comment2 = await postUserComment(
      db,
      base.companyId,
      issueId,
      "Review findings follow-up",
    );
    const urgentRun = await heartbeat.wakeup(base.agentId, {
      ...commentWake(comment2.id, issueId),
      allowRunCoalescing: false,
    });

    // Opting out refuses the merge into the queued turn; the wake waits
    // behind it instead of fanning out a second run.
    expect(urgentRun).toBeNull();
    const coalesced = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, base.companyId),
          eq(agentWakeupRequests.agentId, base.agentId),
          eq(agentWakeupRequests.status, "coalesced"),
        ),
      );
    expect(coalesced).toHaveLength(0);
    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, base.companyId),
          eq(agentWakeupRequests.agentId, base.agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      );
    expect(deferred).toHaveLength(1);
    expect(
      (deferred[0]?.payload as Record<string, unknown> | null)?.requestedReason,
    ).toBe("issue_commented");
  });
});
