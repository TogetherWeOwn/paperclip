import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { githubPairPreviousAssessmentQuery } from "../../../server/src/services/chat-github-shadow.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import * as schema from "./schema/index.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("paired review admission history plans", () => {
  it("uses both indexed identity branches instead of detoasting 100k review events", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("admission-plan-");
    const client = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
    try {
      await client.unsafe(`create schema admission_fixture; set search_path = admission_fixture, public;
        set plan_cache_mode = force_generic_plan;
        create table chat_github_reviews (like public.chat_github_reviews including defaults);
        alter table chat_github_reviews drop column admission_delivery_id;
        alter table chat_github_reviews alter column event set storage external;
        create unique index chat_github_reviews_delivery_uq on chat_github_reviews(endpoint_id, delivery_id);
        create index chat_github_reviews_pull_idx on chat_github_reviews(endpoint_id, repository_id, pull_number, created_at);
        create table chat_deliveries (like public.chat_deliveries including defaults);
        create unique index delivery_id on chat_deliveries(id);
        create table chat_github_review_enrollments (like public.chat_github_review_enrollments including defaults)`);
      const companyId = randomUUID(), endpointId = randomUUID(), issueId = randomUUID(), originDeliveryId = randomUUID();
      await client`insert into chat_github_reviews (company_id, endpoint_id, issue_id, repository_id, repository, pull_number,
          head_sha, delivery_id, configuration_revision, policy_snapshot, event, assessment)
        select ${companyId}::uuid, ${endpointId}::uuid, ${issueId}::uuid, '1', 'org/repo', 81, repeat('b', 40),
          'run:' || i::text, 1, '{}'::jsonb,
          jsonb_build_object('admissionDeliveryId', case when i = 100000 then ${originDeliveryId} else gen_random_uuid()::text end,
            'body', repeat(md5(i::text), 160)), jsonb_build_object('summary', 'assessment-' || i::text)
        from generate_series(1, 100000) i`;
      await client.unsafe(`insert into chat_deliveries (id, company_id, endpoint_id, provider_event_id, deduplication_key, event_kind, normalized_event)
        select (event->>'admissionDeliveryId')::uuid, company_id, endpoint_id, delivery_id, delivery_id, 'mention', '{}'::jsonb
        from chat_github_reviews`);
      await client`insert into chat_github_review_enrollments (company_id, endpoint_id, origin_delivery_id, origin_event_id,
          principal_id, repository_id, repository, pull_number, head_sha, base_sha, round_ordinal, configuration_revision, pair_key, envelope)
        values (${companyId}::uuid, ${endpointId}::uuid, ${originDeliveryId}::uuid, 'origin', ${randomUUID()}::uuid,
          '1', 'org/repo', 81, ${"b".repeat(40)}, ${"a".repeat(40)}, 1, 1, 'pair', '{}'::jsonb)`;
      await client.unsafe("analyze chat_github_reviews; analyze chat_github_review_enrollments; analyze chat_deliveries");
      const before = (await client.unsafe(`explain (analyze, buffers, format json)
        select r.* from chat_github_reviews r join chat_github_review_enrollments e
          on e.company_id = '${companyId}' and e.endpoint_id = '${endpointId}' and e.repository_id = '1'
          and e.pull_number = 81 and e.round_ordinal < 2
          and (r.delivery_id = e.origin_delivery_id::text or r.event->>'admissionDeliveryId' = e.origin_delivery_id::text)
        where r.company_id = '${companyId}' and r.endpoint_id = '${endpointId}' and r.shadow_label is null
          and r.assessment is not null and r.updated_at <= now()
        order by e.round_ordinal desc, r.created_at desc limit 1`))[0]!["QUERY PLAN"];
      const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"));
      const entry = journal.entries.find((e: { tag: string }) => e.tag === "0307_overrated_lightspeed");
      expect(entry).toBeDefined();
      await client.unsafe(await readFile(new URL(`./migrations/${entry.tag}.sql`, import.meta.url), "utf8"));
      expect((await client`select count(*)::int as n from chat_github_reviews where admission_delivery_id is not null`)[0]!.n).toBe(100000);
      await client.unsafe("analyze chat_github_reviews");
      const query = githubPairPreviousAssessmentQuery(drizzle(client, { schema }), { companyId, endpointId, repositoryId: "1", pullNumber: 81,
        roundOrdinal: 2, snapshotStartedAt: new Date(), armId: "primary" }).toSQL();
      await client.unsafe(`prepare admission_history as ${query.sql}`);
      const literals = query.params.map(value => typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`).join(", ");
      const after = (await client.unsafe(`explain (analyze, buffers, format json) execute admission_history(${literals})`))[0]!["QUERY PLAN"];
      if (process.env.ADMISSION_PLAN_EVIDENCE) await writeFile(process.env.ADMISSION_PLAN_EVIDENCE,
        JSON.stringify({ rows: 100000, eventBytes: 5120, before, after, query }, null, 2));
      console.log("admission history plans", JSON.stringify({ before, after }));
      expect(JSON.stringify(before)).toContain('"Node Type":"Seq Scan"');
      expect(JSON.stringify(after)).toContain("chat_github_reviews_admission_idx");
      expect(JSON.stringify(after)).toContain("chat_github_reviews_delivery_uq");
      const nodes: Record<string, any>[] = [];
      const visit = (node: Record<string, any>) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
      visit(after[0].Plan);
      expect(nodes.filter(n => n["Relation Name"] === "chat_github_reviews" && n["Node Type"] === "Seq Scan")).toEqual([]);
      expect(after[0].Plan["Shared Hit Blocks"]).toBeLessThan(100);
      expect((await client.unsafe(query.sql, query.params as never[]))[0]!.assessment).toEqual({ summary: "assessment-100000" });
    } finally {
      await client.end();
      await temporary.cleanup();
    }
  }, 120000);
});
