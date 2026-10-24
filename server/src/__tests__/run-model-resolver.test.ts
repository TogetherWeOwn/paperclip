import { describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { ResolveRunModelParams } from "@paperclipai/plugin-sdk";
import { buildCodexExecArgs } from "../../../packages/adapters/codex-local/src/server/codex-args.js";
import {
  applyRunModelDecision,
  resolveRunModelDecision,
  RunModelDecisionDeferral,
} from "../services/run-model-resolver.js";

const manifest = {
  id: "fixture.model-router", apiVersion: 1, version: "1.0.0",
  displayName: "Model router", description: "Run-local model selection", author: "Tests",
  categories: ["connector"], capabilities: ["run.model.resolve"],
  modelRouting: { envKeys: ["MODEL_CONTEXT_LIMIT"] },
  entrypoints: { worker: "worker.mjs" },
} satisfies PaperclipPluginManifestV1;
const params: Omit<ResolveRunModelParams, "deadlineMs"> = {
  runId: "run", companyId: "company", agentId: "agent", issueId: "issue",
  adapterType: "claude_local", invocationSource: "assignment", wakeReason: null,
  agentDefaultModel: "default", previous: null, issueOverrideModel: null,
};
const holder = { id: "plugin", status: "ready", manifestJson: manifest };
function fixture(answer: unknown = { kind: "keep" }) {
  const call = vi.fn(async () => answer);
  const worker = { isRunning: () => true, call };
  return { params, holders: [holder], worker, baseEnv: {}, call };
}

describe("run.model.resolve manifest contract", () => {
  it("accepts the capability and preserves the declared env allowlist", () => {
    expect(pluginManifestV1Schema.parse(manifest).modelRouting).toEqual(manifest.modelRouting);
  });
  it("rejects an env declaration without the capability", () => {
    expect(pluginManifestV1Schema.safeParse({ ...manifest, capabilities: ["events.subscribe"] }).success).toBe(false);
  });
  it.each(["bad-name", "", "1INVALID"])("rejects invalid env key %j", key => {
    expect(pluginManifestV1Schema.safeParse({ ...manifest, modelRouting: { envKeys: [key] } }).success).toBe(false);
  });
});

describe("bounded, run-local model resolution", () => {
  it("keeps existing behavior without an installed holder", async () => {
    const input = fixture(); input.holders = [];
    expect((await resolveRunModelDecision(input)).answer).toEqual({ kind: "keep" });
    expect(input.call).not.toHaveBeenCalled();
  });
  it("honors keep and supplies the compatibility request and 1500ms deadline", async () => {
    const input = fixture(); const result = await resolveRunModelDecision(input);
    expect(result.answer).toEqual({ kind: "keep" });
    expect(result.record.outcome).toBe("kept");
    expect(input.call).toHaveBeenCalledWith("plugin", "resolveRunModel", expect.objectContaining({ ...params, deadlineMs: 1500 }), 1500);
  });
  it("validates a decision and only applies it to a new run config", async () => {
    const input = fixture({ kind: "decide", decisionId: "d1", model: "chosen", effort: "high", env: { MODEL_CONTEXT_LIMIT: "32000" }, source: "fixture" });
    const result = await resolveRunModelDecision(input);
    const base = { model: "default", env: { PRESERVE: "value" }, cwd: "/workspace" };
    expect(applyRunModelDecision(base, result.answer)).toEqual({ ...base, model: "chosen", effort: "high", modelReasoningEffort: "high", reasoningEffort: "high", env: { PRESERVE: "value", MODEL_CONTEXT_LIMIT: "32000" } });
    expect(base).toEqual({ model: "default", env: { PRESERVE: "value" }, cwd: "/workspace" });
    expect(result.record).toMatchObject({ outcome: "decided", model: "chosen", decisionId: "d1", pluginKey: manifest.id });
    expect(JSON.stringify(result.record)).not.toContain("32000");
  });
  it("replaces higher-priority native effort aliases only on the ephemeral config", () => {
    const base = { model: "default", modelReasoningEffort: "low", reasoningEffort: "medium" };
    expect(applyRunModelDecision(base, { kind: "decide", decisionId: "d", model: "chosen", effort: "high", source: "fixture" }))
      .toMatchObject({ model: "chosen", effort: "high", modelReasoningEffort: "high", reasoningEffort: "high" });
    expect(base).toEqual({ model: "default", modelReasoningEffort: "low", reasoningEffort: "medium" });
  });
  it("forwards decided effort to Codex even when no effort alias was configured", () => {
    const base = { model: "default" };
    const config = applyRunModelDecision(base, { kind: "decide", decisionId: "d", model: "gpt-6.1-sol", effort: "high", source: "fixture" });
    expect(buildCodexExecArgs(config).args).toContain('model_reasoning_effort="high"');
    expect(config.reasoningEffort).toBe("high");
    expect(base).toEqual({ model: "default" });
  });
  it("preserves explicit model pins without calling a plugin", async () => {
    const input = fixture(); input.params = { ...params, issueOverrideModel: "pinned" };
    expect((await resolveRunModelDecision(input)).record).toMatchObject({ outcome: "skipped", reason: "issue_model_override" });
    expect(input.call).not.toHaveBeenCalled();
  });
  it("ignores deliberately disabled and uninstalled holders", async () => {
    const input = fixture(); input.holders = [{ ...holder, status: "disabled" }, { ...holder, status: "uninstalled" }];
    expect((await resolveRunModelDecision(input)).answer.kind).toBe("keep");
  });
  it("does not silently fall open for a holder in error", async () => {
    const input = fixture(); input.holders = [{ ...holder, status: "error" }];
    await expect(resolveRunModelDecision(input)).rejects.toBeInstanceOf(RunModelDecisionDeferral);
    expect(input.call).not.toHaveBeenCalled();
  });
  it("defers rather than arbitrarily choosing among multiple holders", async () => {
    const input = fixture(); input.holders.push({ ...holder, id: "second" });
    await expect(resolveRunModelDecision(input)).rejects.toMatchObject({ reason: "multiple_model_resolvers" });
    expect(input.call).not.toHaveBeenCalled();
  });
  it("fails closed when the manager is unavailable or the worker is not running", async () => {
    await expect(resolveRunModelDecision({ ...fixture(), worker: undefined })).rejects.toBeInstanceOf(RunModelDecisionDeferral);
    const input = fixture(); input.worker.isRunning = () => false;
    await expect(resolveRunModelDecision(input)).rejects.toBeInstanceOf(RunModelDecisionDeferral);
  });
  it("turns RPC errors into bounded deferrals without leaking the error", async () => {
    const input = fixture(); input.call.mockRejectedValueOnce(new Error("sensitive diagnostic"));
    await expect(resolveRunModelDecision(input)).rejects.toMatchObject({ reason: "model_resolver_unavailable", retryAfterMs: 5000 });
  });
  it("honors a defer answer with a bounded delay", async () => {
    await expect(resolveRunModelDecision(fixture({ kind: "defer", retryAfterMs: 999999, reason: "pool_empty" }))).rejects.toMatchObject({ reason: "pool_empty", retryAfterMs: 60000 });
    await expect(resolveRunModelDecision(fixture({ kind: "defer", retryAfterMs: -1, reason: "pool_empty" }))).rejects.toMatchObject({ retryAfterMs: 5000 });
  });
  it.each([
    null, {}, { kind: "other" },
    { kind: "decide", decisionId: "d", model: "" },
    { kind: "decide", decisionId: "d", model: "m".repeat(201) },
    { kind: "decide", model: "chosen" },
    { kind: "decide", decisionId: "d", model: "chosen", env: { UNDECLARED: "value" } },
    { kind: "decide", decisionId: "d", model: "chosen", env: { MODEL_CONTEXT_LIMIT: 32 } },
    { kind: "decide", decisionId: "d", model: "chosen", env: [] },
  ])("fails closed on malformed or out-of-allowlist answer %j", async answer => {
    await expect(resolveRunModelDecision(fixture(answer))).rejects.toMatchObject({ reason: "invalid_model_decision" });
  });
  it("never overwrites a secret reference even when the env key is declared", async () => {
    const input = fixture({ kind: "decide", decisionId: "d", model: "chosen", env: { MODEL_CONTEXT_LIMIT: "value" } });
    await expect(resolveRunModelDecision({ ...input, baseEnv: { MODEL_CONTEXT_LIMIT: { type: "secret_ref", secretId: "secret" } } })).rejects.toMatchObject({ reason: "invalid_model_decision" });
  });
  it("revalidates secret references after issue overrides have been merged", async () => {
    expect(() => applyRunModelDecision({ env: { MODEL_CONTEXT_LIMIT: { type: "secret_ref", secretId: "secret" } } }, { kind: "decide", decisionId: "d", model: "chosen", env: { MODEL_CONTEXT_LIMIT: "value" }, source: "fixture" })).toThrow("secret");
  });
});
