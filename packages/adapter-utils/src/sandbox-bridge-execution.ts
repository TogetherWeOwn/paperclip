import {
  adapterExecutionTargetUsesPaperclipBridge,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
} from "./execution-target.js";
import {
  SandboxBridgeLifetimeError,
  validateSandboxBridgeBudget,
} from "./sandbox-bridge-lifetime.js";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "./types.js";

/** Host-only state: never serialized into provider/session/runtime assets. */
export function prepareSandboxBridgeExecution(ctx: AdapterExecutionContext) {
  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const enabled =
    target?.kind === "remote" &&
    adapterExecutionTargetUsesPaperclipBridge(target) &&
    !ctx.onSandboxBridgeFailure;
  let failure: SandboxBridgeLifetimeError | undefined;
  const abort = new AbortController();
  const fail = (error: SandboxBridgeLifetimeError) => {
    failure ??= error;
    abort.abort(error);
  };
  const normalize = (
    result: AdapterExecutionResult,
  ): AdapterExecutionResult => {
    if (!failure) return result;
    const details = {
      configuredValue: failure.configuredValue ?? ctx.config.timeoutSec ?? null,
      remediation: failure.remediation,
    };
    return {
      ...result,
      exitCode:
        result.exitCode === 0 || result.exitCode == null ? 1 : result.exitCode,
      errorCode: failure.code,
      errorMessage: failure.message,
      remediation: failure.remediation,
      errorDetails: details,
      resultJson: {
        ...result.resultJson,
        sandboxBridgeFailure: {
          code: failure.code,
          ...details,
          retryable: false,
        },
      },
    };
  };
  return {
    ctx: enabled
      ? {
          ...ctx,
          signal: AbortSignal.any([
            abort.signal,
            ...(ctx.signal ? [ctx.signal] : []),
          ]),
          onSandboxBridgeFailure: fail,
        }
      : ctx,
    preflight() {
      // SSH keeps its existing unlimited timeout semantics. The finite-budget
      // exception is for sandbox callback attempts, not the generic resolver.
      if (
        !enabled ||
        target?.kind !== "remote" ||
        target.transport !== "sandbox"
      )
        return;
      const raw = ctx.config.timeoutSec;
      const configured = typeof raw === "number" ? raw : 0;
      validateSandboxBridgeBudget(
        configured === 0
          ? resolveAdapterExecutionTargetTimeoutSec(target, configured)
          : configured,
      );
    },
    normalize,
    fromError(error: unknown): AdapterExecutionResult {
      if (!(error instanceof SandboxBridgeLifetimeError)) throw error;
      fail(error);
      return normalize({ exitCode: 1, signal: null, timedOut: false });
    },
  };
}

/** Preserve terminal callback failure even when a CLI exits zero. Cleanup still owns its errors. */
export async function runWithSandboxBridgeExecution(
  ctx: AdapterExecutionContext,
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>,
): Promise<AdapterExecutionResult> {
  const execution = prepareSandboxBridgeExecution(ctx);
  try {
    execution.preflight();
    return execution.normalize(await execute(execution.ctx));
  } catch (error) {
    return execution.fromError(error);
  }
}
