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

async function createApp(
  actor: Record<string, unknown>,
  routeOverrides: {
    db?: unknown;
    toolDeps?: unknown;
    bridgeDeps?: unknown;
  } = {},
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
  app.use("/api", pluginRoutes(
    (routeOverrides.db ?? {}) as never,
    {} as never,
    undefined,
    undefined,
    routeOverrides.toolDeps as never,
    routeOverrides.bridgeDeps as never,
  ));
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

// db stub for validateToolRunContextScope: 3 selects (agent, run, project).
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

describe("budgetSpentFraction host overwrite (TOG-7967 H6/H8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("overwrites a forged budgetSpentFraction on the direct tool-dispatch branch (H6 B3)", async () => {
    mockRunBudgetSpentFraction.mockResolvedValue(0.1);
    const executeTool = vi.fn(async () => ({ ok: true }));
    const app = await createApp(agentActor(), {
      db: validationDb(),
      toolDeps: {
        toolDispatcher: { getTool: () => ({}), executeTool },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
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
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][2]).toMatchObject({ budgetSpentFraction: 0.1 });
    expect(executeTool.mock.calls[0][2].budgetSpentFraction).not.toBe(0.99);
  });

  it("passes undefined through when no policy envelope exists (H6 B3)", async () => {
    mockRunBudgetSpentFraction.mockResolvedValue(undefined);
    const executeTool = vi.fn(async () => ({ ok: true }));
    const app = await createApp(agentActor(), {
      db: validationDb(),
      toolDeps: {
        toolDispatcher: { getTool: () => ({}), executeTool },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "acme.test:probe",
        parameters: {},
        runContext: {
          agentId: agentA,
          runId: runA,
          companyId: companyA,
          projectId: projectA,
        },
      });

    expect(res.status).toBe(200);
    expect(executeTool.mock.calls[0][2].budgetSpentFraction).toBeUndefined();
  });

  it("stamps the host-computed fraction on the action path (H8)", async () => {
    mockRunBudgetSpentFraction.mockResolvedValue(0.42);
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
      status: "ready",
    });
    const call = vi.fn(async () => ({ ok: true }));
    // Agent actor carries agentId+runId, so the H8 stamp condition resolves.
    const app = await createApp(agentActor(), {
      db: {},
      bridgeDeps: { workerManager: { call } as never },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/bridge/action`)
      .send({ key: "invoke", companyId: companyA });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledTimes(1);
    const params = call.mock.calls[0][2] as { actorContext: Record<string, unknown> };
    expect(params.actorContext).toMatchObject({ budgetSpentFraction: 0.42 });
  });

  it("omits the stamp on the action path when the fraction is undefined (H8)", async () => {
    mockRunBudgetSpentFraction.mockResolvedValue(undefined);
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

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/bridge/action`)
      .send({ key: "invoke", companyId: companyA });

    expect(res.status).toBe(200);
    const params = call.mock.calls[0][2] as { actorContext: Record<string, unknown> };
    expect("budgetSpentFraction" in params.actorContext).toBe(false);
  });
});
