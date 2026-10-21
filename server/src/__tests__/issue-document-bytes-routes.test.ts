import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

function buildByteFixture(tag: string): string {
  const BS = String.fromCharCode(92); // U+005C REVERSE SOLIDUS
  const LF = "\n";
  const CRLF = "\r\n";
  const CR = "\r";
  const TAB = "\t";
  const DQ = String.fromCharCode(34);
  return [
    `# Byte-fidelity fixture ${tag}${LF}`,
    `literal backslash-n: ${BS}n stays literal${LF}`,
    `literal backslash-r: ${BS}r stays literal${LF}`,
    `literal backslash-r-backslash-n: ${BS}r${BS}n stays literal${LF}`,
    `nested double-backslash-n: ${BS}${BS}n stays literal${LF}`,
    `\`\`\`python${LF}`,
    `s = ${DQ}a${BS}nb${BS}tc${DQ}${LF}`,
    `pat = r${DQ}${BS}d+${BS}s*${BS}n${DQ}${LF}`,
    `\`\`\`${LF}`,
    `{"text": ${DQ}a${BS}nb${DQ}, ${DQ}path${DQ}: ${DQ}C:${BS}${BS}tmp${DQ}}${LF}`,
    `crlf-line${CRLF}`,
    `cr-line${CR}`,
    `${TAB}tabbed café naïve ✓${LF}`,
  ].join("");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  getExperimental: vi.fn(async () => ({})),
  getGeneral: vi.fn(async () => ({ feedbackDataSharingPreference: "prompt" })),
  listCompanyIds: vi.fn(async () => [companyId]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  syncDocumentSafely: vi.fn(async () => undefined),
}));

function registerModuleMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentAnnotationService: () => ({
      remapOpenThreadsForDocument: async () => [],
    }),
    documentService: () => mockDocumentsService,
  }));

  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({
      remapOpenThreadsForDocument: async () => [],
    }),
    documentService: () => mockDocumentsService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
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
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  }));
}

async function createApp(
  actor: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
  db: unknown = {},
) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>(
      "../routes/issues.js",
    ),
    vi.importActual<typeof import("../middleware/index.js")>(
      "../middleware/index.js",
    ),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Express.Request["actor"] }).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db as never, {} as never));
  app.use(errorHandler);
  return app;
}

function storedDocument(body: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "document-1",
    companyId,
    issueId,
    key: "spec",
    title: "Spec",
    format: "markdown",
    body,
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "board-user",
    updatedByAgentId: null,
    updatedByUserId: "board-user",
    createdAt: new Date("2026-03-26T12:00:00.000Z"),
    updatedAt: new Date("2026-03-26T12:10:00.000Z"),
    ...overrides,
  };
}

describe("issue document byte-fidelity routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/external-objects.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "issue:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "DOC-BYTES",
      title: "Byte fidelity",
      status: "in_progress",
    });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({});
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([companyId]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("creates a new document with byte-identical body and hash", async () => {
    const fixture = buildByteFixture("create");
    mockDocumentsService.upsertIssueDocument.mockImplementation(
      async (input: { body: string }) => ({
        created: true,
        document: storedDocument(input.body),
      }),
    );

    const res = await request(await createApp())
      .put(`/api/issues/${issueId}/documents/spec`)
      .send({ format: "markdown", title: "Spec", body: fixture });

    expect(res.status).toBe(201);
    expect(mockDocumentsService.upsertIssueDocument).toHaveBeenCalledTimes(1);
    const received = mockDocumentsService.upsertIssueDocument.mock.calls[0][0];
    expect(received.body).toBe(fixture);
    expect(Buffer.byteLength(received.body, "utf8")).toBe(
      Buffer.byteLength(fixture, "utf8"),
    );
    expect(sha256(received.body)).toBe(sha256(fixture));
    expect(res.body.body).toBe(fixture);
    expect(sha256(res.body.body)).toBe(sha256(fixture));
  });

  it("updates a document revision-safely with byte-identical body and hash", async () => {
    const fixture = buildByteFixture("update");
    const baseRevisionId = "33333333-3333-4333-8333-333333333333";
    mockDocumentsService.upsertIssueDocument.mockImplementation(
      async (input: { body: string }) => ({
        created: false,
        document: storedDocument(input.body, {
          latestRevisionId: "revision-2",
          latestRevisionNumber: 2,
        }),
      }),
    );

    const res = await request(await createApp())
      .put(`/api/issues/${issueId}/documents/spec`)
      .send({
        format: "markdown",
        title: "Spec",
        body: fixture,
        baseRevisionId,
      });

    expect(res.status).toBe(200);
    const received = mockDocumentsService.upsertIssueDocument.mock.calls[0][0];
    expect(received.baseRevisionId).toBe(baseRevisionId);
    expect(received.body).toBe(fixture);
    expect(Buffer.byteLength(received.body, "utf8")).toBe(
      Buffer.byteLength(fixture, "utf8"),
    );
    expect(sha256(received.body)).toBe(sha256(fixture));
    expect(res.body.body).toBe(fixture);
  });

  it("keeps the stale-revision conflict without mangling the attempted body", async () => {
    const fixture = buildByteFixture("stale");
    const currentRevisionId = "44444444-4444-4434-8444-444444444444";
    const { conflict } =
      await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockDocumentsService.upsertIssueDocument.mockRejectedValue(
      conflict("Document was updated by someone else", { currentRevisionId }),
    );

    const res = await request(await createApp())
      .put(`/api/issues/${issueId}/documents/spec`)
      .send({
        format: "markdown",
        title: "Spec",
        body: fixture,
        baseRevisionId: "55555555-5555-4555-8555-555555555555",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Document was updated by someone else");
    const received = mockDocumentsService.upsertIssueDocument.mock.calls[0][0];
    expect(received.body).toBe(fixture);
    expect(sha256(received.body)).toBe(sha256(fixture));
  });
});
