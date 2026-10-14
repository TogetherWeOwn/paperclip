/**
 * Test-author slice: source-bound transport-only validation contracts.
 *
 * TEST-ONLY. No implementation in this change.
 *
 * - Every `contract:` test below is expected to FAIL on the current head (the
 *   operation does not exist yet) and turn green only after the paired Builder
 *   slice provides it. Red proof (12 failing contracts) is recorded in the
 *   pull request description; the suite stays red until the Builder slice lands.
 * - Every `non-substitute:` test PASSES on the current head. They pin the
 *   proved remainder: heartbeat wake, issue checkout, adapter test-environment
 *   capability classification, workspace realization parsing, and the
 *   low-trust helper are NOT transport-only validation and must not be
 *   accepted as substitutes by the Builder slice.
 *
 * Source remainder (do not re-inspect here): the source-issue host receipt
 * (2026-10-13 read-only inspection) found no supported source-issue-bound
 * transport-only validation in the inspected server/src seams (heartbeat
 * realization, workspace-runtime, dispatch) and no source-to-image
 * attestation. That inspection is NOT proof of runtime-wide absence.
 *
 * Builder contract (paired change): implement and export
 * `validateSourceTransportOnly` from
 * `server/src/services/source-transport-validation.ts` with exactly the
 * input/result shape typed below. The operation MUST:
 *   1. authorize the intended principal for the given source issue
 *      (principalAgentId must equal the source issue's assignee);
 *   2. preserve the dependency recheck (`issue_dependencies_blocked`) and the
 *      low-trust security preflight (`low_trust_preflight_denied`);
 *   3. validate the selected workspace in that principal transport
 *      (`workspace_transport_mismatch` on mismatch);
 *   4. terminate under an enforced `transport-only` boundary BEFORE any
 *      runtime-service / product / staging execution: the `effects` callbacks,
 *      when supplied, must NEVER be invoked, and every result carries
 *      `boundary: "transport-only"` plus `runtimeInvoked: false`.
 *
 * This file calls only pure, side-effect-free helpers. It performs no wake,
 * no checkout, no workspace realization, no staging/Discord execution, uses
 * no credentials, and changes no model config. All identifiers are synthetic.
 */

import { describe, expect, it } from "vitest";
import * as agentPermissions from "../services/agent-permissions.js";
import { classifyEnvironmentCapabilities } from "../services/environment-runtime.js";
import * as dispatchPolicy from "../modules/run-dispatch/domain/policy.js";
import type {
  QueuedRunFacts,
  ReviewParticipantFacts,
  ScheduledRetryFacts,
} from "../modules/run-dispatch/domain/policy.js";
import { readWorkspaceRealizationRequest } from "../services/workspace-realization.js";

// ---------------------------------------------------------------------------
// Future operation shape (the Builder slice must provide this).
// ---------------------------------------------------------------------------

const TRANSPORT_MODULE_SPECIFIERS = [
  "../services/source-transport-validation.js",
  "../services/source-transport-only-validation.js",
] as const;

const TRANSPORT_OP_NAMES = [
  "validateSourceTransportOnly",
  "validateSourceTransport",
] as const;

type TransportOnlyValidationInput = {
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
  effects?: {
    startRuntimeService?: () => unknown;
    executeProduct?: () => unknown;
    executeStaging?: () => unknown;
  } | null;
};

type TransportOnlyValidationResult =
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

type TransportOnlyValidationOp = (
  input: TransportOnlyValidationInput,
) => Promise<TransportOnlyValidationResult> | TransportOnlyValidationResult;

async function tryDynamicImport(
  specifier: string,
): Promise<Record<string, unknown> | null> {
  try {
    const loader = Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<unknown>;
    return (await loader(specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickTransportOp(
  mod: Record<string, unknown> | null,
): TransportOnlyValidationOp | null {
  if (!mod) return null;
  for (const name of TRANSPORT_OP_NAMES) {
    if (typeof mod[name] === "function") {
      return mod[name] as TransportOnlyValidationOp;
    }
  }
  return null;
}

let cachedTransportOp: TransportOnlyValidationOp | null | undefined;
async function resolveTransportOnlyOp(): Promise<TransportOnlyValidationOp | null> {
  if (cachedTransportOp !== undefined) return cachedTransportOp;
  for (const specifier of TRANSPORT_MODULE_SPECIFIERS) {
    const op = pickTransportOp(await tryDynamicImport(specifier));
    if (op) {
      cachedTransportOp = op;
      return op;
    }
  }
  cachedTransportOp = null;
  return null;
}

const MISSING_OP =
  "missing validateSourceTransportOnly: the paired Builder slice must export it " +
  "from server/src/services/source-transport-validation.ts (see the paired Builder change)";

async function requireTransportOnlyOp(): Promise<TransportOnlyValidationOp> {
  const op = await resolveTransportOnlyOp();
  // NOTE: never `expect(op).toBeDefined()` here: toBeDefined passes for null,
  // which would let these contracts pass vacuously without an implementation.
  if (op === null) throw new Error(MISSING_OP);
  return op;
}

// ---------------------------------------------------------------------------
// Synthetic fixtures (no production data, no credentials).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-01T00:00:00.000Z");
const SOURCE_ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const WRONG_PRINCIPAL_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const BLOCKER_ISSUE_ID = "55555555-5555-4555-8555-555555555555";

function baseValidInput(): TransportOnlyValidationInput {
  return {
    sourceIssueId: SOURCE_ISSUE_ID,
    principalAgentId: PRINCIPAL_AGENT_ID,
    issueAssigneeAgentId: PRINCIPAL_AGENT_ID,
    workspaceId: WORKSPACE_ID,
    transport: "local_fs",
    workspaceTransport: "local_fs",
    dependenciesBlocked: null,
    isLowTrust: false,
    requestedToolClass: null,
    effects: null,
  };
}

function noReviewParticipant(): ReviewParticipantFacts {
  return {
    isInReview: false,
    hasParticipant: false,
    participantIsAgent: false,
    participantAgentId: null,
    currentStageType: null,
    currentParticipant: null,
  };
}

function baseScheduledRetryFacts(): ScheduledRetryFacts {
  return {
    runId: "run-1",
    runAgentId: PRINCIPAL_AGENT_ID,
    issueId: SOURCE_ISSUE_ID,
    retryReasonKind: "other",
    enforceIssueExecutionLock: false,
    budgetBlock: null,
    agentInvokable: true,
    agentInvokabilityDetails: {},
    agentInvokabilityInvalidOrgChain: false,
    heartbeatWakeOnDemandEnabled: true,
    issueFound: true,
    issueStatus: "in_progress",
    issueAssigneeAgentId: PRINCIPAL_AGENT_ID,
    issueExecutionRunId: "run-1",
    isNonAssigneeWorkspaceBusyRetry: false,
    reviewParticipant: noReviewParticipant(),
    activePauseHold: null,
    dependenciesBlocked: null,
    dispositionRepair: null,
  };
}

// ---------------------------------------------------------------------------
// Failing contracts (red on current head; green only after Builder slice).
// ---------------------------------------------------------------------------

describe("contract: source-bound transport-only validation", () => {
  it("contract: exposes a source-issue-bound transport-only validation operation", async () => {
    const op = await requireTransportOnlyOp();
  });

  it("contract: authorizes the intended principal for the given source issue", async () => {
    const op = await requireTransportOnlyOp();
    const allowed = await op(baseValidInput());
    expect(allowed).toMatchObject({
      ok: true,
      boundary: "transport-only",
      runtimeInvoked: false,
      validatedWorkspaceId: WORKSPACE_ID,
    });
    const denied = await op({
      ...baseValidInput(),
      principalAgentId: WRONG_PRINCIPAL_AGENT_ID,
    });
    expect(denied).toMatchObject({
      ok: false,
      errorCode: "unauthorized_principal",
      boundary: "transport-only",
      runtimeInvoked: false,
    });
  });

  it("contract: preserves the issue_dependencies_blocked recheck", async () => {
    const op = await requireTransportOnlyOp();
    const blocked = await op({
      ...baseValidInput(),
      dependenciesBlocked: { unresolvedBlockerIssueIds: [BLOCKER_ISSUE_ID] },
    });
    expect(blocked).toMatchObject({
      ok: false,
      errorCode: "issue_dependencies_blocked",
      boundary: "transport-only",
      runtimeInvoked: false,
    });
    const clear = await op({
      ...baseValidInput(),
      dependenciesBlocked: null,
    });
    expect(clear).toMatchObject({ ok: true });
  });

  it("contract: enforces the low-trust security preflight", async () => {
    const op = await requireTransportOnlyOp();
    const denied = await op({
      ...baseValidInput(),
      isLowTrust: true,
      requestedToolClass: "runtime.manage",
    });
    expect(denied).toMatchObject({
      ok: false,
      errorCode: "low_trust_preflight_denied",
      boundary: "transport-only",
      runtimeInvoked: false,
    });
    const standard = await op({
      ...baseValidInput(),
      isLowTrust: false,
      requestedToolClass: "runtime.manage",
    });
    expect(standard).toMatchObject({ ok: true });
  });

  it("contract: validates the selected workspace in the principal transport", async () => {
    const op = await requireTransportOnlyOp();
    const matched = await op(baseValidInput());
    expect(matched).toMatchObject({
      ok: true,
      validatedWorkspaceId: WORKSPACE_ID,
    });
    const mismatched = await op({
      ...baseValidInput(),
      workspaceTransport: "remote_managed",
    });
    expect(mismatched).toMatchObject({
      ok: false,
      errorCode: "workspace_transport_mismatch",
      boundary: "transport-only",
      runtimeInvoked: false,
    });
  });

  it("contract: terminates under an enforced boundary before runtime/product/staging execution", async () => {
    const op = await requireTransportOnlyOp();
    let runtimeServiceCalls = 0;
    let productCalls = 0;
    let stagingCalls = 0;
    const result = await op({
      ...baseValidInput(),
      effects: {
        startRuntimeService: () => {
          runtimeServiceCalls += 1;
        },
        executeProduct: () => {
          productCalls += 1;
        },
        executeStaging: () => {
          stagingCalls += 1;
        },
      },
    });
    expect(runtimeServiceCalls).toBe(0);
    expect(productCalls).toBe(0);
    expect(stagingCalls).toBe(0);
    expect(result).toMatchObject({
      boundary: "transport-only",
      runtimeInvoked: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Negative tests (green on current head; pin the proved remainder).
// ---------------------------------------------------------------------------

describe("non-substitute: existing operations are not transport-only validation", () => {
  it("non-substitute: heartbeat wake (scheduled-retry promotion gate) carries no transport-only boundary", () => {
    const decision = dispatchPolicy.decideScheduledRetryGate(
      baseScheduledRetryFacts(),
      NOW,
    );
    expect(decision).toEqual({ allowed: true });
    expect("boundary" in decision).toBe(false);
    expect("validatedWorkspaceId" in decision).toBe(false);
    expect("transport" in decision).toBe(false);
  });

  it("non-substitute: issue checkout (execution-lock match) is not transport-only validation", () => {
    const decision = dispatchPolicy.decideScheduledRetryGate(
      {
        ...baseScheduledRetryFacts(),
        retryReasonKind: "max_turn_continuation",
        enforceIssueExecutionLock: true,
        issueExecutionRunId: "run-owned-by-someone-else",
      },
      NOW,
    );
    expect(decision).toMatchObject({
      allowed: false,
      errorCode: "issue_execution_lock_changed",
    });
    expect("boundary" in decision).toBe(false);
    expect("validatedWorkspaceId" in decision).toBe(false);
  });

  it("non-substitute: queued-run staleness recheck carries no transport-only boundary", () => {
    const facts: QueuedRunFacts = {
      runId: "run-1",
      runAgentId: PRINCIPAL_AGENT_ID,
      issueId: SOURCE_ISSUE_ID,
      retryReasonKind: "other",
      issueFound: false,
      issueStatus: "in_progress",
      issueAssigneeAgentId: PRINCIPAL_AGENT_ID,
      issueExecutionRunId: "run-1",
      isResolvedInteractionContinuation: false,
      isInteractionWake: false,
      isAuthorizedSourceScopedRecovery: false,
      isNonAssigneeWorkspaceBusyRetry: false,
      resumeIntent: false,
      wakeCommentIdPresent: false,
      continuationParkApplies: false,
      continuationParksExecutor: false,
      continuationSummaryBody: null,
      wakeReason: null,
      retryReason: null,
      reviewParticipant: noReviewParticipant(),
    };
    const decision = dispatchPolicy.decideQueuedRunStaleness(facts, NOW);
    expect(decision).toMatchObject({
      stale: true,
      errorCode: "issue_not_found",
    });
    expect("boundary" in decision).toBe(false);
    expect("validatedWorkspaceId" in decision).toBe(false);
  });

  it("non-substitute: adapter test-environment capability classification is not source-bound validation", () => {
    const effective = classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentExecute"],
    }) as unknown as Record<string, unknown>;
    expect("boundary" in effective).toBe(false);
    expect("sourceIssueId" in effective).toBe(false);
    expect("validatedWorkspaceId" in effective).toBe(false);
  });

  it("non-substitute: workspace realization parsing performs no transport-only validation", () => {
    const parsed = readWorkspaceRealizationRequest({
      version: 1,
      adapterType: "synthetic-adapter",
      companyId: SOURCE_ISSUE_ID,
      environmentId: WORKSPACE_ID,
      heartbeatRunId: "run-1",
      source: { localPath: "/synthetic/workspace" },
    });
    expect(parsed).not.toBeNull();
    const record = parsed as unknown as Record<string, unknown>;
    for (const key of [
      "boundary",
      "transportOnly",
      "validatedWorkspaceId",
      "digest",
      "attestation",
    ]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("non-substitute: low-trust helper alone authorizes no principal transport", () => {
    expect(agentPermissions.permissionsImplyLowTrust({})).toBe(false);
    const verdict = agentPermissions.permissionsImplyLowTrust(
      {},
    ) as unknown;
    expect(typeof verdict).toBe("boolean");
    expect("boundary" in Object(verdict)).toBe(false);
  });

  it("non-substitute: no current seam module exports the validation operation", () => {
    for (const mod of [dispatchPolicy, agentPermissions]) {
      const record = mod as unknown as Record<string, unknown>;
      for (const name of TRANSPORT_OP_NAMES) {
        expect(name in record, `"${name}" must stay absent from seam modules`).toBe(false);
      }
    }
  });
});
