import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("capture classifier review lookup plan", () => {
  it("uses indexed branches for run, issue and delivery at 100k historical reviews", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("capture-plan-");
    const db = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
    try {
      // Disposable schema; production DBs and their data are never used.
      await db.unsafe(`create schema plan_fixture; set search_path = plan_fixture, public;
        create table chat_github_reviews (like public.chat_github_reviews including defaults);
        create unique index review_id on chat_github_reviews(id);
        create unique index review_company_id on chat_github_reviews(company_id, id);
        create unique index review_delivery on chat_github_reviews(endpoint_id, delivery_id);
        create index review_pull on chat_github_reviews(endpoint_id, repository_id, pull_number, created_at);
        create index review_task on chat_github_reviews(company_id, issue_id, run_id)`);
      const company = randomUUID();
      const endpoint = randomUUID();
      await db`insert into chat_github_reviews
        (company_id, endpoint_id, issue_id, run_id, repository_id, repository, pull_number, head_sha, delivery_id, configuration_revision, policy_snapshot, event, shadow_label)
        select ${company}::uuid, ${endpoint}::uuid, md5('issue-' || i)::uuid, md5('run-' || i)::uuid, '1', 'fixture/repo', i,
          repeat('a', 40), 'delivery-' || i, 1, '{}'::jsonb, jsonb_build_object('body', repeat(md5(i::text), 32)),
          case when i % 10 = 0 then 'candidate' end from generate_series(1, 100000) i`;
      await db.unsafe("analyze chat_github_reviews");
      const query = `select exists (select 1 from chat_github_reviews r where r.company_id = '${company}'::uuid
        and r.shadow_label is not null and (r.issue_id = any(array[md5('issue-99990')::uuid])
          or r.run_id = md5('run-99980')::uuid or r.delivery_id = any(array['delivery-99970'])))`;
      const explain = async () => {
        const rows = await db.unsafe(`explain (analyze, buffers, format json) ${query}`);
        return rows[0]!["QUERY PLAN"];
      };
      const before = await explain();
      console.log("F4 BEFORE (100000 rows)", JSON.stringify(before));
      // Resolve by tag rather than a fixed ordinal so concurrent forward migrations can be rebased.
      const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"));
      const entry = journal.entries.find((e: { tag: string }) => e.tag.endsWith("_capture_review_lookup_indexes"));
      expect(entry).toBeDefined();
      const migration = new URL(`./migrations/${entry.tag}.sql`, import.meta.url);
      await db.unsafe(await readFile(migration, "utf8"));
      await db.unsafe("analyze chat_github_reviews");
      const after = await explain();
      console.log("F4 AFTER (100000 rows)", JSON.stringify(after));
      if (process.env.CAPTURE_PLAN_EVIDENCE) await writeFile(process.env.CAPTURE_PLAN_EVIDENCE,
        JSON.stringify({ rows: 100_000, postgres: await db`select version()`, before, after }, null, 2));
      expect(after[0].Plan["Shared Hit Blocks"]).toBeLessThan(100);
      expect(JSON.stringify(after)).not.toContain('"Node Type":"Seq Scan"');
      expect(JSON.stringify(after)).toContain("BitmapOr");
      expect(JSON.stringify(after)).toContain("chat_github_reviews_capture_run_idx");
      expect(JSON.stringify(after)).toContain("chat_github_reviews_capture_delivery_idx");
      expect((await db.unsafe(query))[0]!.exists).toBe(true);
      expect((await db.unsafe(query.replaceAll("99990", "99991").replaceAll("99980", "99981").replaceAll("99970", "99971")))[0]!.exists).toBe(false);
    } finally {
      await db.end();
      await temporary.cleanup();
    }
  }, 60_000);
});
