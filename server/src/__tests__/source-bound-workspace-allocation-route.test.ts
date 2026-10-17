/**
 * Route tests for the Board-authorized source-bound workspace allocation
 * endpoints (`POST /api/issues/:id/source-bound-workspace-allocation` and
 * its `/rollback` sibling, in `routes/execution-workspaces.ts`).
 *
 * The operation itself is covered by the contract suites; this file pins
 * only the HTTP wiring: board-only access, server-resolved actor +
 * `runtime:manage` forwarding, identical deny shape for missing vs
 * cross-company issues, and the status-code mapping.
 */
import type { Db } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockAllocate = vi.hoisted(() => vi.fn());
const mockRollback = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

vi.mock("../services/source-bound-workspace-allocation.js", () => ({
  allocateSourceBoundWorkspace: mockAllocate,
  rollbackSourceBoundWorkspaceAllocation: mockRollback,
  createDbSourceBoundWorkspaceAllocationDeps: () => ({}),
  SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION:
    "source-bound-workspace-allocation/v1",
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn() }),
  logActivity: vi.fn(async () => undefined),
  workspaceOperationService: () => ({}),
  workspaceRuntimeLeaseService: () => ({}),
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart", "repair"],
}));

vi.mock("../services/workspace-validation-sweep.js", () => ({
  sweepWorkspaceValidationRecoveries: vi.fn(),
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({}),
}));

vi.mock("../services/workspace-runtime.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/workspace-runtime.js")>();
  return {
    ...actual,
    stopRuntimeServicesForExecutionWorkspace: vi.fn(async () => undefined),
    cleanupExecutionWorkspaceArtifacts: vi.fn(async () => ({
      cleaned: true,
      warnings: [] as string[],
    })),
  };
});

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const BOARD_USER_ID = "board-user-9";

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: BOARD_USER_ID,
    companyIds: [COMPANY_ID],
    memberships: [
      { companyId: COMPANY_ID, status: "active", membershipRole: "admin" },
    ],
    source: "session",
    isInstanceAdmin: false,
    ...overrides,
  };
}

function fakeDb(issueRows: Array<{ id: string; companyId: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(issueRows),
        }),
      }),
    }),
  } as unknown as Db;
}

function createApp(
  actor: Record<string, unknown>,
  issueRows: Array<{ id: string; companyId: string }> = [
    { id: ISSUE_ID, companyId: COMPANY_ID },
  ],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor?: unknown }).actor = actor;
    next();
  });
  app.use("/api", executionWorkspaceRoutes(fakeDb(issueRows)));
  app.use(errorHandler);
  return app;
}

function createdResult() {
  return {
    ok: true,
    operationVersion: "source-bound-workspace-allocation/v1",
    disposition: "created",
    companyId: COMPANY_ID,
    sourceIssueId: ISSUE_ID,
    runtimeInvoked: false,
    wakeInvoked: false,
    workspace: { id: WORKSPACE_ID, status: "unrealized" },
  };
}

describe("source-bound workspace allocation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockAllocate.mockResolvedValue(createdResult());
    mockRollback.mockResolvedValue({
      ok: true,
      operationVersion: "source-bound-workspace-allocation/v1",
      workspace: { id: WORKSPACE_ID, status: "archived" },
      restoredExecutionWorkspaceId: null,
      runtimeInvoked: false,
      wakeInvoked: false,
    });
  });

  it("denies agent keys before resolving anything", async () => {
    const res = await request(
      createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: COMPANY_ID,
        source: "agent_key",
      }),
    )
      .post(`/api/issues/${ISSUE_ID}/source-bound-workspace-allocation`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it("allocates for a board actor and forwards the server-resolved actor", async () => {
    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/source-bound-workspace-allocation`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      disposition: "created",
      workspace: { id: WORKSPACE_ID, status: "unrealized" },
    });
    expect(mockAccessService.decide).toHaveBeenCalledWith(
      expect.objectContaining({ action: "runtime:manage" }),
    );
    expect(mockAllocate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        sourceIssueId: ISSUE_ID,
        actor: {
          type: "board",
          userId: BOARD_USER_ID,
          companyId: COMPANY_ID,
          hasRuntimeManage: true,
        },
      }),
    );
  });

  it("forwards a missing board user identity as null so the operation denies", async () => {
    mockAllocate.mockResolvedValue({
      ok: false,
      operationVersion: "source-bound-workspace-allocation/v1",
      errorCode: "unauthorized_principal",
      companyId: COMPANY_ID,
      sourceIssueId: ISSUE_ID,
      runtimeInvoked: false,
      wakeInvoked: false,
    });
    const actor = boardActor();
    delete actor.userId;
    const res = await request(createApp(actor))
      .post(`/api/issues/${ISSUE_ID}/source-bound-workspace-allocation`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockAllocate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: expect.objectContaining({ userId: null }),
      }),
    );
  });

  it("denies missing and cross-company issues with an identical body", async () => {
    const missing = await request(createApp(boardActor(), []))
      .post(`/api/issues/${ISSUE_ID}/source-bound-workspace-allocation`)
      .send({});
    const crossCompany = await request(
      createApp(boardActor({ companyIds: [], memberships: [] })),
    )
      .post(`/api/issues/${ISSUE_ID}/source-bound-workspace-allocation`)
      .send({});
    expect(missing.status).toBe(403);
    expect(crossCompany.status).toBe(403);
    expect(crossCompany.body).toEqual(missing.body);
    expect(missing.body).toMatchObject({
      ok: false,
      errorCode: "unauthorized_principal",
    });
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it.each([
    { errorCode: "binding_conflict", status: 409 },
    { errorCode: "selection_missing", status: 422 },
    { errorCode: "selection_not_isolated", status: 422 },
  ])(
    "maps allocation deny $errorCode to $status",
    async ({ errorCode, status }) => {
      mockAllocate.mockResolvedValue({
        ok: false,
        operationVersion: "source-bound-workspace-allocation/v1",
        errorCode,
        companyId: COMPANY_ID,
        sourceIssueId: ISSUE_ID,
        runtimeInvoked: false,
        wakeInvoked: false,
      });
      const res = await request(createApp(boardActor()))
        .post(`/api/issues/${ISSUE_ID}/source-bound-workspace-allocation`)
        .send({});
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ ok: false, errorCode });
    },
  );

  it("rejects unknown body fields", async () => {
    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${ISSUE_ID}/source-bound-workspace-allocation`)
      .send({ cwd: "/attacker/chosen" });
    expect(res.status).toBe(400);
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it("rolls back through the same board + runtime:manage resolution", async () => {
    const res = await request(createApp(boardActor()))
      .post(
        `/api/issues/${ISSUE_ID}/source-bound-workspace-allocation/rollback`,
      )
      .send({ workspaceId: WORKSPACE_ID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      restoredExecutionWorkspaceId: null,
    });
    expect(mockRollback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        sourceIssueId: ISSUE_ID,
        workspaceId: WORKSPACE_ID,
        actor: expect.objectContaining({
          type: "board",
          userId: BOARD_USER_ID,
          hasRuntimeManage: true,
        }),
      }),
    );
  });
});
