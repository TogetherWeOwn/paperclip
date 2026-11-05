import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, codeDeliveryDiscoveries, codeDeliveryObligations, codeDeliveryOwnershipEvents,
  companies, companyMemberships, createDb, heartbeatRuns, issueCodeDeliveryIntents, issues, issueWorkProducts, projects, projectWorkspaces } from "@paperclipai/db";
import type { CodeDeliveryRegistrationInput } from "@paperclipai/shared";
import type { AuthorizationActor } from "../services/authorization.js";
import { codeDeliveryRegistrationService } from "../services/code-delivery-registration.js";
import { codeDeliveryDecisionService } from "../services/code-delivery-decisions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { insertTerminalDeliveryFixture } from "./helpers/code-delivery.js";

const provider = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../services/code-delivery-github.js", () => ({ createCodeDeliveryGitHubReader: () => provider.read }));
const support = await getEmbeddedPostgresTestSupport();
const head = "a".repeat(40);
const authorUser = "registration-author", reviewerUser = "registration-reviewer";
const author: AuthorizationActor = { type: "board", source: "local_implicit", userId: authorUser, isInstanceAdmin: true };
const reviewer: AuthorizationActor = { type: "board", source: "local_implicit", userId: reviewerUser, isInstanceAdmin: true };

(support.supported ? describe : describe.skip)("authenticated canonical delivery registration", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-delivery-registration-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values([authorUser, reviewerUser].map(id => ({ id, name: id, email: `${id}@example.invalid`, createdAt: new Date(), updatedAt: new Date() })));
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);
  beforeEach(() => { provider.read.mockReset(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Registration", issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values([authorUser, reviewerUser].map(principalId => ({ companyId: company.id,
      principalType: "user", principalId, membershipRole: "owner" })));
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Executor", role: "engineer", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Sources" }).returning();
    const [primary, workspace] = await db.insert(projectWorkspaces).values([
      { companyId: company.id, projectId: project.id, name: "Primary", repoUrl: "https://github.com/fixture/other", isPrimary: true },
      { companyId: company.id, projectId: project.id, name: "Explicit source", repoUrl: "https://github.com/fixture/source" },
    ]).returning();
    const stage = { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "user", userId: reviewerUser }], approvalsNeeded: 1 };
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, projectWorkspaceId: workspace.id,
      title: "Delivery", status: "in_review", createdByUserId: authorUser, assigneeUserId: reviewerUser,
      executionPolicy: { mode: "normal", stages: [stage] }, executionState: { status: "pending", currentStageId: stage.id,
        currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "user", userId: reviewerUser },
        returnAssignee: { type: "agent", agentId: agent.id }, completedStageIds: [], changesRequestedCount: 0,
        lastDecisionId: null, lastDecisionOutcome: null } }).returning();
    return { company, project, primary, workspace, issue, agent };
  }
  async function current(f: Awaited<ReturnType<typeof fixture>>) {
    return (await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]!;
  }
  async function input(f: Awaited<ReturnType<typeof fixture>>): Promise<CodeDeliveryRegistrationInput> {
    return { expectedIssueRevision: (await current(f)).codeDeliveryRevision, workspaceId: f.workspace.id,
      repository: "fixture/source", repositoryId: "42", pullRequestNumber: 1, baseRef: "main", proposedHeadSha: head };
  }
  function observation(overrides: Record<string, unknown> = {}) {
    return { repository: "fixture/source", repositoryId: "42", number: 1, baseRef: "main", headSha: head,
      draft: true, state: "open", mergedAt: null, mergeCommitSha: null, observedAt: new Date().toISOString(), ...overrides };
  }
  function observe(overrides: Record<string, unknown> = {}) {
    provider.read.mockResolvedValue({ status: "observed", pullRequests: [observation(overrides)] });
  }
  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    return { issue: await current(f), obligations: await db.select().from(codeDeliveryObligations).where(eq(codeDeliveryObligations.companyId, f.company.id)),
      events: await db.select().from(codeDeliveryOwnershipEvents).where(eq(codeDeliveryOwnershipEvents.companyId, f.company.id)),
      activities: await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id)) };
  }

  it("registers the explicit non-primary repository without certifying the head or changing review state", async () => {
    const f = await fixture(), before = await current(f); observe();
    const result = await codeDeliveryRegistrationService(db).register(f.company.id, f.issue.id, author, await input(f));
    expect(result).toMatchObject({ ownerIssueId: f.issue.id, sourceProjectId: f.project.id, sourceWorkspaceId: f.workspace.id,
      repositoryId: "42", reviewedHeadSha: null, headDecisionId: null, provenance: { actor: { type: "user", id: authorUser }, observation: { state: "open" } } });
    expect(provider.read).toHaveBeenCalledWith(f.company.id, [{ projectId: f.project.id, workspaceId: f.workspace.id,
      repository: "fixture/source", repositoryId: "42", number: 1, baseRef: "main", reviewedHeadSha: head }]);
    const saved = await snapshot(f);
    expect({ ...saved.issue, codeDeliveryRevision: before.codeDeliveryRevision }).toEqual(before);
    expect(saved.events).toMatchObject([{ toIssueId: f.issue.id, fromIssueId: null }]);
    expect(saved.activities).toMatchObject([{ action: "code_delivery.registered" }]);
  });
  it("replays identical registration and serializes simultaneous duplicates without duplicate audit", async () => {
    const f = await fixture(), service = codeDeliveryRegistrationService(db), request = await input(f); observe();
    const result = await Promise.all([service.register(f.company.id, f.issue.id, author, request), service.register(f.company.id, f.issue.id, author, request)]);
    expect(result[0]).toEqual(result[1]);
    provider.read.mockClear();
    expect(await service.register(f.company.id, f.issue.id, author, request)).toEqual(result[0]);
    expect(provider.read).not.toHaveBeenCalled();
    expect((await snapshot(f)).activities).toHaveLength(1);
  });
  it.each(["unavailable", "wrong_repo", "wrong_id", "wrong_number", "wrong_base", "wrong_head", "expired", "future", "invalid_date", "partial"])("denies %s with no partial state", async fault => {
    const f = await fixture();
    const overrides = fault === "wrong_repo" ? { repository: "fixture/other" } : fault === "wrong_id" ? { repositoryId: "9" }
      : fault === "wrong_number" ? { number: 2 } : fault === "wrong_base" ? { baseRef: "dev" } : fault === "wrong_head" ? { headSha: "b".repeat(40) }
      : fault === "expired" ? { observedAt: new Date(Date.now() - 60_000).toISOString() }
      : fault === "future" ? { observedAt: new Date(Date.now() + 60_000).toISOString() } : fault === "invalid_date" ? { observedAt: "not-a-date" } : {};
    observe(overrides);
    if (fault === "unavailable") provider.read.mockResolvedValue({ status: "unavailable", reason: "authorization_unavailable" });
    if (fault === "partial") provider.read.mockResolvedValue({ status: "observed", pullRequests: [] });
    const before = await snapshot(f);
    await expect(codeDeliveryRegistrationService(db).register(f.company.id, f.issue.id, author, await input(f))).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f)).toEqual(before);
  });
  it.each(["terminal", "non_code", "stale", "wrong_workspace", "foreign_workspace", "forged_receipt"])("refuses %s before provider access", async fault => {
    const f = await fixture();
    if (fault === "terminal") await insertTerminalDeliveryFixture(db, f.issue.id);
    if (fault === "non_code") await db.update(issueCodeDeliveryIntents).set({ intent: "non_code", revision: 2 }).where(eq(issueCodeDeliveryIntents.issueId, f.issue.id));
    const request = await input(f);
    if (fault === "stale") request.expectedIssueRevision++;
    if (fault === "wrong_workspace") request.workspaceId = f.primary.id;
    if (fault === "foreign_workspace") request.workspaceId = (await fixture()).workspace.id;
    if (fault === "forged_receipt") Object.assign(request, { receipt: { merged: true } });
    const before = await snapshot(f);
    await expect(codeDeliveryRegistrationService(db).register(f.company.id, f.issue.id, author, request)).rejects.toBeDefined();
    expect(await snapshot(f)).toEqual(before);
    expect(provider.read).not.toHaveBeenCalled();
  });
  it("refuses cross-tenant task reads and registration without provider access", async () => {
    const f = await fixture(), other = await fixture(), service = codeDeliveryRegistrationService(db);
    const scoped: AuthorizationActor = { type: "agent", companyId: other.company.id, agentId: other.agent.id, runId: randomUUID() };
    await expect(service.read(f.company.id, f.issue.id, scoped)).rejects.toMatchObject({ status: 404 });
    await expect(service.register(f.company.id, f.issue.id, scoped, await input(f))).rejects.toMatchObject({ status: 404 });
    expect(provider.read).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "missing", "stop_requested"])("refuses %s run before provider access", async fault => {
    const f = await fixture();
    const [source] = await db.insert(issues).values({ companyId: f.company.id, title: "Registration run", status: "in_progress",
      assigneeAgentId: f.agent.id, responsibleUserId: authorUser }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: source.id,
      status: fault === "cancelled" ? "cancelled" : "running", invocationSource: "manual",
      contextSnapshot: { issueId: source.id }, resultJson: fault === "stop_requested" ? { executionCancellation: { state: "requested" } } : null }).returning();
    const scoped: AuthorizationActor = { type: "agent", companyId: f.company.id, agentId: f.agent.id,
      runId: fault === "missing" ? randomUUID() : run.id, onBehalfOfUserId: authorUser };
    const before = await snapshot(f);
    await expect(codeDeliveryRegistrationService(db).register(f.company.id, f.issue.id, scoped, await input(f))).rejects.toMatchObject({ status: 403 });
    expect(provider.read).not.toHaveBeenCalled();
    expect(await snapshot(f)).toEqual(before);
  });
  it("refuses stealing canonical identity from another task", async () => {
    const f = await fixture(), service = codeDeliveryRegistrationService(db); observe();
    await service.register(f.company.id, f.issue.id, author, await input(f));
    const [other] = await db.insert(issues).values({ companyId: f.company.id, projectId: f.project.id, title: "Other owner" }).returning();
    provider.read.mockClear();
    await expect(service.register(f.company.id, other.id, author, { ...await input(f), expectedIssueRevision: other.codeDeliveryRevision }))
      .rejects.toMatchObject({ details: { reason: "identity_already_owned" } });
    expect(provider.read).not.toHaveBeenCalled();
    expect((await snapshot(f)).obligations).toHaveLength(1);
  });
  it.each(["issue", "project", "workspace"])("rechecks %s after remote work outside locks", async fault => {
    const f = await fixture();
    provider.read.mockImplementation(async () => {
      await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        if (fault === "issue") {
          await tx.update(issues).set({ executionPolicy: null }).where(eq(issues.id, f.issue.id));
          await tx.update(issues).set({ executionPolicy: f.issue.executionPolicy }).where(eq(issues.id, f.issue.id));
        }
        if (fault === "project") await tx.update(projects).set({ gitAuthorizedByUserId: authorUser }).where(eq(projects.id, f.project.id));
        if (fault === "workspace") await tx.update(projectWorkspaces).set({ repoUrl: "https://github.com/fixture/other" }).where(eq(projectWorkspaces.id, f.workspace.id));
      });
      return { status: "observed", pullRequests: [observation()] };
    });
    await expect(codeDeliveryRegistrationService(db).register(f.company.id, f.issue.id, author, await input(f))).rejects.toMatchObject({ status: 409 });
    expect((await snapshot(f)).obligations).toHaveLength(0);
    expect((await snapshot(f)).activities).toHaveLength(0);
    expect((await current(f)).executionState).toEqual(f.issue.executionState);
  });
  it("retains and matches deleted/reclassified discoveries, but not unrelated branch evidence", async () => {
    const f = await fixture(), service = codeDeliveryRegistrationService(db);
    const [product] = await db.insert(issueWorkProducts).values({ companyId: f.company.id, issueId: f.issue.id, provider: "github", type: "pull_request",
      title: "Display", status: "merged", url: "https://github.com/fixture/source/pull/1#issuecomment-12" }).returning();
    await db.update(issueWorkProducts).set({ type: "artifact", url: null }).where(eq(issueWorkProducts.id, product.id));
    await db.delete(issueWorkProducts).where(eq(issueWorkProducts.id, product.id));
    await db.insert(issueWorkProducts).values({ companyId: f.company.id, issueId: f.issue.id, provider: "github", type: "branch", title: "Branch", status: "active" });
    observe();
    const registered = await service.register(f.company.id, f.issue.id, author, await input(f));
    const read = await service.read(f.company.id, f.issue.id, reviewer);
    expect(read.discoveries.length).toBeGreaterThanOrEqual(2);
    expect(read.associations.filter(row => row.obligationId === registered.id)).toHaveLength(1);
    expect(read.associations.some(row => row.obligationId === null)).toBe(true);
    expect(registered.reviewedHeadSha).toBeNull();
  });
  it("binds branch discoveries to independently accepted delivery and retains exact source revisions", async () => {
    const f = await fixture(), service = codeDeliveryRegistrationService(db);
    await db.insert(issueWorkProducts).values({ companyId: f.company.id, issueId: f.issue.id, provider: "github", type: "branch", title: "Local branch", status: "active" });
    observe();
    const registered = await service.register(f.company.id, f.issue.id, author, await input(f));
    const read = await service.read(f.company.id, f.issue.id, reviewer);
    await codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, reviewer, { kind: "accept_head", obligationId: registered.id,
      expectedObligationRevision: registered.revision, expectedIssueRevision: read.issueRevision, headSha: head,
      discoveryIds: read.discoveries.map(row => row.id), reason: "This retained branch is delivered by the validated PR", idempotencyKey: randomUUID() });
    const after = await service.read(f.company.id, f.issue.id, reviewer);
    expect(after.associations).toMatchObject([{ obligationId: registered.id, decisionId: expect.any(String) }]);
    expect(after.decisions[0].payload).toMatchObject({ reconciliations: [{ discoveryId: read.discoveries[0].id,
      sourceRevision: read.discoveries[0].sourceRevision, obligationId: registered.id }] });
  });
  it("does not let the registrant independently adjudicate after a reviewer swap", async () => {
    const f = await fixture(), service = codeDeliveryRegistrationService(db); observe();
    await service.register(f.company.id, f.issue.id, author, await input(f));
    await db.update(issues).set({ createdByUserId: null, assigneeUserId: authorUser,
      executionPolicy: { mode: "normal", stages: [{ id: "review", type: "review", participants: [{ id: "participant", type: "user", userId: authorUser }], approvalsNeeded: 1 }] },
      executionState: { ...f.issue.executionState, currentStageId: "review", currentParticipant: { type: "user", userId: authorUser } } }).where(eq(issues.id, f.issue.id));
    await expect(codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, author, { kind: "classify_code",
      expectedIssueRevision: (await current(f)).codeDeliveryRevision, reason: "Cannot accept own registration", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ details: { code: "code_delivery_authority_denied" } });
  });
  it.each(["https://github.com/fixture/source/pull/1", "https://github.com/fixture/other/pull/2", "https://github.com/fixture/source/pull/%31"])("does not waive PR discovery with no-PR disposition: %s", async url => {
    const f = await fixture(), service = codeDeliveryRegistrationService(db);
    await db.insert(issueWorkProducts).values({ companyId: f.company.id, issueId: f.issue.id, provider: "github", type: "branch", title: "Retained PR", status: "closed", url });
    await codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, reviewer, { kind: "classify_code",
      expectedIssueRevision: (await current(f)).codeDeliveryRevision, reason: "Code association exists", idempotencyKey: randomUUID() });
    const read = await service.read(f.company.id, f.issue.id, reviewer);
    await expect(codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, reviewer, { kind: "no_pr", expectedIssueRevision: read.issueRevision,
      discoveryIds: read.discoveries.map(row => row.id), reason: "Cannot waive a discovered PR", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ details: { reason: "discovery_identity_mismatch" } });
    expect(provider.read).not.toHaveBeenCalled();
  });
  it("keeps late discoveries unresolved after an earlier independent reconciliation", async () => {
    const f = await fixture(), service = codeDeliveryRegistrationService(db);
    const [product] = await db.insert(issueWorkProducts).values({ companyId: f.company.id, issueId: f.issue.id, provider: "github", type: "branch", title: "No PR", status: "active" }).returning();
    await codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, reviewer, { kind: "classify_code",
      expectedIssueRevision: (await current(f)).codeDeliveryRevision, reason: "Local-only implementation", idempotencyKey: randomUUID() });
    const read = await service.read(f.company.id, f.issue.id, reviewer);
    await codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, reviewer, { kind: "no_pr", expectedIssueRevision: read.issueRevision,
      discoveryIds: read.discoveries.map(row => row.id), reason: "Retained branch requires no PR", idempotencyKey: randomUUID() });
    await db.update(issueWorkProducts).set({ status: "merged" }).where(eq(issueWorkProducts.id, product.id));
    const after = await service.read(f.company.id, f.issue.id, reviewer);
    expect(after.associations.filter(row => row.decisionId)).toHaveLength(1);
    expect(after.associations.filter(row => !row.decisionId)).toHaveLength(1);
    expect(await db.select().from(codeDeliveryDiscoveries).where(eq(codeDeliveryDiscoveries.issueId, f.issue.id))).toHaveLength(2);
  });
});
