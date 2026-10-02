import { describe, expect, it, vi } from "vitest";
import {
  RUN_MODEL_DECISION_CAPABILITY,
  RUN_MODEL_DECISION_DEFAULT_DELAY_MS,
  RUN_MODEL_DECISION_DEFAULT_MAX_ATTEMPTS,
  RUN_MODEL_DECISION_RETRY_REASON,
  RUN_MODEL_DECISION_RPC_TIMEOUT_MS,
  RunModelDecisionDeferral,
  applyRunModelDecisionToAdapterConfig,
  evaluateRunModelDecisionSkip,
  isRunModelDecisionDeferral,
  isSecretEnvBinding,
  readPreviousRunModelDecision,
  resolveRunModelDecision,
  resolveRunModelDecisionNoDecision,
  runModelDecisionChangesModel,
  selectRunModelDecisionHolder,
  validateRunModelDecisionAnswer,
  type ResolveRunModelDecisionInput,
  type RunModelDecisionHolderSelection,
} from "../services/run-model-decision.ts";
import { shouldResetTaskSessionForModelChange } from "../services/heartbeat.ts";

const ALLOWLIST = ["PAPERCLIP_ASSIGNED_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"];

const HOLDER: RunModelDecisionHolderSelection = {
  kind: "single",
  holder: { pluginId: "plugin-1", pluginKey: "model-router", envKeys: ALLOWLIST },
};

function decide(overrides: Record<string, unknown> = {}) {
  return {
    kind: "decide",
    decisionId: "dec-1",
    model: "claude-opus-5-5",
    source: "router",
    ...overrides,
  };
}

/** A clock that advances 7 ms per read, so latency is deterministic. */
function steppingClock() {
  let t = 1_000;
  return () => {
    t += 7;
    return t;
  };
}

function input(
  overrides: Partial<ResolveRunModelDecisionInput> = {},
): ResolveRunModelDecisionInput {
  return {
    requireDecision: true,
    skip: { issueId: "issue-1", assigneeIsHuman: false, issueOverrideModel: null },
    isUserRequestedWake: false,
    holder: HOLDER,
    params: {
      runId: "run-1",
      companyId: "co-1",
      agentId: "agent-1",
      issueId: "issue-1",
      adapterType: "claude_local",
      invocationSource: "assignment",
      wakeReason: "issue_assigned",
      agentDefaultModel: "agent-default-model",
      previous: null,
      issueOverrideModel: null,
    },
    baseEnv: {},
    call: async () => decide(),
    now: steppingClock(),
    ...overrides,
  };
}

describe("run model decision hook (TOG-11792, design §9.2)", () => {
  // 1. decision applied
  it("applies a decide answer to the run config and records it", async () => {
    const call = vi.fn(async () =>
      decide({
        effort: "xhigh",
        tier: "frontier",
        env: { PAPERCLIP_ASSIGNED_MODEL: "claude-opus-5-5" },
      }),
    );
    const resolution = await resolveRunModelDecision(input({ call }));

    expect(call).toHaveBeenCalledWith(
      "plugin-1",
      expect.objectContaining({ runId: "run-1", deadlineMs: RUN_MODEL_DECISION_RPC_TIMEOUT_MS }),
      RUN_MODEL_DECISION_RPC_TIMEOUT_MS,
    );
    expect(resolution.action).toBe("proceed");
    if (resolution.action !== "proceed" || !resolution.answer) throw new Error("expected answer");
    expect(resolution.record).toEqual({
      decisionId: "dec-1",
      pluginKey: "model-router",
      model: "claude-opus-5-5",
      effort: "xhigh",
      tier: "frontier",
      source: "router",
      latencyMs: 7,
      outcome: "decided",
    });

    const merged = applyRunModelDecisionToAdapterConfig(
      { model: "agent-default-model", env: { KEEP: "1", PAPERCLIP_ASSIGNED_MODEL: "old" } },
      resolution.answer,
    );
    expect(merged).toEqual({
      model: "claude-opus-5-5",
      effort: "xhigh",
      env: { KEEP: "1", PAPERCLIP_ASSIGNED_MODEL: "claude-opus-5-5" },
    });
  });

  // 2. env allowlist enforced
  it("parks the run when decision env names a key outside the manifest allowlist", async () => {
    const resolution = await resolveRunModelDecision(
      input({ call: async () => decide({ env: { OPENAI_API_KEY: "x" } }) }),
    );
    expect(resolution).toMatchObject({
      action: "park",
      reason: "invalid answer: env_key_not_allowlisted",
      record: { outcome: "deferred", model: null, decisionId: null },
    });
  });

  it("rejects non-string decision env values", () => {
    const validated = validateRunModelDecisionAnswer(
      decide({ env: { PAPERCLIP_ASSIGNED_MODEL: { type: "plain", value: "m" } } }),
      { allowlistedEnvKeys: ALLOWLIST, baseEnv: {} },
    );
    expect(validated).toMatchObject({ valid: false, error: "env_value_not_plain_string" });
  });

  // 3. secret_ref key rejected
  it("parks the run when an allowlisted env key is a secret binding in the base config", async () => {
    for (const binding of [
      { type: "secret_ref", secretId: "sec-1" },
      { type: "user_secret_ref", key: "anthropic" },
    ]) {
      const resolution = await resolveRunModelDecision(
        input({
          baseEnv: { PAPERCLIP_ASSIGNED_MODEL: binding },
          call: async () => decide({ env: { PAPERCLIP_ASSIGNED_MODEL: "plain" } }),
        }),
      );
      expect(resolution).toMatchObject({
        action: "park",
        reason: "invalid answer: env_key_is_secret_ref",
      });
    }
    expect(isSecretEnvBinding({ type: "plain", value: "x" })).toBe(false);
    expect(isSecretEnvBinding("plain-string")).toBe(false);
  });

  // 4. timeout → defer
  it("parks the run when the RPC times out instead of running on the default", async () => {
    const resolution = await resolveRunModelDecision(
      input({
        call: async () => {
          throw new Error("Worker call resolveRunModel timed out after 1500ms");
        },
      }),
    );
    expect(resolution).toEqual({
      action: "park",
      retryAfterMs: RUN_MODEL_DECISION_DEFAULT_DELAY_MS,
      reason: "Worker call resolveRunModel timed out after 1500ms",
      record: expect.objectContaining({
        outcome: "timeout",
        model: null,
        pluginKey: "model-router",
      }),
    });
    expect(
      resolveRunModelDecisionNoDecision({ consumedAttempts: 0, reason: "timed out" }),
    ).toEqual({ action: "retry", retryAfterMs: RUN_MODEL_DECISION_DEFAULT_DELAY_MS, reason: "timed out" });
  });

  it("honours the router's retryAfterMs on an explicit defer", async () => {
    const resolution = await resolveRunModelDecision(
      input({ call: async () => ({ kind: "defer", retryAfterMs: 30_000, reason: "pacer closed" }) }),
    );
    expect(resolution).toMatchObject({
      action: "park",
      retryAfterMs: 30_000,
      reason: "pacer closed",
      record: { outcome: "deferred", reason: "pacer closed" },
    });
  });

  it("parks the run when more than one plugin holds run.model.resolve", async () => {
    const call = vi.fn();
    const resolution = await resolveRunModelDecision(
      input({ holder: { kind: "conflict", pluginKeys: ["a", "b"] }, call }),
    );
    expect(call).not.toHaveBeenCalled();
    expect(resolution).toMatchObject({
      action: "park",
      reason: "multiple run.model.resolve holders: a, b",
      record: { outcome: "deferred", pluginKey: null },
    });
  });

  // 5. max attempts → surfaced, never default
  it("surfaces the issue once attempts are exhausted; it never returns the default", () => {
    expect(
      resolveRunModelDecisionNoDecision({
        consumedAttempts: RUN_MODEL_DECISION_DEFAULT_MAX_ATTEMPTS - 1,
        reason: "pacer closed",
      }),
    ).toMatchObject({ action: "retry" });
    expect(
      resolveRunModelDecisionNoDecision({
        consumedAttempts: RUN_MODEL_DECISION_DEFAULT_MAX_ATTEMPTS,
        reason: "pacer closed",
      }),
    ).toEqual({ action: "surface", reason: "pacer closed" });
    expect(RUN_MODEL_DECISION_RETRY_REASON).toBe("model_decision_pending");
  });

  // 6. user wake exempt
  it("lets a user-requested wake run on the default when no decision comes, recorded exempt", async () => {
    const resolution = await resolveRunModelDecision(
      input({
        isUserRequestedWake: true,
        call: async () => ({ kind: "defer", retryAfterMs: 5_000, reason: "pacer closed" }),
      }),
    );
    expect(resolution).toMatchObject({
      action: "proceed",
      answer: null,
      record: { outcome: "exempt", reason: "pacer closed", model: null },
    });
  });

  it("still applies a decision on a user-requested wake", async () => {
    const resolution = await resolveRunModelDecision(input({ isUserRequestedWake: true }));
    expect(resolution).toMatchObject({ action: "proceed", record: { outcome: "decided" } });
  });

  // 7. operator override skips
  it("skips the hook when the issue carries an override model", async () => {
    const call = vi.fn();
    const resolution = await resolveRunModelDecision(
      input({
        skip: { issueId: "issue-1", assigneeIsHuman: false, issueOverrideModel: "operator-pin" },
        call,
      }),
    );
    expect(call).not.toHaveBeenCalled();
    expect(resolution).toEqual({
      action: "proceed",
      answer: null,
      record: expect.objectContaining({
        outcome: "skipped",
        reason: "operator_override",
        pluginKey: null,
        latencyMs: 0,
      }),
    });
  });

  // 8. flag off → advisory only
  it("asks the holder but never applies its answer when the flag is off", async () => {
    const resolution = await resolveRunModelDecision(
      input({ requireDecision: false, call: async () => decide({ tier: "frontier" }) }),
    );
    expect(resolution).toEqual({
      action: "proceed",
      answer: null,
      record: {
        decisionId: null,
        pluginKey: "model-router",
        model: null,
        source: null,
        latencyMs: 7,
        outcome: "timeout",
        reason: "requireRunModelDecision disabled",
        advisory: {
          outcome: "decided",
          decisionId: "dec-1",
          model: "claude-opus-5-5",
          tier: "frontier",
          source: "router",
        },
      },
    });
  });

  it("never parks when the flag is off, even if the holder fails", async () => {
    const resolution = await resolveRunModelDecision(
      input({
        requireDecision: false,
        call: async () => {
          throw new Error("worker not running");
        },
      }),
    );
    expect(resolution).toMatchObject({
      action: "proceed",
      answer: null,
      record: {
        outcome: "timeout",
        advisory: { outcome: "timeout", reason: "worker not running" },
      },
    });
  });

  // 9. model change resets session
  it("resets the task session when the decided model differs from the session's model", async () => {
    const resolution = await resolveRunModelDecision(input());
    if (resolution.action !== "proceed" || !resolution.answer) throw new Error("expected answer");
    const runConfig = applyRunModelDecisionToAdapterConfig(
      { model: "agent-default-model" },
      resolution.answer,
    );
    const sessionParams = { __paperclipConfiguredModel: "agent-default-model" };
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: runConfig.model as string,
        taskSessionParams: sessionParams,
      }),
    ).toBe(true);
    expect(runModelDecisionChangesModel("claude-opus-5-5", "agent-default-model")).toBe(true);

    const keep = applyRunModelDecisionToAdapterConfig({ model: "agent-default-model" }, { kind: "keep" });
    expect(
      shouldResetTaskSessionForModelChange({
        configuredModel: keep.model as string,
        taskSessionParams: sessionParams,
      }),
    ).toBe(false);
  });

  // 10. non-issue run skips
  it("skips non-issue runs, human assignees and companies without a holder", async () => {
    const call = vi.fn();
    const skipped = async (overrides: Partial<ResolveRunModelDecisionInput>) =>
      (await resolveRunModelDecision(input({ call, ...overrides }))).record.reason;

    expect(
      await skipped({ skip: { issueId: null, assigneeIsHuman: false, issueOverrideModel: null } }),
    ).toBe("non_issue_run");
    expect(
      await skipped({ skip: { issueId: "issue-1", assigneeIsHuman: true, issueOverrideModel: null } }),
    ).toBe("human_assignee");
    expect(await skipped({ holder: { kind: "none" } })).toBe("no_capability_holder");
    expect(call).not.toHaveBeenCalled();
    expect(
      evaluateRunModelDecisionSkip({
        issueId: "issue-1",
        assigneeIsHuman: false,
        issueOverrideModel: null,
        hasCapabilityHolder: true,
      }),
    ).toEqual({ skip: false, reason: null });
  });
});

describe("run model decision helpers", () => {
  it("rejects malformed answers so the run parks", () => {
    for (const raw of [
      null,
      "decide",
      { kind: "nope" },
      decide({ decisionId: "" }),
      decide({ model: "" }),
      decide({ model: "x".repeat(201) }),
      decide({ env: "nope" }),
    ]) {
      expect(
        validateRunModelDecisionAnswer(raw, { allowlistedEnvKeys: ALLOWLIST, baseEnv: {} }).valid,
      ).toBe(false);
    }
  });

  it("selects exactly one run.model.resolve holder and its env allowlist", () => {
    const router = {
      id: "p-router",
      pluginKey: "model-router",
      manifestJson: {
        capabilities: [RUN_MODEL_DECISION_CAPABILITY, "events.subscribe"],
        modelRouting: { envKeys: ["PAPERCLIP_ASSIGNED_MODEL"] },
      },
    };
    const other = { id: "p-other", pluginKey: "other", manifestJson: { capabilities: ["events.subscribe"] } };

    expect(selectRunModelDecisionHolder([])).toEqual({ kind: "none" });
    expect(selectRunModelDecisionHolder([other, { id: "x", pluginKey: "x", manifestJson: null }])).toEqual({
      kind: "none",
    });
    expect(selectRunModelDecisionHolder([other, router])).toEqual({
      kind: "single",
      holder: { pluginId: "p-router", pluginKey: "model-router", envKeys: ["PAPERCLIP_ASSIGNED_MODEL"] },
    });
    expect(
      selectRunModelDecisionHolder([
        { ...router, id: "p-z", pluginKey: "z-router" },
        router,
      ]),
    ).toEqual({ kind: "conflict", pluginKeys: ["model-router", "z-router"] });
  });

  it("reads the previous run's recorded decision", () => {
    expect(readPreviousRunModelDecision(null)).toBeNull();
    expect(
      readPreviousRunModelDecision({
        id: "run-0",
        contextSnapshot: { modelDecision: { model: "m", decisionId: "d", outcome: "decided" } },
      }),
    ).toEqual({ runId: "run-0", model: "m", decisionId: "d" });
    expect(readPreviousRunModelDecision({ id: "run-0", contextSnapshot: null })).toEqual({
      runId: "run-0",
      model: null,
      decisionId: null,
    });
  });

  it("carries the park details on a typed deferral error", () => {
    const record = {
      decisionId: null,
      pluginKey: "model-router",
      model: null,
      source: null,
      latencyMs: 3,
      outcome: "deferred" as const,
      reason: "pacer closed",
    };
    const deferral = new RunModelDecisionDeferral({ retryAfterMs: 30_000, reason: "pacer closed", record });
    expect(isRunModelDecisionDeferral(deferral)).toBe(true);
    expect(isRunModelDecisionDeferral(new Error("x"))).toBe(false);
    expect(deferral).toMatchObject({ code: "model_decision_pending", retryAfterMs: 30_000, record });
  });
});
