import { and, desc, eq, ne, sql } from "drizzle-orm";
import { heartbeatRuns, pluginCompanySettings, plugins, type Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { ResolveRunModelParams, ResolveRunModelResult } from "@paperclipai/plugin-sdk";

export const RUN_MODEL_RESOLVE_TIMEOUT_MS = 1500;
export const RUN_MODEL_RESOLVE_RETRY_REASON = "model_decision_pending";
export const RUN_MODEL_RESOLVE_MAX_ATTEMPTS = 12;
type Decision = Exclude<ResolveRunModelResult, { kind: "defer" }>;
type Holder = { id: string; status: string; manifestJson: PaperclipPluginManifestV1 };
type Worker = {
  isRunning(pluginId: string): boolean;
  call(pluginId: string, method: "resolveRunModel", params: ResolveRunModelParams, timeoutMs: number): Promise<unknown>;
};
export interface RunModelDecisionRecord {
  outcome: "decided" | "kept" | "skipped" | "deferred";
  pluginKey: string | null;
  decisionId: string | null;
  model: string | null;
  reason?: string;
}
export interface RunModelResolution { answer: Decision; record: RunModelDecisionRecord }
export class RunModelDecisionDeferral extends Error {
  readonly record: RunModelDecisionRecord;
  constructor(readonly reason: string, readonly retryAfterMs = 5000, pluginKey: string | null = null) {
    super(`Run model resolution deferred: ${reason}`);
    this.record = { outcome: "deferred", pluginKey, decisionId: null, model: null, reason };
  }
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit = 200): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;
function assertNoSecretOverwrite(env: Record<string, unknown>, baseEnv: Record<string, unknown>) {
  for (const key of Object.keys(env)) {
    const binding = baseEnv[key];
    if (isRecord(binding) && binding.type === "secret_ref") throw new Error("Cannot replace a secret reference");
  }
}

/** Apply only to the ephemeral run config, before normal secret/env resolution. */
export function applyRunModelDecision(base: Record<string, unknown>, answer: Decision): Record<string, unknown> {
  if (answer.kind === "keep") return base;
  const baseEnv = isRecord(base.env) ? base.env : {};
  assertNoSecretOverwrite(answer.env ?? {}, baseEnv);
  // Legacy adapters do not share one spelling: Codex reads modelReasoningEffort,
  // Grok reads reasoningEffort, and Claude/Kimi read effort. Normalize the
  // decided value on this run-only object even if no alias existed in the base.
  const effort = answer.effort ? {
    effort: answer.effort,
    modelReasoningEffort: answer.effort,
    reasoningEffort: answer.effort,
  } : {};
  return { ...base, model: answer.model, ...effort,
    env: { ...baseEnv, ...answer.env } };
}

/** A manifest is the explicit opt-in. A broken installed holder must not fail open. */
export async function resolveRunModelDecision(input: {
  params: Omit<ResolveRunModelParams, "deadlineMs">;
  holders: Holder[];
  worker?: Worker;
  baseEnv: Record<string, unknown>;
  skipReason?: string;
}): Promise<RunModelResolution> {
  const keep = (reason?: string, pluginKey: string | null = null) => ({
    answer: { kind: "keep" } as const,
    record: { outcome: reason ? "skipped" as const : "kept" as const,
      pluginKey, decisionId: null, model: null, ...(reason ? { reason } : {}) },
  });
  if (input.skipReason) return keep(input.skipReason);
  if (input.params.issueOverrideModel) return keep("issue_model_override");
  const holders = input.holders.filter(holder =>
    !["disabled", "uninstalled"].includes(holder.status) && holder.manifestJson.capabilities.includes("run.model.resolve"));
  if (!holders.length) return keep("no_model_resolver");
  if (holders.length !== 1) throw new RunModelDecisionDeferral("multiple_model_resolvers");
  const holder = holders[0]!;
  const defer = (reason: string, delay?: number): never => {
    throw new RunModelDecisionDeferral(reason, delay, holder.manifestJson.id);
  };
  if (holder.status !== "ready" || !input.worker?.isRunning(holder.id)) defer("model_resolver_unavailable");
  let answer: unknown;
  try {
    answer = await input.worker!.call(holder.id, "resolveRunModel", {
      ...input.params, deadlineMs: RUN_MODEL_RESOLVE_TIMEOUT_MS,
    }, RUN_MODEL_RESOLVE_TIMEOUT_MS);
  } catch {
    return defer("model_resolver_unavailable");
  }
  if (!isRecord(answer)) return defer("invalid_model_decision");
  if (answer.kind === "keep") return keep(undefined, holder.manifestJson.id);
  if (answer.kind === "defer") {
    const delay = typeof answer.retryAfterMs === "number" && Number.isFinite(answer.retryAfterMs) && answer.retryAfterMs >= 0
      ? Math.max(1000, Math.min(60000, answer.retryAfterMs)) : 5000;
    return defer(text(answer.reason, 500) ? answer.reason : "model_resolver_deferred", delay);
  }
  if (answer.kind !== "decide" || !text(answer.decisionId) || !text(answer.model)) return defer("invalid_model_decision");
  const env = answer.env === undefined ? {} : answer.env;
  if (!isRecord(env)) return defer("invalid_model_decision");
  const allowed = new Set(holder.manifestJson.modelRouting?.envKeys ?? []);
  if (Object.entries(env).some(([key, value]) => !allowed.has(key) || typeof value !== "string")) return defer("invalid_model_decision");
  try { assertNoSecretOverwrite(env, input.baseEnv); } catch { return defer("invalid_model_decision"); }
  const decision: Decision = {
    kind: "decide", decisionId: answer.decisionId, model: answer.model,
    source: text(answer.source) ? answer.source : "unknown",
    ...(text(answer.effort) ? { effort: answer.effort } : {}),
    ...(Object.keys(env).length ? { env: env as Record<string, string> } : {}),
    ...(text(answer.tier) ? { tier: answer.tier } : {}),
    ...(typeof answer.fallback === "boolean" ? { fallback: answer.fallback } : {}),
    ...(text(answer.reason, 500) ? { reason: answer.reason } : {}),
  };
  return { answer: decision, record: { outcome: "decided", pluginKey: holder.manifestJson.id,
    decisionId: decision.decisionId, model: decision.model } };
}

/** Company opt-outs apply before holder selection; previous decisions never cross company/issue boundaries. */
export function runModelResolverService(db: Db, worker?: Worker) {
  return async (input: {
    params: Omit<ResolveRunModelParams, "deadlineMs" | "previous">;
    baseEnv: Record<string, unknown>;
    skipReason?: string;
  }): Promise<RunModelResolution> => {
    const params: Omit<ResolveRunModelParams, "deadlineMs"> = { ...input.params, previous: null };
    const skipReason = input.skipReason ?? (!params.issueId ? "non_issue_run" : undefined);
    if (skipReason || params.issueOverrideModel) {
      return resolveRunModelDecision({ ...input, params, holders: [], skipReason });
    }
    let holders: Holder[];
    try {
      const [installed, optedOut] = await Promise.all([
        db.select({ id: plugins.id, status: plugins.status, manifestJson: plugins.manifestJson }).from(plugins),
        db.select({ pluginId: pluginCompanySettings.pluginId }).from(pluginCompanySettings).where(and(
          eq(pluginCompanySettings.companyId, params.companyId), eq(pluginCompanySettings.enabled, false),
        )),
      ]);
      const excluded = new Set(optedOut.map(row => row.pluginId));
      holders = installed.filter(row => !excluded.has(row.id));
      if (holders.some(row => !["disabled", "uninstalled"].includes(row.status) && row.manifestJson.capabilities.includes("run.model.resolve"))) {
        const [previous] = await db.select({ runId: heartbeatRuns.id, context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, params.companyId), eq(heartbeatRuns.agentId, params.agentId), ne(heartbeatRuns.id, params.runId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${params.issueId}`,
          sql`${heartbeatRuns.contextSnapshot} -> 'modelDecision' ->> 'outcome' = 'decided'`,
        )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
        const decision = previous?.context?.modelDecision;
        if (previous && isRecord(decision)) params.previous = {
          runId: previous.runId, model: text(decision.model) ? decision.model : null,
          decisionId: text(decision.decisionId) ? decision.decisionId : null,
        };
      }
    } catch {
      throw new RunModelDecisionDeferral("model_resolver_lookup_unavailable");
    }
    return resolveRunModelDecision({ ...input, params, holders, worker });
  };
}
