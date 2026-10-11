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
  isMonitorOnlyIssueUpdateDetails,
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
    details?: Record<string, unknown>;
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
      details: input.details,
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

  it("ignores a monitor re-arm as the run's only activity", async () => {
    // Regression: every no-op monitor wake re-arms its own monitor, so
    // counting the re-arm as progress suppressed nothing and the final note
    // was published to the thread.
    const seed = await seedCompanyAgentIssueRun();
    await logIssueActivity({ ...seed, action: "issue.monitor_scheduled" });
    await logIssueActivity({
      ...seed,
      action: "issue.updated",
      details: {
        changes: {
          monitorNotes: { to: "Fast lanes green; heavies pending.", from: "CI queued." },
          executionState: {
            to: { status: "idle", monitor: { nextCheckAt: "2026-10-06T19:30:00Z" } },
            from: { status: "idle", monitor: { nextCheckAt: null } },
          },
          executionPolicy: {
            to: { mode: "normal", monitor: { nextCheckAt: "2026-10-06T19:30:00Z" } },
            from: null,
          },
          monitorNextCheckAt: { to: "2026-10-06T19:30:00Z", from: null },
        },
      },
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

  it("still counts a status change as progress", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await logIssueActivity({ ...seed, action: "issue.monitor_scheduled" });
    await logIssueActivity({
      ...seed,
      action: "issue.updated",
      details: {
        changes: {
          status: { to: "in_review", from: "in_progress" },
          monitorNextCheckAt: { to: "2026-10-06T19:30:00Z", from: null },
        },
      },
    });
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: false,
      }),
    ).resolves.toBe(true);
  });

  it("still counts a non-monitor execution-state advance as progress", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await logIssueActivity({
      ...seed,
      action: "issue.updated",
      details: {
        changes: {
          executionState: {
            to: {
              status: "idle",
              currentStageId: "stage-2",
              monitor: { nextCheckAt: "2026-10-06T19:30:00Z" },
            },
            from: {
              status: "idle",
              currentStageId: "stage-1",
              monitor: { nextCheckAt: null },
            },
          },
        },
      },
    });
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: false,
      }),
    ).resolves.toBe(true);
  });

  it("conservatively counts an unclassifiable update as progress", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await logIssueActivity({ ...seed, action: "issue.updated" });
    await expect(
      readPresentationRunMadeIssueProgress(db, {
        companyId: seed.companyId,
        runId: seed.runId,
        issueId: seed.issueId,
        hasExistingRunComment: false,
      }),
    ).resolves.toBe(true);
  });

  it("still counts a comment alongside monitor housekeeping", async () => {
    const seed = await seedCompanyAgentIssueRun();
    await logIssueActivity({ ...seed, action: "issue.monitor_scheduled" });
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
});

describe("isMonitorOnlyIssueUpdateDetails", () => {
  it("treats an empty change set as monitor-only", () => {
    expect(isMonitorOnlyIssueUpdateDetails({ changes: {} })).toBe(true);
  });

  it("treats a monitor-only re-arm as monitor-only", () => {
    expect(
      isMonitorOnlyIssueUpdateDetails({
        changes: {
          monitorNotes: { to: "b", from: "a" },
          executionState: {
            to: { status: "idle", monitor: { nextCheckAt: "t2" } },
            from: { status: "idle", monitor: { nextCheckAt: null } },
          },
          monitorNextCheckAt: { to: "t2", from: null },
        },
      }),
    ).toBe(true);
  });

  it("treats a status change as progress", () => {
    expect(
      isMonitorOnlyIssueUpdateDetails({
        changes: { status: { to: "done", from: "in_progress" } },
      }),
    ).toBe(false);
  });

  it("treats a blocker change as progress", () => {
    expect(
      isMonitorOnlyIssueUpdateDetails({
        changes: {
          blockedByIssueIds: { to: [], from: ["other-id"] },
          monitorNotes: { to: "b", from: "a" },
        },
      }),
    ).toBe(false);
  });

  it("treats missing or malformed details as progress", () => {
    expect(isMonitorOnlyIssueUpdateDetails(null)).toBe(false);
    expect(isMonitorOnlyIssueUpdateDetails({})).toBe(false);
    expect(isMonitorOnlyIssueUpdateDetails({ changes: null })).toBe(false);
  });

  it("treats a scheduling-only policy creation as monitor-only", () => {
    expect(
      isMonitorOnlyIssueUpdateDetails({
        changes: {
          executionPolicy: {
            to: {
              mode: "normal",
              stages: [],
              monitor: { nextCheckAt: "t2" },
              commentRequired: true,
            },
            from: null,
          },
          monitorNextCheckAt: { to: "t2", from: null },
        },
      }),
    ).toBe(true);
  });

  it("treats a policy creation with planned stages as progress", () => {
    expect(
      isMonitorOnlyIssueUpdateDetails({
        changes: {
          executionPolicy: {
            to: {
              mode: "normal",
              stages: [{ id: "stage-1" }],
              monitor: { nextCheckAt: "t2" },
            },
            from: null,
          },
        },
      }),
    ).toBe(false);
  });

  it("treats a from-null execution-state creation as progress", () => {
    expect(
      isMonitorOnlyIssueUpdateDetails({
        changes: {
          executionState: {
            to: { status: "idle", monitor: { nextCheckAt: "t2" } },
            from: null,
          },
        },
      }),
    ).toBe(false);
  });
});
