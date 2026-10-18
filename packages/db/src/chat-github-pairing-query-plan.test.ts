import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("paired review seed query plans", () => {
  it("bounds recovery and round allocation to indexed seeds instead of 100k toasted deliveries", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("pairing-plan-");
    const db = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
    try {
      await db.unsafe(`create schema plan_fixture; set search_path = plan_fixture, public;
        create table chat_deliveries (like public.chat_deliveries including defaults);
        alter table chat_deliveries alter column normalized_event set storage external;
        create unique index delivery_id on chat_deliveries(id);
        create unique index delivery_event on chat_deliveries(endpoint_id, provider_event_id);
        create unique index delivery_dedupe on chat_deliveries(endpoint_id, deduplication_key);
        create index delivery_work on chat_deliveries(state, next_attempt_at);
        create table chat_github_review_enrollments (origin_delivery_id uuid primary key)`);
      const company = randomUUID();
      const endpoint = randomUUID();
      await db`insert into chat_deliveries (company_id, endpoint_id, provider_event_id, deduplication_key, event_kind, normalized_event)
        select ${company}::uuid, ${endpoint}::uuid, i::text, i::text, 'mention',
          jsonb_build_object('body', repeat(md5(i::text), 160)) || case when i % 5000 = 0
            then jsonb_build_object('githubPairingSeed', jsonb_build_object('roundOrdinal', i / 5000,
              'envelope', jsonb_build_object(case when i % 10000 = 0 then 'event' else 'unavailableEvent' end,
                jsonb_build_object('repositoryId', '1', 'pullNumber', 81)))) else '{}'::jsonb end
          from generate_series(1, 100000) i`;
      await db.unsafe(`insert into chat_github_review_enrollments select id from chat_deliveries where normalized_event ? 'githubPairingSeed';
        analyze chat_deliveries; analyze chat_github_review_enrollments`);
      const recovery = `select * from chat_deliveries d where d.normalized_event ? 'githubPairingSeed'
        and not exists (select 1 from chat_github_review_enrollments e where e.origin_delivery_id = d.id) limit 5`;
      const ordinal = `select coalesce(max((normalized_event->'githubPairingSeed'->>'roundOrdinal')::integer), 0) as ordinal
        from chat_deliveries where endpoint_id = '${endpoint}'::uuid
        and normalized_event ? 'githubPairingSeed'
        and coalesce(normalized_event->'githubPairingSeed'->'envelope'->'event'->>'repositoryId', normalized_event->'githubPairingSeed'->'envelope'->'unavailableEvent'->>'repositoryId') = '1'
        and coalesce(normalized_event->'githubPairingSeed'->'envelope'->'event'->>'pullNumber', normalized_event->'githubPairingSeed'->'envelope'->'unavailableEvent'->>'pullNumber') = '81'`;
      const explain = async (query: string) => (await db.unsafe(`explain (analyze, buffers, format json) ${query}`))[0]!["QUERY PLAN"];
      const before = { recovery: await explain(recovery), ordinal: await explain(ordinal) };
      const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"));
      const entry = journal.entries.find((e: { tag: string }) => e.tag.endsWith("_pairing_seed_lookup_indexes"));
      if (entry) await db.unsafe(await readFile(new URL(`./migrations/${entry.tag}.sql`, import.meta.url), "utf8"));
      await db.unsafe("analyze chat_deliveries");
      const after = { recovery: await explain(recovery), ordinal: await explain(ordinal) };
      if (process.env.PAIRING_PLAN_EVIDENCE) await writeFile(process.env.PAIRING_PLAN_EVIDENCE,
        JSON.stringify({ rows: 100_000, payloadBytes: 5120, seeds: 20, postgres: await db`select version()`, before, after }, null, 2));
      console.log("F5 plans", JSON.stringify({ before, after }));
      for (const plan of Object.values(after)) {
        const nodes: Record<string, any>[] = [];
        const visit = (node: Record<string, any>) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
        visit(plan[0].Plan);
        expect(nodes.filter(n => n["Relation Name"] === "chat_deliveries" && n["Node Type"] === "Seq Scan")).toEqual([]);
        expect(plan[0].Plan["Shared Hit Blocks"]).toBeLessThan(1000);
      }
      expect(JSON.stringify(after.ordinal)).toContain("chat_deliveries_pair_round_idx");
      expect((await db.unsafe(ordinal))[0]!.ordinal).toBe(20);
      expect(await db.unsafe(recovery)).toHaveLength(0);
      // Missing projection remains recoverable, including an unavailable-event seed.
      await db.unsafe("delete from chat_github_review_enrollments where origin_delivery_id = (select id from chat_deliveries where provider_event_id = '95000')");
      expect((await db.unsafe(recovery)).map(r => r.provider_event_id)).toEqual(["95000"]);
    } finally {
      await db.end();
      await temporary.cleanup();
    }
  }, 120_000);
});
