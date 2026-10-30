import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agents, authUsers, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints,
  chatExternalPrincipals, chatGitHubConfigurations, chatGitHubReviews, chatIdentityLinks, chatMessageLinks,
  companies, companyMemberships, heartbeatRuns, issueComments, issues, toolApplications, toolConnections, type Db,
} from "@paperclipai/db";
import { defaultGitHubReviewPolicy, type GitHubReviewAssessment, type GitHubReviewEventContext } from "@paperclipai/shared";
import { expect } from "vitest";
import { retainGitHubReviewReceipt } from "./chat-channels/github/task-preparation.js";
import { githubAutomaticAdmission } from "./chat-github-events.js";
import { githubReviewCheckService } from "./chat-github-checks.js";
import { githubChatReviewService } from "./chat-github-reviews.js";
import { secretService } from "./secrets.js";
import { syncGitHubBotTools } from "./chat-github-tools.js";

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();
export type Review = typeof chatGitHubReviews.$inferSelect;
export type Check = {
  id: number; name: string; head_sha: string; external_id: string; status: string;
  conclusion: string | null; html_url: string; app: { id: number };
  output?: { title: string; summary: string }; [key: string]: unknown;
};
export type CheckWrite = { method: string; id: number; path: string; body: Record<string, unknown> };

export async function attemptFixture(db: Db, appId = 314) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), applicationId = randomUUID();
  const userId = `fixture-${randomUUID()}`, connectionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic attempt ownership",
    issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 7)}` });
  await db.insert(authUsers).values({ id: userId, name: "Synthetic user", email: `${userId}@example.test`,
    emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
    status: "active", membershipRole: "operator" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic reviewer", adapterType: "process",
    runtimeConfig: {}, permissions: {} });
  await db.insert(issues).values({ id: issueId, companyId, title: "Review current pull request",
    assigneeAgentId: agentId, status: "in_progress" });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Synthetic GitHub", type: "chat" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, uid: randomUUID(),
    name: "Synthetic GitHub", transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
  const vault = secretService(db), refs: NonNullable<typeof toolConnections.$inferInsert["credentialSecretRefs"]> = [];
  for (const [key, value] of Object.entries({ appId: String(appId), installationId: "2468", privateKey: signingKey })) {
    const secret = await vault.create(companyId, { name: `synthetic-${key}-${randomUUID()}`, provider: "local_encrypted", value });
    await vault.createBinding({ companyId, secretId: secret.id, targetType: "tool_connection", targetId: connectionId,
      configPath: `credentials.${key}` });
    refs.push({ configPath: `credentials.${key}`, secretId: secret.id, versionSelector: "latest" });
  }
  await db.update(toolConnections).set({ credentialSecretRefs: refs }).where(eq(toolConnections.id, connectionId));
  const [endpoint] = await db.insert(chatEndpoints).values({ companyId, connectionId, assignedAgentId: agentId,
    provider: "github", publicId: randomUUID(), status: "active", providerAccountId: `synthetic-github-${companyId}`,
    botExternalId: String(appId), botUsername: `synthetic-review-${appId}[bot]`, publicationMode: "explicit", setup: { step: "complete" } }).returning();
  const policy = { ...defaultGitHubReviewPolicy(), publishInline: false };
  await db.insert(chatGitHubConfigurations).values({ companyId, endpointId: endpoint!.id, updatedByUserId: userId,
    configuration: { version: 1, toolsEnabled: true, responsibleUserId: userId, memberAccess: "all_linked",
      people: [], defaults: policy, repositories: {} } });
  await db.transaction(tx => syncGitHubBotTools(tx, endpoint!, userId, true));
  const [resource] = await db.insert(chatEndpointResources).values({ companyId, endpointId: endpoint!.id,
    type: "repository", providerResourceId: "acme/widget", label: "acme/widget", enabled: true,
    availability: "available", metadata: { providerRepositoryId: "97531" } }).returning();
  const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "github",
    providerAccountId: `synthetic-github-${companyId}`, externalId: "1", kind: "user", handle: "contributor" }).returning();
  await db.insert(chatIdentityLinks).values({ companyId, endpointId: endpoint!.id, principalId: principal!.id,
    paperclipUserId: userId, status: "linked", confirmedAt: new Date() });
  const [conversation] = await db.insert(chatConversations).values({ companyId, endpointId: endpoint!.id, resourceId: resource!.id,
    issueId, externalConversationId: "acme/widget", externalThreadId: "github:acme/widget:42",
    externalLabel: "Synthetic pull request", state: "active" }).returning();
  const headSha = "b".repeat(40), prefix = "/repos/acme/widget";
  const checks: Check[] = [], checkWrites: CheckWrite[] = [], requests: string[] = [], unexpected: string[] = [];
  const comments: Array<{ id: number; body: string; html_url: string; user: { login: string } }> = [];
  let summaryStatus: number | null = null, reversed = false, sequence = 0, checkSequence = 100;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (url.origin === "https://api.github.com") {
      if (method === "POST" && url.pathname === "/app/installations/2468/access_tokens") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ repository_ids: [97531] });
        return Response.json({ token: "synthetic-installation-token" });
      }
      if (method === "GET" && url.pathname === `${prefix}/pulls/42`) return Response.json({ number: 42,
        title: "Review", body: "", state: "open", draft: false, head: { sha: headSha },
        base: { sha: "a".repeat(40), ref: "main" }, user: { id: 1, login: "contributor", type: "User" }, labels: [] });
      if (method === "GET" && url.pathname === `${prefix}/pulls/42/files`) return Response.json([
        { filename: "src/example.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 },
      ]);
      if (method === "GET" && url.pathname === `${prefix}/commits/${headSha}/check-runs`)
        return Response.json({ total_count: checks.length, check_runs: reversed ? [...checks].reverse() : checks });
      const checkItem = url.pathname.match(/^\/repos\/acme\/widget\/check-runs\/(\d+)$/);
      if (checkItem && method === "GET") {
        const item = checks.find(check => check.id === Number(checkItem[1]));
        return item ? Response.json(item) : Response.json({ message: "Not found" }, { status: 404 });
      }
      if ((method === "POST" && url.pathname === `${prefix}/check-runs`) || (checkItem && method === "PATCH")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const existing = checkItem ? checks.find(check => check.id === Number(checkItem[1])) : undefined;
        if (checkItem && !existing) throw new Error("Unknown synthetic check target");
        const id = existing?.id ?? checkSequence++;
        const check = existing ?? { id, name: "", head_sha: "", external_id: "", status: "queued", conclusion: null,
          html_url: `https://github.com/acme/widget/checks/${id}`, app: { id: appId } };
        Object.assign(check, body);
        if (body.status !== "completed") check.conclusion = null;
        if (!existing) checks.push(check);
        checkWrites.push({ method, id, path: url.pathname, body });
        return Response.json(check);
      }
      const list = url.pathname === `${prefix}/issues/42/comments`, item = url.pathname.startsWith(`${prefix}/issues/comments/`);
      if (method === "GET" && list) return Response.json(comments);
      if (method === "GET" && item) return Response.json(comments.find(comment => String(comment.id) === url.pathname.split("/").at(-1)));
      if ((list && method === "POST") || (item && method === "PATCH")) {
        if (summaryStatus !== null) return new Response("Synthetic summary rejection", {
          status: summaryStatus, headers: summaryStatus === 503 ? { "retry-after": "120" } : undefined,
        });
        const existing = item ? comments.find(comment => String(comment.id) === url.pathname.split("/").at(-1)) : undefined;
        const comment = existing ?? { id: 200 + comments.length, body: "",
          html_url: `https://github.com/acme/widget/pull/42#issuecomment-${200 + comments.length}`,
          user: { login: endpoint!.botUsername! } };
        comment.body = JSON.parse(String(init?.body)).body;
        if (!existing) comments.push(comment);
        return Response.json(comment);
      }
    }
    unexpected.push(`${method} ${url}`);
    throw new Error(`Unexpected synthetic GitHub request: ${method} ${url}`);
  };
  const worker = githubReviewCheckService(db, providerFetch), reviews = githubChatReviewService(db, providerFetch);
  const readReview = async (id: string) => (await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, id)))[0]!;
  const actions = () => db.select().from(chatActions).where(eq(chatActions.endpointId, endpoint!.id));
  const publications = async () => (await actions()).filter(action => action.kind === "github_review_publication");
  const session = (runId: string) => ({ companyId, agentId, issueId, runId });
  const assessment: GitHubReviewAssessment = { reviewedCommit: headSha, score: 5, complete: true,
    summary: "Synthetic assessment", rationale: "The reviewed change is correct.",
    coverage: { reviewedPaths: ["src/example.ts"], omittedPaths: [], limitations: [] }, findings: [] };
  async function receipt(options: { automatic?: boolean; enqueue?: boolean; state?: "processed" | "filtered" } = {}) {
    const automatic = options.automatic !== false;
    const event: GitHubReviewEventContext = { event: "reopened", deliveryId: randomUUID(), repositoryId: "97531",
      repository: "acme/widget", pullNumber: 42, title: "Review", body: "", baseSha: "a".repeat(40), headSha,
      baseBranch: "main", author: { id: "1", login: "contributor", isBot: false },
      sender: { id: "1", login: "contributor" }, draft: false, labels: [] };
    if (automatic) expect(await githubAutomaticAdmission(db, endpoint!, event)).toMatchObject({ allowed: true });
    const [delivery] = await db.insert(chatDeliveries).values({ companyId, endpointId: endpoint!.id,
      conversationId: conversation!.id, principalId: principal!.id, providerEventId: event.deliveryId,
      deduplicationKey: randomUUID(), eventKind: "message", state: options.state ?? "processed",
      normalizedEvent: { ...(automatic ? { githubAutomatic: { context: event, revision: 1, policy } } : {}),
        githubAuthority: { guest: false, responsibleUserId: userId, botExternalId: endpoint!.botExternalId } } }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Review this pull request head" }).returning();
    await db.insert(chatMessageLinks).values({ companyId, endpointId: endpoint!.id, conversationId: conversation!.id,
      deliveryId: delivery!.id, commentId: comment!.id, providerMessageId: event.deliveryId, direction: "inbound" });
    let review: Review | undefined;
    if (automatic) {
      if (options.enqueue !== false) await worker.enqueue(endpoint!, event, options.state !== "filtered", "synthetic admitted automatic receipt");
      await db.transaction(async tx => {
        await retainGitHubReviewReceipt(tx as unknown as Db, endpoint!, issueId, delivery!.id, { context: event, revision: 1, policy });
        await tx.update(chatGitHubReviews).set({ createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)) })
          .where(eq(chatGitHubReviews.deliveryId, delivery!.id));
      });
      [review] = await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.deliveryId, delivery!.id));
    }
    return { event, delivery: delivery!, comment: comment!, review };
  }
  async function run(status: string, source?: Awaited<ReturnType<typeof receipt>>) {
    const [saved] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId, status,
      runtimeMode: "native", responsibleUserId: userId, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)),
      contextSnapshot: source ? { issueId, wakeCommentId: source.comment.id } : {} }).returning();
    return saved!;
  }
  async function attempt(kind: "manual" | "automatic" = "automatic") {
    const source = await receipt({ automatic: kind === "automatic" }), execution = await run("running", source);
    await reviews.execute(session(execution.id), "begin_review", { reviewedCommit: headSha });
    const [review] = await db.select().from(chatGitHubReviews).where(and(eq(chatGitHubReviews.endpointId, endpoint!.id),
      eq(chatGitHubReviews.runId, execution.id)));
    expect(review).toMatchObject({ runId: execution.id, state: "running", assessment: null });
    await db.update(chatGitHubReviews).set({ createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sequence)) })
      .where(eq(chatGitHubReviews.id, review!.id));
    return { source, execution, review: await readReview(review!.id) };
  }
  const checkAction = async (event: GitHubReviewEventContext) => (await actions())
    .find(action => action.kind === "github_review_check" && action.providerActionId === `github-check:${event.deliveryId}`)!;
  async function published() {
    const active = await attempt();
    await worker.processPending();
    expect(await reviews.execute(session(active.execution.id), "submit_review", assessment, randomUUID()))
      .toMatchObject({ status: "processed" });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, active.execution.id));
    const review = await readReview(active.review.id);
    expect(checks.find(check => String(check.id) === review.checkId)).toMatchObject({ status: "completed", conclusion: "success" });
    return review;
  }
  async function duePublication() {
    for (const action of await publications()) {
      if (action.status === "failed" && action.result?.retryable === true)
        await db.update(chatActions).set({ result: { ...action.result, retryAt: new Date(0).toISOString() } })
          .where(eq(chatActions.id, action.id));
    }
  }
  return { db, companyId, userId, agentId, issueId, endpoint: endpoint!, conversation: conversation!, headSha,
    checks, checkWrites, requests, unexpected, providerFetch, worker, reviews, readReview, actions, publications,
    session, assessment, receipt, run, attempt, checkAction, published, duePublication,
    summaryStatus: (status: number | null) => { summaryStatus = status; }, reverseChecks: () => { reversed = true; } };
}

export type AttemptFixture = Awaited<ReturnType<typeof attemptFixture>>;
