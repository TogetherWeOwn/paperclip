import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy review-wait recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-review-wait-recovery-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });

  const reviewWaitResult = {
    stopReason: "issue_continuation_waiting_on_review",
    timeoutSource: "stale_queued_run_gate",
    effectiveTimeoutSec: 0,
    timeoutConfigured: false,
    timeoutFired: false,
  };

  async function seed(issueStatus: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Review wait", defaultResponsibleUserId: "board",
      issuePrefix: `R${companyId.slice(0, 6)}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Executor", role: "engineer",
      adapterType: "paperclip_runner", status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Ship docs", status: issueStatus, assigneeAgentId: agentId,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, runtimeMode: "legacy", status: "cancelled",
      errorCode: "issue_continuation_waiting_on_review",
      contextSnapshot: { issueId }, resultJson: reviewWaitResult,
      finishedAt: new Date("2026-10-17T04:46:23Z"),
    }).returning();
    return { companyId, agentId, issueId, runId, run };
  }

  async function seedAction(
    f: Awaited<ReturnType<typeof seed>>,
    input: { status: string; outcome?: string; automatic?: boolean },
  ) {
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.agentId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${f.runId}`, status: input.status,
      outcome: input.outcome ?? null,
      resolvedAt: input.status === "resolved" ? new Date("2026-10-17T05:00:00Z") : null,
      nextAction: "Inspect the stopped provider before continuing.",
      evidence: {
        runId: f.runId, originalFailureCode: "issue_continuation_waiting_on_review",
        adapterRecovery: "unsupported_or_unknown", attempt: 1,
        ...(input.automatic ? {
          automaticRecovery: {
            policy: "preserve_without_replay_v1", runId: f.runId,
            replay: "blocked", actionOutcome: "unknown",
            recordedAt: "2026-10-17T05:00:00.000Z",
          },
        } : {}),
      },
    }).returning();
    return action;
  }

  async function actionsFor(issueId: string) {
    return db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  it("folds active and settled review-wait generations without reblocking the current review wait", async () => {
    const f = await seed("in_review");
    await seedAction(f, { status: "resolved", outcome: "blocked", automatic: true });
    await seedAction(f, { status: "active" });

    await Promise.all([settleUnrecoverableExecutions(db), settleUnrecoverableExecutions(db)]);
    await settleUnrecoverableExecutions(db);

    const actions = await actionsFor(f.issueId);
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.status).toBe("resolved");
      expect(action.outcome).toBe("false_positive");
      const automatic = action.evidence.automaticRecovery as { replay?: string } | undefined;
      expect(automatic?.replay ?? "allowed").toBe("allowed");
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe("in_review");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("does not mint a new generation for identical automatically settled no-replay evidence", async () => {
    const f = await seed("blocked");
    const [realRun] = await db.update(heartbeatRuns).set({
      status: "failed", errorCode: "process_lost", startedAt: new Date("2026-10-17T04:00:00Z"),
      lastOutputSeq: 7, lastOutputAt: new Date("2026-10-17T04:30:00Z"), resultJson: {},
    }).where(eq(heartbeatRuns.id, f.runId)).returning();
    await seedAction(f, { status: "resolved", outcome: "blocked", automatic: true });

    await terminalizeLegacyExecution({ db, run: realRun, status: realRun.status, fromStatuses: [realRun.status] });
    await terminalizeLegacyExecution({ db, run: realRun, status: realRun.status, fromStatuses: [realRun.status] });

    expect(await actionsFor(f.issueId)).toHaveLength(1);
    // The settled unknown-outcome gate itself is preserved.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("still creates a new incident for a later legitimate failure on the same issue", async () => {
    const f = await seed("blocked");
    await seedAction(f, { status: "resolved", outcome: "blocked", automatic: true });
    const [laterRun] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, runtimeMode: "legacy", status: "failed",
      errorCode: "process_lost", startedAt: new Date("2026-10-17T06:00:00Z"),
      lastOutputSeq: 3, lastOutputAt: new Date("2026-10-17T06:05:00Z"),
      contextSnapshot: { issueId: f.issueId }, resultJson: {},
      finishedAt: new Date("2026-10-17T06:06:00Z"),
    }).returning();

    await terminalizeLegacyExecution({
      db, run: laterRun, status: laterRun.status, fromStatuses: [laterRun.status],
    });

    const actions = await actionsFor(f.issueId);
    expect(actions).toHaveLength(2);
    const active = actions.filter((action) => action.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].fingerprint).toBe(`legacy-execution:${laterRun.id}`);
  });

  it("keeps the blocked gate for a review-wait run that emitted output", async () => {
    const f = await seed("in_review");
    await db.update(heartbeatRuns).set({
      lastOutputSeq: 2, lastOutputAt: new Date("2026-10-17T04:40:00Z"),
    }).where(eq(heartbeatRuns.id, f.runId));
    await seedAction(f, { status: "active" });

    await settleUnrecoverableExecutions(db);

    const actions = await actionsFor(f.issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "resolved", outcome: "blocked" });
    const automatic = actions[0].evidence.automaticRecovery as { replay?: string };
    expect(automatic.replay).toBe("blocked");
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.status).toBe("blocked");
  });
});
