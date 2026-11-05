import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, codeDeliveryAuthorities, codeDeliveryDecisions, codeDeliveryDiscoveries,
  codeDeliveryObligations, codeDeliveryOwnershipEvents, issueCodeDeliveryIntents, issues, type Db } from "@paperclipai/db";
import { codeDeliveryAuthoritySchema, codeDeliveryDecisionSchema, type CodeDeliveryAuthorityInput,
  type CodeDeliveryDecisionInput } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { assertDeliveryTransferDestination } from "./code-delivery-transfer.js";
import { assertDeliveryAdjudicator, deliveryActor, lockDeliveryIssues, readDeliveryIssue, type DeliveryIssue } from "./code-delivery-authority.js";
import { createCodeDeliveryGitHubReader, type CodeDeliveryPullRequestObservation } from "./code-delivery-github.js";
import { reconcileDeliveryDiscoveries } from "./code-delivery-discovery.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const open = (issue: DeliveryIssue) => !["done", "cancelled"].includes(issue.status);
function stale() { return conflict("Delivery state changed; read current state and retry", { code: "code_delivery_revision_conflict" }); }
function denied(reason: string) { return conflict("Delivery decision cannot be applied", { code: "code_delivery_decision_conflict", reason }); }
function checkRevision(issue: DeliveryIssue, expected: number) {
  if (issue.codeDeliveryRevision !== expected) throw stale();
  if (!open(issue)) throw denied("terminal_owner");
}

export function codeDeliveryDecisionService(db: Db) {
  const observe = createCodeDeliveryGitHubReader(db);

  async function existingDecision(tx: Db, companyId: string, issueId: string, actor: AuthorizationActor, input: CodeDeliveryDecisionInput) {
    const [existing] = await tx.select().from(codeDeliveryDecisions).where(and(eq(codeDeliveryDecisions.companyId, companyId),
      eq(codeDeliveryDecisions.issueId, issueId), eq(codeDeliveryDecisions.idempotencyKey, input.idempotencyKey)));
    if (!existing) return null;
    const principal = deliveryActor(actor);
    if (existing.requestHash !== digest(input) || existing.actorType !== principal.type || existing.actorId !== principal.id) throw denied("idempotency_key_reused");
    return existing;
  }

  return {
    configureAuthority: async (companyId: string, actor: AuthorizationActor, rawInput: CodeDeliveryAuthorityInput) => {
      const input = codeDeliveryAuthoritySchema.parse(rawInput);
      const principal = deliveryActor(actor);
      if (principal.type !== "user") throw forbidden("Only a company administrator can configure delivery authority");
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const access = await authorizationService(tx).decide({ actor, action: "users:manage_permissions", resource: { type: "company", companyId } });
        if (!access.allowed) throw forbidden(access.explanation);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`code-delivery-authority:${companyId}`}, 0))`);
        const [current] = await tx.select().from(codeDeliveryAuthorities).where(eq(codeDeliveryAuthorities.companyId, companyId)).for("update");
        if ((current?.revision ?? 0) !== input.expectedRevision) throw stale();
        await assertAssignableAgent(tx, companyId, input.technicalAgentId, { kind: "work" });
        const [updated] = await tx.insert(codeDeliveryAuthorities).values({ companyId, technicalAgentId: input.technicalAgentId,
          configuredByUserId: principal.id }).onConflictDoUpdate({ target: codeDeliveryAuthorities.companyId,
          set: { technicalAgentId: input.technicalAgentId, revision: sql`${codeDeliveryAuthorities.revision} + 1`,
            configuredByUserId: principal.id, updatedAt: new Date() } }).returning();
        await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: principal.id,
          action: "code_delivery.authority_configured", entityType: "company", entityId: companyId,
          details: { technicalAgentId: input.technicalAgentId, revision: updated!.revision } });
        return updated!;
      });
    },

    decide: async (companyId: string, issueId: string, actor: AuthorizationActor, rawInput: CodeDeliveryDecisionInput) => {
      const input = codeDeliveryDecisionSchema.parse(rawInput);
      const principal = deliveryActor(actor);
      const initial = await readDeliveryIssue(db, companyId, issueId, actor);
      const authority = await assertDeliveryAdjudicator(db, initial, actor);
      const replay = await existingDecision(db, companyId, issueId, actor, input);
      if (replay) return replay;
      checkRevision(initial, input.expectedIssueRevision);
      const [obligation] = "obligationId" in input ? await db.select().from(codeDeliveryObligations).where(and(
        eq(codeDeliveryObligations.companyId, companyId), eq(codeDeliveryObligations.id, input.obligationId),
        eq(codeDeliveryObligations.ownerIssueId, issueId))) : [];
      if ("obligationId" in input && (!obligation || obligation.revision !== input.expectedObligationRevision)) throw stale();
      let observation: CodeDeliveryPullRequestObservation | null = null;
      if (input.kind === "accept_head" || input.kind === "closed_unmerged" || input.kind === "withdrawn") {
        const result = await observe(companyId, [{ projectId: obligation!.sourceProjectId, workspaceId: obligation!.sourceWorkspaceId,
          repository: obligation!.repository, repositoryId: obligation!.repositoryId, number: obligation!.pullRequestNumber,
          baseRef: obligation!.baseRef, reviewedHeadSha: input.kind === "accept_head" ? input.headSha : obligation!.reviewedHeadSha ?? obligation!.proposedHeadSha }]);
        if (result.status !== "observed") throw conflict("Authenticated delivery observation unavailable", { code: "code_delivery_unavailable", reason: result.reason });
        observation = result.pullRequests[0] ?? null;
        if (!observation || observation.headSha !== (input.kind === "accept_head" ? input.headSha : obligation!.reviewedHeadSha ?? obligation!.proposedHeadSha)) throw denied("head_mismatch");
        if (input.kind !== "accept_head" && observation.state !== "closed") throw denied("not_closed_unmerged");
      }
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const ids = input.kind === "transfer" ? [issueId, input.destinationIssueId] : [issueId];
        const locked = await lockDeliveryIssues(tx, actor, companyId, ids);
        const current = locked.find(row => row.id === issueId)!;
        const currentAuthority = await assertDeliveryAdjudicator(tx, current, actor);
        const existing = await existingDecision(tx, companyId, issueId, actor, input);
        if (existing) return existing;
        checkRevision(current, input.expectedIssueRevision);
        if (digest(currentAuthority) !== digest(authority)) throw stale();
        const [currentObligation] = obligation ? await tx.select().from(codeDeliveryObligations).where(and(
          eq(codeDeliveryObligations.companyId, companyId), eq(codeDeliveryObligations.id, obligation.id))).for("update") : [];
        if (obligation && (!currentObligation || currentObligation.ownerIssueId !== issueId || currentObligation.revision !== obligation.revision)) throw stale();
        const observedAt = observation ? Date.parse(observation.observedAt) : null;
        if (observedAt !== null && (!Number.isFinite(observedAt) || Date.now() - observedAt > 30_000 || observedAt > Date.now())) throw stale();
        const [intent] = await tx.select().from(issueCodeDeliveryIntents).where(and(eq(issueCodeDeliveryIntents.companyId, companyId),
          eq(issueCodeDeliveryIntents.issueId, issueId))).for("update");
        if (!intent) throw denied("missing_intent");
        if (input.kind === "classify_code" || input.kind === "classify_non_code") {
          if (intent.intent !== "ambiguous") throw denied("immutable_intent");
        }
        if (input.kind === "no_pr" && intent.intent !== "code") throw denied("code_intent_required");
        if (input.kind === "classify_non_code" || input.kind === "no_pr") {
          const [owned] = await tx.select({ id: codeDeliveryObligations.id }).from(codeDeliveryObligations).where(and(
            eq(codeDeliveryObligations.companyId, companyId), eq(codeDeliveryObligations.ownerIssueId, issueId))).limit(1);
          const [discovered] = input.kind === "classify_non_code" ? await tx.select({ id: codeDeliveryDiscoveries.id }).from(codeDeliveryDiscoveries).where(and(
            eq(codeDeliveryDiscoveries.companyId, companyId), eq(codeDeliveryDiscoveries.issueId, issueId))).limit(1) : [];
          if (owned || discovered) throw denied("unreconciled_associations");
        }
        const reconciliations = input.kind === "no_pr" || input.kind === "accept_head"
          ? await reconcileDeliveryDiscoveries(tx, companyId, issueId, input.discoveryIds ?? [], input.kind === "accept_head" ? currentObligation : undefined)
          : null;
        if (input.kind === "transfer") {
          if (input.destinationIssueId === issueId) throw denied("self_transfer");
          const destination = locked.find(row => row.id === input.destinationIssueId)!;
          checkRevision(destination, input.expectedDestinationRevision);
          await assertDeliveryTransferDestination(tx, destination);
          const [visited] = await tx.select({ id: codeDeliveryOwnershipEvents.id }).from(codeDeliveryOwnershipEvents).where(and(
            eq(codeDeliveryOwnershipEvents.companyId, companyId), eq(codeDeliveryOwnershipEvents.obligationId, obligation!.id),
            eq(codeDeliveryOwnershipEvents.toIssueId, destination.id))).limit(1);
          if (visited) throw denied("cyclic_transfer");
        }
        const payload: Record<string, unknown> = { version: 1, ...(observation ? { observation } : {}),
          ...(reconciliations ? { reconciliations } : {}),
          ...(input.kind === "accept_head" ? { headSha: input.headSha } : {}),
          ...(input.kind === "transfer" ? { destinationIssueId: input.destinationIssueId, destinationRevision: input.expectedDestinationRevision } : {}) };
        const [decision] = await tx.insert(codeDeliveryDecisions).values({ companyId, issueId, obligationId: obligation?.id ?? null,
          kind: input.kind, issueRevision: current.codeDeliveryRevision, obligationRevision: obligation?.revision ?? null,
          actorType: principal.type, actorId: principal.id, runId: principal.runId, idempotencyKey: input.idempotencyKey,
          requestHash: digest(input), reason: input.reason, authority: currentAuthority, payload }).returning();
        if (input.kind === "classify_code" || input.kind === "classify_non_code") {
          await tx.update(issueCodeDeliveryIntents).set({ intent: input.kind === "classify_code" ? "code" : "non_code",
            revision: intent.revision + 1, provenance: { kind: "independent_decision", decisionId: decision!.id } })
            .where(eq(issueCodeDeliveryIntents.issueId, issueId));
        } else if (input.kind === "accept_head") {
          await tx.update(codeDeliveryObligations).set({ proposedHeadSha: input.headSha, reviewedHeadSha: input.headSha,
            headDecisionId: decision!.id, revision: obligation!.revision + 1 }).where(eq(codeDeliveryObligations.id, obligation!.id));
        } else if (input.kind === "transfer") {
          await tx.update(codeDeliveryObligations).set({ ownerIssueId: input.destinationIssueId, transferDecisionId: decision!.id,
            reviewedHeadSha: null, headDecisionId: null, revision: obligation!.revision + 1 }).where(eq(codeDeliveryObligations.id, obligation!.id));
        }
        await tx.insert(activityLog).values({ companyId, actorType: principal.type, actorId: principal.id, runId: principal.runId,
          action: "code_delivery.decision_recorded", entityType: "issue", entityId: issueId,
          details: { decisionId: decision!.id, kind: input.kind, obligationId: obligation?.id ?? null } });
        if (input.kind === "transfer") {
          await tx.insert(activityLog).values({ companyId, actorType: principal.type, actorId: principal.id, runId: principal.runId,
            action: "code_delivery.ownership_received", entityType: "issue", entityId: input.destinationIssueId,
            details: { decisionId: decision!.id, fromIssueId: issueId, obligationId: obligation!.id } });
        }
        return decision!;
      });
    },
  };
}
