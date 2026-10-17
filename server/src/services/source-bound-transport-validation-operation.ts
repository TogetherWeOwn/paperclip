/**
 * Source-bound transport validation operation (server wiring).
 *
 * This is the invokable entrypoint for the pure helpers in
 * `source-transport-validation.ts` and `source-image-attestation.ts`. The
 * pure helpers only compare caller-supplied values; every fact they compare
 * is resolved here from authoritative server state, inside one company:
 *
 * - the source issue's current assignee (issue row),
 * - the current unresolved-blocker set (dependency readiness, re-resolve at
 *   each invocation — no cached earlier `ok:true` is ever reused),
 * - low-trust status (server trust-preset resolution over agent, project
 *   and issue policy — never a caller-declared boolean),
 * - the selected workspace's transport (execution-workspace record, which
 *   must be bound to the source issue),
 * - the deployed-image attestation inputs (trusted deployment record from
 *   server configuration, never from the caller).
 *
 * Boundary: this operation terminates under `transport-only` BEFORE any
 * runtime-service, product, or staging execution. It performs no wake, no
 * checkout, no workspace realization and no runtime start, and it never
 * invokes the proof `effects` callbacks it forwards to the pure validator.
 * The returned receipt is a validation record, not a capability: it binds
 * no execution authority and must be re-checked at any later use.
 *
 * The attestation section is digest pinning for the exact running build:
 * it proves only that the deployment record's image reference carries the
 * expected `sha256:` digest at validation time. It is not registry,
 * signature, or provenance verification, and the receipt keeps the
 * transport and attestation results as separate sections.
 */

import type { Db } from "@paperclipai/db";
import { agents, executionWorkspaces, issues, projects } from "@paperclipai/db";
import { isUuidLike, normalizeIssueIdentifier } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { issueService } from "./issues.js";
import {
  type VerifySourceImageAttestationResult,
  verifySourceImageAttestation,
} from "./source-image-attestation.js";
import {
  type SourceTransportValidationEffects,
  type ValidateSourceTransportOnlyResult,
  validateSourceTransportOnly,
} from "./source-transport-validation.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

export const SOURCE_BOUND_TRANSPORT_VALIDATION_OPERATION_VERSION =
  "source-bound-transport-validation/v1";

export type SourceBoundIssueFacts = {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  projectId: string | null;
  executionPolicy: unknown;
  executionWorkspaceId: string | null;
};

export type SourceBoundWorkspaceFacts = {
  id: string;
  companyId: string;
  /** Transport name the workspace record is bound to (its provider type). */
  transport: string;
  sourceIssueId: string | null;
  status: string;
  closedAt: Date | string | null;
  /**
   * Row-level realization facts. Optional so older callers that resolve
   * only the status keep compiling; an absent field skips that sub-check,
   * while an explicit null denies. The DB resolver below always returns
   * explicit values, so a status-only spoof (e.g. a generic PATCH flipping
   * `unrealized` to `active` with null row facts) still denies.
   */
  openedAt?: Date | string | null;
  cwd?: string | null;
  providerRef?: string | null;
};

export type DeployedImageAttestationRecord = {
  sourceRevision: string;
  imageReference: string;
  expectedDigest: string;
};

export type SourceBoundTransportAuditEntry = {
  companyId: string;
  sourceIssueId: string;
  principalAgentId: string;
  workspaceId: string | null;
  resultCode: string;
  attestationResultCode: string | null;
  validatedAt: string;
};

export type SourceBoundTransportValidationDeps = {
  resolveSourceIssue: (
    companyId: string,
    sourceIssueId: string,
  ) => Promise<SourceBoundIssueFacts | null>;
  resolveUnresolvedBlockerIssueIds: (
    companyId: string,
    sourceIssueId: string,
  ) => Promise<string[]>;
  /** Server-resolved low-trust status for the principal on this issue. */
  resolveIsLowTrust: (input: {
    companyId: string;
    principalAgentId: string;
    issue: SourceBoundIssueFacts;
  }) => Promise<boolean>;
  resolveWorkspace: (
    companyId: string,
    workspaceId: string,
  ) => Promise<SourceBoundWorkspaceFacts | null>;
  /** Trusted deployment record for the running build; null when unset. */
  resolveDeployedImageAttestation: () =>
    | Promise<DeployedImageAttestationRecord | null>
    | DeployedImageAttestationRecord
    | null;
  logDecision?: (entry: SourceBoundTransportAuditEntry) => Promise<void> | void;
  now?: () => Date;
};

export type RunSourceBoundTransportValidationInput = {
  companyId: string;
  sourceIssueId: string;
  /** Authenticated agent principal (resolved by the route from the actor). */
  principalAgentId: string;
  workspaceId: string;
  /** Transport the principal asks to validate in. */
  transport: string;
  requestedToolClass?: string | null;
  /** Proof sink only: forwarded to the pure validator, never invoked. */
  effects?: SourceTransportValidationEffects | null;
};

export type SourceBoundTransportValidationReceipt = {
  ok: boolean;
  operationVersion: string;
  boundary: "transport-only";
  runtimeInvoked: false;
  sourceIssueId: string;
  principalAgentId: string;
  transport: ValidateSourceTransportOnlyResult;
  attestation:
    | VerifySourceImageAttestationResult
    | {
        ok: false;
        errorCode: "image_attestation_unavailable" | "not_evaluated";
      };
  validatedAt: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Reads the trusted deployment record for the running build from server
 * configuration. All three values must be deployment-set; a partially
 * configured record is treated as unavailable (fail closed) rather than
 * letting any field fall back to a caller-supplied value.
 */
export function readDeployedImageAttestationFromEnv(
  env: Record<string, string | undefined> = process.env,
): DeployedImageAttestationRecord | null {
  const sourceRevision = env.PAPERCLIP_SOURCE_REVISION?.trim() ?? "";
  const imageReference = env.PAPERCLIP_DEPLOYED_IMAGE_REFERENCE?.trim() ?? "";
  const expectedDigest = env.PAPERCLIP_EXPECTED_IMAGE_DIGEST?.trim() ?? "";
  if (!sourceRevision || !imageReference || !expectedDigest) return null;
  return { sourceRevision, imageReference, expectedDigest };
}

export async function runSourceBoundTransportValidation(
  deps: SourceBoundTransportValidationDeps,
  input: RunSourceBoundTransportValidationInput,
): Promise<SourceBoundTransportValidationReceipt> {
  const validatedAt = (deps.now?.() ?? new Date()).toISOString();
  // The caller may address the source issue by identifier; once resolved,
  // the receipt and audit entry carry the canonical issue id.
  let resolvedSourceIssueId = isNonEmptyString(input?.sourceIssueId)
    ? input.sourceIssueId
    : "";
  const finish = async (
    transport: ValidateSourceTransportOnlyResult,
    attestation: SourceBoundTransportValidationReceipt["attestation"],
  ): Promise<SourceBoundTransportValidationReceipt> => {
    const receipt: SourceBoundTransportValidationReceipt = {
      ok: transport.ok && attestation.ok,
      operationVersion: SOURCE_BOUND_TRANSPORT_VALIDATION_OPERATION_VERSION,
      boundary: "transport-only",
      runtimeInvoked: false,
      sourceIssueId: resolvedSourceIssueId,
      principalAgentId: isNonEmptyString(input?.principalAgentId)
        ? input.principalAgentId
        : "",
      transport,
      attestation,
      validatedAt,
    };
    if (deps.logDecision) {
      await deps.logDecision({
        companyId: isNonEmptyString(input?.companyId) ? input.companyId : "",
        sourceIssueId: receipt.sourceIssueId,
        principalAgentId: receipt.principalAgentId,
        workspaceId: isNonEmptyString(input?.workspaceId)
          ? input.workspaceId
          : null,
        resultCode: transport.ok ? "ok" : transport.errorCode,
        attestationResultCode: attestation.ok ? "ok" : attestation.errorCode,
        validatedAt,
      });
    }
    return receipt;
  };

  const deniedTransport = (
    errorCode: Extract<
      ValidateSourceTransportOnlyResult,
      { ok: false }
    >["errorCode"],
  ): ValidateSourceTransportOnlyResult => ({
    ok: false,
    errorCode,
    boundary: "transport-only",
    runtimeInvoked: false,
  });

  // Resolve the source issue inside the caller's company. A missing or
  // cross-company issue denies as unauthorized without revealing which.
  const issue =
    isNonEmptyString(input?.companyId) && isNonEmptyString(input?.sourceIssueId)
      ? await deps.resolveSourceIssue(input.companyId, input.sourceIssueId)
      : null;
  if (!issue || issue.companyId !== input.companyId) {
    return finish(deniedTransport("unauthorized_principal"), {
      ok: false,
      errorCode: "not_evaluated",
    });
  }
  resolvedSourceIssueId = issue.id;

  // Resolve the selected workspace in the same company and require it to be
  // bound to the source issue (its source issue, or the issue's selected
  // execution workspace) and still open. Unbound, missing, or closed
  // workspaces fail closed as a transport mismatch, matching the pure
  // validator's empty-workspace deny.
  const workspace = isNonEmptyString(input.workspaceId)
    ? await deps.resolveWorkspace(input.companyId, input.workspaceId)
    : null;
  const workspaceClosed =
    workspace !== null &&
    (workspace.closedAt != null ||
      workspace.status === "archived" ||
      workspace.status === "cleanup_failed");
  const workspaceBoundToIssue =
    workspace !== null &&
    !workspaceClosed &&
    workspace.companyId === input.companyId &&
    (workspace.sourceIssueId === issue.id ||
      issue.executionWorkspaceId === workspace.id);

  // Fresh, at-invocation resolution of blockers and trust. If trust cannot
  // prove standard, the resolver returns low-trust (fail closed in the
  // pure validator, which denies anything other than explicit `false`).
  const unresolvedBlockerIssueIds = await deps.resolveUnresolvedBlockerIssueIds(
    input.companyId,
    issue.id,
  );
  const isLowTrust = await deps.resolveIsLowTrust({
    companyId: input.companyId,
    principalAgentId: input.principalAgentId,
    issue,
  });

  // Realization is a row-level fact, not a status label alone: a generic
  // PATCH could flip `unrealized` to `active` while cwd, providerRef and
  // openedAt stay null, so the status check alone would then pass. Require
  // the realized row facts as well. Each sub-check skips only when the
  // resolver did not provide the field at all (older callers); an explicit
  // null denies. The DB resolver always provides explicit values.
  const workspaceStatusRealized =
    workspaceBoundToIssue && workspace.status !== "unrealized";
  const workspaceOpenedAtRealized =
    !workspaceBoundToIssue || workspace.openedAt === undefined
      ? true
      : workspace.openedAt != null;
  const workspaceRefRealized =
    !workspaceBoundToIssue ||
    (workspace.providerRef === undefined && workspace.cwd === undefined)
      ? true
      : isNonEmptyString(workspace.providerRef) ||
        isNonEmptyString(workspace.cwd);
  const transport = validateSourceTransportOnly({
    sourceIssueId: issue.id,
    principalAgentId: input.principalAgentId,
    issueAssigneeAgentId: issue.assigneeAgentId ?? "",
    workspaceId: workspaceBoundToIssue ? workspace.id : "",
    transport: input.transport,
    workspaceTransport: workspaceBoundToIssue ? workspace.transport : "",
    // Realization state is reported only for a workspace already proven
    // bound to this issue in this company; an unbound or cross-company
    // unrealized record denies as a transport mismatch above, so its
    // realization state never leaks to a caller who may not see it.
    workspaceRealized: workspaceBoundToIssue
      ? workspaceStatusRealized &&
        workspaceOpenedAtRealized &&
        workspaceRefRealized
      : true,
    dependenciesBlocked: { unresolvedBlockerIssueIds },
    isLowTrust,
    requestedToolClass: input.requestedToolClass ?? null,
    effects: input.effects ?? null,
  });
  if (!transport.ok) {
    return finish(transport, { ok: false, errorCode: "not_evaluated" });
  }

  // Attestation for the exact running build, from the trusted deployment
  // record only. No record (or a mutable tag in it) fails closed: a
  // transport success alone never produces an `ok:true` receipt.
  const record = await deps.resolveDeployedImageAttestation();
  if (!record) {
    return finish(transport, {
      ok: false,
      errorCode: "image_attestation_unavailable",
    });
  }
  const attestation = verifySourceImageAttestation(record);
  return finish(transport, attestation);
}

/**
 * DB-backed dependency factory: the production wiring the route uses.
 * Every resolver is company-scoped.
 */
export function createDbSourceBoundTransportValidationDeps(
  db: Db,
  opts: {
    logDecision?: SourceBoundTransportValidationDeps["logDecision"];
    env?: Record<string, string | undefined>;
  } = {},
): SourceBoundTransportValidationDeps {
  const svc = issueService(db);
  return {
    async resolveSourceIssue(companyId, sourceIssueId) {
      // Accept the identifier form sibling `/issues/:id` routes accept.
      // Anything that is neither a UUID nor an identifier resolves to null
      // (denied as unauthorized) instead of reaching a uuid column, where
      // Postgres would raise 22P02 and surface as a 500.
      if (!isUuidLike(companyId)) return null;
      const identifier = isUuidLike(sourceIssueId)
        ? null
        : normalizeIssueIdentifier(sourceIssueId);
      if (!isUuidLike(sourceIssueId) && identifier === null) return null;
      const rows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          assigneeAgentId: issues.assigneeAgentId,
          projectId: issues.projectId,
          executionPolicy: issues.executionPolicy,
          executionWorkspaceId: issues.executionWorkspaceId,
        })
        .from(issues)
        .where(
          and(
            identifier === null
              ? eq(issues.id, sourceIssueId)
              : eq(issues.identifier, identifier),
            eq(issues.companyId, companyId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async resolveUnresolvedBlockerIssueIds(companyId, sourceIssueId) {
      const readiness = await svc.listDependencyReadiness(companyId, [
        sourceIssueId,
      ]);
      return readiness.get(sourceIssueId)?.unresolvedBlockerIssueIds ?? [];
    },
    async resolveIsLowTrust({ companyId, principalAgentId, issue }) {
      // A non-UUID principal cannot be looked up and cannot prove standard
      // trust: fail closed without sending it into a uuid column.
      if (!isUuidLike(principalAgentId) || !isUuidLike(companyId)) return true;
      const [agent, project] = await Promise.all([
        db
          .select({
            companyId: agents.companyId,
            permissions: agents.permissions,
          })
          .from(agents)
          .where(
            and(
              eq(agents.id, principalAgentId),
              eq(agents.companyId, companyId),
            ),
          )
          .then((rows) => rows[0] ?? null),
        issue.projectId
          ? db
              .select({
                companyId: projects.companyId,
                executionWorkspacePolicy: projects.executionWorkspacePolicy,
              })
              .from(projects)
              .where(
                and(
                  eq(projects.id, issue.projectId),
                  eq(projects.companyId, companyId),
                ),
              )
              .then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
      ]);
      // An unknown principal cannot prove standard trust: fail closed.
      if (!agent) return true;
      const resolution = resolveCoreTrustPreset({
        companyId,
        agent,
        project,
        issue: { companyId, executionPolicy: issue.executionPolicy },
        run: null,
      });
      // `denied` also fails closed into the low-trust preflight deny.
      return resolution.kind !== "standard";
    },
    async resolveWorkspace(companyId, workspaceId) {
      if (!isUuidLike(workspaceId) || !isUuidLike(companyId)) return null;
      const rows = await db
        .select({
          id: executionWorkspaces.id,
          companyId: executionWorkspaces.companyId,
          transport: executionWorkspaces.providerType,
          sourceIssueId: executionWorkspaces.sourceIssueId,
          status: executionWorkspaces.status,
          closedAt: executionWorkspaces.closedAt,
          openedAt: executionWorkspaces.openedAt,
          cwd: executionWorkspaces.cwd,
          providerRef: executionWorkspaces.providerRef,
        })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.id, workspaceId),
            eq(executionWorkspaces.companyId, companyId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    resolveDeployedImageAttestation: () =>
      readDeployedImageAttestationFromEnv(opts.env),
    logDecision: opts.logDecision,
  };
}
