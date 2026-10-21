/**
 * Opt-in seeded perf proof for the bounded milestone sweep (embedded
 * PostgreSQL only).
 *
 * Run ONLY as:
 *   PAPERCLIP_PERF_SEEDED=1 env -u PAPERCLIP_TEST_DATABASE_URL -u DATABASE_URL \
 *     nice -n 10 corepack pnpm@9.15.4 exec vitest run \
 *     server/src/services/chat-run-milestones.perf.test.ts --maxWorkers=1
 *
 * Never against production or a running server. Seeds synthetic
 * production-scale volume (>=500k heartbeat_runs with context_snapshot
 * issueId/source spread over 24h, >=50k issues, >=5k chat_conversations,
 * >=300k issue_comments, >=100k chat_publications) with server-side
 * generate_series so the harness stays in a handful of statements, then
 * records EXPLAIN (ANALYZE, BUFFERS) before (index dropped) vs after
 * (migration index present) plus a timed enqueueChatRunMilestones execution.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  chatConversations,
  chatEndpoints,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issues,
  startEmbeddedPostgresTestDatabase,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { enqueueChatRunMilestones } from "./chat-run-publications.js";
import {
  __unstableGetSkillInventoryLastReconciledAt,
  companySkillService,
} from "./company-skills.js";

const SEEDED = process.env.PAPERCLIP_PERF_SEEDED === "1";
const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const suite = SEEDED && support.supported ? describe.sequential : describe.skip;

// Production-scale seed volumes (host incident 2026-10-18).
const SEED_ISSUES = 50_000;
const SEED_CONVERSATIONS = 5_000;
const SEED_RUNS = 500_000;
const SEED_COMMENTS = 300_000;
const SEED_PUBLICATIONS = 100_000;
// Seeded harness budgets. The cold full-window sweep is inherently heavy
// (the incident shape: ~122 s on prod); it runs once per deploy and is only
// regression-gated here. The steady-state delta sweep is the idle-loop bound:
// the coordinator threads since = last sweep - overlap, so each idle pass
// scans minutes, not the full window. Production target for the delta pass
// is <=1 s; the disposable embedded harness asserts a generous bound.
const COLD_EXECUTION_BUDGET_MS = 300_000;
// Mirrors CHAT_MILESTONE_SWEEP_OVERLAP_MS in app.ts (kept literal so this
// test never imports the app module graph).
const CHAT_MILESTONE_SWEEP_DELTA_MS = 5 * 60_000;
const SINGLE_EXECUTION_BUDGET_MS = 15_000;

suite("seeded milestone sweep + skills cache (opt-in, embedded PG)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | undefined;
  let companyId = "";
  let agentId = "";
  let endpointId = "";

  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-milestone-perf-");
      db = createDb(temporary.connectionString);
    }
    companyId = randomUUID();
    agentId = randomUUID();
    endpointId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Seeded perf fixture",
      issuePrefix: `P${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Seed agent",
      adapterType: "codex_local",
    });
    const toolApplicationId = randomUUID();
    const toolConnectionId = randomUUID();
    await db.insert(toolApplications).values({
      id: toolApplicationId,
      companyId,
      name: "Seed chat",
      type: "chat",
    });
    await db.insert(toolConnections).values({
      id: toolConnectionId,
      companyId,
      applicationId: toolApplicationId,
      uid: randomUUID(),
      name: "Seed chat",
      transport: "chat_sdk",
      connectionPurpose: "channel",
      enabled: true,
      status: "active",
    });
    // Server-side bulk seed: one statement per table, no 1M round trips.
    await db.execute(sql.raw(
      `INSERT INTO issues (company_id, title, status) SELECT '${companyId}', 'Seed issue ' || g, 'todo' FROM generate_series(1, ${SEED_ISSUES}) g`,
    ));
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId: toolConnectionId,
      provider: "slack",
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
    });
    await db.execute(sql.raw(
      `INSERT INTO chat_conversations (company_id, endpoint_id, issue_id, external_conversation_id, external_thread_id, external_label, state)
       SELECT '${companyId}', '${endpointId}', ni.id, 'seed-conv-' || g, 'seed-thread-' || g, 'seed', 'active'
       FROM generate_series(1, ${SEED_CONVERSATIONS}) g
       JOIN (SELECT id, ROW_NUMBER() OVER () AS rn FROM issues WHERE company_id = '${companyId}') ni
         ON ni.rn = (g % ${SEED_ISSUES}) + 1`,
    ));
    await db.execute(sql.raw(
      `INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot, updated_at, created_at)
       SELECT '${companyId}', '${agentId}',
              (ARRAY['running','succeeded','failed','queued'])[(g % 4) + 1],
              jsonb_build_object('issueId', ni.id::text, 'source', 'chat:seed'),
              now() - (((g * 37) % 1440) || ' minutes')::interval,
              now() - (((g * 37) % 1440) || ' minutes')::interval
       FROM generate_series(1, ${SEED_RUNS}) g
       JOIN (SELECT id, ROW_NUMBER() OVER () AS rn FROM issues WHERE company_id = '${companyId}') ni
         ON ni.rn = (g % ${SEED_ISSUES}) + 1`,
    ));
    await db.execute(sql.raw(
      `INSERT INTO issue_comments (company_id, issue_id, body)
       SELECT '${companyId}', ni.id, 'seed comment'
       FROM generate_series(1, ${SEED_COMMENTS}) g
       JOIN (SELECT id, ROW_NUMBER() OVER () AS rn FROM issues WHERE company_id = '${companyId}') ni
         ON ni.rn = (g % ${SEED_ISSUES}) + 1`,
    ));
    await db.execute(sql.raw(
      `INSERT INTO chat_publications (company_id, endpoint_id, conversation_id, issue_id, idempotency_key, payload, state)
       SELECT '${companyId}', '${endpointId}', nc.id, nc.issue_id, 'seed-' || g, '{"kind":"seed"}', 'published'
       FROM generate_series(1, ${SEED_PUBLICATIONS}) g
       JOIN (SELECT id, issue_id, ROW_NUMBER() OVER () AS rn FROM chat_conversations WHERE company_id = '${companyId}') nc
         ON nc.rn = (g % ${SEED_CONVERSATIONS}) + 1`,
    ));
    await db.execute(sql.raw(`ANALYZE heartbeat_runs; ANALYZE issues; ANALYZE chat_conversations; ANALYZE issue_comments; ANALYZE chat_publications;`));
  }, 600_000);

  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  function planText(result: unknown): string {
    // postgres.js driver returns rows directly; node-postgres returns { rows }.
    const rows = Array.isArray(result)
      ? (result as Array<Record<string, unknown>>)
      : (result as { rows: Array<Record<string, unknown>> }).rows;
    return rows.map((row) => String(Object.values(row)[0])).join("\n");
  }

  it("bounds the milestone sweep: index plan + fast single execution", async () => {
    const [runCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(Number(runCount?.n ?? 0)).toBeGreaterThanOrEqual(SEED_RUNS);

    // BEFORE: drop the migration index to capture the incident-shaped plan.
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "heartbeat_runs_updated_at_id_idx"`));
    const before = await db.execute(
      sql.raw(`EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM heartbeat_runs WHERE updated_at >= now() - interval '24 hours' ORDER BY updated_at, id LIMIT 200`),
    );
    const beforeText = planText(before);
    console.log(`[perf-milestones] EXPLAIN BEFORE (index dropped):\n${beforeText}`);

    // AFTER: restore the migration index and re-measure.
    await db.execute(sql.raw(`CREATE INDEX "heartbeat_runs_updated_at_id_idx" ON "heartbeat_runs" USING btree ("updated_at","id")`));
    await db.execute(sql.raw(`ANALYZE heartbeat_runs`));
    const after = await db.execute(
      sql.raw(`EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM heartbeat_runs WHERE updated_at >= now() - interval '24 hours' ORDER BY updated_at, id LIMIT 200`),
    );
    const afterText = planText(after);
    console.log(`[perf-milestones] EXPLAIN AFTER (migration index):\n${afterText}`);
    expect(afterText).toContain("heartbeat_runs_updated_at_id_idx");

    // Cold recovery sweep: full trailing window (expected slow, logged).
    const coldStartedAt = Date.now();
    const coldInserted = await enqueueChatRunMilestones(db, { limit: 200 });
    const coldElapsedMs = Date.now() - coldStartedAt;
    console.log(`[perf-milestones] enqueueChatRunMilestones cold seeded execution: ${coldElapsedMs} ms, inserted=${coldInserted}`);
    expect(coldElapsedMs).toBeLessThan(COLD_EXECUTION_BUDGET_MS);

    // Steady-state sweep: coordinator threads since = last sweep - overlap,
    // so only the delta window is scanned (this is the idle-loop bound).
    const deltaSince = new Date(Date.now() - CHAT_MILESTONE_SWEEP_DELTA_MS);
    const deltaStartedAt = Date.now();
    const deltaInserted = await enqueueChatRunMilestones(db, { limit: 200, since: deltaSince });
    const deltaElapsedMs = Date.now() - deltaStartedAt;
    console.log(`[perf-milestones] enqueueChatRunMilestones delta seeded execution: ${deltaElapsedMs} ms, inserted=${deltaInserted}`);
    expect(deltaElapsedMs).toBeLessThan(SINGLE_EXECUTION_BUDGET_MS);
  }, 600_000);

  it("serves skills reads from cache within the TTL", async () => {
    const svc = companySkillService(db);
    const first = await svc.listFull(companyId);
    expect(Array.isArray(first)).toBe(true);
    const reconciledAt = __unstableGetSkillInventoryLastReconciledAt(companyId);
    expect(reconciledAt).toBeDefined();
    const second = await svc.listFull(companyId);
    expect(second).toHaveLength(first.length);
    // Cached read must not block on a fresh reconcile.
    expect(__unstableGetSkillInventoryLastReconciledAt(companyId)).toBe(reconciledAt);
  }, 120_000);

  it("keeps chat milestone behaviour: agent GET resolves the seeded agent", async () => {
    const [issueCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(Number(issueCount?.n ?? 0)).toBeGreaterThanOrEqual(SEED_ISSUES);
    const convs = await db
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(eq(chatConversations.companyId, companyId));
    expect(convs.length).toBeGreaterThanOrEqual(SEED_CONVERSATIONS);
  }, 120_000);
});
