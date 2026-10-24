import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("heartbeat_runs updated_at index migration", () => {
  it("creates a valid milestone window index and adopts an existing index without rebuilding it", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("hb-updated-at-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const [index] = await sql`
      SELECT i.indexrelid::text AS oid, i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'heartbeat_runs_updated_at_id_idx'`;
    expect(index?.valid).toBe(true);
    expect(index?.definition).toContain("(updated_at, id)");

    await sql.unsafe("SET enable_seqscan = off");
    const plan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE updated_at >= now() - interval '5 minutes' ORDER BY updated_at, id LIMIT 200",
    );
    expect(plan.map((row) => Object.values(row)[0]).join("\n")).toContain("heartbeat_runs_updated_at_id_idx");

    const migration = await readFile(
      fileURLToPath(new URL("./migrations/0334_heartbeat_runs_updated_at_index.sql", import.meta.url)),
      "utf8",
    );
    const statements = migration.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toHaveLength(1);
    for (const statement of statements) await sql.unsafe(statement);
    const [reapplied] = await sql`
      SELECT indexrelid::text AS oid FROM pg_index
      WHERE indexrelid = 'heartbeat_runs_updated_at_id_idx'::regclass`;
    expect(reapplied?.oid).toBe(index?.oid);
  }, 240_000);
});
