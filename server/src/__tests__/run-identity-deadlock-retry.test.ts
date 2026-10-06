import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  secretAccessEvents,
} from "@paperclipai/db";
import { isDeadlockFailure, withDeadlockRetry } from "../db-errors.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("isDeadlockFailure", () => {
  it("matches a bare 40P01 code", () => {
    expect(isDeadlockFailure({ code: "40P01" })).toBe(true);
  });

  it("matches the error Drizzle wraps around the driver failure", () => {
    const wrapped = new Error('Failed query: select "id" from "heartbeat_runs" for update');
    (wrapped as { cause?: unknown }).cause = {
      code: "40P01",
      message: 'deadlock detected: Process 1 waits for ShareLock on transaction 2; blocked by process 2',
    };
    expect(isDeadlockFailure(wrapped)).toBe(true);
  });

  it("ignores other Postgres errors", () => {
    expect(isDeadlockFailure({ code: "23505" })).toBe(false);
    expect(isDeadlockFailure({ code: "40001" })).toBe(false);
    expect(isDeadlockFailure(new Error("boom"))).toBe(false);
    expect(isDeadlockFailure(null)).toBe(false);
    expect(isDeadlockFailure(undefined)).toBe(false);
  });
});

describe("withDeadlockRetry", () => {
  it("returns the first-attempt result without retrying", async () => {
    let calls = 0;
    const result = await withDeadlockRetry(async () => {
      calls += 1;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries deadlock aborts and then succeeds", async () => {
    let calls = 0;
    const result = await withDeadlockRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        return "recovered";
      },
      { maxAttempts: 4, baseDelayMs: 1 },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("rethrows non-deadlock errors without retrying", async () => {
    let calls = 0;
    await expect(
      withDeadlockRetry(async () => {
        calls += 1;
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }),
    ).rejects.toThrow("duplicate key");
    expect(calls).toBe(1);
  });

  it("gives up after maxAttempts and rethrows the deadlock", async () => {
    let calls = 0;
    await expect(
      withDeadlockRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        },
        { maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("deadlock detected");
    expect(calls).toBe(2);
  });
});

const COMPANY_ID = "30000000-0000-4000-8000-000000000001";
const AGENT_ID = "30000000-0000-4000-8000-000000000002";
const ISSUE_ID = "30000000-0000-4000-8000-000000000003";
const RUN_ID = "30000000-0000-4000-8000-000000000004";

function latch() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

describe("runtime run-lock vs secret-access audit deadlock", () => {
  it("reproduces the 40P01 pairing and absorbs it with withDeadlockRetry", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-run-lock-deadlock-");
    const db = createDb(temporary.connectionString);
    const otherDb = createDb(temporary.connectionString);
    try {
      await db.insert(companies).values({ id: COMPANY_ID, name: "Deadlock fixture", issuePrefix: "DDL" });
      await db.insert(agents).values({ id: AGENT_ID, companyId: COMPANY_ID, name: "Deadlock agent" });
      await db.insert(issues).values({ id: ISSUE_ID, companyId: COMPANY_ID, title: "Deadlock issue" });
      await db
        .insert(heartbeatRuns)
        .values({ id: RUN_ID, companyId: COMPANY_ID, agentId: AGENT_ID, status: "running" });

      // Side A mirrors captureRunIdentity: issues row first, heartbeat_runs row
      // second, both FOR UPDATE, inside one transaction.
      const runLockFirst = async () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from issues where company_id = ${COMPANY_ID} and id = ${ISSUE_ID} for update`,
          );
          auditHasRunShare.release();
          await runShareRequested.gate;
          await tx.execute(
            sql`select id from heartbeat_runs where company_id = ${COMPANY_ID} and id = ${RUN_ID} for update`,
          );
        });

      // Side B mirrors the secret-access audit insert racing the run lock: it
      // holds FOR KEY SHARE on the run row (exactly what the heartbeat_run_id
      // FK check takes) before the insert's issue_id FK check asks for KEY
      // SHARE on the issues row. Opposite order to side A on purpose.
      const auditInsert = async () =>
        otherDb.transaction(async (tx) => {
          await tx.execute(sql`select id from heartbeat_runs where id = ${RUN_ID} for key share`);
          runShareRequested.release();
          await auditHasRunShare.gate;
          await tx.insert(secretAccessEvents).values({
            companyId: COMPANY_ID,
            provider: "test",
            actorType: "system",
            consumerType: "agent",
            consumerId: AGENT_ID,
            issueId: ISSUE_ID,
            heartbeatRunId: RUN_ID,
            outcome: "success",
          });
        });

      const auditHasRunShare = latch();
      const runShareRequested = latch();

      // Without the retry wrapper the inverted lock order deadlocks: one side
      // must abort with 40P01. Latches stay open across attempts, so a retry
      // would proceed immediately instead of hanging the test.
      const unguarded = await Promise.allSettled([runLockFirst(), auditInsert()]);
      const deadlock = unguarded.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      expect(deadlock, "expected the inverted lock order to deadlock").toBeDefined();
      expect(isDeadlockFailure(deadlock!.reason)).toBe(true);
      // The surviving side committed; roll the audit row back so the guarded
      // run below starts from the same state.
      await db.delete(secretAccessEvents).where(eq(secretAccessEvents.companyId, COMPANY_ID));

      // The latches above stay open, so the guarded attempts below proceed
      // without hanging and converge once the deadlock loser retries.
      const guarded = await Promise.all([
        withDeadlockRetry(runLockFirst, { baseDelayMs: 1 }),
        withDeadlockRetry(auditInsert, { baseDelayMs: 1 }),
      ]);
      expect(guarded).toHaveLength(2);
      const audits = await db
        .select({ id: secretAccessEvents.id })
        .from(secretAccessEvents)
        .where(
          and(
            eq(secretAccessEvents.companyId, COMPANY_ID),
            eq(secretAccessEvents.heartbeatRunId, RUN_ID),
          ),
        );
      expect(audits).toHaveLength(1);
    } finally {
      await temporary.cleanup();
    }
  }, 120_000);
});
