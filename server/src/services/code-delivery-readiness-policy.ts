import { createHash } from "node:crypto";
import type { codeDeliveryDecisions, codeDeliveryDiscoveries, codeDeliveryObligations, codeDeliveryOwnershipEvents,
  issueCodeDeliveryIntents, issues } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { matchDeliveryDiscovery } from "./code-delivery-discovery.js";
import type { CodeDeliveryPullRequestIdentity, CodeDeliveryPullRequestObservation } from "./code-delivery-github.js";

export type DeliverySnapshot = {
  issue: typeof issues.$inferSelect;
  intent: typeof issueCodeDeliveryIntents.$inferSelect | null;
  obligations: Array<typeof codeDeliveryObligations.$inferSelect>;
  discoveries: Array<typeof codeDeliveryDiscoveries.$inferSelect>;
  decisions: Array<typeof codeDeliveryDecisions.$inferSelect>;
  ownership: Array<typeof codeDeliveryOwnershipEvents.$inferSelect>;
};
export type DeliveryDecision = DeliverySnapshot["decisions"][number];
export type DeliveryEvidence = {
  intent: { kind: "code" | "non_code"; revision: number };
  noPrDecisionId: string | null;
  discoveries: Array<{ discoveryId: string; obligationId: string | null; decisionId: string | null }>;
  transfers: Array<{ obligationId: string; decisionId: string; destinationIssueId: string }>;
  pullRequests: Array<{ obligationId: string; obligationRevision: number; decisionId: string;
    outcome: "merged" | "closed_unmerged" | "withdrawn"; observation: CodeDeliveryPullRequestObservation }>;
};
export type DeliveryReadinessPlan = {
  identities: CodeDeliveryPullRequestIdentity[];
  decisions: DeliveryDecision[];
  evidence: Omit<DeliveryEvidence, "pullRequests">;
};

export const DELIVERY_OBSERVATION_MAX_AGE_MS = 30_000;
export const deliveryFingerprint = (value: unknown): string => {
  const canonical = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
};
export function deliveryReadinessConflict(reason: string) {
  return conflict("Code delivery is not ready for terminal completion", { code: "code_delivery_not_ready", reason });
}
export function assertFreshDeliveryObservation(observation: CodeDeliveryPullRequestObservation, now: number) {
  const at = Date.parse(observation.observedAt);
  if (!Number.isFinite(at) || at > now || now - at > DELIVERY_OBSERVATION_MAX_AGE_MS) throw deliveryReadinessConflict("stale_observation");
}

export function planDeliveryReadiness(snapshot: DeliverySnapshot): DeliveryReadinessPlan {
  const { issue, intent, obligations, discoveries, decisions, ownership } = snapshot;
  if (["done", "cancelled"].includes(issue.status)) throw deliveryReadinessConflict("already_terminal");
  if (!intent || intent.companyId !== issue.companyId || intent.issueId !== issue.id || intent.intent === "ambiguous") {
    throw deliveryReadinessConflict("unclassified_intent");
  }
  if (obligations.some(row => row.companyId !== issue.companyId || (row.ownerIssueId !== issue.id && row.sourceIssueId !== issue.id
    && !ownership.some(event => event.obligationId === row.id && event.fromIssueId === issue.id)))
    || discoveries.some(row => row.companyId !== issue.companyId || row.issueId !== issue.id)
    || decisions.some(row => row.companyId !== issue.companyId)
    || ownership.some(row => row.companyId !== issue.companyId)) throw deliveryReadinessConflict("invalid_scope");
  const owned = obligations.filter(row => row.ownerIssueId === issue.id);
  if (owned.length > 16) throw deliveryReadinessConflict("request_budget_exceeded");
  if (intent.intent === "non_code" && (obligations.length || discoveries.length || ownership.length)) {
    throw deliveryReadinessConflict("non_code_has_associations");
  }
  const transfers = obligations.filter(row => row.ownerIssueId !== issue.id).map(row => {
    const event = ownership.find(event => event.obligationId === row.id && event.fromIssueId === issue.id);
    const decision = event && decisions.find(decision => decision.id === event.provenance.decisionId && decision.kind === "transfer"
      && decision.issueId === issue.id && decision.obligationId === row.id && decision.payload.destinationIssueId === event.toIssueId);
    if (!event || !decision || event.toIssueId === issue.id || decision.obligationRevision == null
      || event.obligationRevision !== decision.obligationRevision + 1 || event.obligationRevision > row.revision) {
      throw deliveryReadinessConflict("unproven_transfer");
    }
    return { obligationId: row.id, decisionId: decision.id, destinationIssueId: event.toIssueId };
  });
  const transferredIds = new Set(transfers.map(row => row.obligationId));
  const reconciliation = discoveries.map(row => matchDeliveryDiscovery(row, obligations, decisions, transferredIds));
  if (reconciliation.some(row => !row.obligationId && !row.decisionId)) throw deliveryReadinessConflict("unreconciled_associations");
  const noPr = !owned.length && !transfers.length && intent.intent === "code"
    ? decisions.find(decision => decision.issueId === issue.id && decision.kind === "no_pr"
      && reconciliation.every(row => row.decisionId === decision.id)) : null;
  if (intent.intent === "code" && !owned.length && !transfers.length && !noPr) throw deliveryReadinessConflict("no_pr_disposition_required");
  const selected: DeliveryDecision[] = noPr ? [noPr] : [];
  for (const obligation of owned) {
    const headDecision = decisions.find(decision => decision.id === obligation.headDecisionId && decision.kind === "accept_head"
      && decision.issueId === issue.id && decision.obligationId === obligation.id
      && decision.obligationRevision === obligation.revision - 1 && decision.payload.headSha === obligation.reviewedHeadSha);
    const disposition = decisions.find(decision => ["closed_unmerged", "withdrawn"].includes(decision.kind)
      && decision.issueId === issue.id && decision.obligationId === obligation.id && decision.obligationRevision === obligation.revision);
    if (!disposition && (!obligation.reviewedHeadSha || !headDecision)) throw deliveryReadinessConflict("reviewed_head_required");
    selected.push(...(headDecision ? [headDecision] : []), ...(disposition ? [disposition] : []));
  }
  selected.push(...reconciliation.flatMap(row => row.decisionId ? decisions.filter(decision => decision.id === row.decisionId) : []));
  return {
    identities: owned.map(row => ({ projectId: row.sourceProjectId, workspaceId: row.sourceWorkspaceId,
      repository: row.repository, repositoryId: row.repositoryId, number: row.pullRequestNumber, baseRef: row.baseRef,
      reviewedHeadSha: row.reviewedHeadSha ?? row.proposedHeadSha })),
    decisions: [...new Map(selected.map(decision => [decision.id, decision])).values()],
    evidence: { intent: { kind: intent.intent, revision: intent.revision }, noPrDecisionId: noPr?.id ?? null,
      discoveries: reconciliation, transfers },
  };
}

export function evaluateDeliveryReadiness(snapshot: DeliverySnapshot, plan: DeliveryReadinessPlan,
  observations: CodeDeliveryPullRequestObservation[], now = Date.now()): DeliveryEvidence {
  const owned = snapshot.obligations.filter(row => row.ownerIssueId === snapshot.issue.id);
  if (observations.length !== owned.length || observations.length > 16) throw deliveryReadinessConflict("incomplete_observations");
  const used = new Set<CodeDeliveryPullRequestObservation>();
  const pullRequests = owned.map(obligation => {
    const observation = observations.find(value => value.repositoryId === obligation.repositoryId
      && value.repository === obligation.repository && value.number === obligation.pullRequestNumber && value.baseRef === obligation.baseRef);
    if (!observation || used.has(observation)) throw deliveryReadinessConflict("identity_mismatch");
    used.add(observation);
    assertFreshDeliveryObservation(observation, now);
    if (observation.headSha !== (obligation.reviewedHeadSha ?? obligation.proposedHeadSha)) throw deliveryReadinessConflict("head_mismatch");
    let outcome: DeliveryEvidence["pullRequests"][number]["outcome"];
    let decision: DeliveryDecision | undefined;
    if (observation.state === "merged") {
      const mergedAt = observation.mergedAt && Date.parse(observation.mergedAt);
      if (observation.draft || !mergedAt || !Number.isFinite(mergedAt) || mergedAt > now
        || !observation.mergeCommitSha || !/^[a-f0-9]{40}$/.test(observation.mergeCommitSha)
        || !obligation.reviewedHeadSha) throw deliveryReadinessConflict("invalid_merged_proof");
      decision = plan.decisions.find(value => value.id === obligation.headDecisionId && value.kind === "accept_head");
      outcome = "merged";
    } else if (observation.state === "closed" && !observation.mergedAt && !observation.mergeCommitSha) {
      decision = plan.decisions.find(value => value.obligationId === obligation.id && value.obligationRevision === obligation.revision
        && (value.kind === "closed_unmerged" || value.kind === "withdrawn"));
      const previous = decision?.payload.observation as CodeDeliveryPullRequestObservation | undefined;
      if (!previous || previous.repositoryId !== observation.repositoryId || previous.repository !== observation.repository
        || previous.number !== observation.number || previous.baseRef !== observation.baseRef || previous.headSha !== observation.headSha
        || previous.state !== "closed" || previous.mergedAt !== null || previous.mergeCommitSha !== null) {
        throw deliveryReadinessConflict("closed_disposition_required");
      }
      outcome = decision!.kind as "closed_unmerged" | "withdrawn";
    } else {
      throw deliveryReadinessConflict(observation.state === "open" ? "pull_request_open" : "invalid_provider_state");
    }
    if (!decision) throw deliveryReadinessConflict("independent_decision_required");
    return { obligationId: obligation.id, obligationRevision: obligation.revision, decisionId: decision.id, outcome,
      observation: { ...observation } };
  });
  return { ...plan.evidence, pullRequests };
}
