import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
  findEarlierCompletedIssueBlockersResolvedWakeForDependent,
} from "../services/issue-dependency-wakeups.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dependency-wake marker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("earlier completed dependency-wake marker", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  const dependentIssueId = randomUUID();
  const blockerIssueId = randomUUID();
  const firstCycle = new Date("2026-04-01T12:00:00.000Z");
  const secondCycle = new Date("2026-08-01T09:30:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dependency-wake-marker-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function insertWake(input: {
    idempotencyKey: string;
    status?: string;
    requestedAt?: Date;
  }) {
    const [row] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      status: input.status ?? "completed",
      idempotencyKey: input.idempotencyKey,
      requestedAt: input.requestedAt ?? firstCycle,
    }).returning({ id: agentWakeupRequests.id });
    return row!.id;
  }

  async function clearWakes() {
    await db.delete(agentWakeupRequests);
  }

  function stateKey(blockedTransitionAt: Date) {
    return buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt,
    });
  }

  it("finds a completed state-key wake requested before the current cycle", async () => {
    await clearWakes();
    const markerId = await insertWake({ idempotencyKey: stateKey(firstCycle) });
    const found = await findEarlierCompletedIssueBlockersResolvedWakeForDependent(db, {
      companyId,
      dependentIssueId,
      blockedTransitionAt: secondCycle,
    });
    expect(found?.id).toBe(markerId);
  });

  it("ignores wakes requested at or after the current cycle start", async () => {
    await clearWakes();
    await insertWake({ idempotencyKey: stateKey(secondCycle), requestedAt: secondCycle });
    await insertWake({
      idempotencyKey: stateKey(new Date("2026-08-02T00:00:00.000Z")),
      requestedAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    const found = await findEarlierCompletedIssueBlockersResolvedWakeForDependent(db, {
      companyId,
      dependentIssueId,
      blockedTransitionAt: secondCycle,
    });
    expect(found).toBeNull();
  });

  it("ignores earlier wakes that are not completed", async () => {
    await clearWakes();
    await insertWake({ idempotencyKey: stateKey(firstCycle), status: "queued" });
    const found = await findEarlierCompletedIssueBlockersResolvedWakeForDependent(db, {
      companyId,
      dependentIssueId,
      blockedTransitionAt: secondCycle,
    });
    expect(found).toBeNull();
  });

  it("ignores legacy per-edge keys", async () => {
    await clearWakes();
    await insertWake({
      idempotencyKey: buildIssueBlockersResolvedWakeIdempotencyKey({
        dependentIssueId,
        resolvedBlockerIssueId: blockerIssueId,
      }),
    });
    const found = await findEarlierCompletedIssueBlockersResolvedWakeForDependent(db, {
      companyId,
      dependentIssueId,
      blockedTransitionAt: secondCycle,
    });
    expect(found).toBeNull();
  });

  it("ignores wakes for other dependents", async () => {
    await clearWakes();
    await insertWake({
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: randomUUID(),
        blockerIssueIds: [blockerIssueId],
        blockedTransitionAt: firstCycle,
      }),
    });
    const found = await findEarlierCompletedIssueBlockersResolvedWakeForDependent(db, {
      companyId,
      dependentIssueId,
      blockedTransitionAt: secondCycle,
    });
    expect(found).toBeNull();
  });

  it("returns null without a current blocked cycle", async () => {
    await clearWakes();
    await insertWake({ idempotencyKey: stateKey(firstCycle) });
    const found = await findEarlierCompletedIssueBlockersResolvedWakeForDependent(db, {
      companyId,
      dependentIssueId,
      blockedTransitionAt: null,
    });
    expect(found).toBeNull();
  });
});
