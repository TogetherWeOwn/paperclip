import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("GitHub pairing forward migration", () => {
  it("preserves primary rows and uniqueness while adding isolated execution scopes", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-pairing-upgrade-");
    const admin = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
    await admin.unsafe('CREATE DATABASE "pairing_legacy"');
    const url = new URL(temporary.connectionString);
    url.pathname = "/pairing_legacy";
    const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      const tag = "0298_green_kingpin";
      const index = journal.entries.findIndex(entry => entry.tag === tag);
      expect(index).toBeGreaterThan(0);
      const apply = async (name: string) => {
        const migration = await readFile(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8");
        await db.begin(async tx => {
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await tx.unsafe(statement);
          }
        });
      };
      for (const entry of journal.entries.slice(0, index)) await apply(entry.tag);
      const company = randomUUID(), agent = randomUUID(), application = randomUUID();
      const connection = randomUUID(), endpoint = randomUUID(), issue = randomUUID(), conversation = randomUUID();
      await db`insert into companies (id, name, issue_prefix) values (${company}, 'Pairing migration', 'PAIR')`;
      await db`insert into agents (id, company_id, name) values (${agent}, ${company}, 'Primary')`;
      await db`insert into tool_applications (id, company_id, name, type) values (${application}, ${company}, 'GitHub', 'chat')`;
      await db`insert into tool_connections (id, company_id, application_id, uid, name, transport, connection_purpose) values (${connection}, ${company}, ${application}, ${randomUUID()}, 'GitHub', 'chat_sdk', 'channel')`;
      await db`insert into chat_endpoints (id, company_id, connection_id, assigned_agent_id, provider, public_id) values (${endpoint}, ${company}, ${connection}, ${agent}, 'github', ${randomUUID()})`;
      await db`insert into issues (id, company_id, title) values (${issue}, ${company}, 'Existing primary review')`;
      await db`insert into chat_conversations (id, company_id, endpoint_id, issue_id, external_conversation_id, external_thread_id, external_label) values (${conversation}, ${company}, ${endpoint}, ${issue}, 'example/repo', 'github:example/repo:1', 'PR 1')`;
      const [before] = await db`select * from chat_conversations where id = ${conversation}`;
      const [beforeEndpoint] = await db`select * from chat_endpoints where id = ${endpoint}`;
      // Exercise the current forward path too, including run-only fencing and
      // explicit unavailable-source enrollment, against existing primary data.
      for (const entry of journal.entries.slice(index)) await apply(entry.tag);
      expect((await db`select * from chat_conversations where id = ${conversation}`)[0]).toEqual({ ...before, execution_scope: "primary" });
      expect((await db`select * from chat_endpoints where id = ${endpoint}`)[0]).toEqual(beforeEndpoint);
      expect(await db`select * from chat_github_review_enrollments`).toHaveLength(0);
      expect(await db`select * from chat_github_review_candidates`).toHaveLength(0);
      await expect(db`insert into chat_conversations (company_id, endpoint_id, issue_id, external_conversation_id, external_thread_id, external_label) values (${company}, ${endpoint}, ${issue}, 'example/repo', 'github:example/repo:1', 'duplicate')`).rejects.toThrow(/unique/);
      await db`insert into chat_conversations (company_id, endpoint_id, issue_id, external_conversation_id, external_thread_id, external_label, execution_scope, github_shadow_label) values (${company}, ${endpoint}, ${issue}, 'example/repo', 'github:example/repo:1', 'isolated', 'shadow:test', 'candidate')`;
      await db`update chat_conversations set state = 'waiting' where id = ${conversation}`;
      await expect(db`update chat_conversations set execution_scope = 'shadow:rebound' where id = ${conversation}`).rejects.toThrow(/immutable/);
    } finally {
      await db.end();
      await admin.end();
      await temporary.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
