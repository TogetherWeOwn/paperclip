import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migration = await readFile(new URL("./migrations/0432_dear_jane_foster.sql", import.meta.url), "utf8");
const decisionMigration = await readFile(new URL("./migrations/0433_last_proudstar.sql", import.meta.url), "utf8");
const support = await getEmbeddedPostgresTestSupport();
const head = "a".repeat(40);

(support.supported ? describe : describe.skip)("durable code-delivery persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: ReturnType<typeof postgres>;
  let legacy: Awaited<ReturnType<typeof fixture>>;
  let legacyTask: Record<string, unknown>;
  let legacyProducts: Record<string, unknown>[];

  async function fixture(status = "in_progress") {
    const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Delivery fixture', ${randomUUID().slice(0, 8)}) RETURNING id`;
    const [project] = await sql`INSERT INTO projects (company_id, name) VALUES (${company.id}, 'Source') RETURNING id`;
    const [workspace] = await sql`INSERT INTO project_workspaces (company_id, project_id, name, repo_url)
      VALUES (${company.id}, ${project.id}, 'Source', 'https://github.com/fixture/source') RETURNING id`;
    const [issue] = await sql`INSERT INTO issues (company_id, project_id, project_workspace_id, title, status)
      VALUES (${company.id}, ${project.id}, ${workspace.id}, 'Delivery', ${status}) RETURNING id`;
    return { companyId: company.id as string, projectId: project.id as string, workspaceId: workspace.id as string, issueId: issue.id as string };
  }
  async function product(f: Awaited<ReturnType<typeof fixture>>, fields: Record<string, unknown> = {}) {
    const [row] = await sql`INSERT INTO issue_work_products ${sql({ company_id: f.companyId, issue_id: f.issueId,
      type: "pull_request", provider: "github", title: "Delivery", status: "merged", url: "https://github.com/fixture/source/pull/1", ...fields })} RETURNING *`;
    return row;
  }
  async function obligation(f: Awaited<ReturnType<typeof fixture>>, fields: Record<string, unknown> = {}) {
    const [row] = await sql`INSERT INTO code_delivery_obligations ${sql({ company_id: f.companyId, owner_issue_id: f.issueId,
      source_issue_id: f.issueId, source_project_id: f.projectId, source_workspace_id: f.workspaceId, repository_id: "42",
      repository: "fixture/source", pull_request_number: 1, base_ref: "main", proposed_head_sha: head,
      provenance: sql.json({ kind: "test_observation" }), ...fields })} RETURNING *`;
    return row;
  }
  async function issue(f: Awaited<ReturnType<typeof fixture>>) {
    const [row] = await sql`SELECT to_jsonb(i) AS row FROM issues i WHERE id = ${f.issueId}`;
    return row.row;
  }
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-code-delivery-");
    sql = postgres(database.connectionString, { max: 5, onnotice: () => {} });
    await sql.unsafe(`DROP TRIGGER code_delivery_transferred_ownership ON code_delivery_obligations;
      DROP TABLE code_delivery_decisions, code_delivery_authorities;
      DROP FUNCTION code_delivery_transferred_ownership(), code_delivery_decision_mutation();
      DROP TRIGGER code_delivery_capture_work_product ON issue_work_products;
      DROP TRIGGER code_delivery_issue_revision ON issues;
      DROP TRIGGER code_delivery_initialize_intent ON issues;
      DROP TABLE code_delivery_ownership_events, code_delivery_obligations, code_delivery_discoveries, issue_code_delivery_intents;
      DROP FUNCTION code_delivery_initial_ownership(), code_delivery_obligation_mutation(), code_delivery_capture_work_product(),
        code_delivery_intent_mutation(), code_delivery_preserve_history(), code_delivery_initialize_intent(), code_delivery_issue_revision();
      ALTER TABLE issues DROP COLUMN code_delivery_revision;
      DROP INDEX project_workspaces_company_project_id_uq;`);
    legacy = await fixture("done");
    const policy = { stages: [{ id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "user", userId: "reviewer" }] }] };
    const state = { status: "completed", completedStageIds: [policy.stages[0].id], returnAssignee: { type: "agent", agentId: randomUUID() }, round: 2 };
    await sql`UPDATE issues SET execution_policy = ${sql.json(policy)}, execution_state = ${sql.json(state)}, completed_at = now() WHERE id = ${legacy.issueId}`;
    await product(legacy);
    await product(legacy, { type: "branch", url: "https://github.com/fixture/source/tree/feature" });
    await product(legacy, { type: "artifact", provider: "local", url: null });
    legacyTask = await issue(legacy);
    legacyProducts = Array.from(await sql<Record<string, unknown>[]>`SELECT * FROM issue_work_products WHERE issue_id = ${legacy.issueId} ORDER BY id`);
    await sql.begin(async tx => {
      for (const statement of `${migration}\n--> statement-breakpoint\n${decisionMigration}`.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) await tx.unsafe(statement);
    });
  }, 90_000);
  afterAll(async () => { await sql?.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  it("backfills ambiguous intent and discovery only, without rewriting terminal or review state", async () => {
    const [intent] = await sql`SELECT * FROM issue_code_delivery_intents WHERE issue_id = ${legacy.issueId}`;
    expect(intent).toMatchObject({ intent: "ambiguous", provenance: { kind: "legacy_unclassified", migration: "0432" } });
    expect(await issue(legacy)).toEqual({ ...legacyTask, code_delivery_revision: 0 });
    const discoveries = await sql`SELECT snapshot FROM code_delivery_discoveries WHERE issue_id = ${legacy.issueId}`;
    expect(discoveries).toHaveLength(2);
    expect(new Set(discoveries.map(row => row.snapshot.type))).toEqual(new Set(["pull_request", "branch"]));
    expect(await sql`SELECT * FROM code_delivery_obligations WHERE owner_issue_id = ${legacy.issueId}`).toHaveLength(0);
    expect(Array.from(await sql<Record<string, unknown>[]>`SELECT * FROM issue_work_products WHERE issue_id = ${legacy.issueId} ORDER BY id`)).toEqual(legacyProducts);
  });
  it("allows ordinary task deletion only when no durable code associations need preservation", async () => {
    const nonCode = await fixture();
    await sql`DELETE FROM issues WHERE id = ${nonCode.issueId}`;
    expect(await sql`SELECT * FROM issue_code_delivery_intents WHERE issue_id = ${nonCode.issueId}`).toHaveLength(0);
    const code = await fixture();
    await product(code);
    await expect(sql`DELETE FROM issues WHERE id = ${code.issueId}`).rejects.toMatchObject({ code: "23503" });
    expect(await sql`SELECT * FROM issue_code_delivery_intents WHERE issue_id = ${code.issueId}`).toHaveLength(1);
  });
  it("initializes new tasks as unresolved rather than silently non-code", async () => {
    const f = await fixture();
    expect(await sql`SELECT intent, revision::int FROM issue_code_delivery_intents WHERE issue_id = ${f.issueId}`)
      .toMatchObject([{ intent: "ambiguous", revision: 1 }]);
  });
  it("keeps all code-link snapshots through deletion, conversion, and task project moves", async () => {
    const f = await fixture();
    const p = await product(f);
    const registered = await obligation(f);
    const before = await issue(f);
    await sql`UPDATE issue_work_products SET type = 'artifact', provider = 'local', url = NULL, metadata = '{}'::jsonb WHERE id = ${p.id}`;
    await sql`DELETE FROM issue_work_products WHERE id = ${p.id}`;
    await sql`UPDATE issues SET project_id = NULL, project_workspace_id = NULL WHERE id = ${f.issueId}`;
    expect(await sql`SELECT snapshot->>'type' AS type FROM code_delivery_discoveries WHERE issue_id = ${f.issueId}`)
      .toMatchObject([{ type: "pull_request" }]);
    expect(await sql`SELECT * FROM code_delivery_obligations WHERE id = ${registered.id}`).toEqual([registered]);
    expect((await issue(f)).code_delivery_revision).toBeGreaterThan(before.code_delivery_revision);
  });
  it("records both owners when a display product moves, without moving its obligation", async () => {
    const f = await fixture();
    const [destination] = await sql`INSERT INTO issues (company_id, title, status) VALUES (${f.companyId}, 'Destination', 'todo') RETURNING id`;
    const p = await product(f);
    const registered = await obligation(f);
    await sql`UPDATE issue_work_products SET issue_id = ${destination.id} WHERE id = ${p.id}`;
    expect(new Set((await sql`SELECT issue_id FROM code_delivery_discoveries WHERE source_work_product_id = ${p.id}`).map(r => r.issue_id)))
      .toEqual(new Set([f.issueId, destination.id]));
    expect(await sql`SELECT owner_issue_id FROM code_delivery_obligations WHERE id = ${registered.id}`).toEqual([{ owner_issue_id: f.issueId }]);
  });
  it("deduplicates canonical identities across owners and retains an initial ownership event", async () => {
    const f = await fixture();
    const first = await obligation(f);
    await expect(obligation(f)).rejects.toMatchObject({ code: "23505" });
    const [other] = await sql`INSERT INTO issues (company_id, title) VALUES (${f.companyId}, 'Second owner') RETURNING id`;
    await expect(obligation({ ...f, issueId: other.id })).rejects.toMatchObject({ code: "23505" });
    expect(await sql`SELECT to_issue_id, from_issue_id, obligation_revision::int FROM code_delivery_ownership_events WHERE obligation_id = ${first.id}`)
      .toEqual([{ to_issue_id: f.issueId, from_issue_id: null, obligation_revision: 1 }]);
    await obligation(f, { repository_id: "43", repository: "fixture/other" });
  });
  it.each(["owner_issue_id", "source_issue_id", "source_project_id", "source_workspace_id"])("rejects a cross-company %s", async field => {
    const f = await fixture(), other = await fixture();
    const values = { owner_issue_id: other.issueId, source_issue_id: other.issueId, source_project_id: other.projectId, source_workspace_id: other.workspaceId };
    await expect(obligation(f, { [field]: values[field as keyof typeof values] })).rejects.toBeDefined();
    expect(await sql`SELECT * FROM code_delivery_obligations WHERE owner_issue_id = ${f.issueId}`).toHaveLength(0);
  });
  it("rejects a workspace from a different project even in the same company", async () => {
    const f = await fixture();
    const [project] = await sql`INSERT INTO projects (company_id, name) VALUES (${f.companyId}, 'Other') RETURNING id`;
    const [workspace] = await sql`INSERT INTO project_workspaces (company_id, project_id, name) VALUES (${f.companyId}, ${project.id}, 'Other') RETURNING id`;
    await expect(obligation(f, { source_workspace_id: workspace.id })).rejects.toMatchObject({ code: "23503" });
  });
  it.each([
    { repository_id: "0" }, { repository_id: "0042" }, { repository_id: "-42" }, { repository_id: "4/2" },
    { repository: "Fixture/source" }, { repository: "fixture/.." }, { repository: "fixture/source/extra" },
    { pull_request_number: 0 }, { pull_request_number: -1 }, { base_ref: "" }, { base_ref: "main\nforged" },
    { proposed_head_sha: "bad" }, { proposed_head_sha: "A".repeat(40) }, { provider: "other" },
    { reviewed_head_sha: head }, { revision: 2 },
  ])("rejects malformed or pre-certified initial identity %j", async fields => {
    const f = await fixture();
    const before = await issue(f);
    await expect(obligation(f, fields)).rejects.toBeDefined();
    expect(await issue(f)).toEqual(before);
    expect(await sql`SELECT * FROM code_delivery_ownership_events WHERE to_issue_id = ${f.issueId}`).toHaveLength(0);
  });
  it.each(["done", "cancelled"])("refuses late PRs and obligations on a %s issue without partial evidence", async status => {
    const f = await fixture(status);
    const before = await issue(f);
    await expect(product(f)).rejects.toMatchObject({ code: "23514", message: "code_delivery_late_association_requires_open_owner" });
    await expect(obligation(f)).rejects.toMatchObject({ code: "23514", message: "code_delivery_requires_open_owner" });
    expect(await issue(f)).toEqual(before);
    expect(await sql`SELECT * FROM code_delivery_discoveries WHERE issue_id = ${f.issueId}`).toHaveLength(0);
  });
  it("retains existing terminal legacy associations when only their display status changes", async () => {
    const p = legacyProducts.find(p => p.type === "pull_request")!;
    await sql`UPDATE issue_work_products SET status = 'open' WHERE id = ${p.id as string}`;
    expect(await sql`SELECT snapshot FROM code_delivery_discoveries WHERE source_work_product_id = ${p.id as string}`).toHaveLength(2);
  });
  it("makes explicit code/non-code intent irreversible and refuses non-code PR attachment", async () => {
    const f = await fixture();
    await sql`UPDATE issue_code_delivery_intents SET intent = 'non_code', revision = revision + 1, provenance = '{"kind":"test_adjudication"}' WHERE issue_id = ${f.issueId}`;
    await expect(sql`UPDATE issue_code_delivery_intents SET intent = 'code', revision = revision + 1 WHERE issue_id = ${f.issueId}`).rejects.toMatchObject({ code: "23514" });
    await expect(product(f)).rejects.toMatchObject({ message: "code_delivery_non_code_intent_is_immutable" });
    await expect(obligation(f)).rejects.toMatchObject({ message: "code_delivery_non_code_intent_is_immutable" });
    await expect(sql`DELETE FROM issue_code_delivery_intents WHERE issue_id = ${f.issueId}`).rejects.toMatchObject({ code: "23514" });
  });
  it("cannot relabel discovered code as non-code after deleting its work product", async () => {
    const f = await fixture();
    const p = await product(f);
    await sql`DELETE FROM issue_work_products WHERE id = ${p.id}`;
    await expect(sql`UPDATE issue_code_delivery_intents SET intent = 'non_code', revision = revision + 1 WHERE issue_id = ${f.issueId}`)
      .rejects.toMatchObject({ message: "code_delivery_associations_require_reconciliation" });
  });
  it.each(["code_delivery_discoveries", "code_delivery_ownership_events"])("protects append-only %s", async table => {
    const f = await fixture();
    await product(f);
    await obligation(f);
    const field = table === "code_delivery_discoveries" ? "snapshot" : "provenance";
    await expect(sql`UPDATE ${sql(table)} SET ${sql({ [field]: sql.json({ forged: true }) })} WHERE company_id = ${f.companyId}`)
      .rejects.toMatchObject({ code: "23514", message: "code_delivery_history_is_immutable" });
    await expect(sql`DELETE FROM ${sql(table)} WHERE company_id = ${f.companyId}`).rejects.toMatchObject({ code: "23514" });
  });
  it.each(["repository_id", "repository", "owner_issue_id", "provenance"])("preserves immutable obligation %s", async field => {
    const f = await fixture();
    const registered = await obligation(f);
    const values: Record<string, unknown> = { repository_id: "43", repository: "fixture/other", owner_issue_id: randomUUID(), provenance: sql.json({ forged: true }) };
    await expect(sql`UPDATE code_delivery_obligations SET ${sql({ [field]: values[field], revision: 2 })} WHERE id = ${registered.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`DELETE FROM code_delivery_obligations WHERE id = ${registered.id}`).rejects.toMatchObject({ code: "23514" });
  });
  it("advances task revisions across policy A-to-B-to-A changes and rejects stale obligation versions", async () => {
    const f = await fixture();
    const registered = await obligation(f);
    const before = await issue(f);
    await sql`UPDATE issues SET execution_policy = '{"mode":"normal"}'::jsonb WHERE id = ${f.issueId}`;
    await sql`UPDATE issues SET execution_policy = NULL WHERE id = ${f.issueId}`;
    expect((await issue(f)).code_delivery_revision).toBe(before.code_delivery_revision + 2);
    await expect(sql`UPDATE code_delivery_obligations SET proposed_head_sha = ${"b".repeat(40)} WHERE id = ${registered.id}`).rejects.toMatchObject({ code: "23514" });
    await sql`UPDATE code_delivery_obligations SET proposed_head_sha = ${"b".repeat(40)}, reviewed_head_sha = NULL, revision = revision + 1 WHERE id = ${registered.id}`;
    expect((await issue(f)).code_delivery_revision).toBe(before.code_delivery_revision + 3);
  });
  it("serializes late association with a concurrent terminal write", async () => {
    const f = await fixture();
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const ready = new Promise<void>(resolve => { release = resolve; });
    const closing = sql.begin(async tx => {
      await tx`SET LOCAL statement_timeout = '5s'`;
      await tx`SELECT id FROM issues WHERE id = ${f.issueId} FOR UPDATE`;
      locked();
      await ready;
      await tx`UPDATE issues SET status = 'done' WHERE id = ${f.issueId}`;
    });
    await acquired;
    const late = product(f);
    const result = expect(late).rejects.toMatchObject({ message: "code_delivery_late_association_requires_open_owner" });
    release();
    await closing;
    await result;
    expect(await sql`SELECT * FROM code_delivery_discoveries WHERE issue_id = ${f.issueId}`).toHaveLength(0);
  });
});
