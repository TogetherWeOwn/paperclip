import { describe, expect, it } from "vitest";
import { githubComparisonEligibility, githubRunComparisonEligibility, GITHUB_SHADOW_PROTOCOL } from "../services/chat-github-comparison.js";
import type { chatGitHubReviewEnrollments } from "@paperclipai/db";

describe("evidence-derived paired review eligibility", () => {
  const proof = { environmentCertified: true, selfTestRecorded: true, selfTestPassed: true, primaryBlindingActive: true,
    snapshotAvailable: true, roundOrdinal: 1 };
  it("certifies only a recorded successful isolated run with the primary guard active", () => {
    expect(githubComparisonEligibility(proof)).toEqual({ certifiedClean: true, reasons: [] });
  });
  it.each([
    ["environmentCertified", "candidate_runtime_not_certified"],
    ["selfTestRecorded", "candidate_isolation_self_test_not_recorded"],
    ["selfTestPassed", "candidate_isolation_self_test_failed"],
    ["primaryBlindingActive", "primary_namespace_not_isolated"],
    ["snapshotAvailable", "admission_snapshot_unavailable"],
  ])("fails closed for %s and retains its exact reason", (field, reason) => {
    expect(githubComparisonEligibility({ ...proof, [field]: false })).toEqual({ certifiedClean: false, reasons: [reason] });
  });
  it("does not call longitudinal history a clean first-round sample", () => {
    expect(githubComparisonEligibility({ ...proof, roundOrdinal: 2 })).toEqual({ certifiedClean: false, reasons: ["longitudinal_arm_history"] });
  });
  it("derives the read-time envelope from the exact assessment run, never another retry or arm", () => {
    const enrollment = { roundOrdinal: 1, envelope: { snapshot: {}, protocol: GITHUB_SHADOW_PROTOCOL }, isolationTests: {
      run: { version: 1, runId: "run", candidateId: "candidate", armId: "arm", environmentId: "env", configurationDigest: "config",
        certificateDigest: "cert", hooksDigest: "hooks", primaryBlindingVersion: 1, status: "passed",
        checks: { primaryCanariesDenied: true, githubDenied: true, configFresh: true } },
    } } as unknown as typeof chatGitHubReviewEnrollments.$inferSelect;
    expect(githubRunComparisonEligibility(enrollment, { id: "candidate", armId: "arm" }, "run")).toEqual({ certifiedClean: true, reasons: [] });
    for (const [candidateId, armId, runId] of [["other", "arm", "run"], ["candidate", "other", "run"], ["candidate", "arm", "retry"]]) {
      expect(githubRunComparisonEligibility(enrollment, { id: candidateId!, armId: armId! }, runId!)).toMatchObject({ certifiedClean: false });
    }
    enrollment.isolationTests.run!.checks.githubDenied = false;
    expect(githubRunComparisonEligibility(enrollment, { id: "candidate", armId: "arm" }, "run").reasons).toContain("candidate_isolation_self_test_failed");
  });
  it.each(["receipt", "envelope"] as const)("rejects missing %s primary namespace evidence", (missing) => {
    const enrollment = { roundOrdinal: 1, envelope: { snapshot: {}, protocol: GITHUB_SHADOW_PROTOCOL }, isolationTests: {
      run: { version: 1, runId: "run", candidateId: "candidate", armId: "arm", environmentId: "env", configurationDigest: "config",
        certificateDigest: "cert", hooksDigest: "hooks", primaryBlindingVersion: 1, status: "passed",
        checks: { primaryCanariesDenied: true, githubDenied: true, configFresh: true } },
    } } as unknown as typeof chatGitHubReviewEnrollments.$inferSelect;
    if (missing === "receipt") delete enrollment.isolationTests.run!.primaryBlindingVersion;
    else delete enrollment.envelope.protocol;
    expect(githubRunComparisonEligibility(enrollment, { id: "candidate", armId: "arm" }, "run"))
      .toEqual({ certifiedClean: false, reasons: ["primary_namespace_not_isolated"] });
  });
  it("records the deliberate web-tools deviation and the supplied observational provenance", () => {
    expect(GITHUB_SHADOW_PROTOCOL.deviations.webTools).toMatchObject({ deniedTools: ["WebSearch", "WebFetch"],
      evidence: { successfulRuns: 3138, lookbackDays: 7, webSearchRequests: 0, webFetchRequests: 0,
        source: "heartbeat_runs.result_json.server_tool_use", observedOn: "2026-10-17", verification: "operator_supplied" } });
  });
});
