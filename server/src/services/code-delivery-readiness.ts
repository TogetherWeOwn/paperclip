import { and, eq, inArray, or } from "drizzle-orm";
import { activityLog, codeDeliveryDecisions, codeDeliveryDiscoveries, codeDeliveryObligations, codeDeliveryOwnershipEvents,
  codeDeliveryReadinessReceipts, codeDeliveryReceiptConsumptions, issueCodeDeliveryIntents, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { conflict, HttpError } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { assertDeliveryAdjudicator, deliveryActor, lockDeliveryIssues, readDeliveryIssue } from "./code-delivery-authority.js";
import { createCodeDeliveryGitHubReader } from "./code-delivery-github.js";
import { assertDeliveryTransferDestination } from "./code-delivery-transfer.js";
import { DELIVERY_OBSERVATION_MAX_AGE_MS, deliveryFingerprint, deliveryReadinessConflict, evaluateDeliveryReadiness,
  planDeliveryReadiness, type DeliveryDecision, type DeliverySnapshot } from "./code-delivery-readiness-policy.js";

export type DeliveryTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
declare const preparedReadiness: unique symbol;
export type PreparedCodeDeliveryReadiness = { readonly [preparedReadiness]: true };
type Prepared = {
  companyId: string;
  issueId: string;
  status: "done" | "cancelled";
  snapshotHash: string;
  actorHash: string;
  lockIds: string[];
  preparedAt: Date;
  expiresAt: Date;
  evidence: ReturnType<typeof evaluateDeliveryReadiness>;
};
const prepared = new WeakMap<PreparedCodeDeliveryReadiness, Prepared>();
const MAX_HISTORY = 512;
const terminal = (status: string): status is "done" | "cancelled" => status === "done" || status === "cancelled";
const stale = () => conflict("Delivery state changed; prepare completion again", { code: "code_delivery_revision_conflict" });

async function snapshot(db: Db, companyId: string, issueId: string, actor: AuthorizationActor): Promise<DeliverySnapshot> {
  const issue = await readDeliveryIssue(db, companyId, issueId, actor);
  const [intent] = await db.select().from(issueCodeDeliveryIntents).where(and(eq(issueCodeDeliveryIntents.companyId, companyId),
    eq(issueCodeDeliveryIntents.issueId, issueId)));
  const ownership = await db.select().from(codeDeliveryOwnershipEvents).where(and(eq(codeDeliveryOwnershipEvents.companyId, companyId),
    eq(codeDeliveryOwnershipEvents.fromIssueId, issueId))).orderBy(codeDeliveryOwnershipEvents.id).limit(MAX_HISTORY + 1);
  const ids = ownership.map(row => row.obligationId);
  const obligations = await db.select().from(codeDeliveryObligations).where(and(eq(codeDeliveryObligations.companyId, companyId),
    or(eq(codeDeliveryObligations.ownerIssueId, issueId), eq(codeDeliveryObligations.sourceIssueId, issueId),
      ...(ids.length ? [inArray(codeDeliveryObligations.id, ids)] : []))))
    .orderBy(codeDeliveryObligations.id).limit(MAX_HISTORY + 1);
  const discoveries = await db.select().from(codeDeliveryDiscoveries).where(and(eq(codeDeliveryDiscoveries.companyId, companyId),
    eq(codeDeliveryDiscoveries.issueId, issueId))).orderBy(codeDeliveryDiscoveries.id).limit(MAX_HISTORY + 1);
  const obligationIds = obligations.map(row => row.id);
  const decisions = await db.select().from(codeDeliveryDecisions).where(and(eq(codeDeliveryDecisions.companyId, companyId),
    or(eq(codeDeliveryDecisions.issueId, issueId), ...(obligationIds.length ? [inArray(codeDeliveryDecisions.obligationId, obligationIds)] : []))))
    .orderBy(codeDeliveryDecisions.id).limit(MAX_HISTORY + 1);
  if ([ownership, obligations, discoveries, decisions].some(rows => rows.length > MAX_HISTORY)) throw deliveryReadinessConflict("history_budget_exceeded");
  const [current] = await db.select({ revision: issues.codeDeliveryRevision }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (!current || current.revision !== issue.codeDeliveryRevision) throw stale();
  return { issue, intent: intent ?? null, ownership, obligations, discoveries, decisions };
}

async function sourceBindings(db: Db, value: DeliverySnapshot, lock = false) {
  const owned = value.obligations.filter(row => row.ownerIssueId === value.issue.id);
  const projectIds = [...new Set(owned.map(row => row.sourceProjectId))].sort();
  const workspaceIds = [...new Set(owned.map(row => row.sourceWorkspaceId))].sort();
  if (!owned.length) return { projects: [], workspaces: [] };
  const projectQuery = db.select().from(projects).where(and(eq(projects.companyId, value.issue.companyId), inArray(projects.id, projectIds))).orderBy(projects.id);
  const workspaceQuery = db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, value.issue.companyId), inArray(projectWorkspaces.id, workspaceIds))).orderBy(projectWorkspaces.id);
  const sources = { projects: await (lock ? projectQuery.for("share") : projectQuery),
    workspaces: await (lock ? workspaceQuery.for("share") : workspaceQuery) };
  if (sources.projects.length !== projectIds.length || sources.workspaces.length !== workspaceIds.length) throw deliveryReadinessConflict("missing_source_binding");
  return sources;
}

function usedDecisions(plan: ReturnType<typeof planDeliveryReadiness>, evidence: ReturnType<typeof evaluateDeliveryReadiness>) {
  const ids = new Set([evidence.noPrDecisionId, ...evidence.discoveries.map(row => row.decisionId),
    ...evidence.pullRequests.map(row => row.decisionId)]);
  return plan.decisions.filter(row => ids.has(row.id));
}

async function adjudication(db: Db, value: DeliverySnapshot, decisions: DeliveryDecision[]) {
  const authorities = new Map<string, Awaited<ReturnType<typeof assertDeliveryAdjudicator>>>();
  for (const decision of decisions) {
    const key = `${decision.actorType}:${decision.actorId}`;
    let authority = authorities.get(key);
    if (!authority) {
      const actor: AuthorizationActor = decision.actorType === "agent"
        ? { type: "agent", agentId: decision.actorId, companyId: value.issue.companyId, runId: decision.runId }
        : { type: "board", userId: decision.actorId };
      try {
        authority = await assertDeliveryAdjudicator(db, value.issue, actor);
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) throw deliveryReadinessConflict("stale_adjudication");
        throw error;
      }
      authorities.set(key, authority);
    }
    if (deliveryFingerprint(authority) !== deliveryFingerprint(decision.authority)) throw deliveryReadinessConflict("stale_adjudication");
  }
}

export function codeDeliveryReadinessService(db: Db) {
  const observe = createCodeDeliveryGitHubReader(db);
  return {
    prepare: async (companyId: string, issueId: string, effectiveStatus: string, actor: AuthorizationActor,
      expectedIssueRevision?: number): Promise<PreparedCodeDeliveryReadiness | null> => {
      if (!terminal(effectiveStatus)) return null;
      deliveryActor(actor);
      const preparedAt = new Date();
      const initial = await snapshot(db, companyId, issueId, actor);
      if (expectedIssueRevision !== undefined && initial.issue.codeDeliveryRevision !== expectedIssueRevision) throw stale();
      const plan = planDeliveryReadiness(initial);
      const sources = await sourceBindings(db, initial);
      const result = plan.identities.length ? await observe(companyId, plan.identities) : { status: "observed" as const, pullRequests: [] };
      if (result.status !== "observed") throw conflict("Authenticated delivery observation unavailable", { code: "code_delivery_unavailable", reason: result.reason });
      const evidence = evaluateDeliveryReadiness(initial, plan, result.pullRequests);
      await adjudication(db, initial, usedDecisions(plan, evidence));
      const expiresAt = new Date(Math.min(preparedAt.getTime() + DELIVERY_OBSERVATION_MAX_AGE_MS,
        ...result.pullRequests.map(row => Date.parse(row.observedAt) + DELIVERY_OBSERVATION_MAX_AGE_MS)));
      if (expiresAt.getTime() <= Date.now()) throw stale();
      const token = Object.freeze({}) as PreparedCodeDeliveryReadiness;
      prepared.set(token, { companyId, issueId, status: effectiveStatus, actorHash: deliveryFingerprint(actor),
        snapshotHash: deliveryFingerprint({ snapshot: initial, sources }), lockIds: [...new Set([issueId,
          ...initial.obligations.flatMap(row => [row.ownerIssueId, row.sourceIssueId])])].sort(), preparedAt, expiresAt, evidence });
      return token;
    },

    apply: async <T>(transaction: DeliveryTransaction, companyId: string, issueId: string, effectiveStatus: string,
      actor: AuthorizationActor, token: PreparedCodeDeliveryReadiness | null, mutate: (tx: DeliveryTransaction) => Promise<T>) => {
      if (!terminal(effectiveStatus)) return { receipt: null, result: await mutate(transaction) };
      const proof = token && typeof token === "object" ? prepared.get(token) : null;
      if (!proof || proof.companyId !== companyId || proof.issueId !== issueId || proof.status !== effectiveStatus
        || proof.actorHash !== deliveryFingerprint(actor)) throw deliveryReadinessConflict("preparation_required");
      prepared.delete(token!);
      if (Date.now() >= proof.expiresAt.getTime()) throw stale();
      return transaction.transaction(async savepoint => {
        const tx = savepoint as unknown as Db;
        const locked = await lockDeliveryIssues(tx, actor, companyId, proof.lockIds, true);
        const current = await snapshot(tx, companyId, issueId, actor);
        const sources = await sourceBindings(tx, current, true);
        if (deliveryFingerprint({ snapshot: current, sources }) !== proof.snapshotHash) throw stale();
        const plan = planDeliveryReadiness(current);
        for (const obligation of current.obligations.filter(row => row.ownerIssueId !== issueId)) {
          const destination = locked.find(row => row.id === obligation.ownerIssueId);
          if (!destination) throw stale();
          await assertDeliveryTransferDestination(tx, destination);
        }
        const evidence = evaluateDeliveryReadiness(current, plan, proof.evidence.pullRequests.map(row => row.observation));
        await adjudication(tx, current, usedDecisions(plan, evidence));
        const principal = deliveryActor(actor);
        if (Date.now() >= proof.expiresAt.getTime()) throw stale();
        const [receipt] = await tx.insert(codeDeliveryReadinessReceipts).values({ companyId, issueId,
          issueRevision: current.issue.codeDeliveryRevision, terminalStatus: effectiveStatus, snapshotHash: proof.snapshotHash,
          actorType: principal.type, actorId: principal.id, runId: principal.runId, evidence: { version: 1, ...evidence },
          preparedAt: proof.preparedAt, expiresAt: proof.expiresAt }).returning();
        if (!receipt) throw deliveryReadinessConflict("receipt_missing");
        const result = await mutate(savepoint);
        const [consumption] = await tx.select().from(codeDeliveryReceiptConsumptions)
          .where(and(eq(codeDeliveryReceiptConsumptions.companyId, companyId), eq(codeDeliveryReceiptConsumptions.issueId, issueId),
            eq(codeDeliveryReceiptConsumptions.receiptId, receipt.id)));
        const [updated] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
        if (!consumption || consumption.issueRevision !== receipt.issueRevision + 1 || consumption.terminalStatus !== effectiveStatus
          || consumption.transactionId !== receipt.transactionId || !updated || updated.status !== effectiveStatus
          || updated.codeDeliveryRevision !== consumption.issueRevision) throw deliveryReadinessConflict("receipt_not_consumed");
        await tx.insert(activityLog).values({ companyId, actorType: principal.type, actorId: principal.id, runId: principal.runId,
          action: "code_delivery.readiness_certified", entityType: "issue", entityId: issueId,
          details: { receiptId: receipt.id, terminalStatus: effectiveStatus, issueRevision: current.issue.codeDeliveryRevision,
            terminalRevision: consumption.issueRevision } });
        return { receipt, result };
      }).catch((error: unknown) => {
        let current = error;
        for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
          const value = current as { code?: unknown; cause?: unknown };
          if (value.code === "55P03" || value.code === "40P01") throw stale();
          current = value.cause;
        }
        throw error;
      });
    },
  };
}
