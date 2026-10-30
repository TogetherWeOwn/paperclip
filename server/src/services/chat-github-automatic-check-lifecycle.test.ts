import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agents, authUsers, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints,
  chatExternalPrincipals, chatGitHubConfigurations, chatGitHubReviews, chatIdentityLinks, chatMessageLinks,
  companies, companyMemberships, createDb, getEmbeddedPostgresTestSupport, heartbeatRuns, issueComments,
  issues, startEmbeddedPostgresTestDatabase, toolApplications, toolConnections, type Db,
} from "@paperclipai/db";
import { defaultGitHubReviewPolicy, type GitHubReviewAssessment, type GitHubReviewEventContext } from "@paperclipai/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retainGitHubReviewReceipt } from "./chat-channels/github/task-preparation.js";
import { githubAutomaticAdmission } from "./chat-github-events.js";
import { githubReviewCheckService } from "./chat-github-checks.js";
import { githubChatReviewService } from "./chat-github-reviews.js";

import { secretService } from "./secrets.js";
import { syncGitHubBotTools } from "./chat-github-tools.js";

const syntheticSigningKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();

type Review = typeof chatGitHubReviews.$inferSelect;
type CheckBody = { name: string; head_sha: string; external_id: string; status: string;
  conclusion?: string; output?: { title: string; summary: string } };
type Check = Partial<CheckBody> & { id: number; html_url: string; app: { id: number } };
const support = await getEmbeddedPostgresTestSupport();

async function fixture(db: Db) {
  const companyId = randomUUID(), agentId = randomUUID(), applicationId = randomUUID(), issueId = randomUUID();
  const userId = `fixture-${randomUUID()}`, connectionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic automatic review lifecycle",
    issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 7)}` });
  await db.insert(authUsers).values({ id: userId, name: "Synthetic user", email: `${userId}@example.test`,
    emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
    status: "active", membershipRole: "operator" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic reviewer", adapterType: "process",
    runtimeConfig: {}, permissions: {} });
  await db.insert(issues).values({ id: issueId, companyId, title: "Review current pull request", assigneeAgentId: agentId,
    status: "in_progress" });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Synthetic GitHub", type: "chat" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, uid: randomUUID(),
    name: "Synthetic GitHub", transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
  const vault = secretService(db), refs: NonNullable<typeof toolConnections.$inferInsert["credentialSecretRefs"]> = [];
  for (const [key, value] of Object.entries({ appId: "314", installationId: "2468", privateKey: syntheticSigningKey })) {
    const secret = await vault.create(companyId, { name: `synthetic-${key}-${randomUUID()}`, provider: "local_encrypted", value });
    await vault.createBinding({ companyId, secretId: secret.id, targetType: "tool_connection", targetId: connectionId,
      configPath: `credentials.${key}` });
    refs.push({ configPath: `credentials.${key}`, secretId: secret.id, versionSelector: "latest" });
  }
  await db.update(toolConnections).set({ credentialSecretRefs: refs }).where(eq(toolConnections.id, connectionId));
  const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId, assignedAgentId: agentId,
    provider: "github", publicId: randomUUID(), status: "active", providerAccountId: "synthetic-github",
    botExternalId: "314", botUsername: "synthetic-review[bot]", publicationMode: "explicit", setup: { step: "complete" } }).returning();
  const policy = { ...defaultGitHubReviewPolicy(), publishInline: false };
  await db.insert(chatGitHubConfigurations).values({ companyId, endpointId: endpoint!.id, updatedByUserId: userId,
    configuration: { version: 1, toolsEnabled: true, responsibleUserId: userId, memberAccess: "all_linked",
      people: [], defaults: policy, repositories: {} } });
  await db.transaction(tx => syncGitHubBotTools(tx, endpoint!, userId, true));
  const [resource] = await db.insert(chatEndpointResources).values({ companyId, endpointId: endpoint!.id,
    type: "repository", providerResourceId: "acme/widget", label: "acme/widget", enabled: true,
    availability: "available", metadata: { providerRepositoryId: "97531" } }).returning();
  const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "github",
    providerAccountId: "synthetic-github", externalId: "1", kind: "user", handle: "contributor" }).returning();
  await db.insert(chatIdentityLinks).values({ companyId, endpointId: endpoint!.id, principalId: principal!.id,
    paperclipUserId: userId, status: "linked", confirmedAt: new Date() });
  const [conversation] = await db.insert(chatConversations).values({ companyId, endpointId: endpoint!.id, resourceId: resource!.id,
    issueId, externalConversationId: "acme/widget", externalThreadId: "github:acme/widget:42",
    externalLabel: "Synthetic pull request", state: "active" }).returning();
  const headSha = "b".repeat(40), prefix = "/repos/acme/widget";
  const checks: Check[] = [], checkWrites: Array<{ method: string; body: CheckBody }> = [];
  const comments: Array<{ id: number; body: string; html_url: string; user: { login: string } }> = [];
  const unexpectedRequests: string[] = [];
  let summaryStatus: number | null = null, receiptSequence = 0, runSequence = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    if (url.origin === "https://api.github.com") {
      if (method === "POST" && url.pathname === "/app/installations/2468/access_tokens") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ repository_ids: [97531] });
        return Response.json({ token: "synthetic-installation-token" });
      }
      if (method === "GET" && url.pathname === `${prefix}/pulls/42`) return Response.json({ number: 42,
        title: "Review", body: "", state: "open", draft: false, head: { sha: headSha },
        base: { sha: "a".repeat(40), ref: "main" }, user: { id: 1, login: "contributor", type: "User" }, labels: [] });
      if (method === "GET" && url.pathname === `${prefix}/pulls/42/files`) {
        return Response.json([{ filename: "src/example.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new",
          additions: 1, deletions: 1 }]);
      }
      if (method === "GET" && url.pathname === `${prefix}/commits/${headSha}/check-runs`) {
        return Response.json({ check_runs: checks });
      }
      if ((method === "POST" && url.pathname === `${prefix}/check-runs`)
        || (method === "PATCH" && url.pathname.startsWith(`${prefix}/check-runs/`))) {
        const body = JSON.parse(String(init?.body)) as CheckBody;
        const existing = method === "PATCH" ? checks.find(check => String(check.id) === url.pathname.split("/").at(-1)) : undefined;
        if (method === "PATCH" && !existing) throw new Error("Unknown synthetic check");
        const check = existing ?? { id: 100 + checks.length, html_url: `https://github.com/acme/widget/checks/${100 + checks.length}`,
          app: { id: 314 } };
        Object.assign(check, body);
        if (body.status !== "completed") delete check.conclusion;
        if (!existing) checks.push(check);
        checkWrites.push({ method, body });
        return Response.json(check);
      }
      const list = url.pathname === `${prefix}/issues/42/comments`;
      const item = url.pathname.startsWith(`${prefix}/issues/comments/`);
      if (list && method === "GET") return Response.json(comments);
      if (item && method === "GET") return Response.json(comments.find(comment => String(comment.id) === url.pathname.split("/").at(-1)));
      if ((list && method === "POST") || (item && method === "PATCH")) {
        if (summaryStatus !== null) return new Response("Synthetic summary rejection", {
          status: summaryStatus, headers: summaryStatus === 503 ? { "retry-after": "120" } : undefined,
        });
        const existing = item ? comments.find(comment => String(comment.id) === url.pathname.split("/").at(-1)) : undefined;
        const comment = existing ?? { id: 200 + comments.length, body: "", html_url: `https://github.com/acme/widget/pull/42#issuecomment-${200 + comments.length}`,
          user: { login: endpoint!.botUsername! } };
        comment.body = JSON.parse(String(init?.body)).body;
        if (!existing) comments.push(comment);
        return Response.json(comment);
      }
    }
    unexpectedRequests.push(`${method} ${url}`);
    throw new Error(`Unexpected synthetic GitHub request: ${method} ${url}`);
  };
  const worker = githubReviewCheckService(db, providerFetch), reviews = githubChatReviewService(db, providerFetch);
  async function automaticReceipt(state: "processed" | "filtered" = "processed") {
    const event: GitHubReviewEventContext = { event: "reopened", deliveryId: randomUUID(), repositoryId: "97531",
      repository: "acme/widget", pullNumber: 42, title: "Review", body: "", baseSha: "a".repeat(40), headSha,
      baseBranch: "main", author: { id: "1", login: "contributor", isBot: false },
      sender: { id: "1", login: "contributor" }, draft: false, labels: [] };
    const admission = await githubAutomaticAdmission(db, endpoint!, event);
    expect(admission).toMatchObject({ allowed: true });
    const [delivery] = await db.insert(chatDeliveries).values({ companyId, endpointId: endpoint!.id,
      conversationId: conversation!.id, principalId: principal!.id, providerEventId: event.deliveryId,
      deduplicationKey: randomUUID(), eventKind: "message", state,
      normalizedEvent: { githubAutomatic: { context: event, revision: 1, policy },
        githubAuthority: { guest: false, responsibleUserId: userId, botExternalId: endpoint!.botExternalId } } }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Review this pull request head" }).returning();
    await db.insert(chatMessageLinks).values({ companyId, endpointId: endpoint!.id, conversationId: conversation!.id,
      deliveryId: delivery!.id, commentId: comment!.id, providerMessageId: event.deliveryId, direction: "inbound" });
    await worker.enqueue(endpoint!, event, state === "processed", "synthetic verified automatic admission");
    await retainGitHubReviewReceipt(db, endpoint!, issueId, delivery!.id, { context: event, revision: 1, policy });
    await db.update(chatGitHubReviews).set({ createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++receiptSequence)) })
      .where(eq(chatGitHubReviews.deliveryId, delivery!.id));
    const [review] = await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.deliveryId, delivery!.id));
    return { event, delivery: delivery!, comment: comment!, review: review! };
  }
  async function run(status: string, receipt?: Awaited<ReturnType<typeof automaticReceipt>>) {
    const [saved] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId, status,
      runtimeMode: "native", responsibleUserId: userId, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++runSequence)),
      contextSnapshot: receipt ? { issueId, wakeCommentId: receipt.comment.id } : {} }).returning();
    return saved!;
  }
  const readReview = async (id: string) => (await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, id)))[0]!;
  const session = (runId: string) => ({ companyId, agentId, issueId, runId });
  const assessment: GitHubReviewAssessment = { reviewedCommit: headSha, score: 5, complete: true,
    summary: "Synthetic assessment", rationale: "The reviewed change is correct.",
    coverage: { reviewedPaths: ["src/example.ts"], omittedPaths: [], limitations: [] }, findings: [] };
  async function begin(receipt: Awaited<ReturnType<typeof automaticReceipt>>) {
    const execution = await run("running", receipt);
    await reviews.execute(session(execution.id), "begin_review", { reviewedCommit: headSha });
    expect(await readReview(receipt.review.id)).toMatchObject({ deliveryId: receipt.delivery.id, runId: execution.id,
      state: "running", assessment: null });
    return execution;
  }
  const enqueue = (receipt: Awaited<ReturnType<typeof automaticReceipt>>) =>
    worker.enqueue(endpoint!, receipt.event, true, "synthetic admitted automatic review");
  const checkAction = async (receipt: Awaited<ReturnType<typeof automaticReceipt>>) => (await db.select().from(chatActions)
    .where(and(eq(chatActions.endpointId, endpoint!.id), eq(chatActions.providerActionId, `github-check:${receipt.event.deliveryId}`))))[0]!;
  const publications = () => db.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint!.id),
    eq(chatActions.kind, "github_review_publication")));
  async function publishedAssessment() {
    const receipt = await automaticReceipt(), execution = await begin(receipt);
    await worker.processPending();
    const submitted = await reviews.execute(session(execution.id), "submit_review", assessment, randomUUID());
    expect(unexpectedRequests).toEqual([]);
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ status: "processed" });
    const review = await readReview(receipt.review.id);
    expect(review).toMatchObject({ state: "completed", conclusion: "success", assessment, checkId: expect.any(String) });
    expect(checks.at(-1)).toMatchObject({ status: "completed", conclusion: "success" });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, execution.id));
    return review;
  }
  return { db, endpoint: endpoint!, issueId, headSha, checks, checkWrites, unexpectedRequests, worker, reviews, providerFetch,
    automaticReceipt, run, readReview, session, assessment, begin, enqueue, checkAction, publications, publishedAssessment,
    rejectSummary: (status: number) => { summaryStatus = status; } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

describe.skipIf(!support.supported)("GitHub automatic check lifecycle PostgreSQL behavior", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("github-automatic-check-lifecycle-");
    db = createDb(temporary.connectionString, { maxConnections: 1 });
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function withFixture(test: (f: Fixture) => Promise<void>) {
    const rollback = Symbol("fixture rollback");
    try {
      await db.transaction(async tx => { await test(await fixture(tx as unknown as Db)); throw rollback; });
    } catch (error) { if (error !== rollback) throw error; }
  }
  async function expectRetained(f: Fixture, assessed: Review, remote: Check[], writeCount: number) {
    expect.soft(f.unexpectedRequests).toEqual([]);
    expect.soft(f.checkWrites.slice(writeCount), "obsolete work must not downgrade an assessment-owned provider check").toEqual([]);
    expect.soft(f.checks).toEqual(remote);
    expect.soft(await f.readReview(assessed.id)).toEqual(assessed);
  }

  it("publishes pending and terminal lifecycle for a claimed automatic same-head UUID receipt", async () => {
    await withFixture(async f => {
      const assessed = await f.publishedAssessment();
      const receipt = await f.automaticReceipt(), execution = await f.begin(receipt);
      expect(receipt.delivery.id).toMatch(/^[0-9a-f-]{36}$/);
      const before = f.checkWrites.length;
      await f.worker.processPending();
      expect.soft(f.checkWrites.slice(before).at(-1)?.body,
        "begin_review must make an admitted automatic attempt pending even though its delivery ID is a UUID")
        .toMatchObject({ head_sha: f.headSha, status: "in_progress" });
      expect.soft(f.checks.at(-1)).toMatchObject({ status: "in_progress" });
      expect.soft(await f.checkAction(receipt)).not.toMatchObject({ result: { code: "assessment_owns_check" } });
      await f.db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, execution.id));
      const action = await f.checkAction(receipt);
      await f.db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } })
        .where(eq(chatActions.id, action.id));
      await f.enqueue(receipt);
      await f.worker.processPending();
      expect.soft(f.checkWrites.slice(before).at(-1)?.body).toMatchObject({ status: "completed", conclusion: "action_required" });
      expect.soft(await f.readReview(receipt.review.id)).toMatchObject({ state: "error", conclusion: "action_required", assessment: null });
      expect.soft(await f.readReview(assessed.id)).toMatchObject({ assessment: assessed.assessment, state: "completed", conclusion: "success" });
      expect(f.unexpectedRequests).toEqual([]);
    });
  });

  it.each(["processed", "filtered"] as const)("preserves assessed ownership for a %s automatic receipt never claimed by begin_review", async state => {
    await withFixture(async f => {
      const assessed = await f.publishedAssessment(), remote = structuredClone(f.checks), before = f.checkWrites.length;
      const receipt = await f.automaticReceipt(state);
      await f.enqueue(receipt);
      await f.worker.processPending();
      await expectRetained(f, assessed, remote, before);
      expect(await f.readReview(receipt.review.id)).toMatchObject({ runId: null, assessment: null });
    });
  });

  it("reconciles a suppressed running duplicate after a later failed-run transition without replacing the assessment", async () => {
    await withFixture(async f => {
      const assessed = await f.publishedAssessment(), remote = structuredClone(f.checks), before = f.checkWrites.length;
      const receipt = await f.automaticReceipt(), execution = await f.run("running");
      await f.db.update(chatGitHubReviews).set({ runId: execution.id, state: "running" }).where(eq(chatGitHubReviews.id, receipt.review.id));
      await f.enqueue(receipt);
      await f.worker.processPending();
      expect(await f.readReview(receipt.review.id)).toMatchObject({ state: "running", assessment: null });
      await expectRetained(f, assessed, remote, before);
      await f.db.update(heartbeatRuns).set({ status: "failed", error: "Synthetic duplicate run failed later" })
        .where(eq(heartbeatRuns.id, execution.id));
      const action = await f.checkAction(receipt);
      await f.db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } })
        .where(eq(chatActions.id, action.id));
      await f.enqueue(receipt);
      await githubReviewCheckService(f.db, f.providerFetch).processPending();
      expect.soft(await f.readReview(receipt.review.id), "terminal execution must still settle a previously suppressed local row")
        .toMatchObject({ runId: execution.id, state: "error", conclusion: "action_required", assessment: null });
      await expectRetained(f, assessed, remote, before);
    });
  });

  it.each([403, 422, 503])("does not confuse a pending check receipt with a published assessment after summary HTTP %s", async status => {
    await withFixture(async f => {
      const receipt = await f.automaticReceipt(), execution = await f.begin(receipt);
      await f.worker.processPending();
      const pending = await f.readReview(receipt.review.id);
      expect(pending).toMatchObject({ state: "running", assessment: null, checkId: expect.any(String) });
      expect(f.checks.at(-1)).toMatchObject({ id: Number(pending.checkId), status: "in_progress" });
      const before = f.checkWrites.length;
      f.rejectSummary(status);
      const submitted = await f.reviews.execute(f.session(execution.id), "submit_review", f.assessment, randomUUID());
      expect(submitted, JSON.stringify(submitted)).toMatchObject({ status: "failed", receipt: { providerStatus: status, retryable: status === 503 } });
      const historical = await f.readReview(receipt.review.id), publication = await f.publications();
      expect(historical).toMatchObject({ assessment: f.assessment, checkId: pending.checkId });
      expect(publication).toEqual([expect.objectContaining({ status: "failed", result: expect.objectContaining({ retryable: status === 503 }) })]);
      expect(f.checkWrites).toHaveLength(before);
      expect(f.checks.at(-1)).toMatchObject({ status: "in_progress" });
      const replacement = await f.automaticReceipt(), failed = await f.run("failed");
      await f.db.update(chatGitHubReviews).set({ runId: failed.id, state: "running" })
        .where(eq(chatGitHubReviews.id, replacement.review.id));
      await f.enqueue(replacement);
      await f.worker.processPending();
      if (status === 503) {
        expect(f.checkWrites).toHaveLength(before);
        expect(f.checks.at(-1)).toMatchObject({ status: "in_progress" });
      } else {
        expect.soft(f.checkWrites.slice(before).at(-1)?.body,
          "a permanently unpublished assessment cannot own a check that still only reports pending")
          .toMatchObject({ status: "completed", conclusion: "action_required" });
        expect.soft(f.checks.at(-1)).toMatchObject({ status: "completed", conclusion: "action_required" });
        expect.soft(await f.readReview(replacement.review.id)).toMatchObject({ state: "error", conclusion: "action_required", assessment: null });
      }
      expect.soft(await f.readReview(historical.id)).toEqual(historical);
      expect.soft(await f.publications()).toEqual(publication);
      expect(f.unexpectedRequests).toEqual([]);
    });
  });
});
