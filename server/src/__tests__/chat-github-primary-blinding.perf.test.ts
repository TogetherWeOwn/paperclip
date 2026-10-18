import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { setTimeout as delay, setImmediate as yieldTurn } from "node:timers/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { describe, expect, it } from "vitest";
import { githubPrimaryBlinding } from "../services/chat-github-primary-blinding.js";
import { initializeGitHubPrimaryBlinding } from "../services/chat-github-primary-blinding-state.js";

const postgres = createRequire(import.meta.resolve("@paperclipai/db"))("postgres") as
  (url: string, options: Record<string, unknown>) => ReturnType<typeof schema.createDb>["$client"];
const suite = process.env.BLINDING_PERF_EVIDENCE ? describe : describe.skip;
const company = "00000000-0000-4000-8000-000000000001";
const offCompany = "00000000-0000-4000-8000-000000000002";
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

// Opt in with BLINDING_PERF_EVIDENCE=/absolute/directory. Every run boots its own
// disposable PostgreSQL; neither DATABASE_URL nor PAPERCLIP_TEST_DATABASE_URL is used.
// Port of the independent verifier's populated-alias churn and lock probes.
suite("primary blinding lock-free production write and request budgets", () => {
  it("bounds unrelated writes, snapshots and concurrency on production-sized aliases", async () => {
    const directory = process.env.BLINDING_PERF_EVIDENCE!;
    await mkdir(directory, { recursive: true });
    const temporary = await startEmbeddedPostgresTestDatabase("blinding-lockfree-perf-");
    const client = postgres(temporary.connectionString, { max: 10, onnotice: () => {},
      connection: { search_path: "blinding_fixture,public", statement_timeout: 180_000 } });
    const queries: { query: string; params: unknown[] }[] = [];
    const db = drizzle(client, { schema, logger: { logQuery: (query, params) => { queries.push({ query, params }); } } });
    const record = async (name: string, value: unknown) => writeFile(path.join(directory, name), JSON.stringify(value, null, 2));
    const metrics: Record<string, unknown> = { timestamp: new Date().toISOString(), pool: 10,
      fixture: { runs: 500000, comments: 300000, assets: 50000, documents: 30000, revisions: 60000, issues: 50000, candidates: 1000 } };
    try {
      await client.unsafe("create schema blinding_fixture; create schema baseline_fixture");
      for (const table of ["chat_github_review_candidates", "heartbeat_runs", "issues", "issue_comments", "issue_attachments", "assets", "chat_github_reviews", "documents", "issue_documents", "document_revisions"]) {
        await client.unsafe(`create table blinding_fixture.${table} (like public.${table} including defaults including indexes)`);
      }
      expect(await client`select 1 from pg_trigger where tgname ~ '^github_.*_visibility$'`).toHaveLength(0);
      expect((await client`select to_regclass('public.chat_github_blinding_versions') as relation`)[0]!.relation).toBeNull();
      await client.unsafe(`create function blinding_fixture.fixture_id(kind text, n integer) returns uuid language sql immutable as 'select md5(kind || n::text)::uuid';
        insert into issues (id, company_id, title, identifier) select fixture_id('issue', i), '${company}', 'Fixture issue ' || i, 'PERF-' || i from generate_series(1,50000) i;
        insert into chat_github_review_candidates (company_id, endpoint_id, enrollment_id, arm_id, agent_id, shadow_label, issue_id)
          select '${company}', fixture_id('endpoint',1), fixture_id('enrollment',i), fixture_id('arm',1), fixture_id('candidate-agent',i % 10), 'candidate', fixture_id('issue',i) from generate_series(1,1000) i;
        insert into heartbeat_runs (id, company_id, agent_id, invocation_source, status, native_issue_id, context_snapshot)
          select fixture_id('run',i), '${company}', case when i % 100 = 0 then fixture_id('candidate-agent',i % 10) else fixture_id('primary-agent',i % 1000) end,
            'on_demand', 'succeeded', case when i % 3 = 0 then fixture_id('issue',1+i % 50000) end,
            case when i % 3 = 1 then jsonb_build_object('issueId',fixture_id('issue',1+i % 50000)::text) when i % 3 = 2 then jsonb_build_object('taskId',fixture_id('issue',1+i % 50000)::text) else '{}'::jsonb end
          from generate_series(1,500000) i;
        insert into issue_comments (company_id, issue_id, author_agent_id, body)
          select '${company}', fixture_id('issue',1+i % 50000), case when i % 100 = 0 then fixture_id('candidate-agent',i % 10) else fixture_id('primary-agent',i % 1000) end, 'comment body ' || i from generate_series(1,300000) i;
        insert into assets (id, company_id, provider, object_key, content_type, byte_size, sha256, created_by_agent_id)
          select fixture_id('asset',i), '${company}', 'local', 'k' || i, 'text/plain', 1, 'x', case when i % 100 = 0 then fixture_id('candidate-agent',i % 10) else fixture_id('primary-agent',i % 1000) end from generate_series(1,50000) i;
        insert into issue_attachments (company_id, issue_id, asset_id) select '${company}', fixture_id('issue',1+i % 50000), fixture_id('asset',i) from generate_series(1,20000) i;
        insert into documents (id, company_id, latest_body, created_by_agent_id)
          select fixture_id('doc',i), '${company}', 'doc ' || i, case when i % 100 = 0 then fixture_id('candidate-agent',i % 10) else fixture_id('primary-agent',i % 1000) end from generate_series(1,30000) i;
        insert into issue_documents (company_id, issue_id, document_id, key) select '${company}', fixture_id('issue',1+i % 50000), fixture_id('doc',i), 'k' || i from generate_series(1,30000) i;
        insert into document_revisions (company_id, document_id, revision_number, body) select '${company}', fixture_id('doc',1+i % 30000), i, 'rev' from generate_series(1,60000) i;`);
      for (const table of ["issues", "issue_comments", "heartbeat_runs"]) {
        await client.unsafe(`create table baseline_fixture.${table} (like blinding_fixture.${table} including defaults including indexes)`);
        if (table !== "heartbeat_runs") await client.unsafe(`insert into baseline_fixture.${table} select * from blinding_fixture.${table}`);
      }
      // LIKE ... INCLUDING INDEXES generates fresh names: matching "visibility"
      // in those names silently retains the new indexes in the baseline. Compare
      // definitions against the actual public migration indexes instead.
      const visibilityIndexes = await client`select tablename, indexdef from pg_indexes
        where schemaname = 'public' and indexname like '%_visibility_idx'`;
      const definitions = new Set(visibilityIndexes.map(row => `${row.tablename}:${String(row.indexdef).split(" USING ")[1]}`));
      const baselineIndexes = (await client`select tablename, indexname, indexdef from pg_indexes where schemaname = 'baseline_fixture'`)
        .filter(row => definitions.has(`${row.tablename}:${String(row.indexdef).split(" USING ")[1]}`));
      expect(baselineIndexes).toHaveLength(4); // Three run indexes and one comment index.
      for (const row of baselineIndexes) await client.unsafe(`drop index baseline_fixture."${row.indexname}"`);
      await client.unsafe("vacuum analyze");
      await initializeGitHubPrimaryBlinding(db);
      const body = [{ id: "public-row", title: "Visible" }];
      const request = async (id = company) => {
        (await githubPrimaryBlinding(db, id)).assertVisible("/api/issues?limit=20");
        return (await githubPrimaryBlinding(db, id)).filter(body);
      };
      queries.length = 0;
      const coldStart = performance.now();
      expect(await request()).toEqual(body);
      metrics.coldMs = performance.now() - coldStart;
      const coldQueries = queries.splice(0);
      const plans = [];
      for (const q of coldQueries) plans.push((await client.unsafe(`explain (analyze, buffers, format json) ${q.query}`, q.params as never))[0]!["QUERY PLAN"]);
      await record("snapshot-explains.json", plans);
      const nodes: Record<string, any>[] = [];
      const visit = (node: Record<string, any>) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
      for (const plan of plans) visit((plan as any[])[0].Plan);
      expect(nodes.filter(n => n["Relation Name"] === "heartbeat_runs" && /Seq Scan/.test(n["Node Type"]))).toEqual([]);
      const measure = async (count: number, id: string) => {
        let next = 0;
        const timings: number[] = [];
        queries.length = 0;
        const start = performance.now();
        await Promise.all(Array.from({ length: 50 }, async () => {
          while (next++ < count) {
            const t = performance.now(); await request(id); timings.push(performance.now() - t);
            await yieldTurn();
          }
        }));
        timings.sort((a, b) => a - b);
        return { count, concurrency: 50, queries: queries.length, totalMs: performance.now() - start,
          meanMs: timings.reduce((a, b) => a + b, 0) / count, p95Ms: timings[Math.floor(count * .95)]!, samplesMs: timings };
      };
      metrics.quiet = await measure(400, company);
      const stable = await githubPrimaryBlinding(db, company);
      let stop = false; let writes = 0;
      const writingSince = performance.now();
      const writer = (async () => {
        let due = performance.now();
        while (!stop) {
          await client`insert into issue_comments (company_id, issue_id, author_agent_id, body)
            values (${company}, fixture_id('issue',49999), fixture_id('primary-agent',7), 'unrelated primary comment')`;
          writes++; due += 50; await delay(Math.max(0, due - performance.now()));
        }
      })();
      let churn: Awaited<ReturnType<typeof measure>>;
      try { churn = await measure(2000, company); }
      finally { stop = true; await writer; }
      metrics.unrelatedWrites20PerSecond = { ...churn, writes, writerDurationMs: performance.now() - writingSince };
      expect(await githubPrimaryBlinding(db, company)).toBe(stable);
      const off = await measure(2000, offCompany);
      metrics.shadowOff = off;
      expect(off.queries).toBe(0);

      // A late commit must change the watermark even if its created_at predates
      // the cached snapshot. Body/status updates and unrelated writes must not.
      const inserted = gate(); const commit = gate(); let alias = "";
      const transaction = client.begin(async tx => {
        const [row] = await tx`insert into issue_comments (company_id, issue_id, author_agent_id, body, created_at)
          values (${company}, fixture_id('issue',1), fixture_id('candidate-agent',0), 'late commit', '2000-01-01') returning id`;
        alias = String(row!.id); inserted.resolve(); await commit.promise;
      });
      await inserted.promise;
      try { expect(await githubPrimaryBlinding(db, company)).toBe(stable); }
      finally { commit.resolve(); await transaction; }
      expect(() => stable.assertVisible(alias)).not.toThrow();
      const fresh = await githubPrimaryBlinding(db, company);
      expect(() => fresh.assertVisible(alias)).toThrow(/not found/i);

      // Original verifier interleavings, coordinated by durable query completion
      // rather than sleeps. A safety timer releases a broken implementation so
      // the measurement reports its delay instead of hanging the test process.
      const comment = (tx: any, schemaName: string, issue: number) => tx.unsafe(`insert into ${schemaName}.issue_comments (company_id, issue_id, body) values ('${company}', blinding_fixture.fixture_id('issue',${issue}), 'lock probe')`);
      const run = (tx: any, schemaName: string) => tx.unsafe(`insert into ${schemaName}.heartbeat_runs (company_id, agent_id, invocation_source, status) values ('${company}', gen_random_uuid(), 'on_demand', 'queued')`);
      const blockingProbe = async (schemaName: string, mode: "baseline" | "on" | "off") => {
        const held = gate(); const release = gate();
        const holder = client.begin(async tx => { await comment(tx, schemaName, 49999); held.resolve(); await release.promise; });
        await held.promise;
        const timer = setTimeout(release.resolve, 1500);
        try {
          if (mode !== "baseline") await request(mode === "on" ? company : offCompany);
          const started = performance.now(); await run(client, schemaName); return performance.now() - started;
        } finally { clearTimeout(timer); release.resolve(); await holder; }
      };
      const deadlockProbe = async (schemaName: string) => {
        const issueLocked = gate(); const runInserted = gate();
        const results = await Promise.allSettled([
          client.begin(async tx => { await tx.unsafe(`select 1 from ${schemaName}.issues where id = blinding_fixture.fixture_id('issue',1) for update`);
            issueLocked.resolve(); await runInserted.promise; await comment(tx, schemaName, 2); }),
          client.begin(async tx => { await issueLocked.promise; try { await run(tx, schemaName); } finally { runInserted.resolve(); }
            await tx.unsafe(`select 1 from ${schemaName}.issues where id = blinding_fixture.fixture_id('issue',1) for update`); }),
        ]);
        return results.flatMap(r => r.status === "rejected" ? [{ code: r.reason.code, message: r.reason.message }] : []);
      };
      await Promise.all(Array.from({ length: 10 }, () => client`select 1`));
      const locks = [];
      for (const mode of ["baseline", "on", "off"] as const) {
        const schemaName = mode === "baseline" ? "baseline_fixture" : "blinding_fixture";
        const samples = [];
        for (let i = 0; i < 3; i++) samples.push(await blockingProbe(schemaName, mode));
        locks.push({ mode, samplesMs: samples, medianMs: median(samples), errors: await deadlockProbe(schemaName) });
      }
      metrics.locks = locks;
      await record("locks.json", locks);
      const writeBatch = async (schemaName: string) => {
        const start = performance.now();
        await Promise.all(Array.from({ length: 50 }, () => client.unsafe(`insert into ${schemaName}.issue_comments (company_id, issue_id, author_agent_id, body)
          values ('${company}', blinding_fixture.fixture_id('issue',49999), blinding_fixture.fixture_id('primary-agent',7), 'write overhead')`)));
        return performance.now() - start;
      };
      const samples: Record<string, number[]> = { baseline: [], on: [], off: [] };
      // Rotate ordering to avoid giving the warmed/later participant an advantage.
      for (let round = 0; round < 12; round++) {
        const order = ["baseline", "on", "off"];
        for (let i = 0; i < 3; i++) {
          const mode = order[(i + round) % 3]!;
          samples[mode]!.push(await writeBatch(mode === "baseline" ? "baseline_fixture" : "blinding_fixture"));
        }
      }
      const writesMetric = Object.fromEntries(Object.entries(samples).map(([mode, times]) => [mode, { samplesMs: times, medianMs: median(times) }]));
      metrics.commentWrites50 = writesMetric;
      await record("benchmark.json", metrics); // Preserve every measurement before any budget assertion.
      console.log(JSON.stringify({ coldMs: metrics.coldMs, churnP95Ms: churn.p95Ms, offP95Ms: off.p95Ms, locks, writesMetric }));
      expect(churn.p95Ms).toBeLessThanOrEqual(50);
      for (const row of locks) { expect(row.errors).toEqual([]); expect(row.medianMs - locks[0]!.medianMs).toBeLessThanOrEqual(50); }
      expect(writesMetric.on!.medianMs / writesMetric.baseline!.medianMs).toBeLessThanOrEqual(1.1);
      expect(writesMetric.off!.medianMs / writesMetric.baseline!.medianMs).toBeLessThanOrEqual(1.1);
    } finally { await client.end(); await temporary.cleanup(); }
  }, 1_200_000);
});
