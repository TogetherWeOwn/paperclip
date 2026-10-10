import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  secretAccessEvents,
} from "@paperclipai/db";
import { isDeadlockFailure, withDeadlockRetry } from "../db-errors.js";
import { captureRunIdentity } from "../services/run-identity.js";
import { secretService } from "../services/secrets.js";
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

describe("production wiring: captureRunIdentity vs secret audit", () => {
  it("drives captureRunIdentity itself into the run-lock/audit deadlock and survives", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-run-identity-prod-");
    const db = createDb(temporary.connectionString);
    const otherDb = createDb(temporary.connectionString);
    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Prod wiring", issuePrefix: "PW" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Wiring agent" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Wiring issue" });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });

      // Raw audit side in the opposite lock order, mirroring
      // secretAccessEvents' heartbeat_run_id then issue_id FK checks.
      const rawAuditInsert = async () =>
        otherDb.transaction(async (tx) => {
          await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for key share`);
          await tx.insert(secretAccessEvents).values({
            companyId,
            provider: "test",
            actorType: "system",
            consumerType: "agent",
            consumerId: agentId,
            issueId,
            heartbeatRunId: runId,
            outcome: "success",
          });
        });

      // captureRunIdentity locks issues then heartbeat_runs (see
      // lockIdentityTask) and is wrapped in withDeadlockRetry. Racing it
      // against the opposite-order audit insert exercises the production
      // wrapper instead of raw SQL on both sides. The raw side is also
      // retried so the test asserts production correctness, not raw-SQL
      // deadlock flakiness.
      const results = await Promise.allSettled([
        captureRunIdentity(db, { companyId, runId, agentId }),
        withDeadlockRetry(rawAuditInsert, { baseDelayMs: 1 }),
        captureRunIdentity(db, { companyId, runId, agentId }),
        withDeadlockRetry(rawAuditInsert, { baseDelayMs: 1 }),
      ]);
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      // With the retry wrapper no deadlock abort may surface; without it this
      // contention fails intermittently with 40P01.
      expect(failures).toHaveLength(0);

      const audits = await db
        .select({ id: secretAccessEvents.id })
        .from(secretAccessEvents)
        .where(eq(secretAccessEvents.heartbeatRunId, runId));
      expect(audits.length).toBeGreaterThanOrEqual(1);
    } finally {
      await temporary.cleanup();
    }
  }, 120_000);

  it("transaction-bound secret audit uses a savepoint so the outer transaction survives", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-secret-savepoint-");
    const db = createDb(temporary.connectionString);
    const otherDb = createDb(temporary.connectionString);
    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Savepoint fixture", issuePrefix: "SP" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Savepoint agent" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Savepoint issue" });
      await db
        .insert(heartbeatRuns)
        .values({ id: runId, companyId, agentId, status: "running" });

      const runLockFirst = async () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from issues where company_id = ${companyId} and id = ${issueId} for update`,
          );
          auditHasRunShare.release();
          await runShareRequested.gate;
          await tx.execute(
            sql`select id from heartbeat_runs where company_id = ${companyId} and id = ${runId} for update`,
          );
        });

      // Mirrors the fixed recordAccessEvent in secrets.ts: when secretService
      // is bound to a caller-held transaction (e.g. the broker token-mint
      // path at tool-access.ts mintExchangeConnectionToken), the audit insert
      // runs in its own nested transaction so a deadlock abort rolls back
      // only to the SAVEPOINT instead of aborting the outer transaction
      // with 25P02.
      const transactionBoundAuditInsert = async () =>
        otherDb.transaction(async (outer) => {
          await outer.execute(sql`select id from heartbeat_runs where id = ${runId} for key share`);
          runShareRequested.release();
          await auditHasRunShare.gate;
          await withDeadlockRetry(
            () =>
              (outer as unknown as Db).transaction(async (t) => {
                await t.insert(secretAccessEvents).values({
                  companyId,
                  provider: "test",
                  actorType: "system",
                  consumerType: "agent",
                  consumerId: agentId,
                  issueId,
                  heartbeatRunId: runId,
                  outcome: "success",
                });
              }),
            { baseDelayMs: 1 },
          );
          // The outer transaction must still be usable after the savepoint
          // retry; a bare insert here would have left it aborted (25P02).
          await outer.execute(sql`select 1`);
        });

      const auditHasRunShare = latch();
      const runShareRequested = latch();

      const guarded = await Promise.all([
        withDeadlockRetry(runLockFirst, { baseDelayMs: 1 }),
        transactionBoundAuditInsert(),
      ]);
      expect(guarded).toHaveLength(2);
      const audits = await db
        .select({ id: secretAccessEvents.id })
        .from(secretAccessEvents)
        .where(
          and(
            eq(secretAccessEvents.companyId, companyId),
            eq(secretAccessEvents.heartbeatRunId, runId),
          ),
        );
      expect(audits).toHaveLength(1);
    } finally {
      await temporary.cleanup();
    }
  }, 120_000);

  it("resolveSecretValue records the audit row with issue/heartbeat context", async () => {
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "0123456789abcdef0123456789abcdef";
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-resolve-audit-");
    const db = createDb(temporary.connectionString);
    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Resolve audit", issuePrefix: "RA" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Resolve agent" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Resolve issue" });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });

      const svc = secretService(db);
      const secret = await svc.create(companyId, {
        name: `audit-${randomUUID()}`,
        provider: "local_encrypted",
        value: "runtime-secret",
      });
      await svc.createBinding({
        companyId,
        secretId: secret.id,
        targetType: "system",
        targetId: "system",
        configPath: "env.API_KEY",
      });

      // Drives the production resolveSecretValue -> recordAccessEvent wiring
      // with the same issueId/heartbeatRunId FKs that deadlock against the
      // run lock. After the savepoint fix this succeeds even when bound to a
      // caller transaction.
      const value = await svc.resolveSecretValue(companyId, secret.id, "latest", {
        consumerType: "system",
        consumerId: "system",
        configPath: "env.API_KEY",
        actorType: "system",
        issueId,
        heartbeatRunId: runId,
      });
      expect(value).toBe("runtime-secret");

      const events = await db
        .select()
        .from(secretAccessEvents)
        .where(eq(secretAccessEvents.secretId, secret.id));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ issueId, heartbeatRunId: runId, outcome: "success" });

      // Same production path bound to a caller-held transaction, as in the
      // broker mint. The savepoint keeps the outer transaction usable.
      await db.transaction(async (tx) => {
        const txSvc = secretService(tx as unknown as Db);
        const txValue = await txSvc.resolveSecretValue(companyId, secret.id, "latest", {
          consumerType: "system",
          consumerId: "system",
          configPath: "env.API_KEY",
          actorType: "system",
          issueId,
          heartbeatRunId: runId,
        });
        expect(txValue).toBe("runtime-secret");
      });
    } finally {
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousKey;
      await temporary.cleanup();
    }
  }, 120_000);
});
