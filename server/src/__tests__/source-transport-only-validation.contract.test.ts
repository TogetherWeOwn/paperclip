/**
 * Source-bound transport-only validation contracts.
 *
 * Implementation is present in
 * `server/src/services/source-transport-validation.ts` and this suite is
 * green, pinning the implementation. The `contract:` tests below are the
 * executable contract: they fail if the operation regresses.
 *
 * - Initial red proof (6 failing contracts on this file; CISO follow-up
 *   items 1-4) is recorded in the pull request description; the Builder
 *   slice has landed so the suite stays green.
 * - The resolver below uses ONLY the canonical module path and export name
 *   (CISO item 1) and surfaces resolution failures with their real cause
 *   instead of swallowing them.
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
import type {
  QueuedRunFacts,
  ReviewParticipantFacts,
  ScheduledRetryFacts,
} from "../modules/run-dispatch/domain/policy.js";
import * as dispatchPolicy from "../modules/run-dispatch/domain/policy.js";
import * as agentPermissions from "../services/agent-permissions.js";
import { classifyEnvironmentCapabilities } from "../services/environment-runtime.js";
import {
  type ValidateSourceTransportOnlyInput,
  type ValidateSourceTransportOnlyResult,
  validateSourceTransportOnly,
} from "../services/source-transport-validation.js";
import { readWorkspaceRealizationRequest } from "../services/workspace-realization.js";

// ---------------------------------------------------------------------------
// Future operation shape (the Builder slice must provide this).
//
// Canonical location ONLY (CISO item 1): the resolver consults exactly one
// module specifier and one export name. Resolving fallback aliases would let
// production and tests diverge, so aliases are never consulted here.
// ---------------------------------------------------------------------------

/** Canonical module specifier for the Builder-owned operation. */
const TRANSPORT_MODULE_SPECIFIER: string =
  "../services/source-transport-validation.js";
/** Canonical export name for the Builder-owned operation. */
const TRANSPORT_OP_NAME = "validateSourceTransportOnly";

// Legacy alias names stay pinned as NEVER-exported by the `non-substitute:`
// seam test at the bottom of this file; they exist only in that negative
// assertion and must not be added back to the resolver above.
const TRANSPORT_OP_NAMES = [
  "validateSourceTransportOnly",
  "validateSourceTransport",
] as const;

// Contract types are the implementation's exported types directly, so a
// signature change in `source-transport-validation.ts` fails typecheck here.
type TransportOnlyValidationInput = ValidateSourceTransportOnlyInput;
type TransportOnlyValidationResult = ValidateSourceTransportOnlyResult;

type TransportOnlyValidationOp = (
  input: TransportOnlyValidationInput,
) => Promise<TransportOnlyValidationResult> | TransportOnlyValidationResult;

// Compiler pins the contract to the implementation: a signature change in
// `source-transport-validation.ts` fails typecheck here.
const _directTransportOp: TransportOnlyValidationOp =
  validateSourceTransportOnly;
void _directTransportOp;

async function resolveTransportOnlyOp(): Promise<TransportOnlyValidationOp> {
  // In-module dynamic import (never `new Function("return import(...)")`):
  // the Function form evaluates in global scope, so a relative specifier can
  // never resolve against this file and every failure collapses to a bare
  // `null`. Here the specifier resolves against this test module and the real
  // resolution cause propagates instead of being swallowed.
  // `TRANSPORT_MODULE_SPECIFIER` is typed `string` (not a literal) so the
  // typechecker does not try to resolve the Builder-owned module at compile
  // time; `/* @vite-ignore */` keeps Vitest from statically analyzing it.
  let mod: Record<string, unknown>;
  try {
    mod = (await import(
      /* @vite-ignore */ TRANSPORT_MODULE_SPECIFIER
    )) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `missing ${TRANSPORT_OP_NAME}: failed to import ${TRANSPORT_MODULE_SPECIFIER} ` +
        `(the paired Builder slice must export ${TRANSPORT_OP_NAME} from ` +
        `server/src/services/source-transport-validation.ts)`,
      { cause },
    );
  }
  const candidate = mod[TRANSPORT_OP_NAME];
  if (typeof candidate !== "function") {
    throw new Error(
      `missing ${TRANSPORT_OP_NAME}: ${TRANSPORT_MODULE_SPECIFIER} resolved ` +
        `but does not export a function named "${TRANSPORT_OP_NAME}" ` +
        `(exports: ${Object.keys(mod).join(", ") || "<none>"})`,
    );
  }
  return candidate as TransportOnlyValidationOp;
}

async function requireTransportOnlyOp(): Promise<TransportOnlyValidationOp> {
  // NOTE: never `expect(op).toBeDefined()` here: toBeDefined passes for null,
  // which would let these contracts pass vacuously without an implementation.
  return resolveTransportOnlyOp();
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
    expect(typeof op).toBe("function");
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

  it("contract: never invokes effects callbacks on deny paths", async () => {
    const op = await requireTransportOnlyOp();
    const denyInputs: TransportOnlyValidationInput[] = [
      { ...baseValidInput(), principalAgentId: WRONG_PRINCIPAL_AGENT_ID },
      {
        ...baseValidInput(),
        dependenciesBlocked: { unresolvedBlockerIssueIds: [BLOCKER_ISSUE_ID] },
      },
      {
        ...baseValidInput(),
        isLowTrust: true,
        requestedToolClass: "runtime.manage",
      },
      { ...baseValidInput(), workspaceTransport: "remote_managed" },
    ];
    for (const input of denyInputs) {
      let calls = 0;
      const counting = () => {
        calls += 1;
      };
      const result = await op({
        ...input,
        effects: {
          startRuntimeService: counting,
          executeProduct: counting,
          executeStaging: counting,
        },
      });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        boundary: "transport-only",
        runtimeInvoked: false,
      });
      expect(calls).toBe(0);
    }
  });

  it("contract: denies empty identities as unauthorized_principal (fail-closed)", async () => {
    const op = await requireTransportOnlyOp();
    const emptyIdentityInputs: TransportOnlyValidationInput[] = [
      {
        ...baseValidInput(),
        principalAgentId: undefined as unknown as string,
        issueAssigneeAgentId: undefined as unknown as string,
      },
      { ...baseValidInput(), principalAgentId: "", issueAssigneeAgentId: "" },
    ];
    for (const input of emptyIdentityInputs) {
      const result = await op(input);
      expect(result).toMatchObject({
        ok: false,
        errorCode: "unauthorized_principal",
        boundary: "transport-only",
        runtimeInvoked: false,
      });
    }
  });

  it("contract: denies empty transports as workspace_transport_mismatch (fail-closed)", async () => {
    const op = await requireTransportOnlyOp();
    const emptyTransportInputs: TransportOnlyValidationInput[] = [
      {
        ...baseValidInput(),
        transport: undefined as unknown as string,
        workspaceTransport: undefined as unknown as string,
      },
      { ...baseValidInput(), transport: "", workspaceTransport: "" },
    ];
    for (const input of emptyTransportInputs) {
      const result = await op(input);
      expect(result).toMatchObject({
        ok: false,
        errorCode: "workspace_transport_mismatch",
        boundary: "transport-only",
        runtimeInvoked: false,
      });
    }
  });

  it("contract: denies malformed dependenciesBlocked as issue_dependencies_blocked (fail-closed)", async () => {
    const op = await requireTransportOnlyOp();
    const malformed = [
      {},
      { unresolvedBlockerIssueIds: "not-an-array" },
      { unresolvedBlockerIssueIds: null },
    ] as unknown as TransportOnlyValidationInput["dependenciesBlocked"][];
    for (const dependenciesBlocked of malformed) {
      const result = await op({ ...baseValidInput(), dependenciesBlocked });
      expect(result).toMatchObject({
        ok: false,
        errorCode: "issue_dependencies_blocked",
        boundary: "transport-only",
        runtimeInvoked: false,
      });
    }
  });

  it("contract: denies empty or missing sourceIssueId as unauthorized_principal (fail-closed)", async () => {
    const op = await requireTransportOnlyOp();
    const inputs: TransportOnlyValidationInput[] = [
      { ...baseValidInput(), sourceIssueId: "" },
      {
        ...baseValidInput(),
        sourceIssueId: undefined as unknown as string,
      },
      { ...baseValidInput(), sourceIssueId: "OTHER-ISSUE-ID" },
    ];
    // Empty/missing bindings deny; a well-formed id distinct from the fixture
    // still authorizes here because the pure core only proves non-emptiness —
    // issue-ownership lookup happens at the caller seam, not in this helper.
    const expected: Array<"unauthorized_principal" | "ok"> = [
      "unauthorized_principal",
      "unauthorized_principal",
      "ok",
    ];
    for (let index = 0; index < inputs.length; index += 1) {
      const result = await op(inputs[index] as TransportOnlyValidationInput);
      if (expected[index] === "ok") {
        expect(result).toMatchObject({ ok: true });
      } else {
        expect(result).toMatchObject({
          ok: false,
          errorCode: "unauthorized_principal",
          boundary: "transport-only",
          runtimeInvoked: false,
        });
      }
    }
  });

  it("contract: denies empty or missing workspaceId as workspace_transport_mismatch (fail-closed)", async () => {
    const op = await requireTransportOnlyOp();
    const inputs: TransportOnlyValidationInput[] = [
      { ...baseValidInput(), workspaceId: "" },
      {
        ...baseValidInput(),
        workspaceId: undefined as unknown as string,
      },
    ];
    for (const input of inputs) {
      const result = await op(input);
      expect(result).toMatchObject({
        ok: false,
        errorCode: "workspace_transport_mismatch",
        boundary: "transport-only",
        runtimeInvoked: false,
      });
    }
  });

  it.each(["true", 1, "yes", {}, [], null, undefined] as const)(
    "contract: denies non-boolean isLowTrust %s as low_trust_preflight_denied (fail-closed)",
    async (isLowTrust) => {
      const op = await requireTransportOnlyOp();
      const result = await op({
        ...baseValidInput(),
        isLowTrust: isLowTrust as unknown as boolean,
      });
      expect(result).toMatchObject({
        ok: false,
        errorCode: "low_trust_preflight_denied",
        boundary: "transport-only",
        runtimeInvoked: false,
      });
    },
  );

  // CISO exact item 4 (strict reading): under low trust, `requestedToolClass`
  // denies AFTER normalization (trim + lowercase) — including `null` and
  // unknown-but-equivalent labels. This pins the strict superset of CISO
  // condition 3 ("any non-empty class denies"); the condition-3/item-4 `null`
  // ambiguity is raised for CISO resolution on the card and must not be
  // silently weakened here.
  it.each([
    null,
    "Runtime.Manage",
    "runtime.manage ",
    "shell.execute",
    "  Custom.Tool  ",
  ] as const)(
    "contract: denies low-trust tool class %s after normalization",
    async (requestedToolClass) => {
      const op = await requireTransportOnlyOp();
      const result = await op({
        ...baseValidInput(),
        isLowTrust: true,
        requestedToolClass,
      });
      expect(result).toMatchObject({
        ok: false,
        errorCode: "low_trust_preflight_denied",
        boundary: "transport-only",
        runtimeInvoked: false,
      });
    },
  );
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
    const verdict = agentPermissions.permissionsImplyLowTrust({}) as unknown;
    expect(typeof verdict).toBe("boolean");
    expect("boundary" in Object(verdict)).toBe(false);
  });

  it("non-substitute: no current seam module exports the validation operation", () => {
    for (const mod of [dispatchPolicy, agentPermissions]) {
      const record = mod as unknown as Record<string, unknown>;
      for (const name of TRANSPORT_OP_NAMES) {
        expect(
          name in record,
          `"${name}" must stay absent from seam modules`,
        ).toBe(false);
      }
    }
  });
});
