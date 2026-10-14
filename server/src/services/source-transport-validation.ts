/**
 * Source-bound transport-only validation.
 *
 * Pure, side-effect-free predicate: it authorizes the intended principal for
 * a source issue, rechecks unresolved dependencies, enforces the low-trust
 * preflight, and validates the selected workspace transport — then terminates
 * under an enforced `transport-only` boundary BEFORE any runtime-service,
 * product, or staging execution. Caller-supplied `effects` callbacks are
 * accepted in the input shape so callers can prove they were never invoked;
 * this module never calls them on any path.
 *
 * This is a transport-boundary check only. It is not authentication,
 * provenance, deployment attestation, or source-native validation.
 */

export type SourceTransportValidationEffects = {
  startRuntimeService?: () => unknown;
  executeProduct?: () => unknown;
  executeStaging?: () => unknown;
};

export type ValidateSourceTransportOnlyInput = {
  sourceIssueId: string;
  principalAgentId: string;
  /** The source issue's current assignee; the pure core compares the two. */
  issueAssigneeAgentId: string;
  workspaceId: string;
  /** Transport the principal asked to validate in. */
  transport: string;
  /** Transport the selected workspace is bound to. */
  workspaceTransport: string;
  dependenciesBlocked?: { unresolvedBlockerIssueIds: string[] } | null;
  isLowTrust?: boolean;
  requestedToolClass?: string | null;
  effects?: SourceTransportValidationEffects | null;
};

export type ValidateSourceTransportOnlyResult =
  | {
      ok: true;
      boundary: "transport-only";
      runtimeInvoked: false;
      validatedWorkspaceId: string;
      checkedDependencies: true;
      preflight: "enforced";
    }
  | {
      ok: false;
      errorCode:
        | "unauthorized_principal"
        | "issue_dependencies_blocked"
        | "low_trust_preflight_denied"
        | "workspace_transport_mismatch";
      boundary: "transport-only";
      runtimeInvoked: false;
    };

function denied(
  errorCode: Extract<
    ValidateSourceTransportOnlyResult,
    { ok: false }
  >["errorCode"],
): ValidateSourceTransportOnlyResult {
  return {
    ok: false,
    errorCode,
    boundary: "transport-only",
    runtimeInvoked: false,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function validateSourceTransportOnly(
  input: ValidateSourceTransportOnlyInput,
): ValidateSourceTransportOnlyResult {
  // Fail closed on a malformed envelope: without an input object no principal
  // can be authorized.
  if (input === null || typeof input !== "object") {
    return denied("unauthorized_principal");
  }

  // 1. The intended principal must equal the source issue's assignee. Empty or
  // missing identities deny rather than passing vacuously.
  if (
    !isNonEmptyString(input.principalAgentId) ||
    !isNonEmptyString(input.issueAssigneeAgentId) ||
    input.principalAgentId !== input.issueAssigneeAgentId
  ) {
    return denied("unauthorized_principal");
  }

  // 2. Dependency recheck: a null/undefined block state is clear; anything
  // else must be a well-formed object whose unresolved list is empty.
  // Malformed shapes deny rather than being treated as clear.
  const dependenciesBlocked = input.dependenciesBlocked;
  if (dependenciesBlocked !== null && dependenciesBlocked !== undefined) {
    if (
      typeof dependenciesBlocked !== "object" ||
      !Array.isArray(
        (dependenciesBlocked as { unresolvedBlockerIssueIds?: unknown })
          .unresolvedBlockerIssueIds,
      )
    ) {
      return denied("issue_dependencies_blocked");
    }
    if (
      (dependenciesBlocked as { unresolvedBlockerIssueIds: unknown[] })
        .unresolvedBlockerIssueIds.length > 0
    ) {
      return denied("issue_dependencies_blocked");
    }
  }

  // 3. Low-trust preflight: any low-trust invocation denies, including a null
  // or absent tool class. This pins the strict superset — deny on null rather
  // than silently scoping it out.
  if (input.isLowTrust === true) {
    return denied("low_trust_preflight_denied");
  }

  // 4. The selected workspace must be bound to the principal transport. Empty
  // or missing transports deny rather than matching vacuously.
  if (
    !isNonEmptyString(input.transport) ||
    !isNonEmptyString(input.workspaceTransport) ||
    input.transport !== input.workspaceTransport
  ) {
    return denied("workspace_transport_mismatch");
  }

  // Transport-only boundary: success carries no execution handle, and the
  // `effects` callbacks above are never invoked on any path.
  return {
    ok: true,
    boundary: "transport-only",
    runtimeInvoked: false,
    validatedWorkspaceId: input.workspaceId,
    checkedDependencies: true,
    preflight: "enforced",
  };
}
