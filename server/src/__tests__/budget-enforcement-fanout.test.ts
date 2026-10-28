import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, approvals, budgetIncidents, budgetPolicies, companies, costEvents, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));

import { budgetService } from "../services/budgets.ts";
import { applyAgentBudgetHoldInTransaction } from "../services/agent-lifecycle.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { createCostAccountingReconciler } from "../services/run-cost-accounting.ts";

// Residual of upstream #17046 (30b753f61): budget enforcement delivery no longer
// runs company-wide lifecycle reconciliation (one company accounting
// transaction per agent), and the cost accounting sweep is single-flight.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budget enforcement company-lock fan-out", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-enforcement-fanout-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function companyWithIdleAgents(count: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fan-out",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(Array.from({ length: count }, (_, index) => ({
      id: randomUUID(), companyId, name: `Idle ${index}`, role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    return companyId;
  }

  /** Runs `start` while another transaction holds the company accounting row. */
  async function settleWhileCompanyLocked<T>(companyId: string, start: () => Promise<T>) {
    let pending!: Promise<T>;
    const settled = await db.transaction(async (tx) => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("update");
      pending = start();
      return Promise.race([
        pending.then((value) => ({ value })),
        new Promise<"waiting">((resolve) => setTimeout(resolve, 1_000, "waiting")),
      ]);
    });
    await pending;
    return settled;
  }

  it("settles budget enforcement without a company accounting transaction per idle agent", async () => {
    const companyId = await companyWithIdleAgents(5);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const settled = await settleWhileCompanyLocked(companyId,
      () => budgetService(db, { cancelWorkForScope }).deliverPendingEnforcement(companyId));

    // Before the fix this waited behind the held row: reconcilePolicyHolds
    // opened one company accounting transaction for each of the 5 idle agents
    // on every settlement, cost event and policy sweep.
    expect(settled).toEqual({ value: undefined });
    expect(cancelWorkForScope).not.toHaveBeenCalled();
  });

  it("applies an agent hard-stop hold in the budget transaction without touching other agents", async () => {
    const companyId = await companyWithIdleAgents(3);
    const [agent, ...others] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agent!.id,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true, isActive: true });
    const [event] = await db.insert(costEvents).values({ companyId, agentId: agent!.id, provider: "openai", biller: "openai",
      billingType: "metered_api", model: "fanout", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costCents: 150,
      occurredAt: new Date() }).returning();
    const service = budgetService(db);

    await service.evaluateCostEvent(event!);
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]).toMatchObject({ lifecycleHolds: ["budget"] });
    for (const other of others) {
      expect((await db.select().from(agents).where(eq(agents.id, other.id)))[0]).toMatchObject({ lifecycleHolds: [] });
    }
    expect(await service.getInvocationBlock(companyId, agent!.id)).toMatchObject({ scopeType: "agent", scopeId: agent!.id });

    await service.upsertPolicy(companyId, { scopeType: "agent", scopeId: agent!.id, amount: 200 }, null);
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]?.lifecycleHolds).not.toContain("budget");
  });

  it("waits for a contended agent row and applies the budget hold after release", async () => {
    const companyId = await companyWithIdleAgents(1);
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agent!.id,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true, isActive: true });
    const [event] = await db.insert(costEvents).values({ companyId, agentId: agent!.id, provider: "openai", biller: "openai",
      billingType: "metered_api", model: "contention", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costCents: 150,
      occurredAt: new Date() }).returning();
    let pending!: Promise<void>;
    const settled = await db.transaction(async (tx) => {
      await tx.select().from(agents).where(eq(agents.id, agent!.id)).for("update");
      pending = budgetService(db).evaluateCostEvent(event!);
      return Promise.race([
        pending.then(() => "completed" as const),
        new Promise<"waiting">((resolve) => setTimeout(resolve, 1_000, "waiting")),
      ]);
    });
    // Always release the lock and drain the evaluation before asserting, including on failure.
    await pending;
    expect(settled).toBe("waiting");
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]).toMatchObject({
      lifecycleHolds: ["budget"], lifecycleState: "pausing", pauseReason: "budget",
    });
  });

  it.each(["stop", "resume"] as const)("preserves an inherited company_paused hold on budget %s", async (action) => {
    const companyId = await companyWithIdleAgents(1);
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    // The company is active but its inherited hold has not yet been projected away.
    // Budget enforcement must change only the budget hold, not reconcile the company.
    await db.update(agents).set({ lifecycleHolds: action === "stop" ? ["company_paused"] : ["company_paused", "budget"],
      lifecycleState: "paused", status: "paused", pauseReason: "company_paused" }).where(eq(agents.id, agent!.id));
    await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agent!.id,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true, isActive: true });
    const [event] = await db.insert(costEvents).values({ companyId, agentId: agent!.id, provider: "openai", biller: "openai",
      billingType: "metered_api", model: "hold-preservation", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1,
      costCents: action === "stop" ? 150 : 50, occurredAt: new Date() }).returning();

    const service = budgetService(db);
    if (action === "stop") await service.evaluateCostEvent(event!);
    else await service.upsertPolicy(companyId, { scopeType: "agent", scopeId: agent!.id, amount: 200 }, null);

    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]).toMatchObject({
      lifecycleHolds: action === "stop" ? ["company_paused", "budget"] : ["company_paused"],
      lifecycleState: "paused", pauseReason: "company_paused",
    });
  });

  it("applies the computed budget decision without resolving policies again", async () => {
    const companyId = await companyWithIdleAgents(1);
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    // No budget policy exists: this integration boundary must consume its caller's decision.
    await db.transaction(tx => applyAgentBudgetHoldInTransaction(tx as unknown as typeof db, companyId, agent!.id, true));
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]?.lifecycleHolds).toEqual(["budget"]);
    await db.transaction(tx => applyAgentBudgetHoldInTransaction(tx as unknown as typeof db, companyId, agent!.id, false));
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]?.lifecycleHolds).toEqual([]);
  });

  it("does not apply a budget decision to an agent from another company", async () => {
    const companyId = await companyWithIdleAgents(1);
    const otherCompanyId = await companyWithIdleAgents(1);
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    // A real blocking policy makes ignoring companyId observable even in the old shim.
    await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agent!.id,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true, isActive: true });
    await db.insert(costEvents).values({ companyId, agentId: agent!.id, provider: "openai", biller: "openai",
      billingType: "metered_api", model: "company-scope", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1,
      costCents: 150, occurredAt: new Date() });
    await db.transaction(tx => applyAgentBudgetHoldInTransaction(tx as unknown as typeof db, otherCompanyId, agent!.id, true));
    expect((await db.select().from(agents).where(eq(agents.id, agent!.id)))[0]?.lifecycleHolds).toEqual([]);
  });

  it("shares one recovery sweep, including service recovery, across overlapping ticks", async () => {
    let release!: () => void;
    const recoverServices = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const reconcile = createCostAccountingReconciler(db, {}, recoverServices);

    const first = reconcile();
    const second = reconcile();
    expect(second).toBe(first);
    release();
    await expect(first).resolves.toMatchObject({ scanned: 0, accounted: 0 });
    expect(recoverServices).toHaveBeenCalledTimes(1);

    // A failed service recovery still completes run accounting, then reports.
    const failing = createCostAccountingReconciler(db, {}, () => Promise.reject(new Error("decision recovery failed")));
    await expect(failing()).rejects.toThrow("decision recovery failed");
  });

  it("returns the in-flight sweep from the heartbeat service instead of starting another", async () => {
    const heartbeat = heartbeatService(db);
    const first = heartbeat.reconcileCostAccounting();
    const second = heartbeat.reconcileCostAccounting();
    expect(second).toBe(first);
    await first;
  });
});
