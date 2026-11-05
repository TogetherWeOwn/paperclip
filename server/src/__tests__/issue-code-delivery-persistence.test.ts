import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, executionWorkspaces, heartbeatRuns, issueComments,
  issueExecutionDecisions, issueThreadInteractions, issues, statusDecisions, type Db } from "@paperclipai/db";
import { issueService, type IssuePostCommitAction } from "../services/issues.js";
import type { ActivityPublication } from "../services/activity-log.js";
import type { PreparedCodeDeliveryReadiness } from "../services/code-delivery-readiness.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("common issue-service code-delivery denial", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-common-delivery-denial-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const stageId = randomUUID(), participantId = randomUUID(), priorStageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Delivery boundary", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending independent review", status: "in_review",
      assigneeAgentId: agentId, createdByAgentId: agentId,
      executionPolicy: { mode: "normal", stages: [
        { id: priorStageId, type: "review", participants: [{ id: randomUUID(), type: "user", userId: "security" }], approvalsNeeded: 1 },
        { id: stageId, type: "review", participants: [{ id: participantId, type: "user", userId: "reviewer" }], approvalsNeeded: 1 },
      ], commentRequired: true },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 1, currentStageType: "review",
        currentParticipant: { type: "user", userId: "reviewer" }, returnAssignee: { type: "agent", agentId },
        completedStageIds: [priorStageId], changesRequestedCount: 1, lastDecisionId: randomUUID(),
        lastDecisionOutcome: "changes_requested", reviewRequest: null },
    }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "running" });
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "request_confirmation", sourceRunId: runId,
      createdByAgentId: agentId, payload: { version: 1, prompt: "Independent acceptance" } });
    return { companyId, issueId, issue, agentId, runId };
  }

  async function snapshot(companyId: string) {
    return Promise.all([issues, heartbeatRuns, issueThreadInteractions, issueExecutionDecisions, statusDecisions,
      issueComments, activityLog, executionWorkspaces].map(async table => {
      const rows = await db.select().from(table).where(eq(table.companyId, companyId));
      return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }));
  }

  it.each(["done", "cancelled"])("rejects direct effective %s with every saved review/run/interaction row unchanged", async status => {
    const f = await seed(), before = await snapshot(f.companyId);
    await expect(issueService(db).update(f.issueId, { status, actorUserId: "reviewer", companyGuard: f.companyId }))
      .rejects.toMatchObject({ status: 409, details: { code: "code_delivery_not_ready", reason: "preparation_required" } });
    expect(await snapshot(f.companyId)).toEqual(before);
  });

  it("refuses a fabricated receipt at the real common-service boundary and preserves the caller's transaction", async () => {
    const f = await seed(), before = await snapshot(f.companyId);
    const publications: ActivityPublication[] = [], actions: IssuePostCommitAction[] = [];
    await db.transaction(async tx => {
      await expect(issueService(db).update(f.issueId, { status: "done", actorUserId: "reviewer" }, tx, publications, actions,
        { codeDelivery: { actor: { type: "board", userId: "reviewer", source: "session" }, prepared: {} as PreparedCodeDeliveryReadiness } }))
        .rejects.toMatchObject({ status: 409, details: { reason: "preparation_required" } });
      expect(await tx.select().from(issues).where(eq(issues.id, f.issueId))).toEqual([f.issue]);
    });
    expect(publications).toEqual([]);
    expect(actions).toEqual([]);
    expect(await snapshot(f.companyId)).toEqual(before);
  });

  it("does not borrow an actor or ambient GitHub access for a system completion", async () => {
    const f = await seed(), before = await snapshot(f.companyId);
    await expect(issueService(db).update(f.issueId, { status: "done", actorAgentId: null, actorUserId: null }))
      .rejects.toMatchObject({ status: 409, details: { reason: "preparation_required" } });
    expect(await snapshot(f.companyId)).toEqual(before);
  });

  it("rejects a terminal timestamp without status at the real common-service boundary", async () => {
    const f = await seed(), before = await snapshot(f.companyId);
    await expect(issueService(db).update(f.issueId, { completedAt: new Date(), actorUserId: "reviewer" }))
      .rejects.toMatchObject({ status: 409, details: { reason: "terminal_timestamp_requires_status" } });
    expect(await snapshot(f.companyId)).toEqual(before);
  });
});
