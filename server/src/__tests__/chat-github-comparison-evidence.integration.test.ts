import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { expect, it } from "vitest";
import { githubPairRunEvidence, GITHUB_REVIEW_RUN_EVIDENCE } from "../services/chat-github-run-evidence.js";

const postgres = createRequire(import.meta.resolve("@paperclipai/db"))("postgres") as
  (url: string, options: Record<string, unknown>) => ReturnType<typeof schema.createDb>["$client"];

it("joins runtime evidence by exact company/admission/head/run/agent and preserves missing retries", async () => {
  // Always disposable: never consumes DATABASE_URL or PAPERCLIP_TEST_DATABASE_URL.
  const temporary = await startEmbeddedPostgresTestDatabase("github-comparison-evidence-");
  const client = postgres(temporary.connectionString, { max: 2, onnotice: () => {}, connection: { search_path: "evidence_fixture,public" } });
  const db = drizzle(client, { schema });
  const company = randomUUID(), endpoint = randomUUID(), delivery = randomUUID(), agent = randomUUID();
  const head = "a".repeat(40);
  const enrollment = { companyId: company, endpointId: endpoint, originDeliveryId: delivery, headSha: head } as typeof schema.chatGitHubReviewEnrollments.$inferSelect;
  const candidate = { agentId: agent };
  const p = { version: 1, cli: { claudeCodeVersion: "2.1.284", tools: ["Bash"], mcpServers: [], permissionMode: "default" }, workspaceHead: head };
  let sequence = 0;
  try {
    await client.unsafe("create schema evidence_fixture");
    for (const table of ["heartbeat_runs", "heartbeat_run_events", "chat_github_reviews"]) {
      await client.unsafe(`create table evidence_fixture.${table} (like public.${table} including defaults including indexes)`);
    }
    const run = async (owner = agent) => {
      const id = randomUUID();
      await client`insert into heartbeat_runs (id,company_id,agent_id,invocation_source,status) values (${id},${company},${owner},'on_demand','running')`;
      return id;
    };
    const event = async (runId: string, owner = agent, companyId = company, eventType = GITHUB_REVIEW_RUN_EVIDENCE) => {
      await db.insert(schema.heartbeatRunEvents).values({ companyId, agentId: owner, runId, seq: ++sequence, eventType, payload: p });
    };
    const review = async (runId: string, overrides: Record<string, string | null> = {}) => {
      const row = { company, endpoint, head, delivery: randomUUID(), admission: delivery, label: null, ...overrides };
      await client`insert into chat_github_reviews (company_id,endpoint_id,issue_id,run_id,repository_id,repository,pull_number,
        head_sha,delivery_id,admission_delivery_id,shadow_label,configuration_revision,policy_snapshot,event)
        values (${row.company},${row.endpoint},${randomUUID()},${runId},'123','org/repo',1,
        ${row.head},${row.delivery},${row.admission},${row.label},1,'{}','{}')`;
    };
    const primary = await run(); const candidateRun = await run();
    await review(primary); await event(primary); await event(candidateRun);
    // Rows satisfying every condition except one must not enter either side.
    for (const overrides of [{ company: randomUUID() }, { endpoint: randomUUID() }, { head: "b".repeat(40) },
      { admission: randomUUID() }, { label: "other-shadow" }]) {
      const noise = await run(); await review(noise, overrides); await event(noise);
    }
    await event(primary, agent, randomUUID());
    await event(primary, randomUUID());
    await event(primary, agent, company, "unrelated.event");
    expect(await githubPairRunEvidence(db, enrollment, candidate, candidateRun)).toEqual({ primaryRuns: [[p]], candidateRun: [p] });
    const retry = await run(); await review(retry, { admission: null, delivery });
    const withMissing = await githubPairRunEvidence(db, enrollment, candidate, candidateRun);
    expect(withMissing.primaryRuns).toHaveLength(2);
    expect(withMissing.primaryRuns).toContainEqual([]);
    await event(retry);
    expect((await githubPairRunEvidence(db, enrollment, candidate, candidateRun)).primaryRuns).toEqual([[p], [p]]);
    const otherAgent = randomUUID();
    const wrongAgent = await run(otherAgent);
    await event(wrongAgent, otherAgent); // A real receipt for another agent is not this candidate.
    await event(wrongAgent); // Nor can event identity alone override the persisted run.
    expect((await githubPairRunEvidence(db, enrollment, candidate, wrongAgent)).candidateRun).toEqual([]);
    expect((await githubPairRunEvidence(db, enrollment, candidate, randomUUID())).candidateRun).toEqual([]);
    expect((await githubPairRunEvidence(db, { ...enrollment, originDeliveryId: randomUUID() }, candidate, candidateRun)).primaryRuns).toEqual([]);
  } finally {
    await client.end();
    await temporary.cleanup();
  }
}, 120_000);
