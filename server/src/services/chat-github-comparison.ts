import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { chatGitHubReviews, type chatGitHubReviewEnrollments, type Db } from "@paperclipai/db";
import { GITHUB_PRIMARY_BLINDING_VERSION } from "./chat-github-primary-blinding.js";
import { githubPairEquivalence, type GitHubPairRunEvidence } from "./chat-github-run-evidence.js";

type Store = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Enrollment = typeof chatGitHubReviewEnrollments.$inferSelect;

/** Match all primary run receipts to this admission and exact head. A snapshot
 * retry cannot erase evidence of earlier live or unproven inputs. */
export async function githubPrimaryInputSource(db: Store, enrollment: Enrollment) {
  const reviews = await db.select({ event: chatGitHubReviews.event }).from(chatGitHubReviews).where(and(
    eq(chatGitHubReviews.companyId, enrollment.companyId), eq(chatGitHubReviews.endpointId, enrollment.endpointId),
    eq(chatGitHubReviews.headSha, enrollment.headSha ?? ""), isNull(chatGitHubReviews.shadowLabel), isNotNull(chatGitHubReviews.runId),
    or(eq(chatGitHubReviews.deliveryId, enrollment.originDeliveryId), eq(chatGitHubReviews.admissionDeliveryId, enrollment.originDeliveryId)),
  ));
  if (reviews.length === 0) return undefined;
  return reviews.every(review => review.event.inputSource === "snapshot") ? "snapshot" : "live";
}

/** Read-time assessment eligibility. The immutable admission envelope cannot be
 * updated after a run; callers must use its exact run and candidate/arm binding.
 * This re-derives the verdict from evidence instead of trusting a cached boolean. */
export function githubRunComparisonEligibility(
  enrollment: typeof chatGitHubReviewEnrollments.$inferSelect,
  candidate: { id: string; armId: string },
  runId: string,
  primaryInputSource?: "snapshot" | "live",
  runEvidence?: GitHubPairRunEvidence,
) {
  const receipt = enrollment.isolationTests[runId];
  const bound = receipt?.version === 1 && receipt.runId === runId
    && receipt.candidateId === candidate.id && receipt.armId === candidate.armId;
  const result = githubComparisonEligibility({
    environmentCertified: !!(bound && receipt.environmentId && receipt.configurationDigest && receipt.certificateDigest),
    selfTestRecorded: !!bound,
    selfTestPassed: !!(bound && receipt.status === "passed" && receipt.checks.primaryCanariesDenied
      && receipt.checks.githubDenied && receipt.checks.configFresh && receipt.checks.providerToolsDenied === true
      && receipt.checks.allowedModelAccepted === true && receipt.checks.otherModelDenied === true && receipt.checks.rawProxyDenied === true && receipt.hooksDigest),
    primaryBlindingActive: enrollment.envelope.protocol?.primaryBlindingVersion === GITHUB_PRIMARY_BLINDING_VERSION
      && receipt?.primaryBlindingVersion === GITHUB_PRIMARY_BLINDING_VERSION,
    snapshotAvailable: !!enrollment.envelope.snapshot,
    roundOrdinal: enrollment.roundOrdinal,
    primaryInputSource,
    runEvidence: bound && runEvidence ? { ...runEvidence, admittedHead: enrollment.headSha } : undefined,
  });
  if (receipt && !bound) {
    result.certifiedClean = false;
    result.reasons.push("candidate_isolation_receipt_binding_mismatch");
  }
  return result;
}

/** Admission and pre-dispatch isolation receipts necessarily precede CLI init.
 * Their cached verdict stays conservative. The authoritative read-time verdict
 * joins the exact assessment run's isolation receipt with both arms' run events;
 * it never promotes immutable admission bytes or borrows another retry/arm. */
export function githubComparisonEligibility(evidence: {
  environmentCertified: boolean; selfTestRecorded: boolean; selfTestPassed: boolean;
  primaryBlindingActive: boolean; snapshotAvailable: boolean; roundOrdinal: number;
  primaryInputSource?: "snapshot" | "live";
  runEvidence?: GitHubPairRunEvidence & { admittedHead: string | null };
}): { certifiedClean: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!evidence.primaryBlindingActive) reasons.push("primary_namespace_not_isolated");
  if (!evidence.environmentCertified) reasons.push("candidate_runtime_not_certified");
  if (!evidence.selfTestRecorded) reasons.push("candidate_isolation_self_test_not_recorded");
  else if (!evidence.selfTestPassed) reasons.push("candidate_isolation_self_test_failed");
  if (!evidence.snapshotAvailable) reasons.push("admission_snapshot_unavailable");
  if (evidence.roundOrdinal > 1) reasons.push("longitudinal_arm_history");
  if (evidence.primaryInputSource !== "snapshot") reasons.push("primary_inputs_not_sealed");
  const equivalence = githubPairEquivalence(evidence.runEvidence);
  if (!equivalence.tools) reasons.push("effective_tool_equivalence_unverified");
  if (!equivalence.workspace) reasons.push("workspace_equivalence_unverified");
  return { certifiedClean: reasons.length === 0, reasons };
}

export const GITHUB_SHADOW_PROTOCOL = {
  version: 3,
  primaryBlindingVersion: GITHUB_PRIMARY_BLINDING_VERSION,
  eligibilitySource: "runCapability.envelope.comparisonEligibility",
  deviations: {
    webTools: {
      deniedTools: ["WebSearch", "WebFetch"],
      reason: "Provider-side public PR reads can reveal the primary review despite candidate host egress isolation.",
      primaryChanged: false,
      evidence: { successfulRuns: 3138, lookbackDays: 7, webSearchRequests: 0, webFetchRequests: 0,
        source: "heartbeat_runs.result_json.server_tool_use", observedOn: "2026-10-17", verification: "operator_supplied" },
    },
  },
} as const;
