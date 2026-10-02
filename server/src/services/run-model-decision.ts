/**
 * Run-scoped model decision hook — pure decision logic (TOG-11792).
 *
 * Parent: TOG-11780. Contract: TOG-11780 document `design`, §4.1/§4.2.
 * The host calls the `run.model.resolve` capability holder inside
 * `executeRun` (after the override parse, before the adapter config merge)
 * and feeds the validated answer through these helpers. All I/O (worker RPC,
 * retry scheduling, run-row writes) stays at the heartbeat.ts call site; this
 * module is pure so the §9.2 cases run as unit tests.
 */

import type {
  ResolveRunModelParams,
  ResolveRunModelResult,
} from "@paperclipai/plugin-sdk";

/** Deadline for the host→worker `resolveRunModel` RPC call. */
export const RUN_MODEL_DECISION_RPC_TIMEOUT_MS = 1500;

/** `scheduleBoundedRetryForRun` reason used when no decision is available. */
export const RUN_MODEL_DECISION_RETRY_REASON = "model_decision_pending";

/** Capability key: exactly one holder per company may resolve run models. */
export const RUN_MODEL_DECISION_CAPABILITY = "run.model.resolve";

/** Default bounded-retry budget for a pending model decision. */
export const RUN_MODEL_DECISION_DEFAULT_MAX_ATTEMPTS = 12;

/** Default delay before the first `model_decision_pending` retry. */
export const RUN_MODEL_DECISION_DEFAULT_DELAY_MS = 5_000;

/** Max accepted length for a decided model id. */
export const RUN_MODEL_DECISION_MAX_MODEL_LENGTH = 200;

/** Input passed to the `onResolveRunModel` plugin hook (design §4.1). */
export type RunModelDecisionInput = ResolveRunModelParams;
export type RunModelDecisionPrevious = NonNullable<ResolveRunModelParams["previous"]>;
export type RunModelDecisionAnswer = ResolveRunModelResult;
export type RunModelDecideAnswer = Extract<ResolveRunModelResult, { kind: "decide" }>;
export type RunModelKeepAnswer = Extract<ResolveRunModelResult, { kind: "keep" }>;
export type RunModelDeferAnswer = Extract<ResolveRunModelResult, { kind: "defer" }>;

// ---------------------------------------------------------------------------
// Skip rules (design §4.2 "Skips")
// ---------------------------------------------------------------------------

export type RunModelDecisionSkipReason =
  | "non_issue_run"
  | "human_assignee"
  | "operator_override"
  | "no_capability_holder";

export interface RunModelDecisionSkipInput {
  issueId: string | null;
  /** True when the issue assignee is a human, not an agent. */
  assigneeIsHuman: boolean;
  /**
   * Issue-level override model, if any. The host cannot tell an operator pin
   * from a legacy plugin pin, so any override wins and the hook is skipped;
   * the plugin retires its own pins once the flag is on (design §4.3).
   */
  issueOverrideModel: string | null;
  /** True when a `run.model.resolve` capability holder is installed. */
  hasCapabilityHolder: boolean;
}

export type RunModelDecisionSkip =
  | { skip: true; reason: RunModelDecisionSkipReason }
  | { skip: false; reason: null };

export function evaluateRunModelDecisionSkip(
  input: RunModelDecisionSkipInput,
): RunModelDecisionSkip {
  if (!input.issueId) return { skip: true, reason: "non_issue_run" };
  if (input.assigneeIsHuman) return { skip: true, reason: "human_assignee" };
  if (input.issueOverrideModel) return { skip: true, reason: "operator_override" };
  if (!input.hasCapabilityHolder) return { skip: true, reason: "no_capability_holder" };
  return { skip: false, reason: null };
}

// ---------------------------------------------------------------------------
// Answer validation (design §4.2 "Validation")
// ---------------------------------------------------------------------------

export type RunModelDecisionValidationError =
  | "not_an_object"
  | "unknown_kind"
  | "missing_decision_id"
  | "invalid_model"
  | "invalid_env"
  | "env_key_not_allowlisted"
  | "env_value_not_plain_string"
  | "env_key_is_secret_ref";

export type RunModelDecisionValidation =
  | { valid: true; answer: RunModelDecisionAnswer; error: null }
  | { valid: false; answer: null; error: RunModelDecisionValidationError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * True when a base-config env value is a secret binding. Decision env may only
 * carry plain plugin-owned keys, so a decision key landing on one of these is
 * rejected (the TOG-11791 secret-copy class of bug, applied to decisions).
 */
export function isSecretEnvBinding(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === "secret_ref" || value.type === "user_secret_ref";
}

export interface ValidateRunModelDecisionOptions {
  /** Manifest `modelRouting.envKeys` allowlist of the capability holder. */
  allowlistedEnvKeys: readonly string[];
  /** Base adapter-config `env` (pre-merge), used for the secret_ref check. */
  baseEnv: Record<string, unknown> | null | undefined;
}

export function validateRunModelDecisionAnswer(
  raw: unknown,
  options: ValidateRunModelDecisionOptions,
): RunModelDecisionValidation {
  if (!isRecord(raw)) return { valid: false, answer: null, error: "not_an_object" };
  const kind = raw.kind;
  if (kind === "keep") {
    return { valid: true, answer: { kind: "keep" }, error: null };
  }
  if (kind === "defer") {
    const retryAfterMs =
      typeof raw.retryAfterMs === "number" && Number.isFinite(raw.retryAfterMs) && raw.retryAfterMs >= 0
        ? Math.floor(raw.retryAfterMs)
        : RUN_MODEL_DECISION_DEFAULT_DELAY_MS;
    const reason = readNonEmptyString(raw.reason) ?? "deferred by router";
    return { valid: true, answer: { kind: "defer", retryAfterMs, reason }, error: null };
  }
  if (kind !== "decide") {
    return { valid: false, answer: null, error: "unknown_kind" };
  }
  const decisionId = readNonEmptyString(raw.decisionId);
  if (!decisionId) {
    return { valid: false, answer: null, error: "missing_decision_id" };
  }
  const model = readNonEmptyString(raw.model);
  if (!model || model.length > RUN_MODEL_DECISION_MAX_MODEL_LENGTH) {
    return { valid: false, answer: null, error: "invalid_model" };
  }
  const source = readNonEmptyString(raw.source) ?? "unknown";
  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) {
      return { valid: false, answer: null, error: "invalid_env" };
    }
    const allowlist = new Set(options.allowlistedEnvKeys);
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (!allowlist.has(key)) {
        return { valid: false, answer: null, error: "env_key_not_allowlisted" };
      }
      if (typeof value !== "string") {
        return { valid: false, answer: null, error: "env_value_not_plain_string" };
      }
      if (isSecretEnvBinding(options.baseEnv?.[key])) {
        return { valid: false, answer: null, error: "env_key_is_secret_ref" };
      }
      next[key] = value;
    }
    env = next;
  }
  const effort = readNonEmptyString(raw.effort) ?? undefined;
  const tier = readNonEmptyString(raw.tier) ?? undefined;
  const reason = readNonEmptyString(raw.reason) ?? undefined;
  const fallback = raw.fallback === true ? true : undefined;
  return {
    valid: true,
    answer: {
      kind: "decide",
      decisionId,
      model,
      ...(effort !== undefined ? { effort } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(tier !== undefined ? { tier } : {}),
      source,
      ...(fallback !== undefined ? { fallback } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Merge application
// ---------------------------------------------------------------------------

/**
 * Applies a validated `decide` answer to a base adapter config. Env merges
 * per key (TOG-11791 semantics); `keep` returns the base untouched.
 */
export function applyRunModelDecisionToAdapterConfig(
  base: Record<string, unknown>,
  answer: RunModelDecideAnswer | RunModelKeepAnswer,
): Record<string, unknown> {
  if (answer.kind === "keep") return base;
  const baseEnv = isRecord(base.env) ? base.env : {};
  return {
    ...base,
    model: answer.model,
    ...(answer.effort !== undefined ? { effort: answer.effort } : {}),
    env: { ...baseEnv, ...(answer.env ?? {}) },
  };
}

/**
 * True when the decided model differs from the model's previous session, i.e.
 * the run must start a fresh session (the existing "configured model changed"
 * reset sees the decided model, design §4.2 "Order").
 */
export function runModelDecisionChangesModel(
  decidedModel: string | null,
  previousSessionModel: string | null,
): boolean {
  if (!decidedModel) return false;
  return decidedModel !== previousSessionModel;
}

// ---------------------------------------------------------------------------
// Outcome recording (design §4.2 "Record")
// ---------------------------------------------------------------------------

export type RunModelDecisionOutcome =
  | "decided"
  | "kept"
  | "deferred"
  | "timeout"
  | "exempt"
  | "skipped";

/**
 * What the holder answered while the flag was off. The run used the default,
 * so the top-level record says `timeout`; this keeps the advice measurable.
 */
export interface RunModelDecisionAdvice {
  outcome: "decided" | "kept" | "deferred" | "timeout";
  decisionId: string | null;
  model: string | null;
  tier?: string;
  source: string | null;
  fallback?: boolean;
  reason?: string;
}

export interface RunModelDecisionRecord {
  decisionId: string | null;
  pluginKey: string | null;
  model: string | null;
  effort?: string;
  tier?: string;
  source: string | null;
  fallback?: boolean;
  latencyMs: number;
  outcome: RunModelDecisionOutcome;
  /** Skip reason when `skipped`; why no decision when `deferred`/`timeout`/`exempt`. */
  reason?: string;
  /** Present only when `requireRunModelDecision` is off (advisory mode). */
  advisory?: RunModelDecisionAdvice;
}

export function buildModelDecisionRecord(input: {
  answer: RunModelDecisionAnswer | null;
  pluginKey: string | null;
  latencyMs: number;
  outcome: RunModelDecisionOutcome;
  reason?: string;
}): RunModelDecisionRecord {
  const answer = input.answer;
  return {
    decisionId:
      answer?.kind === "decide" ? answer.decisionId : null,
    pluginKey: input.pluginKey,
    model: answer?.kind === "decide" ? answer.model : null,
    ...(answer?.kind === "decide" && answer.effort !== undefined
      ? { effort: answer.effort }
      : {}),
    ...(answer?.kind === "decide" && answer.tier !== undefined
      ? { tier: answer.tier }
      : {}),
    source: answer?.kind === "decide" ? answer.source : null,
    ...(answer?.kind === "decide" && answer.fallback === true
      ? { fallback: true as const }
      : {}),
    latencyMs: Math.max(0, Math.floor(input.latencyMs)),
    outcome: input.outcome,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// No-decision path (design §4.2 "Failure")
// ---------------------------------------------------------------------------

export type RunModelDecisionNoDecision =
  | { action: "retry"; retryAfterMs: number; reason: string }
  | { action: "surface"; reason: string };

/**
 * After a timeout/defer/invalid answer the run parks via
 * `scheduleBoundedRetryForRun` (`model_decision_pending`). Once attempts are
 * exhausted the issue is surfaced — the run never falls back to the default.
 */
export function resolveRunModelDecisionNoDecision(input: {
  consumedAttempts: number;
  maxAttempts?: number;
  retryAfterMs?: number;
  reason: string;
}): RunModelDecisionNoDecision {
  const maxAttempts = Math.max(
    0,
    Math.floor(input.maxAttempts ?? RUN_MODEL_DECISION_DEFAULT_MAX_ATTEMPTS),
  );
  if (input.consumedAttempts >= maxAttempts) {
    return { action: "surface", reason: input.reason };
  }
  return {
    action: "retry",
    retryAfterMs: Math.max(
      0,
      Math.floor(input.retryAfterMs ?? RUN_MODEL_DECISION_DEFAULT_DELAY_MS),
    ),
    reason: input.reason,
  };
}


// ---------------------------------------------------------------------------
// Flag-off advisory mode (design §4.2 "Flag")
// ---------------------------------------------------------------------------

/**
 * When `experimental.requireRunModelDecision` is off the hook is advisory:
 * the run proceeds on the default and records `outcome: "timeout"`. What the
 * holder said, if anything, goes under `advisory` for before/after measurement.
 */
export function buildAdvisoryModelDecisionRecord(input: {
  pluginKey: string | null;
  latencyMs: number;
  advice: RunModelDecisionAdvice;
}): RunModelDecisionRecord {
  return {
    ...buildModelDecisionRecord({
      answer: null,
      pluginKey: input.pluginKey,
      latencyMs: input.latencyMs,
      outcome: "timeout",
      reason: "requireRunModelDecision disabled",
    }),
    advisory: input.advice,
  };
}

// ---------------------------------------------------------------------------
// Capability holder (design §4.1: one holder per company)
// ---------------------------------------------------------------------------

export interface RunModelDecisionHolderCandidate {
  id: string;
  pluginKey: string;
  manifestJson: {
    capabilities?: readonly string[];
    modelRouting?: { envKeys?: readonly string[] };
  } | null;
}

export interface RunModelDecisionHolder {
  pluginId: string;
  pluginKey: string;
  /** Manifest `modelRouting.envKeys`: the only env keys a decision may set. */
  envKeys: string[];
}

export type RunModelDecisionHolderSelection =
  | { kind: "none" }
  | { kind: "single"; holder: RunModelDecisionHolder }
  | { kind: "conflict"; pluginKeys: string[] };

/**
 * Picks the `run.model.resolve` holder among ready plugins. More than one
 * holder is a conflict: the host asks nobody, and with the flag on the run
 * defers rather than guessing which router is authoritative.
 */
export function selectRunModelDecisionHolder(
  candidates: readonly RunModelDecisionHolderCandidate[],
): RunModelDecisionHolderSelection {
  const holders = candidates.filter((candidate) =>
    candidate.manifestJson?.capabilities?.includes(RUN_MODEL_DECISION_CAPABILITY),
  );
  if (holders.length === 0) return { kind: "none" };
  if (holders.length > 1) {
    return {
      kind: "conflict",
      pluginKeys: holders.map((holder) => holder.pluginKey).sort(),
    };
  }
  const holder = holders[0]!;
  return {
    kind: "single",
    holder: {
      pluginId: holder.id,
      pluginKey: holder.pluginKey,
      envKeys: [...(holder.manifestJson?.modelRouting?.envKeys ?? [])],
    },
  };
}

/** Reads `previous` from the last run on the same issue and agent. */
export function readPreviousRunModelDecision(
  row: { id: string; contextSnapshot: unknown } | null | undefined,
): RunModelDecisionPrevious | null {
  if (!row) return null;
  const snapshot = isRecord(row.contextSnapshot) ? row.contextSnapshot : {};
  const record = isRecord(snapshot.modelDecision) ? snapshot.modelDecision : {};
  return {
    runId: row.id,
    model: readNonEmptyString(record.model),
    decisionId: readNonEmptyString(record.decisionId),
  };
}

// ---------------------------------------------------------------------------
// Orchestration (design §4.2): one call per run, I/O injected
// ---------------------------------------------------------------------------

/** Thrown inside `executeRun` so the run parks as `model_decision_pending`. */
export class RunModelDecisionDeferral extends Error {
  readonly code = RUN_MODEL_DECISION_RETRY_REASON;
  readonly retryAfterMs: number;
  readonly reason: string;
  readonly record: RunModelDecisionRecord;

  constructor(input: {
    retryAfterMs: number;
    reason: string;
    record: RunModelDecisionRecord;
  }) {
    super(`Model router has not decided this run's model: ${input.reason}`);
    this.name = "RunModelDecisionDeferral";
    this.retryAfterMs = input.retryAfterMs;
    this.reason = input.reason;
    this.record = input.record;
  }
}

export function isRunModelDecisionDeferral(
  error: unknown,
): error is RunModelDecisionDeferral {
  return error instanceof RunModelDecisionDeferral;
}

export type RunModelDecisionResolution =
  | {
      action: "proceed";
      /** `null` runs on the agent default / existing override. */
      answer: RunModelDecideAnswer | RunModelKeepAnswer | null;
      record: RunModelDecisionRecord;
    }
  | {
      action: "park";
      retryAfterMs: number;
      reason: string;
      record: RunModelDecisionRecord;
    };

export interface ResolveRunModelDecisionInput {
  /** `experimental.requireRunModelDecision`. */
  requireDecision: boolean;
  skip: Omit<RunModelDecisionSkipInput, "hasCapabilityHolder">;
  /** User-requested wakes may run on the default when no decision comes. */
  isUserRequestedWake: boolean;
  holder: RunModelDecisionHolderSelection;
  params: Omit<RunModelDecisionInput, "deadlineMs">;
  /** Base adapter-config `env`, for the secret_ref check. */
  baseEnv: Record<string, unknown> | null | undefined;
  /** Host→worker RPC; must reject once `timeoutMs` passes. */
  call: (
    pluginId: string,
    params: RunModelDecisionInput,
    timeoutMs: number,
  ) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
}

const MAX_RECORDED_REASON_LENGTH = 200;

function describeCallFailure(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "resolveRunModel call failed";
  return message.slice(0, MAX_RECORDED_REASON_LENGTH);
}

export async function resolveRunModelDecision(
  input: ResolveRunModelDecisionInput,
): Promise<RunModelDecisionResolution> {
  const skip = evaluateRunModelDecisionSkip({
    ...input.skip,
    hasCapabilityHolder: input.holder.kind !== "none",
  });
  if (skip.skip) {
    return {
      action: "proceed",
      answer: null,
      record: buildModelDecisionRecord({
        answer: null,
        pluginKey: null,
        latencyMs: 0,
        outcome: "skipped",
        reason: skip.reason,
      }),
    };
  }

  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? RUN_MODEL_DECISION_RPC_TIMEOUT_MS;
  const pluginKey =
    input.holder.kind === "single" ? input.holder.holder.pluginKey : null;
  const startedAt = now();

  let answer: RunModelDecisionAnswer | null = null;
  let failure: { outcome: "deferred" | "timeout"; reason: string } | null = null;
  if (input.holder.kind === "conflict") {
    failure = {
      outcome: "deferred",
      reason: `multiple ${RUN_MODEL_DECISION_CAPABILITY} holders: ${input.holder.pluginKeys.join(", ")}`,
    };
  } else if (input.holder.kind === "single") {
    let raw: unknown;
    try {
      raw = await input.call(
        input.holder.holder.pluginId,
        { ...input.params, deadlineMs: timeoutMs },
        timeoutMs,
      );
    } catch (error) {
      failure = { outcome: "timeout", reason: describeCallFailure(error) };
    }
    if (!failure) {
      const validation = validateRunModelDecisionAnswer(raw, {
        allowlistedEnvKeys: input.holder.holder.envKeys,
        baseEnv: input.baseEnv,
      });
      if (!validation.valid) {
        failure = { outcome: "deferred", reason: `invalid answer: ${validation.error}` };
      } else {
        answer = validation.answer;
      }
    }
  }
  const latencyMs = now() - startedAt;

  if (!input.requireDecision) {
    return {
      action: "proceed",
      answer: null,
      record: buildAdvisoryModelDecisionRecord({
        pluginKey,
        latencyMs,
        advice: failure
          ? {
              outcome: failure.outcome,
              decisionId: null,
              model: null,
              source: null,
              reason: failure.reason,
            }
          : toAdvice(answer!),
      }),
    };
  }

  if (answer && answer.kind !== "defer") {
    return {
      action: "proceed",
      answer,
      record: buildModelDecisionRecord({
        answer,
        pluginKey,
        latencyMs,
        outcome: answer.kind === "decide" ? "decided" : "kept",
        ...(answer.kind === "decide" && answer.reason !== undefined
          ? { reason: answer.reason }
          : {}),
      }),
    };
  }

  const reason = failure?.reason ?? (answer?.kind === "defer" ? answer.reason : "no decision");
  const outcome = failure?.outcome ?? "deferred";
  if (input.isUserRequestedWake) {
    return {
      action: "proceed",
      answer: null,
      record: buildModelDecisionRecord({
        answer: null,
        pluginKey,
        latencyMs,
        outcome: "exempt",
        reason,
      }),
    };
  }
  return {
    action: "park",
    retryAfterMs:
      answer?.kind === "defer"
        ? answer.retryAfterMs
        : RUN_MODEL_DECISION_DEFAULT_DELAY_MS,
    reason,
    record: buildModelDecisionRecord({
      answer: null,
      pluginKey,
      latencyMs,
      outcome,
      reason,
    }),
  };
}

function toAdvice(answer: RunModelDecisionAnswer): RunModelDecisionAdvice {
  if (answer.kind === "keep") {
    return { outcome: "kept", decisionId: null, model: null, source: null };
  }
  if (answer.kind === "defer") {
    return {
      outcome: "deferred",
      decisionId: null,
      model: null,
      source: null,
      reason: answer.reason,
    };
  }
  return {
    outcome: "decided",
    decisionId: answer.decisionId,
    model: answer.model,
    ...(answer.tier !== undefined ? { tier: answer.tier } : {}),
    source: answer.source,
    ...(answer.fallback === true ? { fallback: true } : {}),
    ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
  };
}
