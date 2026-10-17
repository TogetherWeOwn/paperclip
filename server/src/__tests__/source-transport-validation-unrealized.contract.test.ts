/**
 * Contract tests (Test Author, red-first): transport validation must DENY
 * unrealized source-bound workspace allocations.
 *
 * Allocation alone can never produce a validation PASS. The pure core
 * (`validateSourceTransportOnly`) gains a server-resolved
 * `workspaceRealized` fact: explicit `false` denies with the stable,
 * machine-readable code `workspace_not_realized`. The operation
 * (`runSourceBoundTransportValidation`) derives that fact from the
 * workspace record's durable `unrealized` status and denies BEFORE any
 * attestation evaluation — including when the record is selected only
 * via `issue.executionWorkspaceId`. Binding is still checked first: an
 * unbound or cross-company unrealized record denies as
 * `workspace_transport_mismatch`, so realization state never leaks for
 * workspaces the caller may not see. The route maps the new code to 409.
 *
 * Also pinned here:
 * - the shared execution-workspace status schema accepts `unrealized`
 *   (the Builder adds it to `executionWorkspaceStatusSchema`), so the
 *   status round-trips through API validators instead of being free text;
 * - heartbeat workspace-reuse resolution never treats an unrealized
 *   record as a restorable existing workspace: presence of
 *   `executionWorkspaceId` is not proof of realization. Realization
 *   adoption goes through `markAllocatedWorkspaceRealized` (see
 *   `source-bound-workspace-allocation.contract.test.ts`), not restore.
 *
 * All identifiers are synthetic.
 */
import type { Db } from "@paperclipai/db";
import { executionWorkspaceStatusSchema } from "@paperclipai/shared";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { sourceTransportValidationRoutes } from "../routes/source-transport-validation.js";
import { resolveExecutionWorkspaceReuseRequestForIssue } from "../services/heartbeat.ts";
import {
  runSourceBoundTransportValidation,
  type SourceBoundTransportValidationDeps,
  type SourceBoundWorkspaceFacts,
} from "../services/source-bound-transport-validation-operation.js";
import { validateSourceTransportOnly } from "../services/source-transport-validation.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";
const SOURCE_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ISSUE_ID = "77777777-7777-4777-8777-777777777777";
const ASSIGNEE_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const DIGEST = `sha256:${"b".repeat(64)}`;

function pureInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceIssueId: SOURCE_ISSUE_ID,
    principalAgentId: ASSIGNEE_AGENT_ID,
    issueAssigneeAgentId: ASSIGNEE_AGENT_ID,
    workspaceId: WORKSPACE_ID,
    transport: "git_worktree",
    workspaceTransport: "git_worktree",
    dependenciesBlocked: { unresolvedBlockerIssueIds: [] as string[] },
    isLowTrust: false,
    ...overrides,
  };
}

function unrealizedWorkspace(
  overrides: Partial<SourceBoundWorkspaceFacts> = {},
): SourceBoundWorkspaceFacts {
  return {
    id: WORKSPACE_ID,
    companyId: COMPANY_ID,
    transport: "git_worktree",
    sourceIssueId: SOURCE_ISSUE_ID,
    status: "unrealized",
    closedAt: null,
    ...overrides,
  };
}

function deps(
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
    resolveWorkspace: async () => unrealizedWorkspace(),
    resolveDeployedImageAttestation: () => ({
      sourceRevision: "a".repeat(40),
      imageReference: `registry.example.com/paperclip-server@${DIGEST}`,
      expectedDigest: DIGEST,
    }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function operationInput() {
  return {
    companyId: COMPANY_ID,
    sourceIssueId: SOURCE_ISSUE_ID,
    principalAgentId: ASSIGNEE_AGENT_ID,
    workspaceId: WORKSPACE_ID,
    transport: "git_worktree",
  };
}

describe("transport validation denial for unrealized allocations (contract)", () => {
  it("shared status schema accepts the durable unrealized status", () => {
    expect(executionWorkspaceStatusSchema.safeParse("unrealized").success).toBe(
      true,
    );
  });

  it("pure core denies an unrealized workspace with workspace_not_realized", () => {
    const result = validateSourceTransportOnly(
      pureInput({ workspaceRealized: false }) as Parameters<
        typeof validateSourceTransportOnly
      >[0],
    );
    expect(result).toEqual({
      ok: false,
      errorCode: "workspace_not_realized",
      boundary: "transport-only",
      runtimeInvoked: false,
    });
  });

  it("pure core still passes an explicitly realized workspace", () => {
    const result = validateSourceTransportOnly(
      pureInput({ workspaceRealized: true }) as Parameters<
        typeof validateSourceTransportOnly
      >[0],
    );
    expect(result).toMatchObject({
      ok: true,
      validatedWorkspaceId: WORKSPACE_ID,
    });
  });

  it("pure core reports unrealized before comparing transports", () => {
    const result = validateSourceTransportOnly(
      pureInput({
        workspaceRealized: false,
        transport: "some_other_transport",
      }) as Parameters<typeof validateSourceTransportOnly>[0],
    );
    expect(result).toMatchObject({
      ok: false,
      errorCode: "workspace_not_realized",
    });
  });

  it("operation denies an unrealized bound workspace before attestation, even with a valid deployment record", async () => {
    const receipt = await runSourceBoundTransportValidation(
      deps(),
      operationInput(),
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.transport).toMatchObject({
      ok: false,
      errorCode: "workspace_not_realized",
    });
    expect(receipt.attestation).toEqual({
      ok: false,
      errorCode: "not_evaluated",
    });
    expect(receipt.runtimeInvoked).toBe(false);
  });

  it("operation denies an unrealized workspace selected only via issue.executionWorkspaceId", async () => {
    const receipt = await runSourceBoundTransportValidation(
      deps({
        resolveWorkspace: async () =>
          unrealizedWorkspace({ sourceIssueId: null }),
      }),
      operationInput(),
    );
    expect(receipt.transport).toMatchObject({
      ok: false,
      errorCode: "workspace_not_realized",
    });
  });

  it("operation does not leak realization state for an unbound unrealized workspace", async () => {
    const receipt = await runSourceBoundTransportValidation(
      deps({
        resolveSourceIssue: async () => ({
          id: SOURCE_ISSUE_ID,
          companyId: COMPANY_ID,
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          projectId: null,
          executionPolicy: null,
          executionWorkspaceId: null,
        }),
        resolveWorkspace: async () =>
          unrealizedWorkspace({ sourceIssueId: OTHER_ISSUE_ID }),
      }),
      operationInput(),
    );
    expect(receipt.transport).toMatchObject({
      ok: false,
      errorCode: "workspace_transport_mismatch",
    });
  });

  it("operation does not leak realization state for a cross-company unrealized workspace", async () => {
    const receipt = await runSourceBoundTransportValidation(
      deps({
        resolveWorkspace: async () =>
          unrealizedWorkspace({ companyId: OTHER_COMPANY_ID }),
      }),
      operationInput(),
    );
    expect(receipt.transport).toMatchObject({
      ok: false,
      errorCode: "workspace_transport_mismatch",
    });
  });

  it("route returns 409 with workspace_not_realized for an unrealized allocation", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: ASSIGNEE_AGENT_ID,
        companyId: COMPANY_ID,
        source: "agent_key",
      };
      next();
    });
    app.use(
      "/api",
      sourceTransportValidationRoutes({} as Db, { deps: deps() }),
    );
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/issues/${SOURCE_ISSUE_ID}/transport-validation`)
      .send({ workspaceId: WORKSPACE_ID, transport: "git_worktree" });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.transport).toMatchObject({
      ok: false,
      errorCode: "workspace_not_realized",
    });
  });

  it("heartbeat reuse resolution never treats an unrealized record as restorable", () => {
    const reuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({
      issueExecutionWorkspaceId: WORKSPACE_ID,
      issueExecutionWorkspacePreference: "reuse_existing",
      existingExecutionWorkspaceStatus: "unrealized",
    });
    expect(reuseRequest.existingExecutionWorkspaceAvailable).toBe(false);
  });
});
