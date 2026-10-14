/**
 * Test-author slice: source-to-deployed-image attestation contracts.
 *
 * TEST-ONLY. No implementation in this change.
 *
 * - Every `contract:` test below is expected to FAIL on the current head (the
 *   operation does not exist yet) and turn green only after the paired Builder
 *   slice provides it. Red proof (6 failing contracts) is recorded in the
 *   pull request description; the suite stays red until the Builder slice lands.
 * - Every `non-substitute:` test PASSES on the current head. They pin the
 *   proved remainder: a mutable image tag (including
 *   `paperclip-local:2026.1005.0-tog.9-9c0a032bb` from the source-issue receipt)
 *   is NOT attestation, and the dispatch gates, capability classification, and
 *   workspace realization parsing carry no digest binding. Build-time digest
 *   CI records and archive exports are not validation-time source-to-image
 *   binding, and must not be accepted as substitutes by the Builder slice.
 *
 * Builder contract (paired change): implement and export
 * `verifySourceImageAttestation` from
 * `server/src/services/source-image-attestation.ts` with exactly the
 * input/result shape typed below. The operation MUST:
 *   1. accept an exact OCI revision/digest binding
 *      (`<repository>@sha256:<64 hex>`) whose digest equals `expectedDigest`;
 *   2. REFUSE mutable-tag acceptance (`mutable_tag_refused`): any
 *      `<repository>:<tag>` reference without a digest, including `:latest`;
 *   3. verify the binding AT VALIDATION TIME (`verifiedAtValidationTime: true`,
 *      never deferred).
 *
 * This file calls only pure, side-effect-free helpers. It performs no wake,
 * no checkout, no workspace realization, no staging/Discord execution, uses
 * no credentials, and changes no model config. All identifiers are synthetic,
 * except the mutable tag quoted from the issue remainder itself.
 */

import { describe, expect, it } from "vitest";
import * as agentPermissions from "../services/agent-permissions.js";
import * as dispatchPolicy from "../modules/run-dispatch/domain/policy.js";
import type {
  QueuedRunFacts,
  ReviewParticipantFacts,
} from "../modules/run-dispatch/domain/policy.js";
import * as environmentRuntime from "../services/environment-runtime.js";
import { readWorkspaceRealizationRequest } from "../services/workspace-realization.js";

// ---------------------------------------------------------------------------
// Future operation shape (the Builder slice must provide this).
// ---------------------------------------------------------------------------

const ATTEST_MODULE_SPECIFIERS = [
  "../services/source-image-attestation.js",
  "../services/source-to-image-attestation.js",
] as const;

const ATTEST_OP_NAMES = [
  "verifySourceImageAttestation",
  "verifySourceImageBinding",
] as const;

type SourceImageAttestationInput = {
  sourceRevision: string;
  imageReference: string;
  /** Expected OCI digest, `sha256:<64 lowercase hex>`. */
  expectedDigest: string;
};

type SourceImageAttestationResult =
  | { ok: true; digest: string; verifiedAtValidationTime: true }
  | {
      ok: false;
      errorCode: "mutable_tag_refused" | "digest_mismatch" | "digest_unparseable";
    };

type SourceImageAttestationOp = (
  input: SourceImageAttestationInput,
) => Promise<SourceImageAttestationResult> | SourceImageAttestationResult;

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

function pickAttestOp(
  mod: Record<string, unknown> | null,
): SourceImageAttestationOp | null {
  if (!mod) return null;
  for (const name of ATTEST_OP_NAMES) {
    if (typeof mod[name] === "function") {
      return mod[name] as SourceImageAttestationOp;
    }
  }
  return null;
}

let cachedAttestOp: SourceImageAttestationOp | null | undefined;
async function resolveAttestOp(): Promise<SourceImageAttestationOp | null> {
  if (cachedAttestOp !== undefined) return cachedAttestOp;
  for (const specifier of ATTEST_MODULE_SPECIFIERS) {
    const op = pickAttestOp(await tryDynamicImport(specifier));
    if (op) {
      cachedAttestOp = op;
      return op;
    }
  }
  cachedAttestOp = null;
  return null;
}

const MISSING_OP =
  "missing verifySourceImageAttestation: the paired Builder slice must export it " +
  "from server/src/services/source-image-attestation.ts (see the paired Builder change)";

async function requireAttestOp(): Promise<SourceImageAttestationOp> {
  const op = await resolveAttestOp();
  // NOTE: never `expect(op).toBeDefined()` here: toBeDefined passes for null,
  // which would let these contracts pass vacuously without an implementation.
  if (op === null) throw new Error(MISSING_OP);
  return op;
}

// ---------------------------------------------------------------------------
// Synthetic fixtures (no production data, no credentials).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-01T00:00:00.000Z");
const SOURCE_REVISION = "9c0a032bb9c0a032bb9c0a032bb9c0a032bb9c0a03";
const PINNED_DIGEST = `sha256:${"ab".repeat(32)}`;
const OTHER_DIGEST = `sha256:${"cd".repeat(32)}`;
const PINNED_REFERENCE = `registry.example.com/paperclip-bot@${PINNED_DIGEST}`;
/** Mutable tag quoted from the source-issue receipt: a tag is not attestation. */
const MUTABLE_TAG_FROM_RECEIPT = "paperclip-local:2026.1005.0-tog.9-9c0a032bb";

const MUTABLE_TAGS = [
  MUTABLE_TAG_FROM_RECEIPT,
  "paperclip-local:latest",
  "registry.example.com/paperclip-bot:2026.1005.0",
] as const;

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

// ---------------------------------------------------------------------------
// Failing contracts (red on current head; green only after Builder slice).
// ---------------------------------------------------------------------------

describe("contract: source-to-deployed-image attestation", () => {
  it("contract: exposes a source-to-image attestation operation", async () => {
    const op = await requireAttestOp();
  });

  it("contract: accepts an exact OCI revision/digest binding verified at validation time", async () => {
    const op = await requireAttestOp();
    const result = await op({
      sourceRevision: SOURCE_REVISION,
      imageReference: PINNED_REFERENCE,
      expectedDigest: PINNED_DIGEST,
    });
    expect(result).toMatchObject({
      ok: true,
      digest: PINNED_DIGEST,
      verifiedAtValidationTime: true,
    });
    expect("deferred" in result).toBe(false);
  });

  it.each(MUTABLE_TAGS)(
    "contract: refuses mutable-tag acceptance (%s)",
    async (imageReference) => {
      const op = await requireAttestOp();
      const result = await op({
        sourceRevision: SOURCE_REVISION,
        imageReference,
        expectedDigest: PINNED_DIGEST,
      });
      expect(result).toMatchObject({
        ok: false,
        errorCode: "mutable_tag_refused",
      });
    },
  );

  it("contract: rejects a digest that does not match the expected binding", async () => {
    const op = await requireAttestOp();
    const result = await op({
      sourceRevision: SOURCE_REVISION,
      imageReference: PINNED_REFERENCE,
      expectedDigest: OTHER_DIGEST,
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "digest_mismatch",
    });
  });
});

// ---------------------------------------------------------------------------
// Negative tests (green on current head; pin the proved remainder).
// ---------------------------------------------------------------------------

describe("non-substitute: tags and existing operations are not attestation", () => {
  it("non-substitute: the receipt tag carries no digest binding", () => {
    expect(MUTABLE_TAG_FROM_RECEIPT.includes("@sha256:")).toBe(false);
    expect(MUTABLE_TAG_FROM_RECEIPT.split("@")).toHaveLength(1);
  });

  it.each(MUTABLE_TAGS)("non-substitute: mutable tag carries no digest (%s)", (tag) => {
    expect(tag.includes("@sha256:")).toBe(false);
  });

  it("non-substitute: queued-run staleness recheck carries no image digest binding", () => {
    const facts: QueuedRunFacts = {
      runId: "run-1",
      runAgentId: "22222222-2222-4222-8222-222222222222",
      issueId: "11111111-1111-4111-8111-111111111111",
      retryReasonKind: "other",
      issueFound: false,
      issueStatus: "in_progress",
      issueAssigneeAgentId: "22222222-2222-4222-8222-222222222222",
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
    const record = decision as unknown as Record<string, unknown>;
    for (const key of ["digest", "imageReference", "attestation"]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("non-substitute: adapter test-environment capability classification carries no digest binding", () => {
    const effective = environmentRuntime.classifyEnvironmentCapabilities({
      verifiedMethods: ["environmentExecute"],
    }) as unknown as Record<string, unknown>;
    for (const key of ["digest", "imageReference", "attestation"]) {
      expect(effective).not.toHaveProperty(key);
    }
  });

  it("non-substitute: workspace realization parsing carries no digest binding", () => {
    const parsed = readWorkspaceRealizationRequest({
      version: 1,
      adapterType: "synthetic-adapter",
      companyId: "11111111-1111-4111-8111-111111111111",
      environmentId: "44444444-4444-4444-8444-444444444444",
      heartbeatRunId: "run-1",
      source: { localPath: "/synthetic/workspace" },
    });
    expect(parsed).not.toBeNull();
    const record = parsed as unknown as Record<string, unknown>;
    for (const key of ["digest", "imageReference", "attestation"]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("non-substitute: no current seam module exports the attestation operation", () => {
    for (const mod of [dispatchPolicy, agentPermissions, environmentRuntime]) {
      const record = mod as unknown as Record<string, unknown>;
      for (const name of ATTEST_OP_NAMES) {
        expect(name in record, `"${name}" must stay absent from seam modules`).toBe(false);
      }
    }
  });
});
