import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  derivePresentationWakeProvenance,
  readPresentationRunMadeIssueProgress,
} from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres no-op-wake presentation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("derivePresentationWakeProvenance", () => {
  it("reads the wake reason from the run context snapshot", () => {
    expect(
      derivePresentationWakeProvenance({
        issueId: "issue-1",
        wakeReason: "issue_monitor_due",
      }),
    ).toEqual({ wakeReason: "issue_monitor_due", wakeCommentId: null });
  });

  it("treats a missing or blank reason as no reason", () => {
    expect(derivePresentationWakeProvenance(null)).toEqual({
      wakeReason: null,
      wakeCommentId: null,
    });
    expect(derivePresentationWakeProvenance({ wakeReason: "   " })).toEqual({
      wakeReason: null,
      wakeCommentId: null,
    });
  });

  it("reads a direct wake comment id", () => {
    expect(
      derivePresentationWakeProvenance({
        wakeReason: "issue_monitor_due",
        wakeCommentId: "comment-9",
      }),
    ).toEqual({ wakeReason: "issue_monitor_due", wakeCommentId: "comment-9" });
  });

  it("prefers the latest batched comment id over the direct field", () => {
    expect(
      derivePresentationWakeProvenance({
        wakeReason: "issue_monitor_due",
        wakeCommentId: "comment-1",
        wakeCommentIds: ["comment-1", "comment-2"],
      }),
    ).toEqual({
      wakeReason: "issue_monitor_due",
      wakeCommentId: "comment-2",
    });
  });
});

describeEmbeddedPostgres("readPresentationRunMadeIssueProgress", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-noop-wake-presentation-",
    );
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssueRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No-op wake presentation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "monitor",
      status: "succeeded",
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId, wakeReason: "issue_monitor_due" },
    });
    return { companyId, agentId, issueId, runId };
  }

  async function logIssueActivity(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId: string;
    action: string;
  }) {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: input.action,
      entityType: "issue",
      entityId: input.issueId,
      agentId: input.agentId,
      runId: input.runId,
    });
  }

  it("returns undefined when there is no issue", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: null,
        hasExistingRunComment: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns true when the run already posted an explicit comment", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: true,
      }),
    ).resolves.toBe(true);
  });

  it("returns false when the run left no activity", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: false,
      }),
    ).resolves.toBe(false);
  });

  it("counts a run-attributed document creation as progress", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await logIssueActivity({ ...seed, action: "issue.document_created" });
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: false,
      }),
    ).resolves.toBe(true);
  });

  it("counts a run-attributed comment as progress", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await logIssueActivity({ ...seed, action: "issue.comment_added" });
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: false,
      }),
    ).resolves.toBe(true);
  });

  it("ignores activity that is not issue progress", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await logIssueActivity({ ...seed, action: "issue.viewed" });
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: false,
      }),
    ).resolves.toBe(false);
  });

  it("ignores progress attributed to a different run", async () => {
    const seed = await seedCompanyAgentIssueRun();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId: seed.companyId,
      agentId: seed.agentId,
      invocationSource: "monitor",
      status: "succeeded",
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId: seed.issueId, wakeReason: "issue_monitor_due" },
    });
    await logIssueActivity({
      ...seed,
      runId: otherRunId,
      action: "issue.comment_added",
    });
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: false,
      }),
    ).resolves.toBe(false);
  });

  it("ignores progress on a different issue", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await logIssueActivity({
      ...seed,
      issueId: randomUUID(),
      action: "issue.comment_added",
    });
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: false,
      }),
    ).resolves.toBe(false);
  });
});
