import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  upsertConfig: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

const mockRunBudgetSpentFraction = vi.hoisted(() => vi.fn());

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ getById: vi.fn() }),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

vi.mock("../services/budgets.js", () => ({
  runBudgetSpentFraction: mockRunBudgetSpentFraction,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
  httpLogger: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

async function createApp(
  actor: Record<string, unknown>,
  routeOverrides: { db?: unknown; toolDeps?: unknown; bridgeDeps?: unknown } = {},
) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      (routeOverrides.db ?? {}) as never,
      {} as never,
      undefined,
      undefined,
      routeOverrides.toolDeps as never,
      routeOverrides.bridgeDeps as never,
    ),
  );
  app.use(errorHandler);

  return app;
}

const companyA = "22222222-2222-4222-8222-222222222222";
const agentA = "44444444-4444-4444-8444-444444444444";
const runA = "55555555-5555-4555-8555-555555555555";
const projectA = "66666666-6666-4666-8666-666666666666";
const pluginId = "11111111-1111-4111-8111-111111111111";

function agentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: agentA,
    companyId: companyA,
    runId: runA,
    source: "agent_jwt",
    ...overrides,
  };
}

function validationDb() {
  const rows = [
    [{ companyId: companyA }],
    [{ companyId: companyA, agentId: agentA }],
    [{ companyId: companyA }],
  ];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(rows.shift() ?? [])),
        })),
      })),
    })),
  };
}

function loggedPayloads(mockFn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return mockFn.mock.calls.map((args) => (args[0] ?? {}) as Record<string, unknown>);
}

function assertSafeReceipt(payload: Record<string, unknown>) {
  const text = JSON.stringify(payload);
  // Safe IDs and bounded numbers only: no prompts, args, secrets, or headers.
  expect(text).not.toMatch(/prompt/i);
  expect(payload).not.toHaveProperty("parameters");
  expect(payload).not.toHaveProperty("params");
  expect(payload).not.toHaveProperty("arguments");
  expect(payload).not.toHaveProperty("headers");
  expect(payload).not.toHaveProperty("authorization");
  expect(payload).not.toHaveProperty("actorContext");
  // Bounded fraction when present.
  if ("budgetSpentFraction" in payload) {
    expect(typeof payload.budgetSpentFraction).toBe("number");
    expect(Number.isFinite(payload.budgetSpentFraction as number)).toBe(true);
  }
}

describe("budget fraction receipts (success/fallback without behavior change)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs a bounded success receipt on the direct tool-dispatch branch and keeps the overwrite", async () => {
    mockRunBudgetSpentFraction.mockResolvedValue(0.123456);
    const executeTool = vi.fn(async () => ({ ok: true }));
    const app = await createApp(agentActor(), {
      db: validationDb(),
      toolDeps: {
        toolDispatcher: { getTool: () => ({}), executeTool },
      },
    });

    const res = await request(app).post("/api/plugins/tools/execute").send({
      tool: "acme.test:probe",
      parameters: {},
      runContext: {
        agentId: agentA,
        runId: runA,
        companyId: companyA,
        projectId: projectA,
        budgetSpentFraction: 0.99,
      },
    });

    expect(res.status).toBe(200);
    // Behavior preserved: forged 0.99 is overwritten with the bounded host value.
    expect(executeTool.mock.calls[0][2]).toMatchObject({ budgetSpentFraction: 0.1235 });
    expect(executeTool.mock.calls[0][2].budgetSpentFraction).not.toBe(0.99);

    const infos = loggedPayloads(mockLogger.info);
    const receipt = infos.find((p) => p.runId === runA && p.injected === true);
    expect(receipt).toMatchObject({ runId: runA, injected: true, budgetSpentFraction: 0.1235 });
    assertSafeReceipt(receipt!);
  });

  it("logs an absent-stamp fallback when no policy envelope exists", async () => {
    mockRunBudgetSpentFraction.mockResolvedValue(undefined);
    const executeTool = vi.fn(async () => ({ ok: true }));
    const app = await createApp(agentActor(), {
      db: validationDb(),
      toolDeps: {
        toolDispatcher: { getTool: () => ({}), executeTool },
      },
    });

    const res = await request(app).post("/api/plugins/tools/execute").send({
      tool: "acme.test:probe",
      parameters: {},
      runContext: { agentId: agentA, runId: runA, companyId: companyA, projectId: projectA },
    });

    expect(res.status).toBe(200);
    expect(executeTool.mock.calls[0][2].budgetSpentFraction).toBeUndefined();

    const infos = loggedPayloads(mockLogger.info);
    const fallback = infos.find((p) => p.runId === runA && p.injected === false);
    expect(fallback).toMatchObject({ runId: runA, injected: false });
    assertSafeReceipt(fallback!);
  });

  it("logs a lookup-error fallback and still omits the stamp", async () => {
    mockRunBudgetSpentFraction.mockRejectedValue(new Error("db down"));
    const executeTool = vi.fn(async () => ({ ok: true }));
    const app = await createApp(agentActor(), {
      db: validationDb(),
      toolDeps: {
        toolDispatcher: { getTool: () => ({}), executeTool },
      },
    });

    const res = await request(app).post("/api/plugins/tools/execute").send({
      tool: "acme.test:probe",
      parameters: {},
      runContext: { agentId: agentA, runId: runA, companyId: companyA, projectId: projectA },
    });

    expect(res.status).toBe(200);
    expect(executeTool.mock.calls[0][2].budgetSpentFraction).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
    const warns = loggedPayloads(mockLogger.warn);
    const fallback = warns.find((p) => p.runId === runA && p.injected === false);
    expect(fallback).toBeDefined();
    assertSafeReceipt(fallback!);
  });

  it("logs the action-path stamp receipt and keeps the stamp", async () => {
    mockRunBudgetSpentFraction.mockResolvedValue(0.42);
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
      status: "ready",
    });
    const call = vi.fn(async () => ({ ok: true }));
    const app = await createApp(agentActor(), {
      db: {},
      bridgeDeps: { workerManager: { call } as never },
    });

    const res = await request(app).post(`/api/plugins/${pluginId}/bridge/action`).send({
      key: "invoke",
      companyId: companyA,
    });

    expect(res.status).toBe(200);
    const params = call.mock.calls[0][2] as { actorContext: Record<string, unknown> };
    expect(params.actorContext).toMatchObject({ budgetSpentFraction: 0.42 });

    const infos = loggedPayloads(mockLogger.info);
    const receipt = infos.find((p) => p.runId === runA && p.injected === true);
    expect(receipt).toMatchObject({ runId: runA, injected: true, budgetSpentFraction: 0.42 });
    assertSafeReceipt(receipt!);
  });
});
