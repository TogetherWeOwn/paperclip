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

suite("GitHub capture authority forward migration", () => {
  it("preserves legacy task and delivery data without inventing past shadow authority", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-capture-upgrade-");
    const admin = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
    await admin.unsafe('CREATE DATABASE "capture_legacy"');
    const url = new URL(temporary.connectionString);
    url.pathname = "/capture_legacy";
    const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      const tag = "0296_steep_patriot";
      const index = journal.entries.findIndex((entry) => entry.tag === tag);
      expect(index).toBeGreaterThan(0);
      const apply = async (name: string) => {
        const migration = await readFile(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8");
        await db.begin(async (tx) => {
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await tx.unsafe(statement);
          }
        });
      };
      for (const entry of journal.entries.slice(0, index)) await apply(entry.tag);
      const company = randomUUID();
      const agent = randomUUID();
      const application = randomUUID();
      const connection = randomUUID();
      const endpoint = randomUUID();
      const issue = randomUUID();
      const conversation = randomUUID();
      const delivery = randomUUID();
      await db`insert into companies (id, name, issue_prefix) values (${company}, 'Legacy capture fixture', 'CAP')`;
      await db`insert into agents (id, company_id, name) values (${agent}, ${company}, 'Primary')`;
      await db`insert into tool_applications (id, company_id, name, type) values (${application}, ${company}, 'GitHub', 'chat')`;
      await db`insert into tool_connections (id, company_id, application_id, uid, name, transport, connection_purpose) values (${connection}, ${company}, ${application}, ${randomUUID()}, 'GitHub', 'chat_sdk', 'channel')`;
      await db`insert into chat_endpoints (id, company_id, connection_id, assigned_agent_id, provider, public_id) values (${endpoint}, ${company}, ${connection}, ${agent}, 'github', ${randomUUID()})`;
      await db`insert into issues (id, company_id, title) values (${issue}, ${company}, 'Legacy manual task')`;
      await db`insert into chat_conversations (id, company_id, endpoint_id, issue_id, external_conversation_id, external_thread_id, external_label) values (${conversation}, ${company}, ${endpoint}, ${issue}, 'example/repo', 'github:example/repo:1', 'PR 1')`;
      await db`insert into chat_deliveries (id, company_id, endpoint_id, conversation_id, provider_event_id, deduplication_key, event_kind, normalized_event) values (${delivery}, ${company}, ${endpoint}, ${conversation}, 'legacy', 'legacy', 'mention', '{"githubManual":{"revision":1}}')`;
      const [beforeConversation] = await db`select * from chat_conversations where id = ${conversation}`;
      const [beforeDelivery] = await db`select * from chat_deliveries where id = ${delivery}`;
      await apply(tag);
      expect((await db`select * from chat_conversations where id = ${conversation}`)[0]).toEqual({ ...beforeConversation, github_shadow_label: null });
      expect((await db`select * from chat_deliveries where id = ${delivery}`)[0]).toEqual({ ...beforeDelivery, github_shadow_label: null });
      // Positive controls: ordinary state changes still work for both kinds.
      await db`update chat_conversations set state = 'waiting' where id = ${conversation}`;
      await db`update chat_deliveries set state = 'retry' where id = ${delivery}`;
      await db`update chat_conversations set github_shadow_label = 'capture' where id = ${conversation}`;
      await db`update chat_deliveries set github_shadow_label = 'capture' where id = ${delivery}`;
      await db`update chat_conversations set state = 'completed' where id = ${conversation}`;
      await db`update chat_deliveries set state = 'processed' where id = ${delivery}`;
      await expect(db`update chat_conversations set github_shadow_label = null where id = ${conversation}`).rejects.toThrow(/immutable/);
      await expect(db`update chat_deliveries set github_shadow_label = null where id = ${delivery}`).rejects.toThrow(/immutable/);
      await expect(db`update chat_deliveries set provider_event_id = 'rebound' where id = ${delivery}`).rejects.toThrow(/immutable/);
    } finally {
      await db.end();
      await admin.end();
      await temporary.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
