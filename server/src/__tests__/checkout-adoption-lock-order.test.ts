import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { issueService } from "../services/issues.ts";

// Test-author owned: integrate unchanged; return test corrections to the author.
// Never consume DATABASE_URL or a shared application/test database. CI uses its
// own embedded PostgreSQL unless an exclusively owned test database is supplied.
const testDatabaseUrl = process.env.PAPERCLIP_CHECKOUT_ADOPTION_TEST_DATABASE_URL?.trim();
if (testDatabaseUrl) {
  const url = new URL(testDatabaseUrl);
  const allowedHost = url.hostname === "agent-testdb" ||
    (process.env.CI === "true" && ["localhost", "127.0.0.1", "postgres"].includes(url.hostname));
  if (!allowedHost || !/^\/paperclip_checkout_adoption_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error("Checkout adoption tests require an exclusive paperclip_checkout_adoption_* database on agent-testdb or a CI PostgreSQL service");
  }
}

type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("unowned checkout adoption lock order", () => {
  let db: ReturnType<typeof createDb>;
  let contender: ReturnType<typeof createDb>;
  let observer: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const companyIds: string[] = [];

  beforeAll(async () => {
    const connectionString = testDatabaseUrl ??
      (tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-adoption-")).connectionString;
    if (testDatabaseUrl) await applyPendingMigrations(connectionString);
    // Two competing transaction connections and one read-only wait-graph observer.
    db = createDb(connectionString, { maxConnections: 1 });
    contender = createDb(connectionString, { maxConnections: 1 });
    observer = createDb(connectionString, { maxConnections: 1 });
    for (const client of [db, contender, observer]) {
      await client.execute(sql`set statement_timeout = '8s'`);
    }
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const companyId of companyIds.splice(0)) {
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
  });

  afterAll(async () => {
    await Promise.all([db, contender, observer].filter(Boolean).map((client) => client.$client.end({ timeout: 0 })));
    await tempDb?.cleanup();
  });

  async function seed(actorStatus: RunStatus = "running", otherAssignee = false) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const actorRunId = randomUUID();
    const issueId = randomUUID();
    companyIds.push(companyId);
    await db.insert(companies).values({
      id: companyId,
      name: "Checkout adoption fixture",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
    });
    await db.insert(agents).values([agentId, otherAgentId].map((id) => ({
      id, companyId, name: id, role: "engineer", status: "active", adapterType: "process",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    await db.insert(heartbeatRuns).values({
      id: actorRunId, companyId, agentId, invocationSource: "manual", status: actorStatus,
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Unowned checkout", status: "in_progress",
      assigneeAgentId: otherAssignee ? otherAgentId : agentId,
      checkoutRunId: null, executionRunId: null,
    });
    return { companyId, agentId, otherAgentId, actorRunId, issueId };
  }

  async function ownership(issueId: string) {
    const [row] = await db.select({
      assigneeAgentId: issues.assigneeAgentId,
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
    }).from(issues).where(eq(issues.id, issueId));
    return row;
  }

  // The barrier is an observed PostgreSQL lock wait, not a sleep that guesses
  // when adoption has begun. A missing wait fails within a fixed deadline.
  async function waitForBlockedBy(blockerPid: number, waiterPid: number) {
    const deadline = performance.now() + 4_000;
    while (performance.now() < deadline) {
      const rows = await observer.execute<{ blocked: boolean }>(sql`
        select ${blockerPid} = any(pg_blocking_pids(${waiterPid})) as blocked
      `);
      if (rows[0]?.blocked) return;
      await delay(10);
    }
    throw new Error("Adoption never reached the issue-row lock held by the competing transaction");
  }

  async function contend(
    seeded: Awaited<ReturnType<typeof seed>>,
    change: "none" | "terminalize" | "reassign",
  ) {
    const locked = deferred();
    const proceed = deferred();
    const adoptionReady = deferred();
    const adoptionCanStart = deferred();
    let blockerPid!: number;
    const [actorConnection] = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    // assertCheckoutOwner first performs two issue-first stale-lock cleanup
    // transactions. Gate the third transaction BEFORE its first statement:
    // otherwise the competitor merely blocks cleanup and the buggy adoption
    // never overlaps it. All callbacks and SQL still execute on real PostgreSQL.
    // If that lifecycle changes, update this test-author-owned fixture explicitly.
    const transaction = db.transaction.bind(db);
    let transactionCount = 0;
    const transactionGate = vi.spyOn(db, "transaction").mockImplementation((callback, config) =>
      transaction(async (tx) => {
        if (++transactionCount === 3) {
          adoptionReady.resolve();
          await adoptionCanStart.promise;
        }
        return callback(tx);
      }, config),
    );
    const adoption = settled(svc.assertCheckoutOwner(seeded.issueId, seeded.agentId, seeded.actorRunId));
    await Promise.race([adoptionReady.promise, adoption.then(() => {
      throw new Error("Ownership resolved before reaching the adoption transaction barrier");
    })]);
    const competitor = settled(contender.transaction(async (tx) => {
      // Model the issue -> run ordering used by finalization/recovery. Keep its
      // run-lock attempt bounded so a regression cannot strand test teardown.
      await tx.execute(sql`set local lock_timeout = '1s'`);
      const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      blockerPid = connection.pid;
      await tx.execute(sql`select id from issues where id = ${seeded.issueId} for update`);
      locked.resolve();
      await proceed.promise;
      await tx.execute(sql`select id from heartbeat_runs where id = ${seeded.actorRunId} for update`);
      if (change === "terminalize") {
        await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, seeded.actorRunId));
      }
      if (change === "reassign") {
        await tx.update(issues).set({ assigneeAgentId: seeded.otherAgentId })
          .where(eq(issues.id, seeded.issueId));
      }
    }));
    try {
      // Surface fixture setup failures rather than hanging on an unfulfilled gate.
      await Promise.race([locked.promise, competitor.then((result) => {
        if (!result.ok) throw result.error;
      })]);
      adoptionCanStart.resolve();
      await waitForBlockedBy(blockerPid, actorConnection.pid);
    } finally {
      proceed.resolve();
      adoptionCanStart.resolve();
      // Drain both operations even if the barrier assertion fails.
      await Promise.all([competitor, adoption]);
      transactionGate.mockRestore();
    }
    return { competitor: await competitor, adoption: await adoption };
  }

  it.each(["queued", "running"] as const)("allows an active %s actor to adopt an unowned checkout", async (status) => {
    const seeded = await seed(status);
    await expect(svc.assertCheckoutOwner(seeded.issueId, seeded.agentId, seeded.actorRunId))
      .resolves.toMatchObject({ checkoutRunId: seeded.actorRunId, executionRunId: seeded.actorRunId });
    expect(await ownership(seeded.issueId)).toEqual({
      assigneeAgentId: seeded.agentId, checkoutRunId: seeded.actorRunId, executionRunId: seeded.actorRunId,
    });
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)("refuses a terminal %s actor without claiming ownership", async (status) => {
    const seeded = await seed(status);
    await expect(svc.assertCheckoutOwner(seeded.issueId, seeded.agentId, seeded.actorRunId))
      .rejects.toMatchObject({ status: 409 });
    expect(await ownership(seeded.issueId)).toEqual({
      assigneeAgentId: seeded.agentId, checkoutRunId: null, executionRunId: null,
    });
  });

  it("refuses an actor other than the assignee", async () => {
    const seeded = await seed("running", true);
    await expect(svc.assertCheckoutOwner(seeded.issueId, seeded.agentId, seeded.actorRunId))
      .rejects.toMatchObject({ status: 409 });
    expect(await ownership(seeded.issueId)).toEqual({
      assigneeAgentId: seeded.otherAgentId, checkoutRunId: null, executionRunId: null,
    });
  });

  it("refuses to replace a different live checkout run", async () => {
    const seeded = await seed();
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId, companyId: seeded.companyId, agentId: seeded.agentId,
      invocationSource: "manual", status: "running",
    });
    await db.update(issues).set({ checkoutRunId: liveRunId, executionRunId: liveRunId })
      .where(eq(issues.id, seeded.issueId));
    await expect(svc.assertCheckoutOwner(seeded.issueId, seeded.agentId, seeded.actorRunId))
      .rejects.toMatchObject({ status: 409 });
    expect(await ownership(seeded.issueId)).toEqual({
      assigneeAgentId: seeded.agentId, checkoutRunId: liveRunId, executionRunId: liveRunId,
    });
  });

  it("waits for the issue without holding the actor run needed by an issue-first competitor", async () => {
    const seeded = await seed();
    const result = await contend(seeded, "none");
    expect(result.competitor, "issue-first competitor must not deadlock or time out on the actor run")
      .toEqual({ ok: true, value: undefined });
    expect(result.adoption).toMatchObject({
      ok: true, value: { checkoutRunId: seeded.actorRunId, executionRunId: seeded.actorRunId },
    });
    expect(await ownership(seeded.issueId)).toEqual({
      assigneeAgentId: seeded.agentId, checkoutRunId: seeded.actorRunId, executionRunId: seeded.actorRunId,
    });
  });

  it("revalidates actor activity after waiting for a concurrent issue-first finalizer", async () => {
    const seeded = await seed();
    const result = await contend(seeded, "terminalize");
    expect(result.competitor, "the finalizer must acquire the actor run and commit")
      .toEqual({ ok: true, value: undefined });
    expect(result.adoption).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await ownership(seeded.issueId)).toEqual({
      assigneeAgentId: seeded.agentId, checkoutRunId: null, executionRunId: null,
    });
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.actorRunId));
    expect(run.status).toBe("succeeded");
  });

  it("does not overwrite a competing assignee change while waiting for the issue", async () => {
    const seeded = await seed();
    const result = await contend(seeded, "reassign");
    expect(result.competitor).toEqual({ ok: true, value: undefined });
    expect(result.adoption).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await ownership(seeded.issueId)).toEqual({
      assigneeAgentId: seeded.otherAgentId, checkoutRunId: null, executionRunId: null,
    });
  });
});
