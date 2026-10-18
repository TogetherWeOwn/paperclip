import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadavg } from "node:os";
import { createRequire } from "node:module";
import { setTimeout as delay, setImmediate as yieldTurn } from "node:timers/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { githubPrimaryBlinding, installGitHubPrimaryApiBlinding } from "../services/chat-github-primary-blinding.js";
import { initializeGitHubPrimaryReviewers } from "../services/chat-github-primary-reviewers.js";
import { initializeGitHubPrimaryBlinding } from "../services/chat-github-primary-blinding-state.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const postgres = createRequire(import.meta.resolve("@paperclipai/db"))("postgres") as
  (url: string, options: Record<string, unknown>) => ReturnType<typeof schema.createDb>["$client"];
const suite = process.env.BLINDING_PERF_EVIDENCE ? describe : describe.skip;
const company = "00000000-0000-4000-8000-000000000001";
const offCompany = "00000000-0000-4000-8000-000000000002";
const primaryAgent = "00000000-0000-4000-8000-000000000003";
const nonPrimaryAgent = "00000000-0000-4000-8000-000000000004";
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
    const metrics: Record<string, unknown> = { timestamp: new Date().toISOString(), loadStart: loadavg(), pool: 10,
      fixture: { runs: 500000, comments: 300000, assets: 50000, documents: 30000, revisions: 60000, issues: 50000, candidates: 1000 } };
    const settings = instanceSettingsService(db, { runtimeEnv: {} });
    const setShadow = async (enabled: boolean) => {
      const result = await settings.updateExperimental({ githubReviewShadowEnabled: enabled });
      expect(result.experimental.githubReviewShadowEnabled).toBe(enabled);
    };
    try {
      await client.unsafe("create schema blinding_fixture; create schema baseline_fixture");
      for (const table of ["chat_endpoints", "chat_github_review_candidates", "heartbeat_runs", "issues", "issue_comments", "issue_attachments", "assets", "chat_github_reviews", "documents", "issue_documents", "document_revisions"]) {
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
        await client.unsafe(`insert into baseline_fixture.${table} select * from blinding_fixture.${table}`);
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
      const actualCounts = (await client`select
        (select count(*)::int from heartbeat_runs) as runs,
        (select count(*)::int from issue_comments) as comments,
        (select count(*)::int from assets) as assets,
        (select count(*)::int from documents) as documents,
        (select count(*)::int from document_revisions) as revisions,
        (select count(*)::int from issues) as issues,
        (select count(*)::int from chat_github_review_candidates) as candidates`)[0];
      expect(actualCounts).toEqual(metrics.fixture);
      metrics.fixture = actualCounts;
      await setShadow(true);
      await initializeGitHubPrimaryBlinding(db);
      await client`insert into chat_endpoints (company_id, connection_id, provider, public_id, assigned_agent_id)
        values (${company}, gen_random_uuid(), 'github', 'perf-primary', ${primaryAgent}),
          (${offCompany}, gen_random_uuid(), 'github', 'perf-off-primary', ${primaryAgent})`;
      await initializeGitHubPrimaryReviewers(db);
      const body = [{ id: "public-row", title: "Visible" }];
      // Measure the actual ingress + response seam, not two synthetic full reads.
      // Authentication, route work and HTTP transport are outside this blinding budget.
      const request = (id = company, agentId = primaryAgent) => new Promise<unknown>((resolve, reject) => {
        const req = { actor: { type: "agent", agentId, companyId: id }, originalUrl: "/api/issues?limit=20" } as Request;
        let status = 200;
        const res = { json: (value: unknown) => {
          if (status >= 400) reject(new Error(`Blinding returned ${status}: ${JSON.stringify(value)}`));
          else resolve(value);
          return res;
        }, status: (code: number) => { status = code; return res; } } as unknown as Response;
        void installGitHubPrimaryApiBlinding(db, id, req, res).then(() => res.json(body)).catch(reject);
      });
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
      const measure = async (minimumCount: number, id: string, minimumDurationMs = 0, agentId = primaryAgent) => {
        let next = 0;
        const timings: number[] = [];
        const errors: string[] = [];
        queries.length = 0;
        const start = performance.now();
        await Promise.all(Array.from({ length: 50 }, async () => {
          while (next < minimumCount || performance.now() - start < minimumDurationMs) {
            next++;
            const t = performance.now();
            try { await request(id, agentId); } catch (error) { errors.push(String(error)); }
            timings.push(performance.now() - t);
            await yieldTurn();
          }
        }));
        timings.sort((a, b) => a - b);
        return { count: timings.length, concurrency: 50, errors, queries: queries.length, totalMs: performance.now() - start,
          meanMs: timings.reduce((a, b) => a + b, 0) / timings.length,
          p95Ms: timings[Math.ceil(timings.length * .95) - 1]!, samplesMs: timings };
      };
      metrics.quiet = await measure(400, company);
      const nonPrimary = await measure(2000, company, 0, nonPrimaryAgent);
      metrics.nonPrimary = nonPrimary;
      expect(nonPrimary.queries).toBe(0);
      expect(nonPrimary.errors).toEqual([]);
      expect(await request(company, nonPrimaryAgent)).toBe(body);
      expect(JSON.stringify(await request(company, nonPrimaryAgent))).toBe(JSON.stringify(body));
      const stable = await githubPrimaryBlinding(db, company);
      let stop = false;
      const completedWritesAtMs: number[] = [];
      const writeErrors: string[] = [];
      const writingSince = performance.now();
      // Schedule independently of query completion: awaiting every INSERT before
      // the 50ms delay quietly reduces the claimed 20/s rate under contention.
      const writer = (async () => {
        const pending: Promise<void>[] = [];
        let due = writingSince;
        while (!stop) {
          pending.push(client`insert into issue_comments (company_id, issue_id, author_agent_id, body)
            values (${company}, fixture_id('issue',49999), fixture_id('primary-agent',7), 'unrelated primary comment')`
            .then(() => { completedWritesAtMs.push(performance.now() - writingSince); })
            .catch(error => { writeErrors.push(String(error)); }));
          due += 50;
          await delay(Math.max(0, due - performance.now()));
        }
        await Promise.all(pending);
      })();
      let churn: Awaited<ReturnType<typeof measure>>;
      let writerActiveMs = 0;
      try { churn = await measure(2000, company, 5000); }
      finally { writerActiveMs = performance.now() - writingSince; stop = true; await writer; }
      const writesDuringRequests = completedWritesAtMs.filter(t => t <= writerActiveMs).length;
      const achievedWritesPerSecond = writesDuringRequests * 1000 / writerActiveMs;
      metrics.unrelatedWrites20PerSecond = { ...churn, writes: completedWritesAtMs.length, writesDuringRequests,
        targetWritesPerSecond: 20, achievedWritesPerSecond, writerActiveMs,
        writerDurationMs: performance.now() - writingSince, completedWritesAtMs, writeErrors };
      expect(await githubPrimaryBlinding(db, company)).toBe(stable);
      await setShadow(false);
      const off = await measure(2000, offCompany);
      metrics.shadowOff = off;
      expect(off.queries).toBe(0);
      expect(await request(offCompany)).toBe(body);
      expect(JSON.stringify(await request(offCompany))).toBe(JSON.stringify(body));
      // OFF is not permission to unseal candidate history. Exercise the SAME
      // admitted company, rather than labelling an unadmitted company's bypass OFF.
      expect(await githubPrimaryBlinding(db, company)).toBe(stable);
      expect(stable.active).toBe(true);

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
      const prepareMode = async (mode: "baseline" | "on" | "off") => {
        await setShadow(mode === "on");
        if (mode !== "baseline") expect(await request(company)).toEqual(body);
      };
      const blockingProbe = async (schemaName: string) => {
        const held = gate(); const release = gate();
        let safetyRelease = false;
        const holder = client.begin(async tx => { await comment(tx, schemaName, 49999); held.resolve(); await release.promise; });
        const timer = setTimeout(() => { safetyRelease = true; release.resolve(); }, 1500);
        try {
          await Promise.race([held.promise, holder]);
          const started = performance.now();
          await run(client, schemaName);
          return { ms: performance.now() - started, finishedWhileCommentOpen: !safetyRelease };
        } finally { clearTimeout(timer); release.resolve(); await holder; }
      };
      const deadlockProbe = async (schemaName: string) => {
        const issueLocked = gate(); const runInserted = gate();
        const results = await Promise.allSettled([
          client.begin(async tx => {
            try {
              await tx`set local lock_timeout = '10s'`;
              await tx.unsafe(`select 1 from ${schemaName}.issues where id = blinding_fixture.fixture_id('issue',1) for update`);
            } finally { issueLocked.resolve(); }
            await runInserted.promise;
            await comment(tx, schemaName, 2);
          }),
          client.begin(async tx => {
            await issueLocked.promise;
            try { await tx`set local lock_timeout = '10s'`; await run(tx, schemaName); }
            finally { runInserted.resolve(); }
            await tx.unsafe(`select 1 from ${schemaName}.issues where id = blinding_fixture.fixture_id('issue',1) for update`);
          }),
        ]);
        return results.flatMap(r => r.status === "rejected" ? [{ code: r.reason.code, message: r.reason.message }] : []);
      };
      await Promise.all(Array.from({ length: 10 }, () => client`select 1`));
      const modes = ["baseline", "on", "off"] as const;
      const lockSamples = { baseline: [], on: [], off: [] } as Record<typeof modes[number], { ms: number; finishedWhileCommentOpen: boolean }[]>;
      // Alternate baseline and feature measurements, not three separate windows.
      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < modes.length; i++) {
          const mode = modes[(i + round) % modes.length]!;
          await prepareMode(mode);
          lockSamples[mode].push(await blockingProbe(mode === "baseline" ? "baseline_fixture" : "blinding_fixture"));
        }
      }
      const locks = [];
      for (const mode of modes) {
        await prepareMode(mode);
        const samples = lockSamples[mode];
        locks.push({ mode, samplesMs: samples.map(s => s.ms), medianMs: median(samples.map(s => s.ms)),
          allFinishedWhileCommentOpen: samples.every(s => s.finishedWhileCommentOpen),
          errors: await deadlockProbe(mode === "baseline" ? "baseline_fixture" : "blinding_fixture") });
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
        for (let i = 0; i < modes.length; i++) {
          const mode = modes[(i + round) % modes.length]!;
          await prepareMode(mode);
          samples[mode]!.push(await writeBatch(mode === "baseline" ? "baseline_fixture" : "blinding_fixture"));
        }
      }
      const writesMetric = Object.fromEntries(Object.entries(samples).map(([mode, times]) => [mode, { samplesMs: times, medianMs: median(times) }]));
      metrics.commentWrites50 = writesMetric;
      metrics.commentWriteOverheadPercent = { on: 100 * (writesMetric.on!.medianMs / writesMetric.baseline!.medianMs - 1),
        off: 100 * (writesMetric.off!.medianMs / writesMetric.baseline!.medianMs - 1) };
      console.log(JSON.stringify({ coldMs: metrics.coldMs, churnP95Ms: churn.p95Ms, achievedWritesPerSecond,
        offP95Ms: off.p95Ms, offQueries: off.queries,
        nonPrimaryP95Ms: nonPrimary.p95Ms, nonPrimaryQueries: nonPrimary.queries, locks, writesMetric }));
      // Soft budgets report every unmet requirement in one expensive fixture run;
      // nothing is retried or relaxed to turn a loaded-host failure into a pass.
      expect.soft(churn.errors, "A3: no snapshot retry exhaustion or other request errors").toEqual([]);
      expect.soft(writeErrors, "A3: all scheduled unrelated writes succeed").toEqual([]);
      expect.soft(achievedWritesPerSecond, "A3: observed churn within 5% of the target 20 writes/s").toBeGreaterThanOrEqual(19);
      expect.soft(churn.p95Ms, "A3: shadow ON request p95 <= 50ms").toBeLessThanOrEqual(50);
      expect.soft(off.errors, "A3: never-enrolled shadow OFF requests succeed").toEqual([]);
      expect.soft(off.queries, "A3: never-enrolled shadow OFF requests use zero queries").toBe(0);
      for (const row of locks) {
        expect.soft(row.errors, `A2: ${row.mode} interleaving produces no deadlock or other errors`).toEqual([]);
        expect.soft(row.allFinishedWhileCommentOpen, `A2: ${row.mode} insert finishes before comment transaction release`).toBe(true);
        expect.soft(row.medianMs - locks[0]!.medianMs, `A2: ${row.mode} insert within +50ms of baseline`).toBeLessThanOrEqual(50);
      }
      expect.soft(writesMetric.on!.medianMs / writesMetric.baseline!.medianMs, "A4: ON write overhead <= +10%").toBeLessThanOrEqual(1.1);
      expect.soft(writesMetric.off!.medianMs / writesMetric.baseline!.medianMs, "A4: OFF write overhead <= +10%").toBeLessThanOrEqual(1.1);
    } finally {
      metrics.loadEnd = loadavg();
      // Preserve partial evidence even when setup, correctness or budgets fail.
      try { await record("benchmark.json", metrics); }
      finally { try { await client.end(); } finally { await temporary.cleanup(); } }
    }
  }, 1_200_000);
});
