const MAX_EXECUTION_SEC = 14_400;

export class SandboxBridgeLifetimeError extends Error {
  readonly remediation =
    "Start a new authorized sandbox attempt with a finite timeout of at most 14400 seconds and host credentials valid for its full lifetime.";

  constructor(
    readonly code: string,
    message: string,
    readonly configuredValue?: unknown,
  ) {
    super(message);
    this.name = "SandboxBridgeLifetimeError";
  }
}

export function validateSandboxBridgeBudget(timeoutSec: number): number {
  if (
    !Number.isFinite(timeoutSec) ||
    timeoutSec <= 0 ||
    timeoutSec > MAX_EXECUTION_SEC
  ) {
    throw new SandboxBridgeLifetimeError(
      "sandbox_bridge_unsupported_lifetime",
      `Unsupported sandbox callback timeoutSec=${String(timeoutSec)}: requires a finite positive execution budget no longer than 14400 seconds.`,
      timeoutSec,
    );
  }
  return timeoutSec * 1000;
}
