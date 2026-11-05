import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const guards = await readFile(new URL("./migration-fragments/code-delivery-terminal-guards.sql", import.meta.url), "utf8");
const persistence = await readFile(new URL("./migrations/0432_dear_jane_foster.sql", import.meta.url), "utf8");
const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("terminal receipt SQL guards in an isolated trigger fixture", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: ReturnType<typeof postgres>;
  type Transaction = postgres.TransactionSql;
  const companyId = randomUUID();
  const evidence = { version: 1, pullRequests: [{ headSha: "a".repeat(40), mergeCommitSha: "b".repeat(40) }] };

  async function fixture() {
    const [issue] = await sql`INSERT INTO issues (company_id, status, execution_state)
      VALUES (${companyId}, 'in_review', ${sql.json({ currentStageId: "qa", completedStageIds: ["security"], changesRequestedCount: 1,
        currentParticipant: "reviewer", returnAssignee: "author", monitor: { nextCheckAt: "2099-01-01T00:00:00Z" } })}) RETURNING *`;
    return issue;
  }
  async function issue(id: string) {
    const [row] = await sql`SELECT * FROM issues WHERE id = ${id}`;
    return row;
  }
  async function receipt(tx: Transaction, row: Record<string, unknown>, status = "done") {
    const [result] = await tx`INSERT INTO code_delivery_readiness_receipts (company_id, issue_id, issue_revision, terminal_status, evidence)
      VALUES (${String(row.company_id)}, ${String(row.id)}, ${Number(row.code_delivery_revision)}, ${status}, ${tx.json(evidence)}) RETURNING *`;
    return result;
  }
  async function close(tx: Transaction, id: string, status = "done") {
    await tx`UPDATE issues SET status = ${status}, completed_at = CASE WHEN ${status} = 'done' THEN clock_timestamp() ELSE NULL END,
      cancelled_at = CASE WHEN ${status} = 'cancelled' THEN clock_timestamp() ELSE NULL END, execution_state = '{"status":"completed"}' WHERE id = ${id}`;
  }
  async function assertNoReceipt(id: string) {
    expect(await sql`SELECT * FROM code_delivery_readiness_receipts WHERE issue_id = ${id}`).toHaveLength(0);
    expect(await sql`SELECT * FROM code_delivery_receipt_consumptions WHERE issue_id = ${id}`).toHaveLength(0);
  }
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-delivery-terminal-guards-");
    const admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try { await admin`CREATE SCHEMA delivery_terminal_fixture`; }
    finally { await admin.end({ timeout: 1 }); }
    sql = postgres(database.connectionString, { max: 4, onnotice: () => {}, connection: { search_path: "delivery_terminal_fixture,public" } });
    await sql.unsafe(`CREATE TABLE issues (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, status text NOT NULL, title text DEFAULT 'Delivery',
      code_delivery_revision bigint DEFAULT 0 NOT NULL, execution_state jsonb, completed_at timestamptz, cancelled_at timestamptz,
      UNIQUE(company_id, id)
    );
    CREATE TABLE code_delivery_readiness_receipts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, issue_id uuid NOT NULL, issue_revision bigint NOT NULL,
      terminal_status text NOT NULL, transaction_id text NOT NULL DEFAULT pg_current_xact_id()::text, evidence jsonb NOT NULL,
      prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 seconds',
      UNIQUE(company_id, issue_id, issue_revision), UNIQUE(company_id, issue_id, id), FOREIGN KEY(company_id, issue_id) REFERENCES issues(company_id, id)
    );
    CREATE TABLE code_delivery_receipt_consumptions (
      receipt_id uuid PRIMARY KEY, company_id uuid NOT NULL, issue_id uuid NOT NULL, issue_revision bigint NOT NULL,
      terminal_status text NOT NULL, transaction_id text NOT NULL DEFAULT pg_current_xact_id()::text, created_at timestamptz DEFAULT now(),
      UNIQUE(company_id, issue_id, issue_revision),
      FOREIGN KEY(company_id, issue_id, receipt_id) REFERENCES code_delivery_readiness_receipts(company_id, issue_id, id)
    );`);
    for (const statement of persistence.split("--> statement-breakpoint").map(value => value.trim())) {
      if (/^CREATE (FUNCTION code_delivery_(issue_revision|preserve_history)\(\)|TRIGGER code_delivery_issue_revision\b)/.test(statement)) {
        await sql.unsafe(statement);
      }
    }
    await sql.unsafe(guards);
  }, 90_000);
  afterAll(async () => { await sql?.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  it.each(["done", "cancelled"])("denies direct %s without changing any task/review field", async status => {
    const before = await fixture();
    await expect(sql.begin(tx => close(tx, before.id, status))).rejects.toThrow("code_delivery_preparation_required");
    expect(await issue(before.id)).toEqual(before);
    await assertNoReceipt(before.id);
  });
  it.each(["done", "cancelled"])("rejects terminal creation/import as %s", async status => {
    const id = randomUUID();
    await expect(sql`INSERT INTO issues (id, company_id, status) VALUES (${id}, ${companyId}, ${status})`)
      .rejects.toThrow("code_delivery_terminal_creation_requires_open_task");
    expect(await issue(id)).toBeUndefined();
  });
  it("rejects terminal timestamps on an otherwise nonterminal create or update", async () => {
    await expect(sql`INSERT INTO issues (company_id, status, completed_at) VALUES (${companyId}, 'in_review', now())`)
      .rejects.toThrow("code_delivery_terminal_creation_requires_open_task");
    const before = await fixture();
    await expect(sql`UPDATE issues SET completed_at = now() WHERE id = ${before.id}`)
      .rejects.toThrow("code_delivery_terminal_timestamp_requires_status");
    expect(await issue(before.id)).toEqual(before);
  });
  it.each(["done", "cancelled"])("consumes one receipt on exactly one %s mutation in the same transaction", async status => {
    const before = await fixture();
    const certified = await sql.begin(async tx => {
      const certified = await receipt(tx, before, status);
      await close(tx, before.id, status);
      return certified;
    });
    const [consumed] = await sql`SELECT * FROM code_delivery_receipt_consumptions WHERE receipt_id = ${certified.id}`;
    expect(consumed).toMatchObject({ company_id: companyId, issue_id: before.id, terminal_status: status,
      transaction_id: certified.transaction_id, issue_revision: String(Number(before.code_delivery_revision) + 1) });
    const [saved] = await sql`SELECT evidence FROM code_delivery_readiness_receipts WHERE id = ${certified.id}`;
    expect(saved.evidence).toEqual(evidence);
    expect(await issue(before.id)).toMatchObject({ status, code_delivery_revision: consumed.issue_revision });
  });
  it("cannot commit a receipt without its terminal mutation", async () => {
    const before = await fixture();
    await expect(sql.begin(tx => receipt(tx, before))).rejects.toThrow("code_delivery_receipt_not_settled");
    expect(await issue(before.id)).toEqual(before);
    await assertNoReceipt(before.id);
  });
  it.each(["revision", "company", "transaction", "expired", "future"])("rejects a receipt with the wrong %s", async fault => {
    const before = await fixture();
    await expect(sql.begin(async tx => {
      await tx`INSERT INTO code_delivery_readiness_receipts (company_id, issue_id, issue_revision, terminal_status, evidence,
        transaction_id, prepared_at, expires_at) VALUES (
        ${fault === "company" ? randomUUID() : companyId}, ${before.id}, ${fault === "revision" ? 77 : Number(before.code_delivery_revision)},
        'done', '{}', ${fault === "transaction" ? "0" : tx`pg_current_xact_id()::text`},
        ${fault === "future" ? tx`clock_timestamp() + interval '1 hour'` : tx`clock_timestamp()`},
        ${fault === "expired" ? tx`clock_timestamp() - interval '1 second'` : tx`clock_timestamp() + interval '30 seconds'`})`;
    })).rejects.toThrow("code_delivery_invalid_receipt");
    expect(await issue(before.id)).toEqual(before);
    await assertNoReceipt(before.id);
  });
  it("rejects a different effective status and leaves the native decision snapshot intact", async () => {
    const before = await fixture();
    await expect(sql.begin(async tx => { await receipt(tx, before, "done"); await close(tx, before.id, "cancelled"); }))
      .rejects.toThrow("code_delivery_preparation_required");
    expect(await issue(before.id)).toEqual(before);
    await assertNoReceipt(before.id);
  });
  it("cannot fabricate consumption before the terminal issue write", async () => {
    const before = await fixture();
    await expect(sql.begin(async tx => {
      const certified = await receipt(tx, before);
      await tx`INSERT INTO code_delivery_receipt_consumptions (receipt_id, company_id, issue_id, issue_revision, terminal_status)
        VALUES (${certified.id}, ${companyId}, ${before.id}, ${Number(before.code_delivery_revision) + 1}, 'done')`;
    })).rejects.toThrow("code_delivery_invalid_consumption");
    await assertNoReceipt(before.id);
  });
  it("cannot reuse a consumed receipt after reopening the same task", async () => {
    const before = await fixture();
    await sql.begin(async tx => { await receipt(tx, before); await close(tx, before.id); });
    await sql`UPDATE issues SET status = 'in_review', completed_at = NULL WHERE id = ${before.id}`;
    const reopened = await issue(before.id);
    await expect(sql.begin(tx => close(tx, before.id))).rejects.toThrow("code_delivery_preparation_required");
    expect(await issue(before.id)).toEqual(reopened);
    expect(await sql`SELECT * FROM code_delivery_readiness_receipts WHERE issue_id = ${before.id}`).toHaveLength(1);
  });
  it("rejects an outer-transaction state change after the receipt was consumed", async () => {
    const before = await fixture();
    await expect(sql.begin(async tx => {
      await receipt(tx, before);
      await close(tx, before.id);
      await tx`UPDATE issues SET title = 'Changed after certification' WHERE id = ${before.id}`;
    })).rejects.toThrow("code_delivery_receipt_not_settled");
    expect(await issue(before.id)).toEqual(before);
    await assertNoReceipt(before.id);
  });
  it("still rejects later state changes after the deferred checks were explicitly flushed", async () => {
    const before = await fixture();
    await expect(sql.begin(async tx => {
      await receipt(tx, before);
      await close(tx, before.id);
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      await tx`UPDATE issues SET title = 'Changed after early constraint check' WHERE id = ${before.id}`;
    })).rejects.toThrow("code_delivery_receipt_not_settled");
    expect(await issue(before.id)).toEqual(before);
    await assertNoReceipt(before.id);
  });
  it("rejects an outer-transaction reopen after consumption rather than persisting an unused terminal receipt", async () => {
    const before = await fixture();
    await expect(sql.begin(async tx => {
      await receipt(tx, before);
      await close(tx, before.id);
      await tx`UPDATE issues SET status = 'in_review', completed_at = NULL WHERE id = ${before.id}`;
    })).rejects.toThrow("code_delivery_receipt_not_settled");
    expect(await issue(before.id)).toEqual(before);
    await assertNoReceipt(before.id);
  });
  it("rolls back receipt, consumption and task fields when a native decision fails inside a savepoint", async () => {
    const before = await fixture();
    await sql.begin(async tx => {
      await expect(tx.savepoint(async nested => {
        await receipt(nested, before);
        await close(nested, before.id);
        throw new Error("native decision failed");
      })).rejects.toThrow("native decision failed");
      await tx`SELECT 1`;
    });
    expect(await issue(before.id)).toEqual(before);
    await assertNoReceipt(before.id);
  });
  it("rejects expiry at outer commit, not only at observation or statement time", async () => {
    const before = await fixture();
    await expect(sql.begin(async tx => {
      await tx`INSERT INTO code_delivery_readiness_receipts (company_id, issue_id, issue_revision, terminal_status, evidence, expires_at)
        VALUES (${companyId}, ${before.id}, ${Number(before.code_delivery_revision)}, 'done', '{}', clock_timestamp() + interval '0.5 seconds')`;
      await close(tx, before.id);
      await tx`SELECT pg_sleep(0.6)`;
    })).rejects.toThrow("code_delivery_receipt_not_settled");
    expect(await issue(before.id)).toEqual(before);
    await assertNoReceipt(before.id);
  });
  it("retains immutable evidence while allowing later terminal bookkeeping without a new verdict", async () => {
    const before = await fixture();
    const certified = await sql.begin(async tx => { const row = await receipt(tx, before); await close(tx, before.id); return row; });
    await sql`UPDATE issues SET title = 'Retained history' WHERE id = ${before.id}`;
    expect((await issue(before.id)).status).toBe("done");
    await expect(sql`UPDATE issues SET completed_at = clock_timestamp() WHERE id = ${before.id}`)
      .rejects.toThrow("code_delivery_preparation_required");
    for (const table of ["code_delivery_readiness_receipts", "code_delivery_receipt_consumptions"]) {
      await expect(sql`DELETE FROM ${sql(table)} WHERE issue_id = ${before.id}`).rejects.toThrow("code_delivery_history_is_immutable");
      await expect(sql`UPDATE ${sql(table)} SET transaction_id = '0' WHERE issue_id = ${before.id}`).rejects.toThrow("code_delivery_history_is_immutable");
    }
    expect(await sql`SELECT * FROM code_delivery_receipt_consumptions WHERE receipt_id = ${certified.id}`).toHaveLength(1);
  });
});
