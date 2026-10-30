import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agents, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints,
  chatGitHubConfigurations, chatGitHubReviews, chatMessageLinks, companies, createDb,
  getEmbeddedPostgresTestSupport, heartbeatRuns, issueComments, issues,
  startEmbeddedPostgresTestDatabase, toolApplications, toolConnections, type Db,
} from "@paperclipai/db";
import {
  defaultGitHubReviewPolicy, type GitHubReviewAssessment, type GitHubReviewEventContext,
  type GitHubReviewPolicy,
} from "@paperclipai/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { githubReviewCheckService } from "./chat-github-checks.js";

vi.mock("./chat-github-client.js", async importOriginal => ({
  ...await importOriginal<typeof import("./chat-github-client.js")>(),
  githubBotRepositoryToken: async () => "synthetic-installation-token",
}));

type ReviewInsert = typeof chatGitHubReviews.$inferInsert;
type RunInsert = typeof heartbeatRuns.$inferInsert;
type CheckBody = {
  name: string;
  head_sha: string;
  external_id: string;
  status: string;
  conclusion?: string;
  output: { title: string; summary: string };
};
type Check = Partial<CheckBody> & { id: number; html_url: string; app: { id: number } };
const support = await getEmbeddedPostgresTestSupport();
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

function assessment(score: GitHubReviewAssessment["score"], complete = true): GitHubReviewAssessment {
  return {
    reviewedCommit: "b".repeat(40), score, complete,
    summary: "Synthetic assessment", rationale: "The recorded findings determine this result.",
    coverage: { reviewedPaths: ["server/example.ts"], omittedPaths: [], limitations: [] },
    findings: score === 5 ? [] : [{ key: "incorrect-result", path: "server/example.ts", line: 12,
      side: "RIGHT", severity: "error", category: "correctness", body: "The result is incorrect." }],
  };
}

async function fixture(db: Db, options: {
  existingCheck?: boolean;
  conclusion?: string;
  ratingThreshold?: GitHubReviewPolicy["ratingThreshold"];
  liveHeadSha?: string;
} = {}) {
  const companyId = randomUUID(), agentId = randomUUID(), applicationId = randomUUID(), issueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic check ownership",
    issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic reviewer", adapterType: "process" });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Synthetic GitHub", type: "chat" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Review the current commit" });
  async function endpoint(botExternalId: string) {
    const connectionId = randomUUID();
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, uid: randomUUID(),
      name: "Synthetic GitHub", transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    const [row] = await db.insert(chatEndpoints).values({ companyId, connectionId, assignedAgentId: agentId,
      publicId: randomUUID(), provider: "github", status: "active", botExternalId,
      setup: { step: "complete" } }).returning();
    return row!;
  }
  const source = await endpoint("314");
  const policy = { ...defaultGitHubReviewPolicy(), ratingThreshold: options.ratingThreshold === undefined ? 5 : options.ratingThreshold };
  await db.insert(chatGitHubConfigurations).values({ companyId, endpointId: source.id, updatedByUserId: "fixture-user",
    configuration: { version: 1, toolsEnabled: true, responsibleUserId: "fixture-user", memberAccess: "all_linked",
      people: [], defaults: policy, repositories: {} } });
  await db.insert(chatEndpointResources).values({ companyId, endpointId: source.id, type: "repository",
    providerResourceId: "acme/widget", label: "acme/widget", enabled: true, availability: "available",
    metadata: { providerRepositoryId: "97531" } });
  const event: GitHubReviewEventContext = {
    event: "synchronize", deliveryId: randomUUID(), repositoryId: "97531", repository: "acme/widget",
    pullNumber: 42, title: "Review", body: "", baseSha: "a".repeat(40), headSha: "b".repeat(40), baseBranch: "main",
    author: { id: "1", login: "contributor", isBot: false }, sender: { id: "1", login: "contributor" }, draft: false, labels: [],
  };
  const externalId = `${source.id}:42:${event.headSha}`;
  const remote: Check[] = options.existingCheck === false ? [] : [{ id: 101, app: { id: 314 },
    name: "Paperclip Review", head_sha: event.headSha, external_id: externalId, status: "completed",
    conclusion: options.conclusion ?? "success", html_url: "https://github.com/acme/widget/checks/101" }];
  const writes: Array<{ method: string; body: CheckBody }> = [];
  const unexpectedRequests: string[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    const prefix = "/repos/acme/widget";
    if (url.origin === "https://api.github.com") {
      if (method === "GET" && url.pathname === `${prefix}/pulls/42`) {
        return Response.json({ head: { sha: options.liveHeadSha ?? event.headSha } });
      }
      if (method === "GET" && url.pathname === `${prefix}/commits/${event.headSha}/check-runs`) {
        return Response.json({ check_runs: remote });
      }
      if ((method === "POST" && url.pathname === `${prefix}/check-runs`)
        || (method === "PATCH" && url.pathname === `${prefix}/check-runs/101`)) {
        const body = JSON.parse(String(init?.body)) as CheckBody;
        writes.push({ method, body });
        const check = method === "PATCH" ? remote[0]! : { id: 102, app: { id: 314 },
          html_url: "https://github.com/acme/widget/checks/102" };
        Object.assign(check, body);
        if (method === "POST") remote.push(check);
        return Response.json(check);
      }
    }
    unexpectedRequests.push(`${method} ${url}`);
    throw new Error(`Unexpected synthetic GitHub request: ${method} ${url}`);
  };
  const service = githubReviewCheckService(db, providerFetch);
  async function review(overrides: Partial<ReviewInsert> = {}) {
    const [row] = await db.insert(chatGitHubReviews).values({ companyId, endpointId: source.id, issueId,
      repositoryId: event.repositoryId, repository: event.repository, pullNumber: event.pullNumber, headSha: event.headSha,
      deliveryId: randomUUID(), configurationRevision: 1, policySnapshot: policy, createdAt: at(10),
      event: { ...event, headSha: overrides.headSha ?? event.headSha, repositoryId: overrides.repositoryId ?? event.repositoryId,
        repository: overrides.repository ?? event.repository, pullNumber: overrides.pullNumber ?? event.pullNumber }, ...overrides }).returning();
    return row!;
  }
  async function run(status: string, overrides: Partial<RunInsert> = {}) {
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, createdAt: at(10), ...overrides }).returning();
    return row!;
  }
  async function delivery(state: typeof chatDeliveries.$inferInsert["state"] = "processed") {
    const [row] = await db.insert(chatDeliveries).values({ companyId, endpointId: source.id, providerEventId: randomUUID(),
      deduplicationKey: randomUUID(), eventKind: "message", state, normalizedEvent: { githubAutomatic: { context: event } } }).returning();
    return row!;
  }
  async function deliveryRun(status: string, createdAt: Date) {
    const received = await delivery();
    const [conversation] = await db.insert(chatConversations).values({ companyId, endpointId: source.id, issueId,
      externalConversationId: randomUUID(), externalLabel: "Synthetic pull request" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, body: "Review this commit" }).returning();
    await db.insert(chatMessageLinks).values({ companyId, endpointId: source.id, conversationId: conversation!.id,
      deliveryId: received.id, commentId: comment!.id, providerMessageId: randomUUID(), direction: "inbound" });
    return run(status, { contextSnapshot: { wakeCommentId: comment!.id }, createdAt });
  }
  const action = async () => (await db.select().from(chatActions).where(eq(chatActions.providerActionId, `github-check:${event.deliveryId}`)))[0]!;
  const reviews = () => db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.companyId, companyId)).orderBy(chatGitHubReviews.id);
  return { db, companyId, agentId, source, event, policy, remote, writes, unexpectedRequests, service,
    review, run, delivery, deliveryRun, action, reviews, otherEndpoint: () => endpoint("315"),
    enqueue: (admitted = true) => service.enqueue(source, event, admitted, "synthetic admission") };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

describe.skipIf(!support.supported)("GitHub assessed check ownership PostgreSQL behavior", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("github-check-ownership-");
    db = createDb(temporary.connectionString, { maxConnections: 1 });
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function withFixture(test: (f: Fixture) => Promise<void>, options: Parameters<typeof fixture>[1] = {}) {
    const rollback = Symbol("fixture rollback");
    try {
      await db.transaction(async tx => {
        await test(await fixture(tx as unknown as Db, options));
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function expectOwnership(f: Fixture, reviewId: string) {
    const retainedAssessments = async () => (await f.reviews()).filter(row => row.assessment !== null)
      .map(({ id, state, conclusion, assessment }) => ({ id, state, conclusion, assessment }));
    const retained = await retainedAssessments(), checks = structuredClone(f.remote);
    await f.enqueue();
    await f.service.processPending();
    expect.soft(f.unexpectedRequests).toEqual([]);
    expect.soft(f.writes, "assessments must prevent every check-run POST and PATCH").toEqual([]);
    expect.soft(await retainedAssessments(), "retained review state, conclusion and assessment must remain intact").toEqual(retained);
    expect.soft(f.remote, "the published assessment must not be replaced or downgraded").toEqual(checks);
    expect.soft(await f.action()).toMatchObject({ status: "processed", result: { code: "assessment_owns_check", reviewId } });
    await f.service.processPending();
    expect.soft(f.writes).toEqual([]);
  }

  it.each(["running", "failed"])("retains an older assessment when a newer unassessed duplicate is %s", async status => {
    await withFixture(async f => {
      const run = await f.run(status);
      await f.review({ runId: run.id, createdAt: at(30) });
      const assessed = await f.review({ createdAt: at(10), state: "completed", conclusion: "success", assessment: assessment(5),
        checkId: "101", checkUrl: "https://github.com/acme/widget/checks/101" });
      await expectOwnership(f, assessed.id);
    });
  });

  it.each([
    { score: 2, complete: true, state: "completed", conclusion: "failure" },
    { score: 0, complete: false, state: "incomplete", conclusion: "action_required" },
  ] as const)("keeps the newest assessed $conclusion result instead of an older passing score", async result => {
    await withFixture(async f => {
      const run = await f.run("failed");
      await f.review({ runId: run.id, createdAt: at(40) });
      const newest = await f.review({ createdAt: at(30), state: result.state, conclusion: result.conclusion,
        assessment: assessment(result.score, result.complete), checkId: "101" });
      await f.review({ createdAt: at(10), state: "completed", conclusion: "success", assessment: assessment(5) });
      await expectOwnership(f, newest.id);
    }, { conclusion: result.conclusion });
  });

  it("preserves the existing single-assessment ownership control", async () => {
    await withFixture(async f => {
      const assessed = await f.review({ state: "completed", conclusion: "success", assessment: assessment(5), checkId: "101" });
      await expectOwnership(f, assessed.id);
    });
  });

  it.each([
    { run: null, state: "queued", status: "queued", action: "received", method: "POST" },
    { run: "queued", state: "queued", status: "queued", action: "received", method: "POST" },
    { run: "running", state: "running", status: "in_progress", action: "received", method: "POST" },
    { run: "succeeded", state: "incomplete", status: "completed", action: "processed", method: "PATCH" },
    { run: "failed", state: "error", status: "completed", action: "processed", method: "PATCH" },
    { run: "cancelled", state: "error", status: "completed", action: "processed", method: "PATCH" },
    { run: "timed_out", state: "error", status: "completed", action: "processed", method: "PATCH" },
  ])("publishes the normal $state lifecycle for an unassessed $run run", async expected => {
    await withFixture(async f => {
      const run = expected.run ? await f.run(expected.run) : undefined;
      const review = await f.review({ runId: run?.id });
      await f.enqueue(); await f.service.processPending();
      expect(f.unexpectedRequests).toEqual([]);
      expect(f.writes).toEqual([{ method: expected.method, body: expect.objectContaining({ name: "Paperclip Review",
        head_sha: f.event.headSha, external_id: `${f.source.id}:42:${f.event.headSha}`, status: expected.status }) }]);
      const body = f.writes[0]!.body;
      expect(body.conclusion).toBe(expected.status === "completed" ? "action_required" : undefined);
      expect(body).not.toHaveProperty("score");
      expect(body.output).not.toHaveProperty("score");
      expect(await f.action()).toMatchObject({ status: expected.action, result: { state: expected.state } });
      expect((await f.reviews()).find(row => row.id === review.id)).toMatchObject({ state: expected.state,
        assessment: null, conclusion: expected.status === "completed" ? "action_required" : null });
    });
  });

  it("keeps the newest unassessed lifecycle when no matching assessment exists", async () => {
    await withFixture(async f => {
      const running = await f.run("running"), failed = await f.run("failed");
      const newest = await f.review({ runId: running.id, createdAt: at(30) });
      const older = await f.review({ runId: failed.id, createdAt: at(10) });
      await f.enqueue(); await f.service.processPending();
      expect(f.writes).toEqual([{ method: "POST", body: expect.objectContaining({ status: "in_progress" }) }]);
      expect(await f.action()).toMatchObject({ status: "received", result: { state: "running" } });
      const retained = await f.reviews();
      expect(retained.find(row => row.id === newest.id)).toMatchObject({ runId: running.id, state: "running", assessment: null });
      expect(retained.find(row => row.id === older.id)).toEqual(older);
    });
  });

  it("creates a queued check when admission has no review or assessment yet", async () => {
    await withFixture(async f => {
      await f.enqueue(); await f.service.processPending();
      expect(f.writes).toEqual([{ method: "POST", body: expect.objectContaining({ status: "queued" }) }]);
      expect(f.writes[0]!.body.conclusion).toBeUndefined();
      expect(await f.action()).toMatchObject({ status: "received", result: { state: "queued" } });
    }, { existingCheck: false });
  });

  it.each(["filtered", "failed"] as const)("publishes manual-required when an unassessed delivery is %s", async state => {
    await withFixture(async f => {
      await f.delivery(state);
      await f.enqueue(); await f.service.processPending();
      expect(f.writes).toEqual([{ method: "PATCH", body: expect.objectContaining({ status: "completed", conclusion: "action_required" }) }]);
      expect(await f.action()).toMatchObject({ status: "processed", result: { state: "manual_required" } });
    });
  });

  it("keeps report-only terminal checks neutral without inventing an assessment", async () => {
    await withFixture(async f => {
      const run = await f.run("succeeded");
      await f.review({ runId: run.id });
      await f.enqueue(); await f.service.processPending();
      expect(f.writes).toEqual([{ method: "PATCH", body: expect.objectContaining({ status: "completed", conclusion: "neutral" }) }]);
      expect((await f.reviews())[0]).toMatchObject({ state: "incomplete", assessment: null, conclusion: "neutral" });
      expect(await f.action()).toMatchObject({ status: "processed", result: { state: "incomplete" } });
    }, { ratingThreshold: null });
  });

  it("recovers the newest matching delivery run when the unassessed review has no run ID", async () => {
    await withFixture(async f => {
      const newest = await f.deliveryRun("running", at(30));
      await f.deliveryRun("failed", at(10));
      await f.run("succeeded", { contextSnapshot: { wakeCommentId: randomUUID() }, createdAt: at(40) });
      await f.review();
      await f.enqueue(); await f.service.processPending();
      expect(f.writes).toEqual([{ method: "POST", body: expect.objectContaining({ status: "in_progress" }) }]);
      expect((await f.reviews())[0]).toMatchObject({ runId: newest.id, state: "running", assessment: null, conclusion: null });
      expect(await f.action()).toMatchObject({ status: "received", result: { state: "running" } });
    });
  });

  it.each([
    { status: "running", state: "running", checkStatus: "in_progress", actionStatus: "received" },
    { status: "failed", state: "error", checkStatus: "completed", actionStatus: "processed" },
  ])("publishes the $state lifecycle instead of an abandoned unpublished assessment", async expected => {
    await withFixture(async f => {
      const abandoned = await f.review({ createdAt: at(10), state: "superseded", assessment: assessment(5),
        conclusion: "success", checkId: null, checkUrl: null });
      const run = await f.run(expected.status);
      const replacement = await f.review({ runId: run.id, createdAt: at(30) });
      await f.enqueue();
      await f.service.processPending();
      expect.soft(f.unexpectedRequests).toEqual([]);
      expect.soft(f.writes, "an unpublished superseded assessment cannot leave the current head without a check")
        .toEqual([{ method: "POST", body: expect.objectContaining({ name: "Paperclip Review",
          head_sha: f.event.headSha, status: expected.checkStatus }) }]);
      expect.soft(f.writes[0]?.body.conclusion).toBe(expected.checkStatus === "completed" ? "action_required" : undefined);
      expect.soft(f.remote).toHaveLength(1);
      expect.soft(await f.action()).toMatchObject({ status: expected.actionStatus, result: { state: expected.state } });
      const retained = await f.reviews();
      expect.soft(retained.find(row => row.id === replacement.id)).toMatchObject({ runId: run.id,
        state: expected.state, assessment: null, conclusion: expected.checkStatus === "completed" ? "action_required" : null });
      expect.soft(retained.find(row => row.id === abandoned.id)).toEqual(abandoned);
    }, { existingCheck: false });
  });

  it("settles an obsolete running duplicate after its run fails without changing the published assessment", async () => {
    await withFixture(async f => {
      const assessed = await f.review({ createdAt: at(10), state: "completed", conclusion: "success",
        assessment: assessment(5), checkId: "101", checkUrl: "https://github.com/acme/widget/checks/101" });
      const run = await f.run("failed", { error: "Synthetic review run failed" });
      const duplicate = await f.review({ runId: run.id, createdAt: at(30), state: "running" });
      await expectOwnership(f, assessed.id);
      expect((await f.reviews()).find(row => row.id === duplicate.id),
        "provider ownership must not keep a failed duplicate displayed as running")
        .toMatchObject({ runId: run.id, state: "error", assessment: null, conclusion: "action_required" });
    });
  });

  it("supersedes a queued automatic receipt for a stale head without changing its published assessment", async () => {
    await withFixture(async f => {
      const assessed = await f.review({ createdAt: at(10), state: "completed", conclusion: "success",
        assessment: assessment(5), checkId: "101", checkUrl: "https://github.com/acme/widget/checks/101" });
      const delivery = await f.delivery();
      const receipt = await f.review({ deliveryId: delivery.id, createdAt: at(30), state: "queued" });
      const checks = structuredClone(f.remote);
      await f.enqueue();
      await f.service.processPending();
      await f.service.processPending();
      expect.soft(f.unexpectedRequests).toEqual([]);
      expect.soft(f.writes, "stale work must not write over the assessed check").toEqual([]);
      expect.soft(f.remote).toEqual(checks);
      expect.soft(await f.action()).toMatchObject({ status: "cancelled", result: { code: "stale_head" } });
      const retained = await f.reviews();
      expect.soft(retained.find(row => row.id === receipt.id),
        "stale-head cancellation and repair must settle the queued automatic receipt")
        .toMatchObject({ state: "superseded", assessment: null, runId: null });
      expect.soft(retained.find(row => row.id === assessed.id)).toEqual(assessed);
    }, { liveHeadSha: "c".repeat(40) });
  });

  const coordinates = ["head", "endpoint", "repository ID", "pull number"] as const;
  async function otherCoordinate(f: Fixture, coordinate: typeof coordinates[number]): Promise<Partial<ReviewInsert>> {
    switch (coordinate) {
      case "head": return { headSha: "c".repeat(40) };
      case "endpoint": return { endpointId: (await f.otherEndpoint()).id };
      case "repository ID": return { repositoryId: "97532" };
      case "pull number": return { pullNumber: 43 };
    }
  }

  it.each(coordinates)("does not borrow an assessment or score from another %s", async coordinate => {
    await withFixture(async f => {
      const run = await f.run("running");
      const review = await f.review({ runId: run.id, createdAt: at(20) });
      const foreign = assessment(5);
      const overrides = await otherCoordinate(f, coordinate);
      if (overrides.headSha) foreign.reviewedCommit = overrides.headSha;
      await f.review({ ...overrides, createdAt: at(30), state: "completed", conclusion: "success", assessment: foreign });
      const before = await f.reviews();
      await f.enqueue(); await f.service.processPending();
      expect(f.unexpectedRequests).toEqual([]);
      expect(f.writes).toEqual([{ method: "POST", body: expect.objectContaining({ status: "in_progress" }) }]);
      expect(f.writes[0]!.body.conclusion).toBeUndefined();
      expect(f.writes[0]!.body.output.summary).not.toMatch(/\b[0-5]\s*\/\s*5\b/);
      expect(await f.action()).toMatchObject({ status: "received", result: { state: "running" } });
      const after = await f.reviews();
      expect(after.find(row => row.id === review.id)).toMatchObject({ state: "running", assessment: null, conclusion: null });
      expect(after.filter(row => row.id !== review.id)).toEqual(before.filter(row => row.id !== review.id));
    });
  });

  it.each(coordinates)("retains matching nonpassing ownership despite a newer assessment on another %s", async coordinate => {
    await withFixture(async f => {
      const run = await f.run("failed");
      await f.review({ runId: run.id, createdAt: at(40) });
      const matching = await f.review({ createdAt: at(10), state: "completed", conclusion: "failure", assessment: assessment(2) });
      const foreign = assessment(5);
      const overrides = await otherCoordinate(f, coordinate);
      if (overrides.headSha) foreign.reviewedCommit = overrides.headSha;
      await f.review({ ...overrides, createdAt: at(30), state: "completed", conclusion: "success", assessment: foreign });
      await expectOwnership(f, matching.id);
    }, { conclusion: "failure" });
  });
});
