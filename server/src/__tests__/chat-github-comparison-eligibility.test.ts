import { describe, expect, it } from "vitest";
import { githubComparisonEligibility, githubRunComparisonEligibility, GITHUB_SHADOW_PROTOCOL } from "../services/chat-github-comparison.js";
import type { chatGitHubReviewEnrollments } from "@paperclipai/db";

describe("evidence-derived paired review eligibility", () => {
  const unverified = ["effective_tool_equivalence_unverified", "workspace_equivalence_unverified"];
  const proof = { environmentCertified: true, selfTestRecorded: true, selfTestPassed: true, primaryBlindingActive: true,
    snapshotAvailable: true, roundOrdinal: 1, primaryInputSource: "snapshot" as const };
  it("keeps successful isolated runs ineligible while tool and workspace equivalence is unverified", () => {
    expect(githubComparisonEligibility(proof)).toEqual({ certifiedClean: false, reasons: unverified });
  });
  it.each([
    ["environmentCertified", "candidate_runtime_not_certified"],
    ["selfTestRecorded", "candidate_isolation_self_test_not_recorded"],
    ["selfTestPassed", "candidate_isolation_self_test_failed"],
    ["primaryBlindingActive", "primary_namespace_not_isolated"],
    ["snapshotAvailable", "admission_snapshot_unavailable"],
  ])("fails closed for %s and retains its exact reason", (field, reason) => {
    expect(githubComparisonEligibility({ ...proof, [field]: false })).toEqual({ certifiedClean: false, reasons: [reason, ...unverified] });
  });
  it.each(["live", undefined] as const)("does not certify primary inputs without a sealed-source receipt (%s)", primaryInputSource => {
    expect(githubComparisonEligibility({ ...proof, primaryInputSource }))
      .toEqual({ certifiedClean: false, reasons: ["primary_inputs_not_sealed", ...unverified] });
  });
  it("does not call longitudinal history a clean first-round sample", () => {
    expect(githubComparisonEligibility({ ...proof, roundOrdinal: 2 })).toEqual({ certifiedClean: false, reasons: ["longitudinal_arm_history", ...unverified] });
  });
  it("derives the read-time envelope from the exact assessment run, never another retry or arm", () => {
    const enrollment = { roundOrdinal: 1, envelope: { snapshot: {}, protocol: GITHUB_SHADOW_PROTOCOL }, isolationTests: {
      run: { version: 1, runId: "run", candidateId: "candidate", armId: "arm", environmentId: "env", configurationDigest: "config",
        certificateDigest: "cert", hooksDigest: "hooks", primaryBlindingVersion: 1, status: "passed",
        checks: { primaryCanariesDenied: true, githubDenied: true, configFresh: true, providerToolsDenied: true,
          allowedModelAccepted: true, otherModelDenied: true, rawProxyDenied: true } },
    } } as unknown as typeof chatGitHubReviewEnrollments.$inferSelect;
    expect(githubRunComparisonEligibility(enrollment, { id: "candidate", armId: "arm" }, "run", "snapshot")).toEqual({ certifiedClean: false, reasons: unverified });
    // Bind the run with a sealed snapshot source: any loosening of the binding
    // checks must fail these exact reasons, not a vacuous false.
    const unbound = ["candidate_runtime_not_certified", "candidate_isolation_self_test_not_recorded",
      ...unverified, "candidate_isolation_receipt_binding_mismatch"];
    for (const [candidateId, armId] of [["other", "arm"], ["candidate", "other"]]) {
      expect(githubRunComparisonEligibility(enrollment, { id: candidateId!, armId: armId! }, "run", "snapshot"))
        .toEqual({ certifiedClean: false, reasons: unbound });
    }
    // A retry id with no receipt also loses the receipt-side namespace evidence.
    expect(githubRunComparisonEligibility(enrollment, { id: "candidate", armId: "arm" }, "retry", "snapshot"))
      .toEqual({ certifiedClean: false, reasons: ["primary_namespace_not_isolated", "candidate_runtime_not_certified",
        "candidate_isolation_self_test_not_recorded", ...unverified] });
    enrollment.isolationTests.run!.checks.githubDenied = false;
    expect(githubRunComparisonEligibility(enrollment, { id: "candidate", armId: "arm" }, "run", "snapshot").reasons).toContain("candidate_isolation_self_test_failed");
  });
  it.each(["receipt", "envelope"] as const)("rejects missing %s primary namespace evidence", (missing) => {
    const enrollment = { roundOrdinal: 1, envelope: { snapshot: {}, protocol: GITHUB_SHADOW_PROTOCOL }, isolationTests: {
      run: { version: 1, runId: "run", candidateId: "candidate", armId: "arm", environmentId: "env", configurationDigest: "config",
        certificateDigest: "cert", hooksDigest: "hooks", primaryBlindingVersion: 1, status: "passed",
        checks: { primaryCanariesDenied: true, githubDenied: true, configFresh: true, providerToolsDenied: true,
          allowedModelAccepted: true, otherModelDenied: true, rawProxyDenied: true } },
    } } as unknown as typeof chatGitHubReviewEnrollments.$inferSelect;
    if (missing === "receipt") delete enrollment.isolationTests.run!.primaryBlindingVersion;
    else delete enrollment.envelope.protocol;
    expect(githubRunComparisonEligibility(enrollment, { id: "candidate", armId: "arm" }, "run", "snapshot"))
      .toEqual({ certifiedClean: false, reasons: ["primary_namespace_not_isolated", ...unverified] });
  });
  it("does not certify a fair comparison from isolation alone without tool and workspace inventories", () => {
    expect(githubComparisonEligibility(proof)).toEqual({ certifiedClean: false,
      reasons: ["effective_tool_equivalence_unverified", "workspace_equivalence_unverified"] });
  });
  it("records the deliberate web-tools deviation and the supplied observational provenance", () => {
    expect(GITHUB_SHADOW_PROTOCOL.deviations.webTools).toMatchObject({ deniedTools: ["WebSearch", "WebFetch"],
      evidence: { successfulRuns: 3138, lookbackDays: 7, webSearchRequests: 0, webFetchRequests: 0,
        source: "heartbeat_runs.result_json.server_tool_use", observedOn: "2026-10-17", verification: "operator_supplied" } });
  });
});
