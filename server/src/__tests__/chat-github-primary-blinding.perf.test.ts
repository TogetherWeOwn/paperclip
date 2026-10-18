import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { transform } from "esbuild";
import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { describe, expect, it } from "vitest";
import { githubPrimaryBlinding } from "../services/chat-github-primary-blinding.js";
import { notFound } from "../errors.js";

// Use the DB package's driver, rather than add a production server dependency for a benchmark.
const postgres = createRequire(import.meta.resolve("@paperclipai/db"))("postgres") as
  (url: string, options: Record<string, unknown>) => ReturnType<typeof schema.createDb>["$client"];

// Opt-in reproducible load test: BLINDING_PERF_EVIDENCE=/absolute/directory
// nice -n 10 pnpm exec vitest run --maxWorkers=1 server/src/__tests__/chat-github-primary-blinding.perf.test.ts
// Always creates its own disposable cluster; never reads DATABASE_URL.
const suite = process.env.BLINDING_PERF_EVIDENCE ? describe : describe.skip;
suite("primary blinding realistic query plans and request overhead", () => {
  it("uses indexed run predicates and shares ingress/response snapshots", async () => {
    const directory = process.env.BLINDING_PERF_EVIDENCE!;
    await mkdir(directory, { recursive: true });
    const temporary = await startEmbeddedPostgresTestDatabase("blinding-perf-");
    const client = postgres(temporary.connectionString, {
      max: 10, onnotice: () => {}, connection: { search_path: "blinding_fixture,public", statement_timeout: 180_000 },
    });
    const queries: { query: string; params: unknown[] }[] = [];
    const db = drizzle(client, { schema, logger: { logQuery: (query, params) => { queries.push({ query, params }); } } });
    const company = "00000000-0000-4000-8000-000000000001";
    const emptyCompany = "00000000-0000-4000-8000-000000000002";
    try {
      // Same column types/defaults/indexes as production, without production FKs.
      await client.unsafe("create schema blinding_fixture");
      for (const table of ["chat_github_review_candidates", "heartbeat_runs", "issues", "issue_comments", "issue_attachments", "assets", "chat_github_reviews", "documents", "issue_documents", "document_revisions", "chat_github_blinding_versions"]) {
        await client.unsafe(`create table blinding_fixture.${table} (like public.${table} including defaults including indexes)`);
      }
      await client.unsafe(`create function blinding_fixture.fixture_id(kind text, n integer) returns uuid
        language sql immutable as 'select md5(kind || n::text)::uuid';
        insert into issues (id, company_id, title, identifier)
          select fixture_id('issue', i), '${company}', 'Fixture issue ' || i, 'PERF-' || i from generate_series(1,50000) i;
        insert into chat_github_review_candidates (company_id, endpoint_id, enrollment_id, arm_id, agent_id, shadow_label, issue_id)
          select '${company}', fixture_id('endpoint',1), fixture_id('enrollment',i), fixture_id('arm',1),
            fixture_id('candidate-agent',i % 10), 'candidate', fixture_id('issue',i) from generate_series(1,1000) i;
        insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, native_issue_id, context_snapshot)
          select fixture_id('run',i), '${company}',
            case when i % 100 = 0 then fixture_id('candidate-agent',i % 10) else fixture_id('primary-agent',i % 1000) end,
            'on_demand', 'succeeded', case when i % 3 = 0 then fixture_id('issue',1+i % 50000) end,
            case when i % 3 = 1 then jsonb_build_object('issueId',fixture_id('issue',1+i % 50000)::text)
              when i % 3 = 2 then jsonb_build_object('taskId',fixture_id('issue',1+i % 50000)::text) else '{}'::jsonb end
          from generate_series(1,500000) i;
        insert into chat_github_blinding_versions (company_id) values ('${company}');
        analyze issues; analyze heartbeat_runs; analyze chat_github_review_candidates; analyze chat_github_blinding_versions`);
      await client.unsafe("vacuum (analyze) chat_github_review_candidates");
      const record = async (name: string, value: unknown) => writeFile(path.join(directory, name), JSON.stringify(value, null, 2));
      // Execute the actual pre-fix implementation, not a hand-written timing proxy.
      // Fixed source revision is intentional so the baseline cannot drift after rebase.
      const baselineRef = "f650d1ae1";
      const baselineSource = execFileSync("git", ["show", `${baselineRef}:server/src/services/chat-github-primary-blinding.ts`], { cwd: path.resolve(import.meta.dirname, "../../.."), encoding: "utf8" });
      await writeFile(path.join(directory, "baseline-source.ts"), baselineSource);
      const compiled = (await transform(baselineSource, { loader: "ts", target: "es2022", format: "esm" })).code
        .replace(/^import .*?;\n/gm, "").replace(/export\s*\{[^}]*\};?\s*$/s, "");
      const bindings = { and, eq, inArray, or, sql, notFound, ...schema };
      const before = new Function(...Object.keys(bindings), `${compiled}; return githubPrimaryBlinding;`)(...Object.values(bindings)) as typeof githubPrimaryBlinding;
      const explain = async (query: { query: string; params: unknown[] }) => (await client.unsafe(`explain (analyze, buffers, format json) ${query.query}`, query.params as never))[0]!["QUERY PLAN"];
      const body = [{ id: "public-row", title: "Visible" }, { id: (await client`select id from issues where identifier = 'PERF-1'`)[0]!.id, title: "Private" }];
      const request = async (loader: typeof githubPrimaryBlinding, id = company) => {
        const arrival = await loader(db, id);
        arrival.assertVisible("/api/issues?limit=20");
        const response = await loader(db, id);
        return response.filter(body);
      };
      const oldOutput = await request(before);
      const oldQueries = queries.splice(0);
      await record("explain-before.json", await explain(oldQueries.find(q => q.query.includes('from "heartbeat_runs"'))!));
      const coldStart = performance.now();
      expect(await request(githubPrimaryBlinding)).toEqual(oldOutput);
      const coldMs = performance.now() - coldStart;
      const newQueries = queries.splice(0);
      await record("explain-after.json", await explain(newQueries.find(q => q.query.includes('from "heartbeat_runs"'))!));
      await record("explain-version.json", await explain(newQueries[0]!));
      const afterPlan = await explain(newQueries.find(q => q.query.includes('from "heartbeat_runs"'))!);
      const nodes: Record<string, any>[] = [];
      const visit = (node: Record<string, any>) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
      visit(afterPlan[0].Plan);
      expect(nodes.filter(n => n["Relation Name"] === "heartbeat_runs" && /Seq Scan/.test(n["Node Type"]))).toEqual([]);
      expect(oldOutput).toEqual([{ id: "public-row", title: "Visible" }]);
      const measure = async (loader: typeof githubPrimaryBlinding, count: number, concurrency: number, id = company) => {
        const timings: number[] = [];
        queries.length = 0;
        const start = performance.now();
        let next = 0;
        await Promise.all(Array.from({ length: concurrency }, async () => {
          while (next++ < count) {
            const started = performance.now();
            await request(loader, id);
            timings.push(performance.now() - started);
          }
        }));
        timings.sort((a,b) => a-b);
        return { count, concurrency, pool: 10, queries: queries.length, totalMs: performance.now()-start,
          meanMs: timings.reduce((a,b) => a+b,0)/count, p50Ms: timings[Math.floor(count*.5)], p95Ms: timings[Math.min(count-1,Math.floor(count*.95))], samplesMs: timings };
      };
      const beforeRequests = await measure(before, 8, 4);
      const afterRequests = await measure(githubPrimaryBlinding, 8, 4);
      const after50 = await measure(githubPrimaryBlinding, 100, 50);
      const empty = await measure(githubPrimaryBlinding, 100, 50, emptyCompany);
      expect(afterRequests.queries).toBe(16);
      expect(empty.queries).toBe(200);
      const writeComments = async () => {
        const start = performance.now();
        const rows = await Promise.all(Array.from({ length: 50 }, () => client`
          insert into issue_comments (company_id, issue_id, body)
          values (${company}, fixture_id('issue',1), 'Benchmark alias') returning id`));
        return { ms: performance.now() - start, ids: rows.flat().map(r => String(r.id)) };
      };
      const withoutTriggers = await writeComments();
      const triggers = await client`select pg_get_triggerdef(t.oid) as definition from pg_trigger t
        join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace
        and t.tgname ~ '^github_.*_visibility$'`;
      expect(triggers).toHaveLength(10);
      for (const { definition } of triggers) {
        expect(definition).toContain(" ON public.");
        await client.unsafe(String(definition).replace(" ON public.", " ON blinding_fixture."));
      }
      const withTriggers = await writeComments();
      const epoch = (await client`select version::text from chat_github_blinding_versions where company_id = ${company}`)[0]!.version;
      expect(epoch).toBe("50");
      const changedStart = performance.now();
      const changed = await githubPrimaryBlinding(db, company);
      const changedMs = performance.now() - changedStart;
      for (const id of [...withoutTriggers.ids, ...withTriggers.ids]) expect(() => changed.assertVisible(id)).toThrow(/not found/i);
      const writes = { count: 50, concurrency: 50, pool: 10, withoutTriggersMs: withoutTriggers.ms, withTriggersMs: withTriggers.ms, epoch, changedMs };
      await record("benchmark.json", { timestamp: new Date().toISOString(), baselineRef,
        postgres: await client`select version()`, fixture: { runs: 500000, issues: 50000, candidates: 1000, aliasTables: "empty" },
        oldQueriesPerRequest: oldQueries.length, coldQueriesPerRequest: newQueries.length, coldMs,
        beforeRequests, afterRequests, after50, empty, writes });
      console.log(JSON.stringify({ beforeRequests, afterRequests, after50, empty, writes, coldMs }));
    } finally {
      await client.end();
      await temporary.cleanup();
    }
  }, 600_000);
});
