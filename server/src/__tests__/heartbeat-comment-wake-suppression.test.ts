import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  toolRuntimeMetricCounters,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { findActionableCommentMarkers } from "../services/comment-wake-suppression.ts";
import { replayWakeSuppression } from "../services/wake-suppression-replay.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Comment wake suppression test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres comment wake suppression tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat comment wake suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-comment-wake-suppression-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(toolRuntimeMetricCounters);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

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
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No-op wake storm",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedTerminalRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    finishedSecondsAgo: number;
  }) {
    const runId = randomUUID();
    const finishedAt = new Date(Date.now() - input.finishedSecondsAgo * 1000);
    const startedAt = new Date(finishedAt.getTime() - 5_000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status ?? "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt,
      finishedAt,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_commented" },
    });
    return runId;
  }

  async function seedComment(input: {
    companyId: string;
    issueId: string;
    authorType: "user" | "agent" | "system";
    authorAgentId?: string;
    body: string;
  }) {
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: input.authorType,
      authorAgentId: input.authorAgentId ?? null,
      authorUserId: input.authorType === "user" ? "board-user" : null,
      body: input.body,
    });
    return commentId;
  }

  function commentWake(input: {
    agentId: string;
    issueId: string;
    commentId: string;
    requestedByActorType: "user" | "agent" | "system";
    requestedByActorId?: string;
    reason?: string;
    mutation?: string;
    allowRunCoalescing?: boolean;
    extraPayload?: Record<string, unknown>;
    extraContextSnapshot?: Record<string, unknown>;
  }) {
    return heartbeat.wakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason ?? "issue_commented",
      payload: {
        issueId: input.issueId,
        commentId: input.commentId,
        mutation: input.mutation ?? "comment",
        ...(input.extraPayload ?? {}),
      },
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.reason ?? "issue_commented",
        wakeCommentId: input.commentId,
        ...(input.extraContextSnapshot ?? {}),
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId:
        input.requestedByActorId ??
        (input.requestedByActorType === "user" ? "board-user" : "test-automation"),
      ...(input.allowRunCoalescing === undefined
        ? {}
        : { allowRunCoalescing: input.allowRunCoalescing }),
    });
  }

  async function latestWakeRequest(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function wakeSuppressionOf(wake: { payload: unknown } | null) {
    return (
      (wake?.payload as Record<string, unknown> | null)?.wakeSuppression as
        | Record<string, unknown>
        | undefined
    );
  }

  async function metricCount(companyId: string, metric: string) {
    return db
      .select({ count: sql<number | null>`sum(${toolRuntimeMetricCounters.count})::int` })
      .from(toolRuntimeMetricCounters)
      .where(
        and(
          eq(toolRuntimeMetricCounters.companyId, companyId),
          eq(toolRuntimeMetricCounters.metric, metric),
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function waitForMetric(companyId: string, metric: string) {
    // The counter write is fire-and-forget off the wake path; poll briefly.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await metricCount(companyId, metric)) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`metric ${metric} was never recorded for ${companyId}`);
  }

  async function runCount(companyId: string) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
  }

  it("suppresses markerless automation comments without starting a run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const wake = await commentWake({ agentId, issueId, commentId, requestedByActorType: "agent" });
    expect(wake).toBeNull();
    expect(await runCount(companyId)).toBe(0);

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toBe("comment_wake_suppressed");
    const suppression = wakeSuppressionOf(skipped);
    expect(suppression?.reason).toBe("automation_comment_no_marker");
    expect(suppression?.wakeCommentId).toBe(commentId);
    expect(suppression?.markers).toEqual([]);
    expect(typeof suppression?.suppressedAt).toBe("string");

    await waitForMetric(companyId, "wake_suppressed:automation_comment_no_marker");
  });

  it("wakes for human comments even with receipt-like bodies", async () => {
    const { agentId, issueId, companyId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "user",
      body: "PR #235 merged.",
    });

    const wake = await commentWake({ agentId, issueId, commentId, requestedByActorType: "user" });
    expect(wake).not.toBeNull();
  });

  it("wakes human comments with markers inside the debounce window", async () => {
    const { agentId, issueId, companyId } = await seedCompanyAgentIssue();
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 60 });
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "user",
      body: "@codexcoder please confirm the launch plan.",
    });

    // The debounce reset query excludes the triggering comment itself, so the
    // gate must bypass human authors explicitly instead of relying on it.
    const wake = await commentWake({ agentId, issueId, commentId, requestedByActorType: "user" });
    expect(wake).not.toBeNull();
  });

  it("wakes user-requested wakes that reference marked automation comments", async () => {
    const { agentId, issueId, companyId } = await seedCompanyAgentIssue();
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 60 });
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "Review finished with 2 findings.",
    });

    const wake = await commentWake({ agentId, issueId, commentId, requestedByActorType: "user" });
    expect(wake).not.toBeNull();
  });

  it("wakes for automation comments carrying an actionable marker", async () => {
    const { agentId, issueId, companyId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "system",
      body: "CI is red on the PR head: unit-tests failed.",
    });

    const wake = await commentWake({ agentId, issueId, commentId, requestedByActorType: "system" });
    expect(wake).not.toBeNull();
  });

  it("debounces marker-bearing automation chatter inside N minutes, then wakes on human input", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 60 });
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "Review finished with 2 findings.",
    });

    const debounced = await commentWake({ agentId, issueId, commentId, requestedByActorType: "agent" });
    expect(debounced).toBeNull();
    const skipped = await latestWakeRequest(agentId);
    expect(wakeSuppressionOf(skipped)?.reason).toBe("comment_wake_debounced");
    expect(typeof wakeSuppressionOf(skipped)?.nextAllowedAt).toBe("string");
    await waitForMetric(companyId, "wake_suppressed:comment_wake_debounced");

    // A human comment since the last finish resets the debounce window.
    await seedComment({ companyId, issueId, authorType: "user", body: "Looking now." });
    const admitted = await commentWake({ agentId, issueId, commentId, requestedByActorType: "agent" });
    expect(admitted).not.toBeNull();
  });

  it("guards quiet re-wakes inside M minutes and admits them on new input", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    // 7 minutes out: past the 5-minute debounce, inside the 10-minute guard.
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 7 * 60 });
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "system",
      body: "Review finished with 2 findings.",
    });

    const guarded = await commentWake({ agentId, issueId, commentId, requestedByActorType: "system" });
    expect(guarded).toBeNull();
    expect(wakeSuppressionOf(await latestWakeRequest(agentId))?.reason).toBe(
      "recent_run_no_changes",
    );
    await waitForMetric(companyId, "wake_suppressed:recent_run_no_changes");

    // Non-comment new input (a document) ends the quiet period.
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.document_created",
      entityType: "issue",
      entityId: issueId,
    });
    const admitted = await commentWake({ agentId, issueId, commentId, requestedByActorType: "system" });
    expect(admitted).not.toBeNull();
  });

  it("wakes marker-bearing automation comments after a failed run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    await seedTerminalRun({ companyId, agentId, issueId, status: "failed", finishedSecondsAgo: 60 });
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "Review finished with 2 findings.",
    });

    // Recovery, not chatter: the debounce and guard require a succeeded run.
    const wake = await commentWake({ agentId, issueId, commentId, requestedByActorType: "agent" });
    expect(wake).not.toBeNull();
  });

  it("fails open when the triggering comment is missing", async () => {
    const { agentId, issueId } = await seedCompanyAgentIssue();
    const wake = await commentWake({
      agentId,
      issueId,
      commentId: randomUUID(),
      requestedByActorType: "agent",
    });
    expect(wake).not.toBeNull();
  });

  // One wake per test: a second wake in the same test would hit the live run
  // from the first via wake-queue coalesce/defer instead of this gate.
  it("fails open when the triggering comment belongs to another issue", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Sibling issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    const foreignCommentId = await seedComment({
      companyId,
      issueId: otherIssueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const wake = await commentWake({
      agentId,
      issueId,
      commentId: foreignCommentId,
      requestedByActorType: "agent",
    });
    expect(wake).not.toBeNull();
  });

  it("never suppresses reopen wakes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const reopened = await commentWake({
      agentId,
      issueId,
      commentId,
      requestedByActorType: "agent",
      reason: "issue_reopened_via_comment",
    });
    expect(reopened).not.toBeNull();
  });

  it("never suppresses explicit-resume wakes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const resumed = await commentWake({
      agentId,
      issueId,
      commentId,
      requestedByActorType: "agent",
      extraPayload: { resumeIntent: true },
    });
    expect(resumed).not.toBeNull();
  });

  it("never suppresses interaction-mutation wakes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const interaction = await commentWake({
      agentId,
      issueId,
      commentId,
      requestedByActorType: "system",
      mutation: "interaction",
    });
    expect(interaction).not.toBeNull();
  });

  it("never suppresses child stop-relay notifications to the parent assignee", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    // Exact production relay body (services/issues.ts addStopRelayCommentIfNeeded).
    const body = "System relay: [TOG-1](/TOG/issues/TOG-1) transitioned to `blocked`.";
    // Prove the test is meaningful: the body matches no actionable marker, so
    // without the provenance bypass the gate would suppress this wake.
    expect(findActionableCommentMarkers(body)).toEqual([]);
    const commentId = await seedComment({ companyId, issueId, authorType: "system", body });

    // Raw literals, not the shared constants: these must match the values the
    // real wake site in routes/issues.ts sends, so a desync breaks this test.
    const wake = await commentWake({
      agentId,
      issueId,
      commentId,
      requestedByActorType: "system",
      requestedByActorId: "issue_stop_relay",
      extraContextSnapshot: { source: "issue.stop_relay" },
    });
    expect(wake).not.toBeNull();
  });

  it("never suppresses liveness-continuation wakes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    // Quarantined low-trust handoff shape: a markerless agent comment that must
    // still wake because the continuation is deliberate recovery, not chatter.
    const wake = await commentWake({
      agentId,
      issueId,
      commentId,
      requestedByActorType: "system",
      extraContextSnapshot: {
        livenessContinuationState: "quarantined_low_trust_handoff",
        livenessContinuationAttempt: 1,
        livenessContinuationMaxAttempts: 2,
        livenessContinuationReason: "Low-trust review output requires sanitized follow-up.",
      },
    });
    expect(wake).not.toBeNull();
  });

  it("never suppresses review-path recovery wakes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const wake = await commentWake({
      agentId,
      issueId,
      commentId,
      requestedByActorType: "agent",
      extraPayload: { reviewPathLost: true },
    });
    expect(wake).not.toBeNull();
  });

  it("never suppresses interrupted-run recovery wakes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const wake = await commentWake({
      agentId,
      issueId,
      commentId,
      requestedByActorType: "agent",
      extraPayload: { interruptedRunId: randomUUID() },
    });
    expect(wake).not.toBeNull();
  });

  it("never suppresses force-fresh-session wakes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const wake = await commentWake({
      agentId,
      issueId,
      commentId,
      requestedByActorType: "agent",
      extraContextSnapshot: { forceFreshSession: true },
    });
    expect(wake).not.toBeNull();
  });

  it("never suppresses causally-isolated wakes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const wake = await commentWake({
      agentId,
      issueId,
      commentId,
      requestedByActorType: "agent",
      allowRunCoalescing: false,
    });
    expect(wake).not.toBeNull();
  });

  it("fails open when the triggering comment is deleted", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });
    await db
      .update(issueComments)
      .set({ deletedAt: new Date() })
      .where(eq(issueComments.id, commentId));

    const wake = await commentWake({ agentId, issueId, commentId, requestedByActorType: "agent" });
    expect(wake).not.toBeNull();
  });

  it("stays disabled with COMMENT_WAKE_SUPPRESSION_ENABLED=false", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const commentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });

    const disabledHeartbeat = heartbeatService(db, {
      runtimeEnv: { COMMENT_WAKE_SUPPRESSION_ENABLED: "false" },
    });
    const wake = await disabledHeartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId, mutation: "comment" },
      contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: commentId },
      requestedByActorType: "agent",
      requestedByActorId: "test-automation",
    });
    expect(wake).not.toBeNull();
  });

  it("replays wake history with suppression tallies and zero human loss", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const botCommentId = await seedComment({
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "PR #235 merged.",
    });
    const humanCommentId = await seedComment({
      companyId,
      issueId,
      authorType: "user",
      body: "Please confirm the launch plan.",
    });
    const relayCommentId = await seedComment({
      companyId,
      issueId,
      authorType: "system",
      body: "System relay: [TOG-1](/TOG/issues/TOG-1) transitioned to `blocked`.",
    });

    async function seedWake(input: {
      commentId: string;
      requestedByActorType: "user" | "agent" | "system";
      requestedByActorId?: string;
      status?: string;
    }) {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: input.commentId, mutation: "comment" },
        status: input.status ?? "queued",
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId ?? "replay-fixture",
      });
    }
    await seedWake({ commentId: botCommentId, requestedByActorType: "agent" });
    await seedWake({ commentId: humanCommentId, requestedByActorType: "user" });
    await seedWake({ commentId: botCommentId, requestedByActorType: "agent", status: "skipped" });
    await seedWake({ commentId: botCommentId, requestedByActorType: "agent", status: "coalesced" });
    await seedWake({
      commentId: botCommentId,
      requestedByActorType: "agent",
      status: "deferred_issue_execution",
    });
    await seedWake({
      commentId: relayCommentId,
      requestedByActorType: "system",
      requestedByActorId: "issue_stop_relay",
    });

    const report = await replayWakeSuppression(db, {
      windowStart: new Date(Date.now() - 3_600_000),
      limit: 100,
      debounceMs: 5 * 60_000,
      guardMs: 10 * 60_000,
      companyIds: [companyId],
    });

    expect(report.wakesScanned).toBe(6);
    expect(report.alreadySkipped).toBe(1);
    // Coalesced/deferred rows never started a run: outside the denominator.
    expect(report.notRunStarting).toBe(2);
    expect(report.notRunStartingByStatus).toEqual({
      coalesced: 1,
      deferred_issue_execution: 1,
    });
    expect(report.classified).toBe(3);
    expect(report.suppressedTotal).toBe(1);
    expect(report.suppressedByReason.automation_comment_no_marker).toBe(1);
    // Human wake + stop-relay wake admitted.
    expect(report.admitted).toBe(2);
    expect(report.projectedRunReduction).toBeCloseTo(1 / 3, 4);
    expect(report.humanWakesSeen).toBe(1);
    expect(report.humanWakesSuppressed).toBe(0);
    // Receipt parity: ids and reason only, never comment bodies.
    expect(report.suppressedWakeSample).toHaveLength(1);
    expect(report.suppressedWakeSample[0]).not.toHaveProperty("bodyPrefix");
    expect(report.suppressedWakeSample[0]).toMatchObject({
      reason: "automation_comment_no_marker",
      commentId: botCommentId,
    });
  });
});
