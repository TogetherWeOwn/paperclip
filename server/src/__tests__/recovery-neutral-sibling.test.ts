import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_ACTION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("recovery neutral sibling attribution", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("recovery-neutral-sibling-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it.each(["issue_children_completed", "issue_commented"])(
    "preserves the overlapping author's bounded wait after a never-started %s sibling", async wakeReason => {
      const companyId = randomUUID(), agentId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: `R${companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" });
      const nextCheckAt = new Date(Date.now() + 15 * 60_000);
      const timeoutAt = new Date(Date.now() + 60 * 60_000);
      const [issue] = await db.insert(issues).values({ companyId, title: "Settled readiness", status: "in_progress",
        assigneeAgentId: agentId, monitorNextCheckAt: nextCheckAt,
        executionPolicy: { monitor: { kind: "external_service", serviceName: "github-checks",
          externalRef: "https://github.com/example/project/pull/1", nextCheckAt: nextCheckAt.toISOString(),
          timeoutAt: timeoutAt.toISOString(), maxAttempts: 4 } } }).returning();
      const [author] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded",
        createdAt: new Date("2026-01-01T10:00:00.000Z"), startedAt: new Date("2026-01-01T10:00:01.000Z"),
        finishedAt: new Date("2026-01-01T10:10:00.000Z"), contextSnapshot: { issueId: issue.id } }).returning();
      const [comment] = wakeReason === "issue_commented"
        ? await db.insert(issueComments).values({ companyId, issueId: issue.id, authorAgentId: agentId,
          body: "The independent check found a compatibility risk. Keep the safety review before merge.",
          createdAt: new Date("2026-01-01T10:00:01.500Z") }).returning()
        : [];
      const [sibling] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled",
        errorCode: "issue_dependencies_blocked", error: "Issue has unresolved blockers",
        createdAt: new Date("2026-01-01T10:00:02.000Z"), startedAt: null,
        finishedAt: new Date("2026-01-01T10:00:03.000Z"),
        contextSnapshot: { issueId: issue.id, wakeReason, ...(comment ? { wakeCommentId: comment.id } : {}) } }).returning();
      const [newest] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
      expect(newest.id).toBe(sibling.id);
      expect(author.finishedAt!.getTime()).toBeGreaterThan(sibling.finishedAt!.getTime());
      expect(sibling.startedAt).toBeNull();
      const enqueueWakeup = vi.fn(async () => { throw new Error("A future monitor must not dispatch early"); });
      const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues({ companyId, issueId: issue.id });
      const [current] = await db.select().from(issues).where(eq(issues.id, issue.id));
      const actions = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issue.id)));
      expect({ result, current: { status: current.status, assigneeAgentId: current.assigneeAgentId,
        monitorNextCheckAt: current.monitorNextCheckAt }, actions },
      JSON.stringify({ authorId: author.id, newestCreatedRunId: newest.id, siblingId: sibling.id, actions }))
        .toMatchObject({ result: { escalated: 0 }, current: { status: "in_progress", assigneeAgentId: agentId,
          monitorNextCheckAt: nextCheckAt }, actions: [] });
      expect(enqueueWakeup).not.toHaveBeenCalled();
      if (comment) expect(await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))
        .toMatchObject([{ body: comment.body }]);
    }, 30_000,
  );
});
