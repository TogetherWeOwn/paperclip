import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, codeDeliveryAuthorities, codeDeliveryDecisions, codeDeliveryObligations,
  codeDeliveryOwnershipEvents, companies, companyMemberships, createDb, heartbeatRuns, issueCodeDeliveryIntents,
  issues, issueWorkProducts, projects, projectWorkspaces } from "@paperclipai/db";
import type { CodeDeliveryDecisionInput } from "@paperclipai/shared";
import { codeDeliveryDecisionService } from "../services/code-delivery-decisions.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../services/code-delivery-github.js", () => ({ createCodeDeliveryGitHubReader: () => provider.read }));
const support = await getEmbeddedPostgresTestSupport();
const head = "a".repeat(40);

(support.supported ? describe : describe.skip)("independent durable code-delivery decisions", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const reviewer = "delivery-reviewer", creator = "delivery-creator";
  const actor: AuthorizationActor = { type: "board", source: "local_implicit", userId: reviewer, isInstanceAdmin: true };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-delivery-decisions-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values([reviewer, creator].map(id => ({ id, name: id, email: `${id}@example.invalid`, createdAt: new Date(), updatedAt: new Date() })));
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);
  beforeEach(() => { provider.read.mockReset(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Delivery decisions", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [author, technical] = await db.insert(agents).values(["Author", "Technical"].map(name => ({ companyId: company.id,
      name, role: "engineer", adapterType: "process", status: "idle" }))).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: reviewer, membershipRole: "owner" });
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Source" }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId: company.id, projectId: project.id, name: "Source", repoUrl: "https://github.com/fixture/source" }).returning();
    const stages = [{ id: randomUUID(), type: "review" as const, approvalsNeeded: 1 as const,
      participants: [{ id: randomUUID(), type: "user" as const, userId: "security-reviewer" }] },
    { id: randomUUID(), type: "review" as const, approvalsNeeded: 1 as const,
      participants: [{ id: randomUUID(), type: "user" as const, userId: reviewer }] }];
    const policy = { mode: "normal", stages, commentRequired: true };
    const state = { status: "pending", currentStageId: stages[1].id, currentStageIndex: 1, currentStageType: "review",
      currentParticipant: { type: "user", userId: reviewer }, returnAssignee: { type: "agent", agentId: author.id },
      completedStageIds: [stages[0].id], lastDecisionId: null, lastDecisionOutcome: null, reviewRequest: null, changesRequestedCount: 1 };
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, projectWorkspaceId: workspace.id,
      title: "Delivery", status: "in_review", createdByAgentId: author.id, assigneeUserId: reviewer,
      executionPolicy: policy, executionState: state }).returning();
    return { company, issue, author, technical, project, workspace, policy, state };
  }
  async function current(f: Awaited<ReturnType<typeof fixture>>) {
    return (await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]!;
  }
  async function input(f: Awaited<ReturnType<typeof fixture>>, kind: "classify_code" | "classify_non_code" | "no_pr"): Promise<CodeDeliveryDecisionInput> {
    return { kind, expectedIssueRevision: (await current(f)).codeDeliveryRevision, reason: "Independently examined the delivery scope", idempotencyKey: randomUUID() };
  }
  async function register(f: Awaited<ReturnType<typeof fixture>>) {
    return (await db.insert(codeDeliveryObligations).values({ companyId: f.company.id, ownerIssueId: f.issue.id,
      sourceIssueId: f.issue.id, sourceProjectId: f.project.id, sourceWorkspaceId: f.workspace.id,
      repositoryId: "42", repository: "fixture/source", pullRequestNumber: 1, baseRef: "main", proposedHeadSha: head,
      provenance: { kind: "test_registration" } }).returning())[0]!;
  }
  function observe(state = "closed", observedHead = head) {
    provider.read.mockResolvedValue({ status: "observed", pullRequests: [{ repositoryId: "42", repository: "fixture/source", number: 1,
      baseRef: "main", headSha: observedHead, state, draft: state === "open", mergedAt: null, mergeCommitSha: null, observedAt: new Date().toISOString() }] });
  }
  async function obligationInput(f: Awaited<ReturnType<typeof fixture>>, o: typeof codeDeliveryObligations.$inferSelect,
    kind: "accept_head" | "closed_unmerged" | "withdrawn") {
    return { kind, obligationId: o.id, expectedObligationRevision: o.revision, expectedIssueRevision: (await current(f)).codeDeliveryRevision,
      reason: "Independent technical delivery decision", idempotencyKey: randomUUID(), ...(kind === "accept_head" ? { headSha: head } : {}) } as CodeDeliveryDecisionInput;
  }
  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    return { issue: await current(f), decisions: await db.select().from(codeDeliveryDecisions).where(eq(codeDeliveryDecisions.companyId, f.company.id)),
      obligations: await db.select().from(codeDeliveryObligations).where(eq(codeDeliveryObligations.companyId, f.company.id)),
      events: await db.select().from(codeDeliveryOwnershipEvents).where(eq(codeDeliveryOwnershipEvents.companyId, f.company.id)),
      activities: await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id)) };
  }
  async function destination(f: Awaited<ReturnType<typeof fixture>>) {
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Runnable owner", status: "in_progress", assigneeAgentId: f.author.id }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.author.id, issueId: issue.id, status: "running", invocationSource: "manual" });
    return issue;
  }

  it("classifies independently, retains immutable evidence and preserves native review state", async () => {
    const f = await fixture(), before = await current(f);
    const decision = await codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, await input(f, "classify_non_code"));
    expect(decision).toMatchObject({ actorType: "user", actorId: reviewer, authority: { kind: "final_stage", stageId: f.policy.stages[1].id } });
    const [intent] = await db.select().from(issueCodeDeliveryIntents).where(eq(issueCodeDeliveryIntents.issueId, f.issue.id));
    expect(intent).toMatchObject({ intent: "non_code", provenance: { decisionId: decision.id } });
    const after = await current(f);
    expect({ ...after, codeDeliveryRevision: before.codeDeliveryRevision }).toEqual(before);
    expect(provider.read).not.toHaveBeenCalled();
    await expect(db.update(codeDeliveryDecisions).set({ reason: "rewrite" }).where(eq(codeDeliveryDecisions.id, decision.id)))
      .rejects.toMatchObject({ cause: { message: "code_delivery_history_is_immutable" } });
    await expect(db.delete(codeDeliveryDecisions).where(eq(codeDeliveryDecisions.id, decision.id))).rejects.toBeDefined();
  });
  it.each(["creator", "executor", "requester", "work_product_author", "earlier_stage", "wrong_participant", "missing_completed_stage", "no_stage_board"])("denies %s without partial changes", async fault => {
    const f = await fixture();
    if (fault === "creator") await db.update(issues).set({ createdByUserId: reviewer }).where(eq(issues.id, f.issue.id));
    if (fault === "executor") await db.update(issues).set({ executionState: { ...f.state, returnAssignee: { type: "user", userId: reviewer } } }).where(eq(issues.id, f.issue.id));
    if (fault === "requester") await db.insert(activityLog).values({ companyId: f.company.id, entityType: "issue", entityId: f.issue.id,
      actorType: "user", actorId: reviewer, action: "issue.updated", details: { status: "in_review", _previous: { status: "in_progress" } } });
    if (fault === "work_product_author") {
      const [product] = await db.insert(issueWorkProducts).values({ companyId: f.company.id, issueId: f.issue.id,
        type: "branch", provider: "github", title: "Branch", status: "active" }).returning();
      await db.insert(activityLog).values({ companyId: f.company.id, actorType: "user", actorId: reviewer,
        action: "issue.work_product_created", entityType: "issue", entityId: f.issue.id, details: { workProductId: product.id } });
    }
    if (fault === "earlier_stage") await db.update(issues).set({ executionState: { ...f.state, currentStageId: f.policy.stages[0].id, currentStageIndex: 0 } }).where(eq(issues.id, f.issue.id));
    if (fault === "wrong_participant") await db.update(issues).set({ executionState: { ...f.state, currentParticipant: { type: "user", userId: creator } } }).where(eq(issues.id, f.issue.id));
    if (fault === "missing_completed_stage") await db.update(issues).set({ executionState: { ...f.state, completedStageIds: [] } }).where(eq(issues.id, f.issue.id));
    if (fault === "no_stage_board") await db.update(issues).set({ executionPolicy: null, executionState: null }).where(eq(issues.id, f.issue.id));
    const before = await snapshot(f);
    await expect(codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, await input(f, "classify_code")))
      .rejects.toMatchObject({ status: 403, details: { code: "code_delivery_authority_denied" } });
    expect(await snapshot(f)).toEqual(before);
  });
  it("rejects forged caller authority, receipt, provider observation, and cross-company requests", async () => {
    const f = await fixture(), other = await fixture();
    const decision = await input(f, "classify_code");
    for (const key of ["authority", "receipt", "observation", "actorId", "runId"]) {
      await expect(codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, { ...decision, [key]: {} } as CodeDeliveryDecisionInput)).rejects.toBeDefined();
    }
    await expect(codeDeliveryDecisionService(db).decide(other.company.id, f.issue.id, actor, decision)).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(codeDeliveryDecisions)).toBeDefined();
    expect((await snapshot(f)).decisions).toHaveLength(0);
  });
  it("replays exact decisions once and refuses a key reused for another decision", async () => {
    const f = await fixture(), request = await input(f, "classify_code"), service = codeDeliveryDecisionService(db);
    const first = await service.decide(f.company.id, f.issue.id, actor, request);
    expect(await service.decide(f.company.id, f.issue.id, actor, request)).toEqual(first);
    await expect(service.decide(f.company.id, f.issue.id, actor, { ...request, reason: "changed" })).rejects.toMatchObject({ status: 409 });
    expect((await snapshot(f)).decisions).toHaveLength(1);
  });
  it("serializes duplicate simultaneous decisions without duplicate audit or review decisions", async () => {
    const f = await fixture(), request = await input(f, "classify_code"), service = codeDeliveryDecisionService(db);
    const results = await Promise.all([service.decide(f.company.id, f.issue.id, actor, request), service.decide(f.company.id, f.issue.id, actor, request)]);
    expect(results[0]).toEqual(results[1]);
    expect((await snapshot(f)).activities).toHaveLength(1);
  });
  it("permits a typed no-PR decision only for explicit code without retained discoveries", async () => {
    const f = await fixture(), service = codeDeliveryDecisionService(db);
    await expect(service.decide(f.company.id, f.issue.id, actor, await input(f, "no_pr"))).rejects.toMatchObject({ details: { reason: "code_intent_required" } });
    await service.decide(f.company.id, f.issue.id, actor, await input(f, "classify_code"));
    expect(await service.decide(f.company.id, f.issue.id, actor, await input(f, "no_pr"))).toMatchObject({ kind: "no_pr" });
    await db.insert(issueWorkProducts).values({ companyId: f.company.id, issueId: f.issue.id, type: "branch", provider: "github", title: "Retained code", status: "active" });
    await expect(service.decide(f.company.id, f.issue.id, actor, await input(f, "no_pr"))).rejects.toMatchObject({ details: { reason: "unreconciled_associations" } });
  });
  it.each(["closed_unmerged", "withdrawn"] as const)("records %s only with fresh authenticated closed output", async kind => {
    const f = await fixture(), o = await register(f); observe();
    const decision = await codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, await obligationInput(f, o, kind));
    expect(decision.payload).toMatchObject({ observation: { state: "closed", mergedAt: null, mergeCommitSha: null } });
    expect((await current(f)).status).toBe("in_review");
  });
  it.each(["open", "merged", "wrong_head", "unavailable"])("denies closed disposition for %s with complete state preservation", async fault => {
    const f = await fixture(), o = await register(f);
    observe(fault === "wrong_head" ? "closed" : fault, fault === "wrong_head" ? "b".repeat(40) : head);
    if (fault === "unavailable") provider.read.mockResolvedValue({ status: "unavailable", reason: "authorization_unavailable" });
    const before = await snapshot(f);
    await expect(codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, await obligationInput(f, o, "closed_unmerged"))).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(f)).toEqual(before);
  });
  it("accepts the exact live head independently and cannot reuse acceptance after another revision", async () => {
    const f = await fixture(), o = await register(f); observe("open");
    const decision = await codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, await obligationInput(f, o, "accept_head"));
    const [saved] = await db.select().from(codeDeliveryObligations).where(eq(codeDeliveryObligations.id, o.id));
    expect(saved).toMatchObject({ proposedHeadSha: head, reviewedHeadSha: head, headDecisionId: decision.id, revision: 2 });
    await expect(db.update(codeDeliveryObligations).set({ proposedHeadSha: "b".repeat(40), revision: 3 }).where(eq(codeDeliveryObligations.id, o.id))).rejects.toBeDefined();
    await db.update(codeDeliveryObligations).set({ proposedHeadSha: "b".repeat(40), reviewedHeadSha: null, headDecisionId: null, revision: 3 }).where(eq(codeDeliveryObligations.id, o.id));
    await expect(db.update(codeDeliveryObligations).set({ reviewedHeadSha: head, headDecisionId: decision.id, revision: 4 }).where(eq(codeDeliveryObligations.id, o.id))).rejects.toBeDefined();
  });
  it("does remote work outside row locks, then rejects intervening policy A-to-B-to-A changes", async () => {
    const f = await fixture(), o = await register(f);
    provider.read.mockImplementation(async () => {
      await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.update(issues).set({ executionPolicy: null }).where(eq(issues.id, f.issue.id));
        await tx.update(issues).set({ executionPolicy: f.policy }).where(eq(issues.id, f.issue.id));
      });
      return { status: "observed", pullRequests: [{ state: "closed", headSha: head, observedAt: new Date().toISOString() }] };
    });
    const request = await obligationInput(f, o, "closed_unmerged");
    await expect(codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, request)).rejects.toMatchObject({ details: { code: "code_delivery_revision_conflict" } });
    expect((await snapshot(f)).decisions).toHaveLength(0);
    expect((await current(f)).executionState).toEqual(f.state);
  });
  it("transfers ownership atomically with provenance on both tasks and clears accepted-head authority", async () => {
    const f = await fixture(), o = await register(f), dest = await destination(f);
    const request: CodeDeliveryDecisionInput = { kind: "transfer", obligationId: o.id, expectedObligationRevision: 1,
      destinationIssueId: dest.id, expectedDestinationRevision: dest.codeDeliveryRevision,
      expectedIssueRevision: (await current(f)).codeDeliveryRevision, reason: "Research finished; delivery continues on its assigned runnable task", idempotencyKey: randomUUID() };
    const decision = await codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, request);
    expect((await db.select().from(codeDeliveryObligations).where(eq(codeDeliveryObligations.id, o.id)))[0])
      .toMatchObject({ ownerIssueId: dest.id, transferDecisionId: decision.id, reviewedHeadSha: null, headDecisionId: null, revision: 2 });
    expect(await db.select().from(codeDeliveryOwnershipEvents).where(eq(codeDeliveryOwnershipEvents.obligationId, o.id)))
      .toMatchObject([{ fromIssueId: null }, { fromIssueId: f.issue.id, toIssueId: dest.id, provenance: { decisionId: decision.id } }]);
    expect(new Set((await snapshot(f)).activities.map(a => a.entityId))).toEqual(new Set([f.issue.id, dest.id]));
    expect(provider.read).not.toHaveBeenCalled();
  });
  it.each(["self", "missing", "foreign", "terminal", "unassigned", "paused", "no_wake", "stale", "non_code"])("rejects %s transfer without partial decisions or events", async fault => {
    const f = await fixture(), o = await register(f), dest = await destination(f);
    let destinationId = dest.id;
    if (fault === "self") destinationId = f.issue.id;
    if (fault === "missing") destinationId = randomUUID();
    if (fault === "foreign") destinationId = (await fixture()).issue.id;
    if (fault === "terminal") await db.update(issues).set({ status: "done" }).where(eq(issues.id, dest.id));
    if (fault === "unassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, dest.id));
    if (fault === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.author.id));
    if (fault === "no_wake") await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.issueId, dest.id));
    if (fault === "non_code") await db.update(issueCodeDeliveryIntents).set({ intent: "non_code", revision: 2 }).where(eq(issueCodeDeliveryIntents.issueId, dest.id));
    const [target] = await db.select().from(issues).where(eq(issues.id, destinationId));
    const before = await snapshot(f);
    await expect(codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, { kind: "transfer", obligationId: o.id,
      expectedObligationRevision: 1, expectedIssueRevision: (await current(f)).codeDeliveryRevision, destinationIssueId: destinationId,
      expectedDestinationRevision: (target?.codeDeliveryRevision ?? 0) + (fault === "stale" ? 1 : 0), reason: "Transfer delivery", idempotencyKey: randomUUID() })).rejects.toBeDefined();
    expect(await snapshot(f)).toEqual(before);
  });
  it.each(["original_author", "cycle"])("retains %s protection after transfer", async fault => {
    const f = await fixture(), o = await register(f), dest = await destination(f), service = codeDeliveryDecisionService(db);
    await db.update(issues).set({ createdByUserId: creator }).where(eq(issues.id, f.issue.id));
    await service.decide(f.company.id, f.issue.id, actor, { kind: "transfer", obligationId: o.id, expectedObligationRevision: 1,
      expectedIssueRevision: (await current(f)).codeDeliveryRevision, destinationIssueId: dest.id,
      expectedDestinationRevision: dest.codeDeliveryRevision, reason: "Retain independent delivery ownership", idempotencyKey: randomUUID() });
    const nextReviewer = fault === "original_author" ? creator : reviewer;
    const policy = { ...f.policy, stages: [f.policy.stages[0], { ...f.policy.stages[1], participants: [{ id: randomUUID(), type: "user", userId: nextReviewer }] }] };
    await db.update(issues).set({ status: "in_review", assigneeAgentId: null, assigneeUserId: nextReviewer, executionPolicy: policy,
      executionState: { ...f.state, currentParticipant: { type: "user", userId: nextReviewer }, returnAssignee: { type: "agent", agentId: f.technical.id } } }).where(eq(issues.id, dest.id));
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: f.technical.id, assigneeUserId: null }).where(eq(issues.id, f.issue.id));
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.technical.id, issueId: f.issue.id, status: "running", invocationSource: "manual" });
    const [target] = await db.select().from(issues).where(eq(issues.id, dest.id));
    const before = await snapshot(f);
    const request: CodeDeliveryDecisionInput = fault === "original_author" ? { kind: "closed_unmerged", obligationId: o.id,
      expectedObligationRevision: 2, expectedIssueRevision: target.codeDeliveryRevision, reason: "Cannot self adjudicate after transfer", idempotencyKey: randomUUID() }
      : { kind: "transfer", obligationId: o.id, expectedObligationRevision: 2, expectedIssueRevision: target.codeDeliveryRevision,
        destinationIssueId: f.issue.id, expectedDestinationRevision: (await current(f)).codeDeliveryRevision,
        reason: "Cannot transfer back into ownership history", idempotencyKey: randomUUID() };
    await expect(service.decide(f.company.id, dest.id, { ...actor, userId: nextReviewer }, request)).rejects.toMatchObject(fault === "original_author"
      ? { status: 403, details: { code: "code_delivery_authority_denied" } } : { status: 409, details: { reason: "cyclic_transfer" } });
    expect(await snapshot(f)).toEqual(before);
    expect(provider.read).not.toHaveBeenCalled();
  });
  it.each(["expired", "future", "invalid_date", "obligation_changed"])("rejects %s prepared evidence", async fault => {
    const f = await fixture(), o = await register(f);
    provider.read.mockImplementation(async () => {
      if (fault === "obligation_changed") await db.update(codeDeliveryObligations).set({ proposedHeadSha: "b".repeat(40), revision: 2 }).where(eq(codeDeliveryObligations.id, o.id));
      return { status: "observed", pullRequests: [{ state: "closed", headSha: head,
        observedAt: fault === "invalid_date" ? "invalid" : new Date(Date.now() + (fault === "future" ? 60_000 : fault === "expired" ? -60_000 : 0)).toISOString() }] };
    });
    await expect(codeDeliveryDecisionService(db).decide(f.company.id, f.issue.id, actor, await obligationInput(f, o, "closed_unmerged")))
      .rejects.toMatchObject({ details: { code: "code_delivery_revision_conflict" } });
    expect((await snapshot(f)).decisions).toHaveLength(0);
    expect((await snapshot(f)).activities).toHaveLength(0);
  });
  it("does not accept a direct head certification or ownership move without a current decision", async () => {
    const f = await fixture(), o = await register(f), dest = await destination(f), before = await snapshot(f);
    await expect(db.update(codeDeliveryObligations).set({ reviewedHeadSha: head, revision: 2 }).where(eq(codeDeliveryObligations.id, o.id))).rejects.toBeDefined();
    await expect(db.update(codeDeliveryObligations).set({ ownerIssueId: dest.id, revision: 2 }).where(eq(codeDeliveryObligations.id, o.id))).rejects.toBeDefined();
    expect(await snapshot(f)).toEqual(before);
  });
  it("configures a company-bound explicit technical authority and denies agent configuration", async () => {
    const f = await fixture(), other = await fixture(), service = codeDeliveryDecisionService(db);
    expect(await service.configureAuthority(f.company.id, actor, { technicalAgentId: f.technical.id, expectedRevision: 0 }))
      .toMatchObject({ technicalAgentId: f.technical.id, revision: 1, configuredByUserId: reviewer });
    await expect(service.configureAuthority(f.company.id, actor, { technicalAgentId: other.technical.id, expectedRevision: 1 })).rejects.toBeDefined();
    await expect(service.configureAuthority(f.company.id, { type: "agent", companyId: f.company.id, agentId: f.author.id, runId: randomUUID() },
      { technicalAgentId: f.author.id, expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(codeDeliveryAuthorities).where(eq(codeDeliveryAuthorities.companyId, f.company.id))).toHaveLength(1);
  });
  it("uses the configured independent no-stage technical agent with a current run", async () => {
    const f = await fixture(), service = codeDeliveryDecisionService(db);
    await service.configureAuthority(f.company.id, actor, { technicalAgentId: f.technical.id, expectedRevision: 0 });
    await db.update(issues).set({ assigneeUserId: null, assigneeAgentId: f.author.id, status: "in_progress", executionPolicy: null, executionState: null }).where(eq(issues.id, f.issue.id));
    const [source] = await db.insert(issues).values({ companyId: f.company.id, title: "Technical adjudication", assigneeAgentId: f.technical.id, status: "in_progress", responsibleUserId: reviewer }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.technical.id, issueId: source.id,
      status: "running", invocationSource: "manual", contextSnapshot: { issueId: source.id } }).returning();
    const agentActor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId: f.company.id, agentId: f.technical.id,
      runId: run.id, onBehalfOfUserId: reviewer };
    const decision = await service.decide(f.company.id, f.issue.id, agentActor, await input(f, "classify_non_code"));
    expect(decision).toMatchObject({ actorId: f.technical.id, runId: run.id, authority: { kind: "technical_authority", authorityRevision: 1 } });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
    await expect(service.decide(f.company.id, f.issue.id, agentActor, await input(f, "classify_code"))).rejects.toBeDefined();
    expect((await snapshot(f)).decisions).toHaveLength(1);
  });
});
