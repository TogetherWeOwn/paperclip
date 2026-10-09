import { readFile } from "node:fs/promises";
import { getTableConfig } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { chatPublications } from "./schema/chat_channels.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0280_reflective_hawkeye.sql";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("chat publication lookup index schema", () => {
  it("declares the host-verified definitions under identical names", () => {
    const indexes = getTableConfig(chatPublications).indexes;

    const interactionIdx = indexes.find(
      (candidate) =>
        candidate.config.name ===
        "ops_chatpub_company_issue_interaction_published_idx",
    );
    expect(interactionIdx?.config.unique).toBe(false);
    expect(
      interactionIdx?.config.columns.map(
        (column) => (column as { name?: string }).name,
      ),
    ).toEqual(["company_id", "issue_id", undefined]);
    expect(interactionIdx?.config.columns[2]).toBeInstanceOf(SQL);
    expect(interactionIdx?.config.where).toBeDefined();

    const conversationIdx = indexes.find(
      (candidate) =>
        candidate.config.name ===
        "ops_chatpub_company_endpoint_conversation_idx",
    );
    expect(conversationIdx?.config.unique).toBe(false);
    expect(
      conversationIdx?.config.columns.map(
        (column) => (column as { name?: string }).name,
      ),
    ).toEqual(["company_id", "endpoint_id", "conversation_id"]);
    // drizzle-orm 0.45.2 cannot express INCLUDE, so the covering column is
    // asserted against the live database in the migration test below.
  });
});

type LiveIndexDef = {
  unique: boolean;
  nkeyatts: number;
  valid: boolean;
  ready: boolean;
  keycols: string | null;
  expr: string | null;
  pred: string | null;
  count: string;
};

async function readLiveIndexDef(
  sql: postgres.Sql,
  name: string,
): Promise<LiveIndexDef> {
  const normalize = (value: string | null) =>
    value === null
      ? null
      : value.toLowerCase().replace(/\s+/g, "").replaceAll("::text", "");
  const [row] = await sql`
    SELECT i.indisunique AS "unique",
           i.indnkeyatts AS "nkeyatts",
           i.indisvalid AS "valid",
           i.indisready AS "ready",
           (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
              FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum
             WHERE u.attnum <> 0) AS "keycols",
           pg_get_expr(i.indexprs, i.indrelid) AS "expr",
           pg_get_expr(i.indpred, i.indrelid) AS "pred",
           (SELECT count(*)::text FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = ${name} AND n.nspname = 'public') AS "count"
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = ${name}
       AND n.nspname = 'public'
       AND i.indrelid = 'public.chat_publications'::regclass
  `;
  return {
    unique: row.unique,
    nkeyatts: Number(row.nkeyatts),
    valid: row.valid,
    ready: row.ready,
    keycols: row.keycols,
    expr: normalize(row.expr),
    pred: normalize(row.pred),
    count: row.count,
  };
}

function expectInteractionDef(def: LiveIndexDef) {
  expect(def.count).toBe("1");
  expect(def.unique).toBe(false);
  expect(def.valid).toBe(true);
  expect(def.ready).toBe(true);
  expect(def.keycols).toBe("company_id,issue_id");
  expect(def.expr).toBe("(payload->>'interactionid')");
  expect(def.pred).toBe("(state='published')");
}

function expectConversationDef(def: LiveIndexDef) {
  expect(def.count).toBe("1");
  expect(def.unique).toBe(false);
  expect(def.valid).toBe(true);
  expect(def.ready).toBe(true);
  expect(def.nkeyatts).toBe(3);
  expect(def.keycols).toBe(
    "company_id,endpoint_id,conversation_id,comment_id",
  );
  expect(def.expr).toBeNull();
  expect(def.pred).toBeNull();
}

// Mirrors the production runner: one transaction per file, breakpoint split,
// each chunk executed as a single statement.
async function applyMigrationFile(
  sql: postgres.Sql,
  fileName: string,
): Promise<void> {
  const content = await readFile(
    new URL(`./migrations/${fileName}`, import.meta.url),
    "utf8",
  );
  const statements = content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  expect(statements.length).toBeGreaterThan(0);
  await sql.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

describeEmbeddedPostgres("chat publication lookup index migration", () => {
  it(
    "builds fresh, adopts the exact host definitions, and rejects drift",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-chatpub-indexes-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, {
        max: 4,
        onnotice: () => {},
      });
      cleanups.push(async () => sql.end());

      // Fresh database: the bootstrap applied 0280, so both definitions land
      // with the verified shape and no duplicates.
      expectInteractionDef(
        await readLiveIndexDef(
          sql,
          "ops_chatpub_company_issue_interaction_published_idx",
        ),
      );
      expectConversationDef(
        await readLiveIndexDef(
          sql,
          "ops_chatpub_company_endpoint_conversation_idx",
        ),
      );

      // Deployments where the exact host definitions already exist: drop both,
      // rebuild with the byte-exact host DDL from the TOG-19457 repair
      // document (unqualified predicate, double-paren expression), then
      // re-run only this migration file. Adoption must succeed with exactly
      // one definition per name.
      await sql`DROP INDEX public.ops_chatpub_company_issue_interaction_published_idx`;
      await sql`DROP INDEX public.ops_chatpub_company_endpoint_conversation_idx`;
      await sql.unsafe(
        `CREATE INDEX CONCURRENTLY ops_chatpub_company_issue_interaction_published_idx ON public.chat_publications (company_id, issue_id, ((payload->>'interactionId'))) WHERE state='published'`,
      );
      await sql.unsafe(
        `CREATE INDEX CONCURRENTLY ops_chatpub_company_endpoint_conversation_idx ON public.chat_publications (company_id, endpoint_id, conversation_id) INCLUDE (comment_id)`,
      );
      await applyMigrationFile(sql, MIGRATION_FILE);
      expectInteractionDef(
        await readLiveIndexDef(
          sql,
          "ops_chatpub_company_issue_interaction_published_idx",
        ),
      );
      expectConversationDef(
        await readLiveIndexDef(
          sql,
          "ops_chatpub_company_endpoint_conversation_idx",
        ),
      );

      // Incompatible same-name definition: the migration must fail loudly
      // instead of silently accepting drift, and the wrong definition must
      // survive untouched so the conflict stays visible.
      await sql`DROP INDEX public.ops_chatpub_company_issue_interaction_published_idx`;
      await sql.unsafe(
        `CREATE INDEX ops_chatpub_company_issue_interaction_published_idx ON public.chat_publications (company_id)`,
      );
      await expect(applyMigrationFile(sql, MIGRATION_FILE)).rejects.toThrow(
        /must be \(company_id, issue_id\)/,
      );
      const drifted = await readLiveIndexDef(
        sql,
        "ops_chatpub_company_issue_interaction_published_idx",
      );
      expect(drifted.count).toBe("1");
      expect(drifted.keycols).toBe("company_id");
      // The sibling definition is unaffected by the aborted run.
      expectConversationDef(
        await readLiveIndexDef(
          sql,
          "ops_chatpub_company_endpoint_conversation_idx",
        ),
      );
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
