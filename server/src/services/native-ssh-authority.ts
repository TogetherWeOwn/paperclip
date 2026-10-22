import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  createEd25519NativeSshEnvelopeVerifier,
  createNativeSshHostExecutorTarget,
  isNativeSshAuthorityRequired,
  NativeSshAuthorityError,
  runWithNativeSshHostExecutor,
  type CreateNativeSshHostExecutorTargetInput,
  type NativeSshEnvelopeVerifier,
  type NativeSshHostExecutorTarget,
  type NativeSshSignerTransport,
} from "@paperclipai/adapter-utils/host-executor";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { createUnixSocketNativeSshSignerTransport } from "@paperclipai/adapter-utils/native-ssh-signer-transport";
import { unprocessable } from "../errors.js";
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

function isSshTarget(target: AdapterExecutionTarget | null | undefined): boolean {
  return target?.kind === "remote" && target.transport === "ssh";
}

/**
 * Builds the run's native SSH authority issuer, or null when the run does not
 * launch over SSH or the server leaves native SSH authority off. For an SSH
 * run that requires it, a missing assigned model or run identity throws here,
 * before any ledger write, signer request or ssh client.
 */
export function createNativeSshHostExecutorForRun(
  input: CreateNativeSshHostExecutorForRunInput,
): NativeSshHostExecutorTarget | null {
  if (!isSshTarget(input.target) || !isNativeSshAuthorityRequired()) return null;
  const { target: _target, holder, decision, issueId, ...seed } = input;
  return createNativeSshHostExecutorTarget({
    ...seed,
    issueId: issueId ?? "",
    assignedModel: assignedModelForNativeSsh(holder, decision),
  });
}

/**
 * A probe outside a run (environment Test, connection adoption) has no run,
 * issue or decided model to bind an authority to. While the server requires
 * native SSH authority, refuse it on SSH targets with a clear 422.
 */
export function assertNativeSshProbeSupported(target: AdapterExecutionTarget | null | undefined): void {
  if (!isSshTarget(target) || !isNativeSshAuthorityRequired()) return;
  throw unprocessable(
    "This check cannot run on an SSH environment while native SSH launch authority is required: it has no run to authorize it.",
    { code: "native_ssh_authority_required" },
  );
}

/**
 * Records the run's native SSH authority on its heartbeat run row: the exact
 * authority before the signer is asked (the signer signs only what the server
 * recorded for the opaque id), then the signed envelope's digest. Either write
 * failing aborts the launch. `runContext`, the run's in-memory context, gets
 * the same fields so later whole-snapshot writes of it keep them.
 */
export function nativeSshAuthorityRunLedger(
  db: Db,
  runId: string,
  runContext?: Record<string, unknown>,
): Pick<CreateNativeSshHostExecutorTargetInput, "persistAuthority" | "persistEnvelope"> {
  async function record(patch: Record<string, unknown>, what: string) {
    const rows = await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning({ id: heartbeatRuns.id });
    if (rows.length === 0) throw new Error(`Failed to record native SSH ${what} on the run`);
    if (runContext) Object.assign(runContext, patch);
  }
  return {
    persistAuthority: (authority) =>
      record({ nativeSshAuthority: authority, nativeSshEnvelopeSha256: null }, "authority"),
    persistEnvelope: ({ envelopeSha256 }) =>
      record({ nativeSshEnvelopeSha256: envelopeSha256 }, "envelope digest"),
  };
}

/** Runs `fn` with the run's executor bound to every launch it makes; unbound when there is none. */
export function runWithRunNativeSshHostExecutor<T>(
  executor: NativeSshHostExecutorTarget | null,
  fn: () => T,
): T {
  return executor ? runWithNativeSshHostExecutor(executor, fn) : fn();
}

export interface NativeSshSignerEndpointInput {
  /** Explicit transport, for tests and embeds that speak to the signer already. */
  readonly signer?: NativeSshSignerTransport | null | undefined;
  /** Explicit signature check paired with `signer`. */
  readonly verifyEnvelope?: NativeSshEnvelopeVerifier | null | undefined;
  /** AF_UNIX socket path of the out-of-process signer. Null leaves the seam dormant. */
  readonly endpoint?: string | null | undefined;
  /** Ed25519 public key (SPKI PEM) the signer signs with. Null leaves the seam dormant. */
  readonly publicKeyPem?: string | null | undefined;
}

export interface ResolvedNativeSshSignerPair {
  readonly signer: NativeSshSignerTransport | undefined;
  readonly verifyEnvelope: NativeSshEnvelopeVerifier | undefined;
}

function readSignerConfigText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : value;
}

/**
 * Resolves the heartbeat's signer pair from explicit pieces or endpoint
 * config. All unset means dormant: the executor keeps its current fail-closed
 * behavior. A half-set endpoint or an explicit piece mixed with endpoint
 * config is operator error and throws here, before any launch, so a typo can
 * neither silently disable the check nor silently leave enforcement refusing
 * every SSH run. Explicit pieces pass through untouched.
 */
export function resolveNativeSshSignerPair(
  input: NativeSshSignerEndpointInput,
): ResolvedNativeSshSignerPair {
  const endpoint = readSignerConfigText(input.endpoint);
  const publicKeyPem = readSignerConfigText(input.publicKeyPem);
  const hasExplicit = input.signer != null || input.verifyEnvelope != null;
  const hasEndpointConfig = endpoint !== null || publicKeyPem !== null;
  if (hasExplicit && hasEndpointConfig) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH signer is configured twice: pass an explicit signer pair or an endpoint, not both",
    );
  }
  if (hasEndpointConfig) {
    if (endpoint === null || publicKeyPem === null) {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_invalid",
        "Native SSH signer endpoint needs both a socket path and the signer's public key",
      );
    }
    let verifyEnvelope: NativeSshEnvelopeVerifier;
    try {
      verifyEnvelope = createEd25519NativeSshEnvelopeVerifier(publicKeyPem);
    } catch {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_invalid",
        "Native SSH signer public key is not a usable public key",
      );
    }
    return {
      signer: createUnixSocketNativeSshSignerTransport(endpoint),
      verifyEnvelope,
    };
  }
  return {
    signer: input.signer ?? undefined,
    verifyEnvelope: input.verifyEnvelope ?? undefined,
  };
}
