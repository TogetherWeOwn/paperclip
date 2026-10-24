import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the unblock-owner notification loop: entering `blocked`
// with a self-owned descriptor when all blockers are already done (the shape the
// 422 guard forces on a restore) must not re-notify on every round trip.
// Genuine handoffs and genuinely blocked transitions must still notify.
vi.setConfig({ testTimeout: 30000 });

const agentSelf = "00000000-0000-4000-8000-000000000001";
const agentOther = "00000000-0000-4000-8000-000000000009";

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
  function queryWithRows(rows: unknown[]) {
    const whereResult = {
      limit: vi.fn(async () => rows),
      then: async (resolve: (rows: unknown[]) => unknown) => resolve(rows),
    };
    const query: Record<string, unknown> = {};
    query.innerJoin = vi.fn(() => query);
    query.where = vi.fn(() => whereResult);
    return query;
  }
  function tableName(table: unknown): string | null {
    try {
      return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")] as string ?? null;
    } catch {
      return null;
    }
  }
  const routeDb = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        // Descriptor owner validation queries `agents`; every other lookup in
        // this flow (unresolved blockers, pending interactions/approvals) stays
        // empty to model all-done with nothing pending.
        if (tableName(table) === "agents") {
          return queryWithRows([{ id: agentSelf }]);
        }
        return queryWithRows(emptyRows);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
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
    blockedOwnerNotifiedAt: null,
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function unblockCalls() {
  return mockWakeup.mock.calls.filter(
    (call) => (call[1] as { reason?: string } | undefined)?.reason === "issue_unblock_requested",
  );
}

describe("self-owned unblock notification does not loop on restore", () => {
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
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
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

  it("does not re-notify a self-owned descriptor when all blockers are done and nothing is pending", async () => {
    const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const blockerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: issueId,
      identifier: "PAP-300",
      title: "Self restore",
      status: "in_progress",
      assigneeAgentId: agentSelf,
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: issueId,
      identifier: "PAP-300",
      title: "Self restore",
      status: "blocked",
      assigneeAgentId: agentSelf,
      blockedTransitionAt: new Date("2026-08-04T12:00:00.000Z"),
      blockedOwnerNotifiedAt: null,
      unblockDescriptor: { owner: { agentId: agentSelf }, action: "Review the restored dependency" },
    }));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "blocked",
        unblockDescriptor: { owner: { agentId: agentSelf }, action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unblockCalls()).toHaveLength(0);
  });

  it("still notifies a genuine handoff to a different owner", async () => {
    const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const blockerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: issueId,
      identifier: "PAP-301",
      title: "Handoff",
      status: "in_progress",
      assigneeAgentId: agentSelf,
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: issueId,
      identifier: "PAP-301",
      title: "Handoff",
      status: "blocked",
      assigneeAgentId: agentSelf,
      blockedTransitionAt: new Date("2026-08-04T13:00:00.000Z"),
      blockedOwnerNotifiedAt: null,
      unblockDescriptor: { owner: { agentId: agentOther }, action: "Approve the exception" },
    }));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "blocked",
        unblockDescriptor: { owner: { agentId: agentOther }, action: "Approve the exception" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(unblockCalls()).toHaveLength(1);
    });
    expect(unblockCalls()[0]?.[0]).toBe(agentOther);
  });

  it("still notifies a self-owned descriptor when unresolved blockers remain", async () => {
    const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const blockerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: issueId,
      identifier: "PAP-302",
      title: "Genuinely blocked",
      status: "in_progress",
      assigneeAgentId: agentSelf,
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: issueId,
      identifier: "PAP-302",
      title: "Genuinely blocked",
      status: "blocked",
      assigneeAgentId: agentSelf,
      blockedTransitionAt: new Date("2026-08-04T14:00:00.000Z"),
      blockedOwnerNotifiedAt: null,
      unblockDescriptor: { owner: { agentId: agentSelf }, action: "Wait for the blocker" },
    }));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      unresolvedBlockerCount: 1,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: false,
      isDependencyReady: false,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "blocked",
        unblockDescriptor: { owner: { agentId: agentSelf }, action: "Wait for the blocker" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(unblockCalls()).toHaveLength(1);
    });
  });
});
