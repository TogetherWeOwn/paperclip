import { createHash } from "node:crypto";
import {
  createNativeSshHostExecutorTarget,
  runWithNativeSshHostExecutor,
  type CreateNativeSshHostExecutorTargetInput,
  type NativeSshHostExecutorTarget,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  evaluateRunModelDecisionSeam,
  RUN_MODEL_DECISION_SEAM_VIOLATION_ASSIGNED_MODEL_MISSING,
  type RunModelDecisionHolderSelection,
  type RunModelDecisionRecord,
} from "./run-model-decision.js";

/** A native SSH launch was refused because the run has no authoritative assigned model to bind. */
export class NativeSshAssignedModelMissingError extends Error {
  readonly code = "native_ssh_assigned_model_missing" as const;
  readonly violation = RUN_MODEL_DECISION_SEAM_VIOLATION_ASSIGNED_MODEL_MISSING;

  constructor(readonly reason: string) {
    super(`Native SSH launch refused: assigned model missing (${reason})`);
    this.name = "NativeSshAssignedModelMissingError";
  }
}

export interface CreateNativeSshHostExecutorForRunInput
  extends Pick<
    CreateNativeSshHostExecutorTargetInput,
    | "runId"
    | "companyId"
    | "agentId"
    | "adapterType"
    | "signer"
    | "verifyEnvelope"
    | "persistAuthority"
    | "persistEnvelope"
    | "now"
    | "maxLifetimeMs"
  > {
  readonly issueId: string | null;
  readonly target: AdapterExecutionTarget | null | undefined;
  readonly holder: RunModelDecisionHolderSelection;
  readonly decision: Pick<RunModelDecisionRecord, "model" | "outcome" | "pluginKey"> | null | undefined;
}

/**
 * The model the authority binds. Only an explicit `decide` answer from the single
 * enforced holder names one; a keep, skip, deferral, advisory record or foreign
 * router does not, and `adapterConfig.model` is never consulted.
 */
function assignedModelForNativeSsh(
  holder: RunModelDecisionHolderSelection,
  decision: CreateNativeSshHostExecutorForRunInput["decision"],
): CreateNativeSshHostExecutorTargetInput["assignedModel"] {
  const seam = evaluateRunModelDecisionSeam(holder);
  if (!seam.enforced) throw new NativeSshAssignedModelMissingError(seam.reason);
  if (decision?.outcome !== "decided" || decision.pluginKey !== seam.holder.pluginKey) {
    throw new NativeSshAssignedModelMissingError(
      `no model decided by ${seam.holder.pluginKey} for this run`,
    );
  }
  const model = typeof decision.model === "string" ? decision.model.trim() : "";
  if (!model || /[\x00-\x1f\x7f]/.test(model)) {
    throw new NativeSshAssignedModelMissingError("the decided model is blank or malformed");
  }
  return { version: "1", model, sha256: createHash("sha256").update(model).digest("hex") };
}

/**
 * Builds the run's native SSH authority issuer, or null when the run does not
 * launch over SSH. For an SSH run, a missing assigned model or run identity
 * throws here, before any ledger write, signer request or ssh client.
 */
export function createNativeSshHostExecutorForRun(
  input: CreateNativeSshHostExecutorForRunInput,
): NativeSshHostExecutorTarget | null {
  if (input.target?.kind !== "remote" || input.target.transport !== "ssh") return null;
  const { target: _target, holder, decision, issueId, ...seed } = input;
  return createNativeSshHostExecutorTarget({
    ...seed,
    issueId: issueId ?? "",
    assignedModel: assignedModelForNativeSsh(holder, decision),
  });
}

/** Runs `fn` with the run's executor bound to every launch it makes; unbound when there is none. */
export function runWithRunNativeSshHostExecutor<T>(
  executor: NativeSshHostExecutorTarget | null,
  fn: () => T,
): T {
  return executor ? runWithNativeSshHostExecutor(executor, fn) : fn();
}
