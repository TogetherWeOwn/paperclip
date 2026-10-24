import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Echo-shape coverage for the restore-to-blocked wake loop: production loop
// restores re-send UNCHANGED `blockedByIssueIds` on every round trip, so edge
// presence alone must not count as a genuine signal. Only an actual edge delta
// (added or removed blockers) attempts the restored wake.
vi.setConfig({ testTimeout: 30000 });

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockFindExistingIssueBlockersResolvedWakeForReadyState = vi.hoisted(() => vi.fn(async () => null));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWakeForReadyState:
      mockFindExistingIssueBlockersResolvedWakeForReadyState,
  };
});

async function createApp() {
  const emptyRows: unknown[] = [];
  const whereResult = {
    limit: vi.fn(async () => emptyRows),
    then: async (resolve: (rows: unknown[]) => unknown) => resolve(emptyRows),
  };
  const query: Record<string, unknown> = {};
  query.innerJoin = vi.fn(() => query);
  query.where = vi.fn(() => whereResult);
  const routeDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => query),
    })),
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  };
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function issueRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-100",
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    blockedTransitionAt: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function blockersResolvedCalls() {
  return mockWakeup.mock.calls.filter(
    (call) => (call[1] as { reason?: string } | undefined)?.reason === "issue_blockers_resolved",
  );
}

describe("echoed unchanged blocker edges do not re-wake", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "issue-1",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("does not emit when the restore echoes the pre-existing blocker edges", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const blockerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-210",
      title: "Echoed edges",
      status: "in_progress",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-210",
      title: "Echoed edges",
      status: "blocked",
      assigneeAgentId: "agent-2",
      blockedTransitionAt: new Date("2026-08-04T10:00:00.000Z"),
    }));
    // Pre-update relations already carry the blocker: the request echoes them.
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: blockerId }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [blockerId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blockersResolvedCalls()).toHaveLength(0);
  });

  it("still emits when the restore adds a blocker edge", async () => {
    const dependentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const blockerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const newBlockerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-211",
      title: "Added edge",
      status: "in_progress",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: dependentId,
      identifier: "PAP-211",
      title: "Added edge",
      status: "blocked",
      assigneeAgentId: "agent-2",
      blockedTransitionAt: new Date("2026-08-04T11:00:00.000Z"),
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: blockerId }],
      blocks: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: dependentId,
      blockerIssueIds: [blockerId, newBlockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [blockerId, newBlockerId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(blockersResolvedCalls()).toHaveLength(1);
    });
  });
});
