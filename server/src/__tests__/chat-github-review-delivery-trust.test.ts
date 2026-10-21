import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueExecutionPolicySchema, LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { githubReviewDeliveryTrust } from "../services/chat-github-task-trust.js";
import { resolveCoreTrustPreset } from "../services/trust-preset-resolver.js";

const COMPANY_ID = randomUUID();
const ISSUE_ID = randomUUID();
const AGENT_ID = randomUUID();
const REVIEW_PRESET = { id: LOW_TRUST_REVIEW_PRESET, version: 1, rawOutputDisposition: "quarantine" } as const;

function boundary(overrides: Record<string, unknown> = {}) {
  return {
    mode: LOW_TRUST_REVIEW_PRESET, companyId: COMPANY_ID, rootIssueId: ISSUE_ID, issueIds: [ISSUE_ID],
    allowedAgentIds: [AGENT_ID], allowedToolClasses: ["git.read", "github.pr.read", "tests.local"],
    allowedSecretBindingIds: [], ...overrides,
  };
}
function lowPolicy(overrides: Record<string, unknown> = {}) {
  return {
    mode: "normal", commentRequired: true, stages: [], reviewPreset: REVIEW_PRESET,
    authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET, reviewPreset: REVIEW_PRESET, trustBoundary: boundary() },
    ...overrides,
  };
}
const marker = (lowTrust: unknown, executionPolicy: unknown) => ({ version: 1, lowTrust, executionPolicy });
/** The reader returns the schema-normalized policy: input plus schema defaults, nothing else. */
const normalized = (policy: unknown) => issueExecutionPolicySchema.parse(policy);
/** The runtime resolver the heartbeat applies to the pinned policy at dispatch. */
const runtimeTrust = (executionPolicy: unknown) =>
  resolveCoreTrustPreset({ companyId: COMPANY_ID, run: { companyId: COMPANY_ID, executionPolicy } });

describe("githubReviewDeliveryTrust reads the admitted marker without widening it", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "low"],
    ["an array", [{ version: 1, lowTrust: true }]],
    ["an unknown version", { version: 2, lowTrust: false, executionPolicy: null }],
    ["a missing version", { lowTrust: false, executionPolicy: null }],
    ["a missing lowTrust flag", { version: 1, executionPolicy: null }],
    ["a truthy non-boolean lowTrust", { version: 1, lowTrust: "false", executionPolicy: null }],
    ["a numeric lowTrust", { version: 1, lowTrust: 0, executionPolicy: null }],
  ])("returns null for %s, so callers treat legacy deliveries as untrusted", (_name, value) => {
    expect(githubReviewDeliveryTrust(value)).toBeNull();
  });

  it("passes a normal marker with no policy through unchanged", () => {
    expect(githubReviewDeliveryTrust(marker(false, null))).toEqual({ lowTrust: false, executionPolicy: null });
  });

  it("keeps an operator policy on a normal marker apart from schema defaults", () => {
    const operator = { mode: "normal", commentRequired: false, stages: [] };
    expect(githubReviewDeliveryTrust(marker(false, operator))).toEqual({ lowTrust: false, executionPolicy: normalized(operator) });
  });

  it("keeps a complete low-trust boundary intact and does not report a denial", () => {
    const policy = lowPolicy();
    const result = githubReviewDeliveryTrust(marker(true, policy));
    expect(result).toEqual({ lowTrust: true, executionPolicy: normalized(policy) });
    expect(result).not.toHaveProperty("denied");
    expect(runtimeTrust(result!.executionPolicy)).toMatchObject({ kind: "low_trust_review", boundary: { issueIds: [ISSUE_ID], allowedAgentIds: [AGENT_ID] } });
  });

  it("cannot be downgraded: a normal marker over a low-trust policy stays low trust", () => {
    const policy = lowPolicy();
    expect(githubReviewDeliveryTrust(marker(false, policy))).toEqual({ lowTrust: true, executionPolicy: normalized(policy) });
  });

  it("treats a boundary alone as low trust even when the marker says normal", () => {
    const policy = { mode: "normal", commentRequired: true, stages: [], authorizationPolicy: { trustBoundary: boundary() } };
    expect(githubReviewDeliveryTrust(marker(false, policy))).toMatchObject({ lowTrust: true, executionPolicy: policy });
  });

  it("passes a valid low-trust marker WITHOUT a boundary through to runtime denial, never to normal execution", () => {
    const policy = { mode: "normal", commentRequired: true, stages: [], reviewPreset: REVIEW_PRESET };
    const result = githubReviewDeliveryTrust(marker(true, policy));
    expect(result).toEqual({ lowTrust: true, executionPolicy: normalized(policy) });
    expect(result).not.toHaveProperty("denied");
    expect(result!.executionPolicy).not.toHaveProperty("authorizationPolicy.trustBoundary");
    expect(runtimeTrust(result!.executionPolicy)).toMatchObject({ kind: "denied", reason: "missing_low_trust_boundary_scope" });
  });

  it.each([
    ["no policy", null],
    ["a plain operator policy", { mode: "normal", commentRequired: false, stages: [] }],
  ])("adds the missing review preset to a source-trust-only low marker over %s", (_name, policy) => {
    const result = githubReviewDeliveryTrust(marker(true, policy));
    expect(result).toMatchObject({ lowTrust: true, executionPolicy: { reviewPreset: REVIEW_PRESET } });
    expect(result).not.toHaveProperty("denied");
    // Still no scope: the runtime denies instead of running it as standard trust.
    expect(result!.executionPolicy).not.toHaveProperty("authorizationPolicy.trustBoundary");
    expect(runtimeTrust(result!.executionPolicy)).toMatchObject({ kind: "denied", reason: "missing_low_trust_boundary_scope" });
    if (policy) expect(result!.executionPolicy).toMatchObject({ commentRequired: false });
  });

  it.each([
    ["an unknown mode", { mode: "bogus" }],
    ["a non-object policy", "not-a-policy"],
    ["an array policy", []],
    ["wrong stage types", { mode: "normal", commentRequired: true, stages: "review" }],
    ["a non-boolean commentRequired", { mode: "normal", commentRequired: "yes", stages: [] }],
    ["an unsupported review preset", { mode: "normal", commentRequired: true, stages: [], reviewPreset: { ...REVIEW_PRESET, version: 2 } }],
    ["an unsupported trust preset", { mode: "normal", commentRequired: true, stages: [], authorizationPolicy: { trustPreset: "no_such_preset" } }],
    ["a boundary with an extra field", lowPolicy({ authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET, trustBoundary: boundary({ extra: true }) } })],
    ["a boundary with a non-GUID scope", lowPolicy({ authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET, trustBoundary: boundary({ issueIds: ["not-a-guid"] }) } })],
    ["a boundary in the wrong mode", lowPolicy({ authorizationPolicy: { trustBoundary: boundary({ mode: "standard" }) } })],
  ])("returns a permanent denial for %s and exposes no usable policy", (_name, policy) => {
    for (const lowTrust of [true, false]) {
      expect(githubReviewDeliveryTrust(marker(lowTrust, policy))).toEqual({
        lowTrust: true, executionPolicy: null, denied: "invalid_admitted_policy",
      });
    }
  });

  it("does not mutate the stored marker or the policy it was handed", () => {
    const policy = Object.freeze(lowPolicy({ authorizationPolicy: Object.freeze({ trustPreset: LOW_TRUST_REVIEW_PRESET, trustBoundary: Object.freeze(boundary()) }) }));
    const stored = Object.freeze(marker(true, policy));
    const before = JSON.stringify(stored);
    expect(() => githubReviewDeliveryTrust(stored)).not.toThrow();
    expect(() => githubReviewDeliveryTrust(marker(true, Object.freeze({ mode: "normal", commentRequired: true, stages: [] })))).not.toThrow();
    expect(JSON.stringify(stored)).toBe(before);
  });

  it("returns a fresh policy object so a caller cannot alias the stored delivery event", () => {
    const stored = marker(true, lowPolicy());
    const result = githubReviewDeliveryTrust(stored);
    expect(result!.executionPolicy).not.toBe(stored.executionPolicy);
    (result!.executionPolicy as Record<string, unknown>).commentRequired = false;
    expect((stored.executionPolicy as Record<string, unknown>).commentRequired).toBe(true);
  });
});
