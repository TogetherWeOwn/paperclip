import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  projects,
} from "@paperclipai/db";
import { budgetService } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// Budget behavior is exercised against PostgreSQL below and in
// cost-accounting-reliability.test.ts, including transaction and retry paths.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budgetService release gate enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    mockLogActivity.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createBudgetFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Budget Project",
      status: "in_progress",
    });

    return { companyId, agentId, projectId };
  }

  async function insertCostEvent(input: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
    costCents: number;
    occurredAt?: Date;
  }) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId ?? null,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5-release-gate",
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        costCents: input.costCents,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();

    return event!;
  }

  // Port of #17966's settleWhileCompanyRowLocked. 1023 computes spend inside
  // budgets.ts, so a module mock cannot observe the scan; instead the spend
  // tables are locked so any ledger/pending-run scan would wait.
  async function settleWhileLocked<T>(locks: { companyId?: string; spendTables?: boolean }, start: () => Promise<T>) {
    let admission!: Promise<T>;
    const settled = await db.transaction(async (tx) => {
      if (locks.companyId) await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, locks.companyId)).for("update");
      if (locks.spendTables) await tx.execute(sql`lock table cost_events, heartbeat_runs in access exclusive mode`);
      admission = start();
      return Promise.race([
        admission.then((value) => ({ value })),
        new Promise<"waiting">((resolve) => setTimeout(resolve, 1_000, "waiting")),
      ]);
    });
    return { settled, admission };
  }

  it("raises one soft incident per window before hard-stopping and safely logging agent telemetry", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const softEvent = await insertCostEvent({ companyId, agentId, costCents: 80 });
    await service.evaluateCostEvent(softEvent);
    await service.evaluateCostEvent(softEvent);

    let incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({
      companyId,
      policyId: policy!.id,
      scopeType: "agent",
      scopeId: agentId,
      thresholdType: "soft",
      amountLimit: 100,
      amountObserved: 80,
      approvalId: null,
      status: "open",
    });

    const [agentBeforeHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentBeforeHardStop).toEqual({ status: "active", pauseReason: null });

    const hardEvent = await insertCostEvent({ companyId, agentId, costCents: 25 });
    await service.evaluateCostEvent(hardEvent);
    await service.evaluateCostEvent(hardEvent);

    incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    expect(incidentRows.find((incident) => incident.thresholdType === "soft")).toMatchObject({
      status: "resolved",
    });
    expect(incidentRows.find((incident) => incident.thresholdType === "hard")).toMatchObject({
      amountLimit: 100,
      amountObserved: 105,
      status: "open",
    });

    const [approval] = await db.select().from(approvals);
    expect(approval).toMatchObject({
      companyId,
      type: "budget_override_required",
      status: "pending",
    });

    const [agentAfterHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents);
    expect(agentAfterHardStop).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(agentAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(2);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId, createdBefore: expect.any(Date), enforcement: { policyId: expect.any(String), version: expect.any(Number) } });

    const block = await service.getInvocationBlock(companyId, agentId);
    expect(block).toEqual({
      scopeType: "agent",
      scopeId: agentId,
      scopeName: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    const telemetryCalls = mockLogActivity.mock.calls.map(([, input]) => input);
    expect(telemetryCalls.filter((call) => call.action === "budget.soft_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls.filter((call) => call.action === "budget.hard_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.soft_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 80,
            amountLimit: 100,
          }),
        }),
        expect.objectContaining({
          action: "budget.hard_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 105,
            amountLimit: 100,
            approvalId: approval!.id,
          }),
        }),
      ]),
    );
    for (const call of telemetryCalls) {
      expect(JSON.stringify(call.details)).not.toContain("SECRET_TOKEN_SHOULD_NOT_LEAK");
      expect(call.details).not.toHaveProperty("prompt");
      expect(call.details).not.toHaveProperty("message");
    }
  });

  it("distinguishes a company budget pause from a manual company pause", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const service = budgetService(db);
    await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, companyId));
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Budget pause requires a policy or an explicit operator resume.",
    });
    await db.update(companies).set({ pauseReason: null }).where(eq(companies.id, companyId));
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Company is paused and cannot start new work.",
    });
  });

  it("hard-stops project work until a valid budget raise resumes it and overview reconciles ledger spend", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);

    const incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    const hardIncident = incidentRows.find((incident) => incident.thresholdType === "hard")!;
    expect(hardIncident).toMatchObject({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      amountLimit: 100,
      amountObserved: 125,
      status: "open",
    });

    const [projectAfterHardStop] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterHardStop?.pauseReason).toBe("budget");
    expect(projectAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "project", scopeId: projectId, createdBefore: expect.any(Date), enforcement: { policyId: expect.any(String), version: expect.any(Number) } });

    const overviewWhileBlocked = await service.overview(companyId);
    expect(overviewWhileBlocked.pausedProjectCount).toBe(1);
    expect(overviewWhileBlocked.pendingApprovalCount).toBe(1);
    expect(overviewWhileBlocked.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 100,
      observedAmount: 125,
      remainingAmount: 0,
      utilizationPercent: 125,
      status: "hard_stop",
      paused: true,
      pauseReason: "budget",
    });
    expect(overviewWhileBlocked.activeIncidents).toHaveLength(1);

    await expect(
      service.resolveIncident(
        companyId,
        hardIncident.id,
        { action: "raise_budget_and_resume", amount: 125 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toEqual({
      scopeType: "project",
      scopeId: projectId,
      scopeName: "Budget Project",
      reason: "Project cannot start work because its budget hard-stop is still exceeded.",
    });

    const resolved = await service.resolveIncident(
      companyId,
      hardIncident.id,
      { action: "raise_budget_and_resume", amount: 175, decisionNote: "Approved release-gate budget raise." },
      "board-user",
    );
    expect(resolved).toMatchObject({ status: "resolved", approvalStatus: "approved" });

    const [projectAfterResume] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterResume).toEqual({ pauseReason: null, pausedAt: null });
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();

    const overviewAfterResume = await service.overview(companyId);
    expect(overviewAfterResume.pausedProjectCount).toBe(0);
    expect(overviewAfterResume.pendingApprovalCount).toBe(0);
    expect(overviewAfterResume.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 175,
      observedAmount: 125,
      remainingAmount: 50,
      utilizationPercent: expect.closeTo(71.43, 2),
      status: "ok",
      paused: false,
      pauseReason: null,
    });
    expect(overviewAfterResume.activeIncidents).toHaveLength(0);
  });

  it("admits concurrent runs without the company lock when no policy can block", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const service = budgetService(db);
    const policyBase = { companyId, metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100 };
    await db.insert(budgetPolicies).values([
      { ...policyBase, scopeType: "company", scopeId: companyId, hardStopEnabled: true, isActive: false },
      { ...policyBase, scopeType: "agent", scopeId: agentId, hardStopEnabled: false, isActive: true },
      { ...policyBase, scopeType: "project", scopeId: projectId, hardStopEnabled: true, amount: 0, isActive: true },
    ]);
    await insertCostEvent({ companyId, agentId, projectId, costCents: 500 });

    const { settled } = await settleWhileLocked({ companyId, spendTables: true }, () => Promise.all([
      service.getInvocationBlock(companyId, agentId, { projectId }),
      service.getInvocationBlock(companyId, agentId),
    ]));

    expect(settled).toEqual({ value: [null, null] });
    await expect(service.getInvocationBlock(companyId, randomUUID())).rejects.toThrow("Agent not found");
  });

  it("keeps active hard-stop admission behind the company lock and blocks at the limit", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const service = budgetService(db);
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true, isActive: true });

    const underLimit = await settleWhileLocked({ companyId }, () => service.getInvocationBlock(companyId, agentId));
    expect(underLimit.settled).toBe("waiting");
    expect(await underLimit.admission).toBeNull();

    await insertCostEvent({ companyId, agentId, costCents: 100 });
    const atLimit = await settleWhileLocked({ companyId }, () => service.getInvocationBlock(companyId, agentId));
    expect(atLimit.settled).toBe("waiting");
    expect(await atLimit.admission).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Company is paused because its budget hard-stop was reached.",
    });
  });

  it("resolves inactive policy incidents and budget holds without scanning their spend", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const service = budgetService(db);
    const policyBase = { companyId, metric: "billed_cents", amount: 100, hardStopEnabled: true, isActive: false };
    const [agentPolicy] = await db.insert(budgetPolicies).values({ ...policyBase, scopeType: "agent", scopeId: agentId,
      windowKind: "calendar_month_utc" }).returning();
    const [projectPolicy] = await db.insert(budgetPolicies).values({ ...policyBase, scopeType: "project", scopeId: projectId,
      windowKind: "lifetime" }).returning();
    const incidentBase = { companyId, metric: "billed_cents", windowStart: new Date(0), windowEnd: new Date(Date.UTC(9999, 0, 1)),
      amountLimit: 100, amountObserved: 125, status: "open" };
    await db.insert(budgetIncidents).values([
      { ...incidentBase, policyId: agentPolicy!.id, scopeType: "agent", scopeId: agentId, windowKind: "calendar_month_utc", thresholdType: "soft" },
      { ...incidentBase, policyId: projectPolicy!.id, scopeType: "project", scopeId: projectId, windowKind: "lifetime", thresholdType: "hard" },
    ]);
    await db.update(projects).set({ pauseReason: "budget", pausedAt: new Date() }).where(eq(projects.id, projectId));
    const incidentStatus = async (policyId: string) =>
      (await db.select().from(budgetIncidents).where(eq(budgetIncidents.policyId, policyId)))[0]?.status;

    expect((await settleWhileLocked({ spendTables: true }, () => service.getInvocationBlock(companyId, agentId))).settled)
      .toEqual({ value: null });
    expect(await incidentStatus(agentPolicy!.id)).toBe("resolved");
    expect(await incidentStatus(projectPolicy!.id)).toBe("open");

    expect((await settleWhileLocked({ spendTables: true }, () => service.getInvocationBlock(companyId, agentId, { projectId }))).settled)
      .toEqual({ value: null });
    expect(await incidentStatus(projectPolicy!.id)).toBe("resolved");
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]).toMatchObject({ pauseReason: null, pausedAt: null });
  });

  it("keeps a manual project pause blocking when no policy exists", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    await db.update(projects).set({ pauseReason: "manual", pausedAt: new Date() }).where(eq(projects.id, projectId));
    expect(await budgetService(db).getInvocationBlock(companyId, agentId, { projectId })).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      reason: "Project is paused and cannot start new work.",
    });
  });

  // 1023-only: budgetService.getInvocationBlock also reconciles agent policy
  // holds under the lock. The fast path is taken only when that is a no-op.
  it("keeps agent hold reconciliation behind the company lock when holds are unsettled", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    await db.update(agents).set({ lifecycleHolds: ["company_paused"], pauseReason: "company_paused" }).where(eq(agents.id, agentId));
    const { settled, admission } = await settleWhileLocked({ companyId }, () => budgetService(db).getInvocationBlock(companyId, agentId));
    expect(settled).toBe("waiting");
    expect(await admission).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toMatchObject({ lifecycleHolds: [], pauseReason: null });
  });

  it("still retries pending budget cancellation delivery on the lock-free path", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true, isActive: false,
      enforcementVersion: 1, enforcementDeliveredVersion: 0 }).returning();
    expect(await budgetService(db, { cancelWorkForScope }).getInvocationBlock(companyId, agentId)).toBeNull();
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy!.id)))[0]?.enforcementDeliveredVersion).toBe(1);
  });
});
