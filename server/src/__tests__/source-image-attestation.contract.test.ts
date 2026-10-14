/**
 * Test-author slice: source-to-deployed-image attestation contracts.
 *
 * TEST-ONLY. No implementation in this change.
 *
 * DIGEST PINNING, NOT PROVENANCE: a success result proves only that two
 * caller-supplied digest strings matched at validation time. It does not
 * prove what source built an image, what is deployed, or that any
 * registry/signature check ran. There is deliberately NO registry allowlist:
 * any registry (including unknown or untrusted hosts) validates when the
 * digests match (see the `evil.example.com` test below).
 *
 * - Every `contract:` test below is expected to FAIL until the paired Builder
 *   slice provides the operation (initial red proof: 6 failing contracts on
 *   this file; CISO follow-up items 1, 5-7 extend the suite and stay red
 *   until the Builder slice satisfies them). Red proof is recorded in the
 *   pull request description; the suite stays red until the Builder slice
 *   lands.
 * - The resolver below uses ONLY the canonical module path and export name
 *   (CISO item 1) and surfaces resolution failures with their real cause
 *   instead of swallowing them.
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
import type {
  QueuedRunFacts,
  ReviewParticipantFacts,
} from "../modules/run-dispatch/domain/policy.js";
import * as dispatchPolicy from "../modules/run-dispatch/domain/policy.js";
import * as agentPermissions from "../services/agent-permissions.js";
import * as environmentRuntime from "../services/environment-runtime.js";
import { readWorkspaceRealizationRequest } from "../services/workspace-realization.js";

// ---------------------------------------------------------------------------
// Future operation shape (the Builder slice must provide this).
//
// Canonical location ONLY (CISO item 1): the resolver consults exactly one
// module specifier and one export name. Resolving fallback aliases would let
// production and tests diverge, so aliases are never consulted here.
// ---------------------------------------------------------------------------

/** Canonical module specifier for the Builder-owned operation. */
const ATTEST_MODULE_SPECIFIER: string =
  "../services/source-image-attestation.js";
/** Canonical export name for the Builder-owned operation. */
const ATTEST_OP_NAME = "verifySourceImageAttestation";

// Legacy alias names stay pinned as NEVER-exported by the `non-substitute:`
// seam test at the bottom of this file; they exist only in that negative
// assertion and must not be added back to the resolver above.
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
      errorCode:
        | "mutable_tag_refused"
        | "digest_mismatch"
        | "digest_unparseable";
    };

type SourceImageAttestationOp = (
  input: SourceImageAttestationInput,
) => Promise<SourceImageAttestationResult> | SourceImageAttestationResult;

async function resolveAttestOp(): Promise<SourceImageAttestationOp> {
  // In-module dynamic import (never `new Function("return import(...)")`):
  // the Function form evaluates in global scope, so a relative specifier can
  // never resolve against this file and every failure collapses to a bare
  // `null`. Here the specifier resolves against this test module and the real
  // resolution cause propagates instead of being swallowed.
  // `ATTEST_MODULE_SPECIFIER` is typed `string` (not a literal) so the
  // typechecker does not try to resolve the Builder-owned module at compile
  // time; `/* @vite-ignore */` keeps Vitest from statically analyzing it.
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ ATTEST_MODULE_SPECIFIER)) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    throw new Error(
      `missing ${ATTEST_OP_NAME}: failed to import ${ATTEST_MODULE_SPECIFIER} ` +
        `(the paired Builder slice must export ${ATTEST_OP_NAME} from ` +
        `server/src/services/source-image-attestation.ts)`,
      { cause },
    );
  }
  const candidate = mod[ATTEST_OP_NAME];
  if (typeof candidate !== "function") {
    throw new Error(
      `missing ${ATTEST_OP_NAME}: ${ATTEST_MODULE_SPECIFIER} resolved ` +
        `but does not export a function named "${ATTEST_OP_NAME}" ` +
        `(exports: ${Object.keys(mod).join(", ") || "<none>"})`,
    );
  }
  return candidate as SourceImageAttestationOp;
}

async function requireAttestOp(): Promise<SourceImageAttestationOp> {
  // NOTE: never `expect(op).toBeDefined()` here: toBeDefined passes for null,
  // which would let these contracts pass vacuously without an implementation.
  return resolveAttestOp();
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
  // CISO item 6: bare repository (implicit `:latest`) and `:dev`/`:edge` tags
  // are mutable forms too. All entries stay `@`-free so the `non-substitute:`
  // digest-absence checks below keep passing unchanged.
  "registry.example.com/paperclip-bot",
  "registry.example.com/paperclip-bot:dev",
  "registry.example.com/paperclip-bot:edge",
] as const;

/**
 * Tagged references that still carry a digest MUST also refuse: mutability
 * wins over the digest binding (CISO item 6). Kept out of `MUTABLE_TAGS`
 * because these contain `@sha256:` by construction.
 */
const MUTABLE_TAGGED_PINNED = [
  `registry.example.com/paperclip-bot:dev@${PINNED_DIGEST}`,
  `registry.example.com/paperclip-bot:edge@${PINNED_DIGEST}`,
] as const;

/** Malformed digest forms that must report `digest_unparseable` (CISO item 5). */
const UNPARSEABLE_REFERENCES = [
  `registry.example.com/paperclip-bot@sha256:not-hex`,
  `registry.example.com/paperclip-bot@sha256:ab12`,
  `registry.example.com/paperclip-bot@sha256:${"ab".repeat(33)}`,
  `registry.example.com/paperclip-bot@sha256:${"AB".repeat(32)}`,
  `registry.example.com/paperclip-bot@sha512:${"ab".repeat(32)}`,
  `registry.example.com/paperclip-bot@md5:${"ab".repeat(32)}`,
  `registry.example.com/paperclip-bot@sha256:`,
  `registry.example.com/sha256:${"ab".repeat(32)}/paperclip-bot`,
  `registry.example.com/paperclip-bot@sha256:${"ab".repeat(32)}@extra`,
  `@sha256:${"ab".repeat(32)}`,
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
    expect(typeof op).toBe("function");
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

  it.each(MUTABLE_TAGGED_PINNED)(
    "contract: refuses tagged-but-pinned references as mutable (%s)",
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

  it.each(UNPARSEABLE_REFERENCES)(
    "contract: reports malformed digests as digest_unparseable (%s)",
    async (imageReference) => {
      const op = await requireAttestOp();
      const result = await op({
        sourceRevision: SOURCE_REVISION,
        imageReference,
        expectedDigest: PINNED_DIGEST,
      });
      expect(result).toMatchObject({
        ok: false,
        errorCode: "digest_unparseable",
      });
    },
  );

  it("contract: reports a malformed expectedDigest as digest_unparseable", async () => {
    const op = await requireAttestOp();
    const malformedExpected = [
      "not-a-digest",
      "",
      `sha256:${"AB".repeat(32)}`,
      `sha512:${"ab".repeat(32)}`,
    ];
    for (const expectedDigest of malformedExpected) {
      const result = await op({
        sourceRevision: SOURCE_REVISION,
        imageReference: PINNED_REFERENCE,
        expectedDigest,
      });
      expect(result).toMatchObject({
        ok: false,
        errorCode: "digest_unparseable",
      });
    }
  });

  it("contract: validates any registry when digests match (no allowlist)", async () => {
    const op = await requireAttestOp();
    const result = await op({
      sourceRevision: SOURCE_REVISION,
      imageReference: `evil.example.com/anything@${PINNED_DIGEST}`,
      expectedDigest: PINNED_DIGEST,
    });
    expect(result).toMatchObject({
      ok: true,
      digest: PINNED_DIGEST,
      verifiedAtValidationTime: true,
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

  it.each(MUTABLE_TAGS)(
    "non-substitute: mutable tag carries no digest (%s)",
    (tag) => {
      expect(tag.includes("@sha256:")).toBe(false);
    },
  );

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
        expect(
          name in record,
          `"${name}" must stay absent from seam modules`,
        ).toBe(false);
      }
    }
  });
});
