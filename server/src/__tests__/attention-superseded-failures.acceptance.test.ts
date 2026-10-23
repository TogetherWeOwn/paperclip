import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Db } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attentionService } from "../services/attention.js";

const state = vi.hoisted(() => ({
  exhausted: [] as Array<Record<string, unknown>>,
  retention: new Map<string, { keep: boolean; archivedAt: Date | null; version: number }>(),
}));

// Only unrelated services and the existing exhaustion-receipt reader are
// replaced. The supersession query, key comparison and feed visibility run in
// attentionService itself, through the real Drizzle PostgreSQL query builder.
vi.mock("../services/attention-exhausted-runs.js", () => ({
  listAttentionExhaustedRuns: async () => state.exhausted,
}));
vi.mock("../services/issues.js", () => ({
  BLOCKER_ATTENTION_MAX_DEPTH: 20,
  BLOCKER_ATTENTION_MAX_NODES: 100,
  issueService: () => ({ list: async () => [], listReviewAttention: async () => new Map() }),
}));
vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({ overview: async () => ({ activeIncidents: [] }) }),
}));
vi.mock("../services/decision-queues.js", () => ({
  decisionQueueService: () => ({ materializeSeededQueues: async () => undefined }),
}));
vi.mock("../services/decision-retention.js", () => ({
  DEFAULT_DECISION_SHELF_DAYS: 30,
  decisionRetentionService: () => ({ syncItems: async () => state.retention }),
}));

const companyId = "company-a";
const agentId = "agent-a";
const failedAt = new Date("2026-07-09T12:00:00.000Z");
const newerAt = new Date("2026-07-09T12:01:00.000Z");
const olderAt = new Date("2026-07-09T11:59:00.000Z");

type Run = {
  id: string;
  companyId?: string;
  agentId?: string;
  createdAt?: Date;
  finishedAt?: Date;
  contextSnapshot: Record<string, unknown> | null;
  status?: string;
};

function exhausted(contextSnapshot: Run["contextSnapshot"], id = "failed-a", overrides: Partial<Run> = {}) {
  return {
    id, companyId, agentId, agentName: "Worker", status: "failed",
    error: "adapter failed", errorCode: "adapter_failed", contextSnapshot,
    createdAt: failedAt, updatedAt: failedAt, finishedAt: failedAt,
    exhaustionMessage: "Bounded retry exhausted after scheduled attempts",
    ...overrides,
  };
}

// SQLite is an in-process SQL fixture executor, not an application database.
// It executes the emitted SELECT unchanged (JSON ->>, COALESCE and EXISTS are
// shared here). This proves key semantics and returned-row bounds, NOT the
// PostgreSQL planner, indexes, production latency or release qualification.
function fixtureDb(runs: Run[]) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`create table heartbeat_runs (
    id text primary key, company_id text, agent_id text, created_at text,
    context_snapshot text, status text
  )`);
  const insert = sql.prepare("insert into heartbeat_runs values (?, ?, ?, ?, ?, ?)");
  for (const run of runs) {
    insert.run(run.id, run.companyId ?? companyId, run.agentId ?? agentId,
      (run.createdAt ?? newerAt).toISOString(), JSON.stringify(run.contextSnapshot), run.status ?? "succeeded");
  }
  const reads: Array<{ query: string; rowCount: number }> = [];
  const db = drizzle(async (query, params) => {
    if (query.includes('"heartbeat_runs"')) {
      const statement = sql.prepare(query);
      statement.setReturnArrays(true);
      // Bind by ordinal: SQLite named-parameter binding also accepts $1, $2...
      const bindings = Object.fromEntries(params.map((value, index) => [String(index + 1), value]));
      const rows = statement.all(bindings);
      reads.push({ query, rowCount: rows.length });
      return { rows };
    }
    if (query.includes('from "companies"')) return { rows: [["ACC"]] };
    return { rows: [] };
  });
  return { db: db as unknown as Db, reads, close: () => sql.close() };
}

let database: ReturnType<typeof fixtureDb> | undefined;

beforeEach(() => {
  state.exhausted = [];
  state.retention = new Map();
});
afterEach(() => database?.close());

async function feed(failed: ReturnType<typeof exhausted>[], newer: Run[] = [], options = {}) {
  state.exhausted = failed;
  database = fixtureDb([...failed, ...newer]);
  return attentionService(database.db, { now: () => newerAt.getTime() }).list(companyId, {
    includeDismissed: true, all: true, allowUnscopedAll: true, ...options,
  });
}

const keyCases: Array<{
  name: string;
  failed: Run["contextSnapshot"];
  newer: Run["contextSnapshot"];
  suppressed: boolean;
}> = [
  { name: "same issueId", failed: { issueId: "issue-a" }, newer: { issueId: "issue-a" }, suppressed: true },
  { name: "taskId fallback on failure", failed: { taskId: "issue-a" }, newer: { issueId: "issue-a" }, suppressed: true },
  { name: "taskId fallback on newer run", failed: { issueId: "issue-a" }, newer: { taskId: "issue-a" }, suppressed: true },
  { name: "both taskId", failed: { taskId: "issue-a" }, newer: { taskId: "issue-a" }, suppressed: true },
  { name: "null issueId falls back", failed: { issueId: null, taskId: "issue-a" }, newer: { taskId: "issue-a" }, suppressed: true },
  { name: "newer null issueId falls back", failed: { taskId: "issue-a" }, newer: { issueId: null, taskId: "issue-a" }, suppressed: true },
  { name: "issueId wins over taskId", failed: { issueId: "issue-a", taskId: "issue-b" }, newer: { issueId: "issue-b" }, suppressed: false },
  { name: "newer issueId wins over taskId", failed: { issueId: "issue-a" }, newer: { issueId: "issue-b", taskId: "issue-a" }, suppressed: false },
  { name: "different issues", failed: { issueId: "issue-a" }, newer: { issueId: "issue-b" }, suppressed: false },
  { name: "no-issue null contexts", failed: null, newer: null, suppressed: true },
  { name: "no-issue absent keys", failed: {}, newer: {}, suppressed: true },
  { name: "null and absent keys agree", failed: { issueId: null, taskId: null }, newer: {}, suppressed: true },
  { name: "empty issueId stays no-issue, not taskId", failed: { issueId: "", taskId: "issue-a" }, newer: {}, suppressed: true },
  { name: "empty newer issueId stays no-issue", failed: {}, newer: { issueId: "", taskId: "issue-a" }, suppressed: true },
  { name: "issue failure versus no-issue run", failed: { issueId: "issue-a" }, newer: {}, suppressed: false },
  { name: "no-issue failure versus issue run", failed: {}, newer: { issueId: "issue-a" }, suppressed: false },
];

describe("attention superseded-failure lookup acceptance", () => {
  it("skips run-history lookup when there are no exhausted candidates", async () => {
    const result = await feed([], [{ id: "unrelated", contextSnapshot: { issueId: "issue-a" } }]);
    expect(result.items).toEqual([]);
    expect(database!.reads).toEqual([]);
  });

  it.each(keyCases)("preserves stable keys: $name", async ({ failed, newer, suppressed }) => {
    const result = await feed([exhausted(failed)], [{ id: "newer-a", contextSnapshot: newer }]);
    expect(result.items.map((item) => item.subject.id)).toEqual(suppressed ? [] : ["failed-a"]);
    expect(result.countsBySourceKind.failed_run).toBe(suppressed ? 0 : 1);
  });

  it.each([
    { name: "another company", companyId: "company-b", suppressed: false },
    { name: "another agent", agentId: "agent-b", suppressed: false },
    { name: "equal timestamp", createdAt: failedAt, suppressed: false },
    { name: "older timestamp", createdAt: olderAt, suppressed: false },
    { name: "one millisecond newer", createdAt: new Date(failedAt.getTime() + 1), suppressed: true },
  ])("preserves scope and strict timestamp order: $name", async ({ suppressed, name: _name, ...overrides }) => {
    const result = await feed([exhausted({ issueId: "issue-a" })], [{
      id: "other", contextSnapshot: { issueId: "issue-a" }, ...overrides,
    }]);
    expect(result.items.map((item) => item.subject.id)).toEqual(suppressed ? [] : ["failed-a"]);
  });

  it.each(["queued", "running", "succeeded", "failed", "timed_out", "cancelled"])(
    "any newer %s run supersedes the old exhausted attempt",
    async (status) => {
      const result = await feed([exhausted({ issueId: "issue-a" })], [{
        id: "newer", contextSnapshot: { issueId: "issue-a" }, status,
      }]);
      expect(result.items).toEqual([]);
    },
  );

  it("keeps equal-time exhausted attempts and compares each candidate to its own timestamp", async () => {
    const result = await feed([
      exhausted({ issueId: "issue-a" }, "old"),
      exhausted({ taskId: "issue-a" }, "latest-a", { createdAt: newerAt }),
      exhausted({ issueId: "issue-a" }, "latest-b", { createdAt: newerAt }),
      exhausted({ issueId: "issue-b" }, "unrelated"),
    ]);
    expect(result.items.map((item) => item.subject.id).sort()).toEqual(["latest-a", "latest-b", "unrelated"]);
  });

  it("returns only matching failure identities, not all later history for their agents", async () => {
    const result = await feed([exhausted({ issueId: "issue-a" })], Array.from({ length: 256 }, (_, i) => ({
      id: `unrelated-${i}`, contextSnapshot: { issueId: `other-${i}`, prompt: "x".repeat(1000) },
    })));
    expect(result.items.map((item) => item.subject.id)).toEqual(["failed-a"]);
    expect(database!.reads.length).toBeGreaterThan(0);
    expect(database!.reads.reduce((count, read) => count + read.rowCount, 0),
      "supersession lookup must not transfer unrelated run history").toBeLessThanOrEqual(1);
    expect(database!.reads.some((read) => /\bexists\s*\(/i.test(read.query)),
      "perform the supersession existence check in the database").toBe(true);
  });

  it("retains required old and Keep failures; only already archived state hides a row", async () => {
    state.retention.set("failed_run:keep", { keep: true, archivedAt: null, version: 4 });
    state.retention.set("failed_run:archived", { keep: false, archivedAt: olderAt, version: 2 });
    const failures = [
      exhausted({ issueId: "issue-a" }, "required", { finishedAt: new Date("2026-01-01T00:00:00.000Z") }),
      exhausted({ issueId: "issue-b" }, "keep"),
      exhausted({ issueId: "issue-c" }, "archived"),
    ];
    const result = await feed(failures);
    expect(result.items.map((item) => item.subject.id).sort()).toEqual(["keep", "required"]);
    expect(result.items.find((item) => item.subject.id === "keep")).toMatchObject({ keep: true, retentionVersion: 4 });
    expect(result.items.find((item) => item.subject.id === "required")).toMatchObject({ shelf: true, archivedAt: null });
  });
});
