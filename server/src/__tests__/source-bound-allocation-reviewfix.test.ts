/**
 * Builder-owned regression tests for the Paperclip Review round-2 findings
 * on PR #163 (source-bound workspace allocation).
 *
 * These are NOT Test Author contract tests: they pin the two review fixes
 * only (PATCH-guard, row-level validator denial, guarded adoption denial)
 * with mocked or in-memory harnesses. The contract suites remain the
 * acceptance authority and are untouched.
 *
 * Finding 1: a generic PATCH must not move an `unrealized` record to
 * `active`, and transport validation must deny a status-flipped row whose
 * row facts (openedAt / providerRef / cwd) are still null.
 * Finding 2: heartbeat adoption must go through the guarded
 * `markAllocatedWorkspaceRealized` transition, which denies (instead of
 * resurrecting) a record a Board rollback already archived or unbound.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import {
  markAllocatedWorkspaceRealized,
  type SourceBoundAllocationIssueFacts,
  type SourceBoundAllocationWorkspaceRecord,
  type SourceBoundWorkspaceAllocationDeps,
  type SourceBoundWorkspaceAllocationTx,
} from "../services/source-bound-workspace-allocation.js";
import {
  runSourceBoundTransportValidation,
  type SourceBoundTransportValidationDeps,
  type SourceBoundWorkspaceFacts,
} from "../services/source-bound-transport-validation-operation.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listOverview: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  archiveWorkspaceUnderLifecycleLock: vi.fn(),
  fenceClosedWorkspaceDestruction: vi.fn(),
  reconcileExecutionWorkspaceBranch: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
  assertRuntimeControlAvailable: vi.fn(async () => undefined),
}));

const mockWorkspaceRuntimeLeaseService = vi.hoisted(() => ({
  claim: vi.fn(async () => ({ outcome: "created", ownerKey: "issue:issue-1", lease: null, reclaimedFrom: null })),
  release: vi.fn(async () => ({ released: false, ownerKey: null })),
  get: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockSweepWorkspaceValidationRecoveries = vi.hoisted(() => vi.fn());

vi.mock("../services/workspace-validation-sweep.js", () => ({
  sweepWorkspaceValidationRecoveries: mockSweepWorkspaceValidationRecoveries,
}));

const mockEnvironmentRuntimeService = vi.hoisted(() => ({
  destroyReusableSandboxLeases: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
  workspaceRuntimeLeaseService: () => mockWorkspaceRuntimeLeaseService,
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart", "repair"],
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntimeService,
}));

const mockWorkspaceRuntimeTeardown = vi.hoisted(() => ({
  stopRuntimeServicesForExecutionWorkspace: vi.fn(async () => undefined),
  cleanupExecutionWorkspaceArtifacts: vi.fn(async () => ({ cleaned: true, warnings: [] as string[] })),
}));

vi.mock("../services/workspace-runtime.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/workspace-runtime.js")>();
  return {
    ...actual,
    stopRuntimeServicesForExecutionWorkspace:
      mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace,
    cleanupExecutionWorkspaceArtifacts: mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts,
  };
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const UNREALIZED_RECORD = {
  id: "workspace-1",
  companyId: "company-1",
  sourceIssueId: "issue-1",
  status: "unrealized",
  mode: "isolated_workspace",
  projectWorkspaceId: null,
  projectId: null,
  cwd: null,
  metadata: null,
};

describe("reviewfix: PATCH cannot realize an allocated record", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "runtime:manage",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
  });

  it.each(["active", "idle", "in_review", "cleanup_failed"])(
    "refuses PATCH status %s on an unrealized record (409, no update)",
    async (status) => {
      mockExecutionWorkspaceService.getById.mockResolvedValue({
        ...UNREALIZED_RECORD,
      });

      const res = await request(createApp())
        .patch("/api/execution-workspaces/workspace-1")
        .send({ status });

      expect(res.status).toBe(409);
      expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
      expect(
        mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock,
      ).not.toHaveBeenCalled();
    },
  );

  it("still allows archiving an unrealized record through PATCH", async () => {
    const archivedWorkspace = {
      ...UNREALIZED_RECORD,
      status: "archived",
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      ...UNREALIZED_RECORD,
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      capturedGeneration: 3,
    });
    mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction.mockImplementation(
      async ({ destroy }: { destroy: () => Promise<unknown> }) => ({
        skippedReopened: false,
        result: await destroy(),
      }),
    );

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(
      mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock,
    ).toHaveBeenCalledTimes(1);
  });
});

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const ASSIGNEE_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const DIGEST = `sha256:${"b".repeat(64)}`;

function validationDeps(
  workspace: SourceBoundWorkspaceFacts,
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
    resolveWorkspace: async () => workspace,
    resolveDeployedImageAttestation: () => ({
      sourceRevision: "a".repeat(40),
      imageReference: `registry.example.com/paperclip-server@${DIGEST}`,
      expectedDigest: DIGEST,
    }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  };
}

function validationInput() {
  return {
    companyId: COMPANY_ID,
    sourceIssueId: SOURCE_ISSUE_ID,
    principalAgentId: ASSIGNEE_AGENT_ID,
    workspaceId: WORKSPACE_ID,
    transport: "git_worktree",
  };
}

describe("reviewfix: validator denies status-flipped rows with null row facts", () => {
  it("denies workspace_not_realized for an active row with null openedAt/cwd/providerRef", async () => {
    const receipt = await runSourceBoundTransportValidation(
      validationDeps({
        id: WORKSPACE_ID,
        companyId: COMPANY_ID,
        transport: "git_worktree",
        sourceIssueId: SOURCE_ISSUE_ID,
        status: "active",
        closedAt: null,
        openedAt: null,
        cwd: null,
        providerRef: null,
      }),
      validationInput(),
    );
    expect(receipt.transport).toMatchObject({
      ok: false,
      errorCode: "workspace_not_realized",
    });
  });

  it("passes a genuinely realized row (status + openedAt + providerRef)", async () => {
    const receipt = await runSourceBoundTransportValidation(
      validationDeps({
        id: WORKSPACE_ID,
        companyId: COMPANY_ID,
        transport: "git_worktree",
        sourceIssueId: SOURCE_ISSUE_ID,
        status: "active",
        closedAt: null,
        openedAt: new Date("2026-01-02T00:00:00.000Z"),
        cwd: "/repo/.paperclip/worktrees/TST-1",
        providerRef: "/repo/.paperclip/worktrees/TST-1",
      }),
      validationInput(),
    );
    expect(receipt.ok).toBe(true);
    expect(receipt.transport).toMatchObject({ ok: true });
  });
});

const ALLOC_COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALLOC_ISSUE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALLOC_WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function allocIssue(
  overrides: Partial<SourceBoundAllocationIssueFacts> = {},
): SourceBoundAllocationIssueFacts {
  return {
    id: ALLOC_ISSUE_ID,
    companyId: ALLOC_COMPANY_ID,
    projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    projectWorkspaceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    status: "blocked",
    assigneeAgentId: null,
    executionWorkspaceId: ALLOC_WORKSPACE_ID,
    executionWorkspacePreference: "isolated_workspace",
    executionWorkspaceSettings: {
      mode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree" },
    },
    executionPolicy: null,
    ...overrides,
  };
}

function allocWorkspace(
  overrides: Partial<SourceBoundAllocationWorkspaceRecord> = {},
): SourceBoundAllocationWorkspaceRecord {
  return {
    id: ALLOC_WORKSPACE_ID,
    companyId: ALLOC_COMPANY_ID,
    projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    projectWorkspaceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    sourceIssueId: ALLOC_ISSUE_ID,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "TST-1-source-transport",
    status: "unrealized",
    cwd: null,
    repoUrl: null,
    baseRef: null,
    branchName: null,
    providerType: "git_worktree",
    providerRef: null,
    openedAt: null,
    closedAt: null,
    metadata: null,
    ...overrides,
  };
}

function allocDeps(
  issue: SourceBoundAllocationIssueFacts,
  workspace: SourceBoundAllocationWorkspaceRecord,
): SourceBoundWorkspaceAllocationDeps {
  const store = {
    issue,
    workspace,
    mutations: [] as string[],
  };
  const tx: SourceBoundWorkspaceAllocationTx = {
    async loadIssue(companyId, issueId) {
      return store.issue.id === issueId && store.issue.companyId === companyId
        ? store.issue
        : null;
    },
    async listWorkspacesForSourceIssue() {
      return [store.workspace];
    },
    async getWorkspace(companyId, workspaceId) {
      return store.workspace.id === workspaceId &&
        store.workspace.companyId === companyId
        ? store.workspace
        : null;
    },
    async insertWorkspace(record) {
      throw new Error(`unexpected insertWorkspace for ${record.id}`);
    },
    async updateWorkspace(_companyId, _workspaceId, patch) {
      store.mutations.push("updateWorkspace");
      store.workspace = { ...store.workspace, ...patch };
      return store.workspace;
    },
    async bindIssueExecutionWorkspace() {},
    async logActivity() {},
  };
  return {
    async transact(work) {
      return work(tx);
    },
  };
}

const REALIZED_FACTS = {
  cwd: "/repo/.paperclip/worktrees/TST-1",
  providerRef: "/repo/.paperclip/worktrees/TST-1",
  branchName: "TST-1-source-transport",
};

describe("reviewfix: guarded adoption never resurrects a rolled-back record", () => {
  it("denies workspace_not_unrealized after a rollback archived the record", async () => {
    const deps = allocDeps(
      allocIssue(),
      allocWorkspace({ status: "archived", closedAt: new Date() }),
    );
    const result = await markAllocatedWorkspaceRealized(deps, {
      companyId: ALLOC_COMPANY_ID,
      sourceIssueId: ALLOC_ISSUE_ID,
      workspaceId: ALLOC_WORKSPACE_ID,
      ...REALIZED_FACTS,
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "workspace_not_unrealized",
    });
  });

  it("denies binding_conflict after a rollback restored a prior binding", async () => {
    const deps = allocDeps(
      allocIssue({ executionWorkspaceId: null }),
      allocWorkspace(),
    );
    const result = await markAllocatedWorkspaceRealized(deps, {
      companyId: ALLOC_COMPANY_ID,
      sourceIssueId: ALLOC_ISSUE_ID,
      workspaceId: ALLOC_WORKSPACE_ID,
      ...REALIZED_FACTS,
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "binding_conflict",
    });
  });
});
