/**
 * Source-bound transport validation operation (server wiring) tests.
 *
 * These pin the invokable entrypoint around the pure helpers: every fact
 * is resolved through the injected authoritative resolvers at invocation
 * time, the transport-only boundary holds (proof `effects` callbacks are
 * never invoked), and an `ok:true` receipt additionally requires the
 * trusted deployment record to pass digest pinning — mutable tags and a
 * missing record fail closed. All identifiers are synthetic.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type DeployedImageAttestationRecord,
  readDeployedImageAttestationFromEnv,
  runSourceBoundTransportValidation,
  type SourceBoundTransportValidationDeps,
} from "../services/source-bound-transport-validation-operation.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";
const SOURCE_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const ASSIGNEE_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WRONG_AGENT_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const BLOCKER_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_REVISION = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

const validRecord: DeployedImageAttestationRecord = {
  sourceRevision: SOURCE_REVISION,
  imageReference: `registry.example.com/paperclip-server@${DIGEST}`,
  expectedDigest: DIGEST,
};

function baseDeps(
  overrides: Partial<SourceBoundTransportValidationDeps> = {},
): SourceBoundTransportValidationDeps {
  return {
    resolveSourceIssue: async () => ({
      id: SOURCE_ISSUE_ID,
      companyId: COMPANY_ID,
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      projectId: null,
      executionPolicy: null,
      executionWorkspaceId: WORKSPACE_ID,
    }),
    resolveUnresolvedBlockerIssueIds: async () => [],
    resolveIsLowTrust: async () => false,
    resolveWorkspace: async () => ({
      id: WORKSPACE_ID,
      companyId: COMPANY_ID,
      transport: "local_fs",
      sourceIssueId: SOURCE_ISSUE_ID,
    }),
    resolveDeployedImageAttestation: () => validRecord,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function baseInput() {
  return {
    companyId: COMPANY_ID,
    sourceIssueId: SOURCE_ISSUE_ID,
    principalAgentId: ASSIGNEE_AGENT_ID,
    workspaceId: WORKSPACE_ID,
    transport: "local_fs",
  };
}

describe("source-bound transport validation operation", () => {
  it("returns a transport-only receipt for the source assignee with attested digest", async () => {
    const receipt = await runSourceBoundTransportValidation(
      baseDeps(),
      baseInput(),
    );
    expect(receipt).toMatchObject({
      ok: true,
      boundary: "transport-only",
      runtimeInvoked: false,
      sourceIssueId: SOURCE_ISSUE_ID,
      principalAgentId: ASSIGNEE_AGENT_ID,
      transport: {
        ok: true,
        validatedWorkspaceId: WORKSPACE_ID,
        checkedDependencies: true,
        preflight: "enforced",
      },
      attestation: {
        ok: true,
        digest: DIGEST,
        sourceRevision: SOURCE_REVISION,
      },
      validatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("denies a principal who is not the source issue assignee (server-resolved)", async () => {
    const receipt = await runSourceBoundTransportValidation(baseDeps(), {
      ...baseInput(),
      principalAgentId: WRONG_AGENT_ID,
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.transport).toMatchObject({
      ok: false,
      errorCode: "unauthorized_principal",
    });
    expect(receipt.attestation).toEqual({
      ok: false,
      errorCode: "not_evaluated",
    });
  });

  it("denies when the source issue is missing or in another company", async () => {
    for (const resolveSourceIssue of [
      async () => null,
      async () => ({
        id: SOURCE_ISSUE_ID,
        companyId: OTHER_COMPANY_ID,
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        projectId: null,
        executionPolicy: null,
        executionWorkspaceId: WORKSPACE_ID,
      }),
    ]) {
      const receipt = await runSourceBoundTransportValidation(
        baseDeps({ resolveSourceIssue }),
        baseInput(),
      );
      expect(receipt.transport).toMatchObject({
        ok: false,
        errorCode: "unauthorized_principal",
      });
    }
  });

  it("rechecks dependencies at invocation: a blocker added after an ok receipt denies the next call", async () => {
    let blockers: string[] = [];
    const resolveUnresolvedBlockerIssueIds = vi.fn(async () => blockers);
    const deps = baseDeps({ resolveUnresolvedBlockerIssueIds });

    const first = await runSourceBoundTransportValidation(deps, baseInput());
    expect(first.ok).toBe(true);

    blockers = [BLOCKER_ID];
    const second = await runSourceBoundTransportValidation(deps, baseInput());
    expect(second.ok).toBe(false);
    expect(second.transport).toMatchObject({
      ok: false,
      errorCode: "issue_dependencies_blocked",
    });
    expect(resolveUnresolvedBlockerIssueIds).toHaveBeenCalledTimes(2);
  });

  it("enforces the server-resolved low-trust preflight", async () => {
    const receipt = await runSourceBoundTransportValidation(
      baseDeps({ resolveIsLowTrust: async () => true }),
      { ...baseInput(), requestedToolClass: "runtime.manage" },
    );
    expect(receipt.transport).toMatchObject({
      ok: false,
      errorCode: "low_trust_preflight_denied",
    });
  });

  it("denies when the selected workspace transport differs from the principal transport", async () => {
    const receipt = await runSourceBoundTransportValidation(baseDeps(), {
      ...baseInput(),
      transport: "remote_managed",
    });
    expect(receipt.transport).toMatchObject({
      ok: false,
      errorCode: "workspace_transport_mismatch",
    });
  });

  it("denies a workspace that is not bound to the source issue", async () => {
    const receipt = await runSourceBoundTransportValidation(
      baseDeps({
        resolveSourceIssue: async () => ({
          id: SOURCE_ISSUE_ID,
          companyId: COMPANY_ID,
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          projectId: null,
          executionPolicy: null,
          executionWorkspaceId: null,
        }),
        resolveWorkspace: async () => ({
          id: WORKSPACE_ID,
          companyId: COMPANY_ID,
          transport: "local_fs",
          sourceIssueId: "77777777-7777-4777-8777-777777777777",
        }),
      }),
      baseInput(),
    );
    expect(receipt.transport).toMatchObject({
      ok: false,
      errorCode: "workspace_transport_mismatch",
    });
  });

  it("never invokes effects callbacks on success or deny paths", async () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
    };
    const effects = {
      startRuntimeService: counting,
      executeProduct: counting,
      executeStaging: counting,
    };
    const ok = await runSourceBoundTransportValidation(baseDeps(), {
      ...baseInput(),
      effects,
    });
    expect(ok.ok).toBe(true);
    const denied = await runSourceBoundTransportValidation(baseDeps(), {
      ...baseInput(),
      principalAgentId: WRONG_AGENT_ID,
      effects,
    });
    expect(denied.ok).toBe(false);
    expect(calls).toBe(0);
    expect(ok.runtimeInvoked).toBe(false);
    expect(denied.runtimeInvoked).toBe(false);
  });

  it("fails closed when no trusted deployment attestation record is configured", async () => {
    const receipt = await runSourceBoundTransportValidation(
      baseDeps({ resolveDeployedImageAttestation: () => null }),
      baseInput(),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.transport.ok).toBe(true);
    expect(receipt.attestation).toEqual({
      ok: false,
      errorCode: "image_attestation_unavailable",
    });
  });

  it("refuses a mutable tag in the deployment record (mutable tags do not count)", async () => {
    const receipt = await runSourceBoundTransportValidation(
      baseDeps({
        resolveDeployedImageAttestation: () => ({
          sourceRevision: SOURCE_REVISION,
          imageReference: "registry.example.com/paperclip-server:latest",
          expectedDigest: DIGEST,
        }),
      }),
      baseInput(),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.attestation).toEqual({
      ok: false,
      errorCode: "mutable_tag_refused",
    });
  });

  it("denies when the deployed digest does not match the expected digest", async () => {
    const receipt = await runSourceBoundTransportValidation(
      baseDeps({
        resolveDeployedImageAttestation: () => ({
          sourceRevision: SOURCE_REVISION,
          imageReference: `registry.example.com/paperclip-server@sha256:${"c".repeat(64)}`,
          expectedDigest: DIGEST,
        }),
      }),
      baseInput(),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.attestation).toEqual({
      ok: false,
      errorCode: "digest_mismatch",
    });
  });

  it("logs every decision with result codes and no secrets", async () => {
    const logDecision = vi.fn();
    await runSourceBoundTransportValidation(
      baseDeps({ logDecision }),
      baseInput(),
    );
    expect(logDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        principalAgentId: ASSIGNEE_AGENT_ID,
        workspaceId: WORKSPACE_ID,
        resultCode: "ok",
        attestationResultCode: "ok",
        validatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  });

  it("reads the deployment record only when all three server values are set", () => {
    expect(readDeployedImageAttestationFromEnv({})).toBeNull();
    expect(
      readDeployedImageAttestationFromEnv({
        PAPERCLIP_SOURCE_REVISION: SOURCE_REVISION,
        PAPERCLIP_DEPLOYED_IMAGE_REFERENCE: validRecord.imageReference,
      }),
    ).toBeNull();
    expect(
      readDeployedImageAttestationFromEnv({
        PAPERCLIP_SOURCE_REVISION: SOURCE_REVISION,
        PAPERCLIP_DEPLOYED_IMAGE_REFERENCE: validRecord.imageReference,
        PAPERCLIP_EXPECTED_IMAGE_DIGEST: DIGEST,
      }),
    ).toEqual(validRecord);
  });
});
