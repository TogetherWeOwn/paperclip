import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ROUTINE_ID = "9cf0f09c-62d5-4193-b699-3268a3c17561";
const FINGERPRINT = "259c2d3e1d0a20184c022ea9d069a06a4f3bd938a6ddaa41ec09d237090cfb8a";

describeEmbeddedPostgres("issueService.assertCheckoutOwner orphaned routine firing adoption", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-routine-adopt-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Mirrors the live shape: the agent's current routine firing is executing under
  // `currentRunId`, and an older firing of the same routine + fingerprint is
  // `in_progress` with no checkout/execution run (its run was reaped).
  async function seed(params: {
    siblingStatus?: "in_progress" | "done";
    orphanFingerprint?: string;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const currentRunId = randomUUID();
    const currentIssueId = randomUUID();
    const orphanIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Planner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: currentRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    const siblingStatus = params.siblingStatus ?? "in_progress";
    await db.insert(issues).values({
      id: currentIssueId,
      companyId,
      title: "Current routine firing",
      status: siblingStatus,
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: ROUTINE_ID,
      originFingerprint: FINGERPRINT,
      checkoutRunId: siblingStatus === "in_progress" ? currentRunId : null,
      executionRunId: siblingStatus === "in_progress" ? currentRunId : null,
      executionLockedAt: siblingStatus === "in_progress" ? new Date() : null,
    });
    await db.insert(issues).values({
      id: orphanIssueId,
      companyId,
      title: "Orphaned older routine firing",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: ROUTINE_ID,
      originFingerprint: params.orphanFingerprint ?? FINGERPRINT,
      checkoutRunId: null,
      executionRunId: null,
    });
    return { agentId, currentRunId, currentIssueId, orphanIssueId };
  }

  it("rejects adoption of an orphaned firing with a 409 while a sibling firing holds the execution slot", async () => {
    const seeded = await seed();

    await expect(
      svc.assertCheckoutOwner(seeded.orphanIssueId, seeded.agentId, seeded.currentRunId),
    ).rejects.toMatchObject({ status: 409 });

    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, seeded.orphanIssueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: null, executionRunId: null });
  });

  it("control: adopts the orphaned firing once the sibling firing is closed", async () => {
    const seeded = await seed({ siblingStatus: "done" });

    const ownership = await svc.assertCheckoutOwner(
      seeded.orphanIssueId,
      seeded.agentId,
      seeded.currentRunId,
    );

    expect(ownership.checkoutRunId).toBe(seeded.currentRunId);
    expect(ownership.executionRunId).toBe(seeded.currentRunId);
  });

  it("control: adopts the orphaned firing when the sibling has a different fingerprint", async () => {
    const seeded = await seed({ orphanFingerprint: "another-fingerprint" });

    const ownership = await svc.assertCheckoutOwner(
      seeded.orphanIssueId,
      seeded.agentId,
      seeded.currentRunId,
    );

    expect(ownership.checkoutRunId).toBe(seeded.currentRunId);
  });
});
