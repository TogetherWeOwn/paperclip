import { and, eq, or, sql } from "drizzle-orm";
import { activityLog, codeDeliveryDecisions, codeDeliveryDiscoveries, codeDeliveryObligations, issueCodeDeliveryIntents,
  projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { codeDeliveryRegistrationSchema, type CodeDeliveryRegistrationInput } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { deliveryActor, lockDeliveryIssues, readDeliveryIssue, type DeliveryIssue } from "./code-delivery-authority.js";
import { createCodeDeliveryGitHubReader } from "./code-delivery-github.js";
import { matchDeliveryDiscovery } from "./code-delivery-discovery.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";

type Obligation = typeof codeDeliveryObligations.$inferSelect;
function denied(reason: string) {
  return conflict("Delivery registration cannot be applied", { code: "code_delivery_registration_conflict", reason });
}
function stale() {
  return conflict("Delivery state changed; read current state and retry", { code: "code_delivery_revision_conflict" });
}
function checkIssue(issue: DeliveryIssue, expected: number) {
  if (["done", "cancelled"].includes(issue.status)) throw denied("terminal_owner");
  if (issue.codeDeliveryRevision !== expected) throw stale();
}

export function codeDeliveryRegistrationService(db: Db) {
  const observe = createCodeDeliveryGitHubReader(db);

  async function binding(connection: Db, issue: DeliveryIssue, input: CodeDeliveryRegistrationInput, lock = false) {
    if (!issue.projectId) throw denied("project_required");
    const projectQuery = connection.select().from(projects).where(and(eq(projects.companyId, issue.companyId), eq(projects.id, issue.projectId)));
    const [project] = await (lock ? projectQuery.for("share") : projectQuery);
    const workspaceQuery = connection.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, issue.companyId),
      eq(projectWorkspaces.projectId, issue.projectId), eq(projectWorkspaces.id, input.workspaceId)));
    const [workspace] = await (lock ? workspaceQuery.for("share") : workspaceQuery);
    if (!project || project.archivedAt || !workspace?.repoUrl) throw denied("source_unavailable");
    let repository: string;
    try { repository = normalizeProjectRepositoryUrl(workspace.repoUrl).fullName.toLowerCase(); }
    catch { throw denied("invalid_repository"); }
    if (repository !== input.repository) throw denied("repository_mismatch");
    return { projectId: project.id, workspaceId: workspace.id, repository, projectUpdatedAt: project.updatedAt.toISOString(),
      workspaceUpdatedAt: workspace.updatedAt.toISOString(), repoUrl: workspace.repoUrl, repoRef: workspace.repoRef,
      defaultRef: workspace.defaultRef, metadata: workspace.metadata, grantId: project.gitAuthorizationGrantId,
      authorizedByUserId: project.gitAuthorizedByUserId };
  }

  async function existing(connection: Db, companyId: string, input: CodeDeliveryRegistrationInput) {
    const [row] = await connection.select().from(codeDeliveryObligations).where(and(eq(codeDeliveryObligations.companyId, companyId),
      eq(codeDeliveryObligations.provider, "github"), eq(codeDeliveryObligations.repositoryId, input.repositoryId),
      eq(codeDeliveryObligations.pullRequestNumber, input.pullRequestNumber)));
    return row ?? null;
  }

  function sameRegistration(row: Obligation, issueId: string, input: CodeDeliveryRegistrationInput) {
    if (row.ownerIssueId !== issueId || row.sourceIssueId !== issueId) throw denied("identity_already_owned");
    if (row.sourceWorkspaceId !== input.workspaceId || row.repository !== input.repository || row.baseRef !== input.baseRef
      || row.proposedHeadSha !== input.proposedHeadSha) throw denied("identity_already_registered");
    return row;
  }

  return {
    read: async (companyId: string, issueId: string, actor: AuthorizationActor) => {
      await readDeliveryIssue(db, companyId, issueId, actor, false);
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const issue = await readDeliveryIssue(tx, companyId, issueId, actor, false);
        const [intent] = await tx.select().from(issueCodeDeliveryIntents).where(and(eq(issueCodeDeliveryIntents.companyId, companyId),
          eq(issueCodeDeliveryIntents.issueId, issueId)));
        const obligations = await tx.select().from(codeDeliveryObligations).where(and(eq(codeDeliveryObligations.companyId, companyId),
          or(eq(codeDeliveryObligations.ownerIssueId, issueId), eq(codeDeliveryObligations.sourceIssueId, issueId))));
        const discoveries = await tx.select().from(codeDeliveryDiscoveries).where(and(eq(codeDeliveryDiscoveries.companyId, companyId),
          eq(codeDeliveryDiscoveries.issueId, issueId)));
        const decisions = await tx.select().from(codeDeliveryDecisions).where(and(eq(codeDeliveryDecisions.companyId, companyId),
          eq(codeDeliveryDecisions.issueId, issueId)));
        return { issueRevision: issue.codeDeliveryRevision, intent: intent ?? null, obligations, discoveries, decisions,
          associations: discoveries.map(discovery => matchDeliveryDiscovery(discovery, obligations, decisions)) };
      }, { isolationLevel: "repeatable read" });
    },

    register: async (companyId: string, issueId: string, actor: AuthorizationActor, rawInput: CodeDeliveryRegistrationInput) => {
      const input = codeDeliveryRegistrationSchema.parse(rawInput);
      const principal = deliveryActor(actor);
      const initial = await readDeliveryIssue(db, companyId, issueId, actor);
      if (["done", "cancelled"].includes(initial.status)) throw denied("terminal_owner");
      const source = await binding(db, initial, input);
      const prior = await existing(db, companyId, input);
      if (prior) sameRegistration(prior, issueId, input);
      if (!prior) {
        checkIssue(initial, input.expectedIssueRevision);
        const [intent] = await db.select().from(issueCodeDeliveryIntents).where(and(eq(issueCodeDeliveryIntents.companyId, companyId),
          eq(issueCodeDeliveryIntents.issueId, issueId)));
        if (!intent || intent.intent === "non_code") throw denied("code_intent_required");
      }
      const result = prior ? null : await observe(companyId, [{ projectId: source.projectId, workspaceId: source.workspaceId,
        repository: input.repository, repositoryId: input.repositoryId, number: input.pullRequestNumber,
        baseRef: input.baseRef, reviewedHeadSha: input.proposedHeadSha }]);
      if (result && result.status !== "observed") throw conflict("Authenticated delivery observation unavailable", {
        code: "code_delivery_unavailable", reason: result.reason });
      const observation = result?.status === "observed" ? result.pullRequests[0] : null;
      if (!prior && (!observation || observation.repository !== input.repository || observation.repositoryId !== input.repositoryId
        || observation.number !== input.pullRequestNumber || observation.baseRef !== input.baseRef
        || observation.headSha !== input.proposedHeadSha)) throw denied("observation_mismatch");
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const locked = await lockDeliveryIssues(tx, actor, companyId, [issueId]);
        const current = locked.find(row => row.id === issueId)!;
        if (["done", "cancelled"].includes(current.status)) throw denied("terminal_owner");
        const currentSource = await binding(tx, current, input, true);
        if (JSON.stringify(source) !== JSON.stringify(currentSource)) throw stale();
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`code-delivery:${companyId}:${input.repositoryId}:${input.pullRequestNumber}`}, 0))`);
        const registered = await existing(tx, companyId, input);
        if (registered) return sameRegistration(registered, issueId, input);
        checkIssue(current, input.expectedIssueRevision);
        const observedAt = observation ? Date.parse(observation.observedAt) : NaN;
        if (!Number.isFinite(observedAt) || observedAt > Date.now() || Date.now() - observedAt > 30_000) throw stale();
        const [intent] = await tx.select().from(issueCodeDeliveryIntents).where(and(eq(issueCodeDeliveryIntents.companyId, companyId),
          eq(issueCodeDeliveryIntents.issueId, issueId)));
        if (!intent || intent.intent === "non_code") throw denied("code_intent_required");
        const [obligation] = await tx.insert(codeDeliveryObligations).values({ companyId, ownerIssueId: issueId, sourceIssueId: issueId,
          sourceProjectId: source.projectId, sourceWorkspaceId: source.workspaceId, repository: input.repository,
          repositoryId: input.repositoryId, pullRequestNumber: input.pullRequestNumber, baseRef: input.baseRef,
          proposedHeadSha: input.proposedHeadSha, provenance: { kind: "authenticated_registration", version: 1,
            actor: principal, observation, issueRevision: current.codeDeliveryRevision } }).onConflictDoNothing().returning();
        if (!obligation) throw stale();
        await tx.insert(activityLog).values({ companyId, actorType: principal.type, actorId: principal.id, runId: principal.runId,
          action: "code_delivery.registered", entityType: "issue", entityId: issueId,
          details: { obligationId: obligation.id, repositoryId: input.repositoryId, pullRequestNumber: input.pullRequestNumber } });
        return obligation;
      });
    },
  };
}
