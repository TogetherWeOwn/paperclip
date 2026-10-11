import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  secretAccessEvents,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { isDeadlockFailure, withDeadlockRetry } from "../db-errors.js";
import { captureRunIdentity } from "../services/run-identity.js";
import { secretService } from "../services/secrets.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("isDeadlockFailure", () => {
  it("matches a bare 40P01 code", () => {
    expect(isDeadlockFailure({ code: "40P01" })).toBe(true);
  });

  it("matches the error Drizzle wraps around the driver failure", () => {
    const wrapped = new Error(
      'Failed query: select "id" from "heartbeat_runs" for update',
    );
    (wrapped as { cause?: unknown }).cause = {
      code: "40P01",
      message:
        "deadlock detected: Process 1 waits for ShareLock on transaction 2; blocked by process 2",
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
        if (calls < 3)
          throw Object.assign(new Error("deadlock detected"), {
            code: "40P01",
          });
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
          throw Object.assign(new Error("deadlock detected"), {
            code: "40P01",
          });
        },
        { maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("deadlock detected");
    expect(calls).toBe(2);
  });
});

const MASTER_KEY = "0123456789abcdef0123456789abcdef";

function latch() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/**
 * Postgres runs a row's FK checks in trigger-name order, and the trigger names
 * come from OIDs assigned when each constraint was created. Migration 0082
 * adds `secret_access_events`' issue_id FK before its heartbeat_run_id FK, so
 * a database migrated from scratch checks `issues` first: the same order as
 * lockIdentityTask, with no inversion. The production database has the
 * constraints in name order (heartbeat_run_id before issue_id, as a pg_dump
 * restore re-creates them), so its audit insert takes KEY SHARE on the run row
 * and then on the issue row. Re-create the two FKs in that order so the real
 * insert takes the production lock order, and fail fast if it did not stick.
 */
async function matchProductionAuditFkOrder(db: Db) {
  await db.execute(sql`
    do $$
    declare
      run_fk text;
      issue_fk text;
    begin
      select pg_get_constraintdef(oid) into run_fk from pg_constraint
        where conname = 'secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk';
      select pg_get_constraintdef(oid) into issue_fk from pg_constraint
        where conname = 'secret_access_events_issue_id_issues_id_fk';
      alter table secret_access_events
        drop constraint secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk,
        drop constraint secret_access_events_issue_id_issues_id_fk;
      execute 'alter table secret_access_events add constraint secret_access_events_heartbeat_run_id_heartbeat_runs_id_fk ' || run_fk;
      execute 'alter table secret_access_events add constraint secret_access_events_issue_id_issues_id_fk ' || issue_fk;
    end $$;
  `);
  const fired = (await db.execute(sql`
    select c.confrelid::regclass::text as ref
    from pg_trigger t
    join pg_constraint c on c.oid = t.tgconstraint
    where t.tgrelid = 'secret_access_events'::regclass
      and c.confrelid in ('issues'::regclass, 'heartbeat_runs'::regclass)
      and t.tgfoid = 'pg_catalog."RI_FKey_check_ins"'::regproc
    order by t.tgname
  `)) as unknown as Array<{ ref: string }>;
  expect(fired.map((row) => row.ref)).toEqual(["heartbeat_runs", "issues"]);
}

async function waitForLockWaiter(observer: Db) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = (await observer.execute(sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `)) as unknown as Array<{ waiting: number }>;
    if (row && row.waiting > 0) return;
    if (Date.now() > deadline)
      throw new Error("no session started waiting on a row lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The run-identity side: lockIdentityTask's issues-then-run FOR UPDATE order.
 * It takes the run lock only once the audit side is already blocked on the
 * issue row, while the audit insert still holds KEY SHARE on the run row, so
 * the cycle forms every time. Its deadlock_timeout is raised so the audit side,
 * which started waiting first, is always the deadlock victim.
 */
function lockIssueThenRun(
  db: Db,
  ids: { companyId: string; issueId: string; runId: string },
  issueLocked: () => void,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local deadlock_timeout = '30s'`);
    await tx.execute(
      sql`select id from issues where company_id = ${ids.companyId} and id = ${ids.issueId} for update`,
    );
    issueLocked();
    await waitForLockWaiter(db);
    await tx.execute(
      sql`select id from heartbeat_runs where company_id = ${ids.companyId} and id = ${ids.runId} for update`,
    );
  });
}

async function seedRuntimeRun(db: Db, prefix: string) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  await db
    .insert(companies)
    .values({ id: companyId, name: `${prefix} fixture`, issuePrefix: prefix });
  await db
    .insert(agents)
    .values({ id: agentId, companyId, name: `${prefix} agent` });
  await db
    .insert(issues)
    .values({ id: issueId, companyId, title: `${prefix} issue` });
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    status: "running",
    contextSnapshot: { issueId },
  });
  return { companyId, agentId, issueId, runId };
}

async function seedBoundSecret(db: Db, companyId: string) {
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
  return secret;
}

function runtimeAccess(ids: { issueId: string; runId: string }) {
  return {
    consumerType: "system" as const,
    consumerId: "system",
    configPath: "env.API_KEY",
    actorType: "system" as const,
    issueId: ids.issueId,
    heartbeatRunId: ids.runId,
  };
}

async function withMasterKey<T>(fn: () => Promise<T>) {
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = MASTER_KEY;
  try {
    return await fn();
  } finally {
    if (previousKey === undefined)
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousKey;
  }
}

describe("runtime run-lock vs secret-access audit deadlock", () => {
  it("deadlocks the real audit insert against the run lock in the production FK order", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase(
      "paperclip-run-lock-deadlock-",
    );
    const db = createDb(temporary.connectionString);
    const otherDb = createDb(temporary.connectionString);
    try {
      await matchProductionAuditFkOrder(db);
      const ids = await seedRuntimeRun(db, "DDL");

      // A plain insert with no hand-written locks: its own FK checks take KEY
      // SHARE on heartbeat_runs and then on issues.
      const auditInsert = () =>
        otherDb.insert(secretAccessEvents).values({
          companyId: ids.companyId,
          provider: "test",
          actorType: "system",
          consumerType: "agent",
          consumerId: ids.agentId,
          issueId: ids.issueId,
          heartbeatRunId: ids.runId,
          outcome: "success",
        });

      const unguardedIssueLocked = latch();
      const unguarded = await Promise.allSettled([
        lockIssueThenRun(db, ids, unguardedIssueLocked.release),
        unguardedIssueLocked.gate.then(auditInsert),
      ]);
      expect(unguarded[0].status).toBe("fulfilled");
      expect(
        unguarded[1].status,
        "expected the audit insert to lose the deadlock",
      ).toBe("rejected");
      expect(
        isDeadlockFailure((unguarded[1] as PromiseRejectedResult).reason),
      ).toBe(true);

      const guardedIssueLocked = latch();
      await Promise.all([
        lockIssueThenRun(db, ids, guardedIssueLocked.release),
        guardedIssueLocked.gate.then(() =>
          withDeadlockRetry(auditInsert, { baseDelayMs: 1 }),
        ),
      ]);
      const audits = await db
        .select({ id: secretAccessEvents.id })
        .from(secretAccessEvents)
        .where(eq(secretAccessEvents.heartbeatRunId, ids.runId));
      expect(audits).toHaveLength(1);
    } finally {
      await temporary.cleanup();
    }
  }, 120_000);
});

describe("production wiring: captureRunIdentity vs secret audit", () => {
  it("drives captureRunIdentity itself into the run-lock/audit deadlock and survives", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase(
      "paperclip-run-identity-prod-",
    );
    const db = createDb(temporary.connectionString);
    const otherDb = createDb(temporary.connectionString);
    try {
      await matchProductionAuditFkOrder(db);
      const { companyId, agentId, issueId, runId } = await seedRuntimeRun(
        db,
        "PW",
      );

      // The audit side in the production FK order. Its first statement is the
      // KEY SHARE on the run row that the insert's first FK check takes;
      // splitting it out only widens the gap before the issue check, because
      // captureRunIdentity cannot be paused between its issue and run locks.
      const rawAuditInsert = async () =>
        otherDb.transaction(async (tx) => {
          await tx.execute(
            sql`select id from heartbeat_runs where id = ${runId} for key share`,
          );
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
      // lockIdentityTask) and is wrapped in withDeadlockRetry. The raw side is
      // also retried so the test asserts production correctness, not raw-SQL
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
      // contention fails with 40P01.
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

  it("root-bound resolveSecretValue keeps the audit row when its insert loses the deadlock", async () => {
    await withMasterKey(async () => {
      const temporary = await startEmbeddedPostgresTestDatabase(
        "paperclip-secret-root-deadlock-",
      );
      const db = createDb(temporary.connectionString);
      const otherDb = createDb(temporary.connectionString);
      try {
        await matchProductionAuditFkOrder(db);
        const ids = await seedRuntimeRun(db, "RD");
        const secret = await seedBoundSecret(db, ids.companyId);

        const issueLocked = latch();
        const [, value] = await Promise.all([
          lockIssueThenRun(db, ids, issueLocked.release),
          issueLocked.gate.then(() =>
            secretService(otherDb).resolveSecretValue(
              ids.companyId,
              secret.id,
              "latest",
              runtimeAccess(ids),
            ),
          ),
        ]);
        expect(value).toBe("runtime-secret");

        // resolveSecretValue swallows audit failures, so without the retry the
        // deadlock victim's audit row would silently be missing here.
        const events = await db
          .select()
          .from(secretAccessEvents)
          .where(eq(secretAccessEvents.secretId, secret.id));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          issueId: ids.issueId,
          heartbeatRunId: ids.runId,
          outcome: "success",
        });
      } finally {
        await temporary.cleanup();
      }
    });
  }, 120_000);

  it("transaction-bound resolveSecretValue retries in a savepoint so the caller's transaction survives", async () => {
    await withMasterKey(async () => {
      const temporary = await startEmbeddedPostgresTestDatabase(
        "paperclip-secret-savepoint-",
      );
      const db = createDb(temporary.connectionString);
      const otherDb = createDb(temporary.connectionString);
      try {
        await matchProductionAuditFkOrder(db);
        const ids = await seedRuntimeRun(db, "SP");
        const secret = await seedBoundSecret(db, ids.companyId);

        // secretService bound to a caller-held transaction, as in the broker
        // token-mint path. A deadlock abort must roll back only the audit's
        // SAVEPOINT; a bare insert or bare retry would leave the outer
        // transaction aborted and the follow-up query failing with 25P02.
        const issueLocked = latch();
        let savepointAttempts = 0;
        const [, value] = await Promise.all([
          lockIssueThenRun(db, ids, issueLocked.release),
          issueLocked.gate.then(() =>
            otherDb.transaction(async (tx) => {
              const savepointSpy = vi.spyOn(tx, "transaction");
              const resolved = await secretService(
                tx as unknown as Db,
              ).resolveSecretValue(
                ids.companyId,
                secret.id,
                "latest",
                runtimeAccess(ids),
              );
              await tx.execute(sql`select 1`);
              savepointAttempts = savepointSpy.mock.calls.length;
              return resolved;
            }),
          ),
        ]);
        expect(value).toBe("runtime-secret");
        // The first savepoint lost the deadlock; the retry opened a second.
        expect(savepointAttempts).toBe(2);

        const events = await db
          .select()
          .from(secretAccessEvents)
          .where(eq(secretAccessEvents.secretId, secret.id));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          issueId: ids.issueId,
          heartbeatRunId: ids.runId,
          outcome: "success",
        });
      } finally {
        await temporary.cleanup();
      }
    });
  }, 120_000);

  it("resolveSecretValue records the audit row with issue/heartbeat context", async () => {
    await withMasterKey(async () => {
      const temporary = await startEmbeddedPostgresTestDatabase(
        "paperclip-resolve-audit-",
      );
      const db = createDb(temporary.connectionString);
      try {
        const ids = await seedRuntimeRun(db, "RA");
        const secret = await seedBoundSecret(db, ids.companyId);
        const svc = secretService(db);

        const value = await svc.resolveSecretValue(
          ids.companyId,
          secret.id,
          "latest",
          runtimeAccess(ids),
        );
        expect(value).toBe("runtime-secret");

        const events = await db
          .select()
          .from(secretAccessEvents)
          .where(eq(secretAccessEvents.secretId, secret.id));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          issueId: ids.issueId,
          heartbeatRunId: ids.runId,
          outcome: "success",
        });

        // Same production path bound to a caller-held transaction, as in the
        // broker mint: exactly one savepoint for the audit insert, and the
        // outer transaction stays usable.
        await db.transaction(async (tx) => {
          const savepointSpy = vi.spyOn(tx, "transaction");
          const txValue = await secretService(
            tx as unknown as Db,
          ).resolveSecretValue(
            ids.companyId,
            secret.id,
            "latest",
            runtimeAccess(ids),
          );
          expect(txValue).toBe("runtime-secret");
          expect(savepointSpy).toHaveBeenCalledTimes(1);
          await tx.execute(sql`select 1`);
        });
      } finally {
        await temporary.cleanup();
      }
    });
  }, 120_000);

  it("root-bound secret audit inserts without opening an extra transaction", async () => {
    await withMasterKey(async () => {
      const temporary = await startEmbeddedPostgresTestDatabase(
        "paperclip-resolve-audit-root-",
      );
      const db = createDb(temporary.connectionString);
      try {
        const ids = await seedRuntimeRun(db, "RR");
        const secret = await seedBoundSecret(db, ids.companyId);
        const svc = secretService(db);

        // The root-bound audit must stay a bare insert. An extra
        // db.transaction here shifts transaction-counting spies in unrelated
        // suites (tool-access rollback, chat lifecycle) and regressed CI.
        const transactionSpy = vi.spyOn(db, "transaction");
        try {
          const value = await svc.resolveSecretValue(
            ids.companyId,
            secret.id,
            "latest",
            runtimeAccess(ids),
          );
          expect(value).toBe("runtime-secret");
          expect(transactionSpy).not.toHaveBeenCalled();
        } finally {
          transactionSpy.mockRestore();
        }

        const events = await db
          .select()
          .from(secretAccessEvents)
          .where(eq(secretAccessEvents.secretId, secret.id));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          issueId: ids.issueId,
          heartbeatRunId: ids.runId,
          outcome: "success",
        });
      } finally {
        await temporary.cleanup();
      }
    });
  }, 120_000);
});
