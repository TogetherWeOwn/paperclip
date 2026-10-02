import { describe, expect, it } from "vitest";
import {
  RUN_MODEL_DECISION_CAPABILITY,
  RUN_MODEL_DECISION_DEFAULT_DELAY_MS,
  RUN_MODEL_DECISION_DEFAULT_MAX_ATTEMPTS,
  RUN_MODEL_DECISION_RETRY_REASON,
  RUN_MODEL_DECISION_RPC_TIMEOUT_MS,
  applyRunModelDecisionToAdapterConfig,
  buildAdvisoryModelDecisionRecord,
  buildModelDecisionRecord,
  deferRunModelDecisionOnTimeout,
  evaluateRunModelDecisionSkip,
  isSecretEnvBinding,
  resolveRunModelDecisionNoDecision,
  runModelDecisionChangesModel,
  validateRunModelDecisionAnswer,
} from "../services/run-model-decision.ts";

const ALLOWLIST = ["PAPERCLIP_ASSIGNED_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"] as const;

describe("run model decision hook (TOG-11792, design §9.2)", () => {
  // 1. decision applied
  it("applies a decide answer: model, effort and allowlisted env merge per key", () => {
    const validated = validateRunModelDecisionAnswer(
      {
        kind: "decide",
        decisionId: "dec-1",
        model: "claude-opus-5-5",
        effort: "xhigh",
        env: { PAPERCLIP_ASSIGNED_MODEL: "claude-opus-5-5" },
        source: "router",
      },
      { allowlistedEnvKeys: ALLOWLIST, baseEnv: {} },
    );
    expect(validated.valid).toBe(true);
    if (!validated.valid) throw new Error("expected valid");
    const merged = applyRunModelDecisionToAdapterConfig(
      { model: "base-model", env: { KEEP: "1" } },
      validated.answer,
    );
    expect(merged.model).toBe("claude-opus-5-5");
    expect(merged.effort).toBe("xhigh");
    expect(merged.env).toEqual({
      KEEP: "1",
      PAPERCLIP_ASSIGNED_MODEL: "claude-opus-5-5",
    });
  });

  // 2. env allowlist enforced
  it("rejects a decision env key outside the manifest allowlist", () => {
    const validated = validateRunModelDecisionAnswer(
      {
        kind: "decide",
        decisionId: "dec-2",
        model: "m",
        env: { NOT_ALLOWLISTED: "x" },
        source: "router",
      },
      { allowlistedEnvKeys: ALLOWLIST, baseEnv: {} },
    );
    expect(validated.valid).toBe(false);
    if (validated.valid) throw new Error("expected invalid");
    expect(validated.error).toBe("env_key_not_allowlisted");
  });

  it("rejects a non-string decision env value", () => {
    const validated = validateRunModelDecisionAnswer(
      {
        kind: "decide",
        decisionId: "dec-2b",
        model: "m",
        env: { PAPERCLIP_ASSIGNED_MODEL: 42 },
        source: "router",
      },
      { allowlistedEnvKeys: ALLOWLIST, baseEnv: {} },
    );
    expect(validated.valid).toBe(false);
    if (validated.valid) throw new Error("expected invalid");
    expect(validated.error).toBe("env_value_not_plain_string");
  });

  // 3. secret_ref key rejected
  it("rejects a decision env key that is a secret_ref in the base config", () => {
    const validated = validateRunModelDecisionAnswer(
      {
        kind: "decide",
        decisionId: "dec-3",
        model: "m",
        env: { PAPERCLIP_ASSIGNED_MODEL: "plain" },
        source: "router",
      },
      {
        allowlistedEnvKeys: ALLOWLIST,
        baseEnv: {
          PAPERCLIP_ASSIGNED_MODEL: { type: "secret_ref", secretId: "sec-1" },
        },
      },
    );
    expect(validated.valid).toBe(false);
    if (validated.valid) throw new Error("expected invalid");
    expect(validated.error).toBe("env_key_is_secret_ref");
  });

  it("rejects a decision env key that is a user_secret_ref in the base config", () => {
    const validated = validateRunModelDecisionAnswer(
      {
        kind: "decide",
        decisionId: "dec-3b",
        model: "m",
        env: { PAPERCLIP_ASSIGNED_MODEL: "plain" },
        source: "router",
      },
      {
        allowlistedEnvKeys: ALLOWLIST,
        baseEnv: {
          PAPERCLIP_ASSIGNED_MODEL: { type: "user_secret_ref", key: "k" },
        },
      },
    );
    expect(validated.valid).toBe(false);
    if (validated.valid) throw new Error("expected invalid");
    expect(validated.error).toBe("env_key_is_secret_ref");
  });

  it("detects secret bindings and ignores plain values", () => {
    expect(isSecretEnvBinding({ type: "secret_ref", secretId: "s" })).toBe(true);
    expect(isSecretEnvBinding({ type: "user_secret_ref", key: "k" })).toBe(true);
    expect(isSecretEnvBinding({ type: "plain", value: "x" })).toBe(false);
    expect(isSecretEnvBinding("plain-string")).toBe(false);
    expect(isSecretEnvBinding(null)).toBe(false);
  });

  // 4. timeout → defer (parks via model_decision_pending, never defaults)
  it("maps an RPC timeout to a defer that parks the run", () => {
    const deferred = deferRunModelDecisionOnTimeout();
    expect(deferred.kind).toBe("defer");
    expect(deferred.retryAfterMs).toBe(RUN_MODEL_DECISION_DEFAULT_DELAY_MS);
    const next = resolveRunModelDecisionNoDecision({
      consumedAttempts: 0,
      reason: deferred.reason,
    });
    expect(next).toEqual({
      action: "retry",
      retryAfterMs: RUN_MODEL_DECISION_DEFAULT_DELAY_MS,
      reason: deferred.reason,
    });
    expect(RUN_MODEL_DECISION_RETRY_REASON).toBe("model_decision_pending");
    expect(RUN_MODEL_DECISION_RPC_TIMEOUT_MS).toBe(1500);
  });

  // 5. max attempts → surfaced, never default
  it("surfaces the issue after max attempts instead of running on the default", () => {
    const next = resolveRunModelDecisionNoDecision({
      consumedAttempts: RUN_MODEL_DECISION_DEFAULT_MAX_ATTEMPTS,
      reason: "router has not decided",
    });
    expect(next).toEqual({
      action: "surface",
      reason: "router has not decided",
    });
  });

  // 6. user wake exempt
  it("skips the hook for user-requested wakes (recorded exempt)", () => {
    const skip = evaluateRunModelDecisionSkip({
      issueId: "issue-1",
      assigneeIsHuman: false,
      issueOverrideModel: null,
      isUserRequestedWake: true,
      hasCapabilityHolder: true,
    });
    expect(skip).toEqual({ skip: true, reason: "user_wake" });
    const record = buildModelDecisionRecord({
      answer: null,
      pluginKey: null,
      latencyMs: 3,
      outcome: "exempt",
      reason: "user-requested wake",
    });
    expect(record.outcome).toBe("exempt");
    expect(record.model).toBeNull();
  });

  // 7. operator override skips the hook
  it("skips the hook when an operator override model is set", () => {
    const skip = evaluateRunModelDecisionSkip({
      issueId: "issue-1",
      assigneeIsHuman: false,
      issueOverrideModel: "operator-pinned-model",
      isUserRequestedWake: false,
      hasCapabilityHolder: true,
    });
    expect(skip).toEqual({ skip: true, reason: "operator_override" });
  });

  it("skips non-issue runs, human assignees and missing holders", () => {
    const base = {
      issueId: "issue-1",
      assigneeIsHuman: false,
      issueOverrideModel: null,
      isUserRequestedWake: false,
      hasCapabilityHolder: true,
    };
    expect(
      evaluateRunModelDecisionSkip({ ...base, issueId: null }),
    ).toEqual({ skip: true, reason: "non_issue_run" });
    expect(
      evaluateRunModelDecisionSkip({ ...base, assigneeIsHuman: true }),
    ).toEqual({ skip: true, reason: "human_assignee" });
    expect(
      evaluateRunModelDecisionSkip({ ...base, hasCapabilityHolder: false }),
    ).toEqual({ skip: true, reason: "no_capability_holder" });
    expect(evaluateRunModelDecisionSkip(base)).toEqual({
      skip: false,
      reason: null,
    });
  });

  // 8. flag off → advisory only
  it("records advisory outcome when the flag is off and runs on the default", () => {
    const record = buildAdvisoryModelDecisionRecord({
      pluginKey: "router",
      latencyMs: 0,
    });
    expect(record.outcome).toBe("advisory");
    expect(record.model).toBeNull();
    expect(record.pluginKey).toBe("router");
  });

  // 9. model change resets session
  it("starts a fresh session when the decided model differs", () => {
    expect(runModelDecisionChangesModel("new-model", "old-model")).toBe(true);
    expect(runModelDecisionChangesModel("same-model", "same-model")).toBe(false);
    expect(runModelDecisionChangesModel(null, "old-model")).toBe(false);
  });

  // 10. non-issue run skips the hook
  it("skips the hook for runs without an issue", () => {
    const skip = evaluateRunModelDecisionSkip({
      issueId: null,
      assigneeIsHuman: false,
      issueOverrideModel: null,
      isUserRequestedWake: false,
      hasCapabilityHolder: true,
    });
    expect(skip.skip).toBe(true);
    expect(skip.reason).toBe("non_issue_run");
  });

  it("accepts keep answers and leaves the base config untouched", () => {
    const validated = validateRunModelDecisionAnswer(
      { kind: "keep" },
      { allowlistedEnvKeys: ALLOWLIST, baseEnv: {} },
    );
    expect(validated.valid).toBe(true);
    if (!validated.valid) throw new Error("expected valid");
    const base = { model: "base-model", env: { A: "1" } };
    expect(applyRunModelDecisionToAdapterConfig(base, validated.answer)).toBe(
      base,
    );
    const record = buildModelDecisionRecord({
      answer: validated.answer,
      pluginKey: "router",
      latencyMs: 7,
      outcome: "kept",
    });
    expect(record).toMatchObject({
      outcome: "kept",
      decisionId: null,
      model: null,
      latencyMs: 7,
    });
  });

  it("rejects malformed answers as defer-equivalent (never default)", () => {
    for (const raw of [
      null,
      "decide",
      { kind: "nope" },
      { kind: "decide", decisionId: "", model: "m", source: "r" },
      { kind: "decide", decisionId: "d", model: "", source: "r" },
      { kind: "decide", decisionId: "d", model: "m", env: "nope", source: "r" },
      {
        kind: "decide",
        decisionId: "d",
        model: "x".repeat(201),
        source: "r",
      },
    ]) {
      const validated = validateRunModelDecisionAnswer(raw, {
        allowlistedEnvKeys: ALLOWLIST,
        baseEnv: {},
      });
      expect(validated.valid).toBe(false);
    }
  });

  it("weakening validation to accept any env key fails the allowlist (mutation guard)", () => {
    // The old shape: decision env spread onto base env without checks.
    const raw = {
      kind: "decide",
      decisionId: "d",
      model: "m",
      env: { NOT_ALLOWLISTED: "x" },
      source: "r",
    } as const;
    const unguarded = {
      ...(raw.env as Record<string, string>),
    };
    expect(unguarded.NOT_ALLOWLISTED).toBe("x");
    // The validator must not share that behaviour.
    const validated = validateRunModelDecisionAnswer(raw, {
      allowlistedEnvKeys: ALLOWLIST,
      baseEnv: {},
    });
    expect(validated.valid).toBe(false);
  });

  it("uses the run.model.resolve capability key", () => {
    expect(RUN_MODEL_DECISION_CAPABILITY).toBe("run.model.resolve");
  });
});
