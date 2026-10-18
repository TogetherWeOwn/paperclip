import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("chat action delivery lookup migration", () => {
  it("indexes delivery and kind for the durable wake capture guard", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("chat-action-delivery-index-");
    const db = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
    try {
      const rows = await db`select indexdef from pg_indexes where schemaname = 'public'
        and tablename = 'chat_actions' and indexname = 'chat_actions_delivery_kind_idx'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toContain("USING btree (delivery_id, kind)");
    } finally {
      await db.end();
      await temporary.cleanup();
    }
  }, 60_000);
});
