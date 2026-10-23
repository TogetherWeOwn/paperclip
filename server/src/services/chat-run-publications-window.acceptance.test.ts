import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  chatConversations,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { enqueueChatRunMilestones } from "./chat-run-publications.js";

// Checkout-only runner: install @electric-sql/pglite@0.3.14 outside this
// checkout, and set PAPERCLIP_ACCEPTANCE_RUNTIME to that package directory.
// This is in-memory PostgreSQL, not an application DB, server or migration.
const runtimeRequire = createRequire(
  process.env.PAPERCLIP_ACCEPTANCE_RUNTIME
    ? path.join(process.env.PAPERCLIP_ACCEPTANCE_RUNTIME, "package.json")
    : import.meta.url,
);
type MemoryPostgres = {
  exec(query: string): Promise<unknown>;
  query(
    query: string,
    params?: unknown[],
    options?: { rowMode: "array" },
  ): Promise<{ rows: unknown[][] }>;
  close(): Promise<void>;
};
const { PGlite } = runtimeRequire("@electric-sql/pglite") as {
  PGlite: new () => MemoryPostgres;
};
const tables = [
  agents,
  agentWakeupRequests,
  chatConversations,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
];
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const company = id(1);
const otherCompany = id(2);
const agent = id(3);
const issue = id(4);
const now = new Date("2026-10-20T12:00:00.000Z");
const since = new Date("2026-10-20T11:00:00.000Z");
const until = new Date("2026-10-20T11:30:00.000Z");
let engine: InstanceType<typeof PGlite>;
let db: Db;
let nextIdentity: number;
let beforeQuery: ((query: string) => Promise<void>) | undefined;

// The upper bound is a requested additive contract. Casting keeps pristine
// stable executable: ignoring `until` must fail an output assertion, not import
// or type collection. The lower bound is inclusive; the upper bound inclusive
// as well, with overlap and publication uniqueness making boundary replay safe.
function sweep(options: { since?: Date; until?: Date; limit?: number } = {}) {
  return enqueueChatRunMilestones(db, {
    since,
    until,
    ...options,
  } as Parameters<typeof enqueueChatRunMilestones>[1]);
}

async function fixture(
  updatedAt = since,
  status = "running",
  runId = id(nextIdentity++),
) {
  const endpointId = id(nextIdentity++);
  const conversationId = id(nextIdentity++);
  const commentId = id(nextIdentity++);
  await db.insert(chatEndpoints).values({
    id: endpointId,
    companyId: company,
    assignedAgentId: agent,
    publicationMode: "automatic",
    provider: "slack",
  } as typeof chatEndpoints.$inferInsert);
  await db.insert(chatConversations).values({
    id: conversationId,
    companyId: company,
    endpointId,
    issueId: issue,
    state: "active",
  } as typeof chatConversations.$inferInsert);
  await db.insert(chatMessageLinks).values({
    companyId: company,
    endpointId,
    conversationId,
    commentId,
    direction: "inbound",
  } as typeof chatMessageLinks.$inferInsert);
  const [existing] = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId));
  const wakeCommentIds = [
    ...((existing?.contextSnapshot?.wakeCommentIds as string[] | undefined) ??
      []),
    commentId,
  ];
  const contextSnapshot = {
    source: "chat:slack",
    issueId: issue,
    wakeCommentIds,
  };
  if (existing) {
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot })
      .where(eq(heartbeatRuns.id, runId));
  } else {
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company,
      agentId: agent,
      status,
      updatedAt,
      runtimeMode: "legacy",
      contextSnapshot,
      resultJson: status === "succeeded" ? { presentationDecision: {} } : null,
    } as typeof heartbeatRuns.$inferInsert);
  }
  return { runId, endpointId, conversationId, commentId };
}

async function publications() {
  return db
    .select({
      companyId: chatPublications.companyId,
      conversationId: chatPublications.conversationId,
      key: chatPublications.idempotencyKey,
      payload: chatPublications.payload,
    })
    .from(chatPublications)
    .orderBy(chatPublications.idempotencyKey);
}

beforeAll(async () => {
  engine = new PGlite();
  // Use the official table declarations only for column types. No constraints,
  // application data, migration files or instance configuration are loaded.
  for (const table of tables) {
    const { name, columns } = getTableConfig(table);
    const fields = columns.map((column) => {
      const type = column.getSQLType();
      const fallback =
        column.name === "id" && type === "uuid"
          ? " default gen_random_uuid()"
          : type.startsWith("timestamp")
            ? " default now()"
            : "";
      return `"${column.name}" ${type}${fallback}`;
    });
    await engine.exec(`create table "${name}" (${fields.join(", ")})`);
  }
  await engine.exec(
    "create unique index publication_identity on chat_publications(company_id, idempotency_key)",
  );
  const realQuery = engine.query.bind(engine);
  engine.query = async (query, params, options) => {
    await beforeQuery?.(query);
    return realQuery(query, params, options);
  };
  db = drizzle(async (query, params) => {
    const result = await engine.query(query, params, { rowMode: "array" });
    return {
      rows: result.rows.map((row: unknown[]) =>
        row.map((value) =>
          value instanceof Date ? value.toISOString() : value,
        ),
      ),
    };
  }) as unknown as Db;
}, 30_000);

afterAll(async () => {
  await engine?.close();
});
beforeEach(async () => {
  beforeQuery = undefined;
  nextIdentity = 100;
  await engine.exec(
    `truncate ${tables.map((table) => `"${getTableConfig(table).name}"`).join(", ")}`,
  );
  await db
    .insert(agents)
    .values({
      id: agent,
      companyId: company,
      name: "Assistant",
    } as typeof agents.$inferInsert);
});

describe("bounded chat milestone window acceptance", () => {
  it("includes exact edges and leaves later work for the next window", async () => {
    const before = await fixture(new Date(since.getTime() - 1));
    const lower = await fixture(since);
    const upper = await fixture(until);
    const after = await fixture(new Date(until.getTime() + 1));
    await sweep();
    expect(
      (await publications()).map((row) => row.conversationId).sort(),
    ).toEqual([lower.conversationId, upper.conversationId].sort());
    await sweep({ since: until, until: now });
    expect(
      (await publications()).map((row) => row.conversationId).sort(),
    ).toEqual(
      [lower.conversationId, upper.conversationId, after.conversationId].sort(),
    );
    expect(
      (await publications()).some(
        (row) => row.conversationId === before.conversationId,
      ),
    ).toBe(false);
  });

  it("does not round a submillisecond timestamp beyond the upper edge into the window", async () => {
    const edge = await fixture(until);
    const later = await fixture(until);
    await db.execute(
      sql`update heartbeat_runs set updated_at = '2026-10-20 11:30:00.000001+00'::timestamptz where id = ${later.runId}`,
    );
    await sweep();
    expect((await publications()).map((row) => row.conversationId)).toEqual([
      edge.conversationId,
    ]);
  });

  it("drains more than a page of timestamp/run/conversation ties without duplicates", async () => {
    const runIds = [id(80), id(81)];
    const expected: string[] = [];
    for (let i = 0; i < 31; i++) {
      expected.push(
        (await fixture(since, "running", runIds[i % 2])).conversationId,
      );
    }
    expect(await sweep({ limit: 30 })).toBe(30);
    expect(await sweep({ limit: 30 })).toBe(1);
    expect(await sweep({ limit: 30 })).toBe(0);
    expect(
      (await publications()).map((row) => row.conversationId).sort(),
    ).toEqual(expected.sort());
  });

  it("pages beyond skipped origin candidates instead of treating an empty publication count as exhaustion", async () => {
    for (let i = 0; i < 27; i++) {
      const row = await fixture(since);
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            source: "chat:slack",
            issueId: issue,
            wakeCommentIds: [row.commentId],
            endpointId: id(99),
          },
        })
        .where(eq(heartbeatRuns.id, row.runId));
    }
    const eligible = await fixture(new Date(since.getTime() + 1));
    expect(await sweep({ limit: 1 })).toBe(1);
    expect((await publications()).map((row) => row.conversationId)).toEqual([
      eligible.conversationId,
    ]);
  });

  it("replays overlapping windows and a fresh invocation with exactly one publication per milestone", async () => {
    const row = await fixture();
    expect(await sweep()).toBe(1);
    expect(await sweep({ since: new Date(since.getTime() - 60_000) })).toBe(0);
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", updatedAt: until })
      .where(eq(heartbeatRuns.id, row.runId));
    expect(await sweep()).toBe(1);
    expect(await enqueueChatRunMilestones(db, { since })).toBe(0);
    expect((await publications()).map((entry) => entry.key)).toEqual([
      `run:${row.runId}:failed:${row.endpointId}`,
      `run:${row.runId}:working:${row.endpointId}`,
    ]);
  });

  it("retains unprocessed tied work after reaching the insertion cap", async () => {
    const expected: string[] = [];
    for (let i = 0; i < 29; i++)
      expected.push((await fixture()).conversationId);
    for (let i = 0; i < 10; i++) await sweep({ limit: 3 });
    expect(
      (await publications()).map((row) => row.conversationId).sort(),
    ).toEqual(expected.sort());
  });

  it("recovers the uncommitted publication after a mid-sweep failure", async () => {
    const expected = [
      (await fixture()).conversationId,
      (await fixture()).conversationId,
    ];
    let inserts = 0;
    beforeQuery = async (query) => {
      if (
        query.startsWith('insert into "chat_publications"') &&
        ++inserts === 2
      ) {
        throw new Error("synthetic publication write failure");
      }
    };
    await expect(sweep()).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "synthetic publication write failure",
      }),
    });
    beforeQuery = undefined;
    expect(await sweep()).toBe(1);
    expect(
      (await publications()).map((row) => row.conversationId).sort(),
    ).toEqual(expected.sort());
  });

  it("leaves a run updated beyond the frozen upper bound for a later sweep", async () => {
    const first = await fixture();
    const changed = await fixture(new Date(since.getTime() + 1));
    let moved = false;
    beforeQuery = async (query) => {
      if (!moved && query.startsWith('insert into "chat_publications"')) {
        moved = true;
        await db
          .update(heartbeatRuns)
          .set({ status: "failed", updatedAt: now })
          .where(eq(heartbeatRuns.id, changed.runId));
      }
    };
    await sweep({ limit: 1 });
    await sweep({ limit: 1 });
    expect((await publications()).map((row) => row.conversationId)).toEqual([
      first.conversationId,
    ]);
    beforeQuery = undefined;
    await sweep({ since: until, until: now });
    expect((await publications()).map((row) => row.key).sort()).toEqual(
      [
        `run:${first.runId}:working:${first.endpointId}`,
        `run:${changed.runId}:failed:${changed.endpointId}`,
      ].sort(),
    );
  });

  it("recovers an update behind an advanced page cursor through overlap replay", async () => {
    const old = await fixture(new Date(since.getTime() - 1));
    for (let i = 0; i < 25; i++) await fixture(since);
    let writes = 0;
    beforeQuery = async (query) => {
      if (
        query.startsWith('insert into "chat_publications"') &&
        ++writes === 25
      ) {
        await db
          .update(heartbeatRuns)
          .set({ updatedAt: since })
          .where(eq(heartbeatRuns.id, old.runId));
      }
    };
    await sweep({ limit: 26 });
    beforeQuery = undefined;
    await sweep();
    expect(
      (await publications()).filter(
        (row) => row.conversationId === old.conversationId,
      ),
    ).toHaveLength(1);
    expect(await publications()).toHaveLength(26);
  });

  it("advances past a page of skipped candidates with PostgreSQL submillisecond timestamps", async () => {
    for (let i = 0; i < 26; i++) {
      const row = await fixture();
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            source: "chat:slack",
            issueId: issue,
            wakeCommentIds: [row.commentId],
            endpointId: id(99),
          },
        })
        .where(eq(heartbeatRuns.id, row.runId));
      await db.execute(
        sql`update heartbeat_runs set updated_at = '2026-10-20 11:00:00.000500+00'::timestamptz where id = ${row.runId}`,
      );
    }
    const eligible = await fixture(new Date(since.getTime() + 1));
    let pages = 0;
    beforeQuery = async (query) => {
      if (
        query.includes('"heartbeat_runs"."updated_at"') &&
        query.includes("order by") &&
        ++pages > 4
      ) {
        throw new Error(
          "milestone candidate scan repeated an already exhausted page",
        );
      }
    };
    // A finite statement budget makes cursor livelock an assertion failure,
    // rather than a test timeout or an unbounded sweep on a shared worker.
    const outcome = await sweep({ limit: 1 }).catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message ===
          "milestone candidate scan repeated an already exhausted page"
      ) {
        return error.cause.message;
      }
      throw error;
    });
    expect(outcome).toBe(1);
    beforeQuery = undefined;
    expect((await publications()).map((row) => row.conversationId)).toEqual([
      eligible.conversationId,
    ]);
  });

  it("recovers the latest milestone when a selected row changes before its insertion", async () => {
    await fixture();
    const changed = await fixture(new Date(since.getTime() + 1));
    let moved = false;
    beforeQuery = async (query) => {
      if (!moved && query.startsWith('insert into "chat_publications"')) {
        moved = true;
        await db
          .update(heartbeatRuns)
          .set({ status: "failed", updatedAt: until })
          .where(eq(heartbeatRuns.id, changed.runId));
      }
    };
    await sweep();
    beforeQuery = undefined;
    await sweep();
    expect(
      (await publications()).filter(
        (row) =>
          row.key === `run:${changed.runId}:failed:${changed.endpointId}`,
      ),
    ).toHaveLength(1);
    expect(await sweep()).toBe(0);
  });

  it("can recover a late-visible row older than an ordinary overlap on cold replay", async () => {
    await sweep();
    const late = await fixture(new Date("2026-10-18T00:00:00.000Z"));
    await sweep();
    expect(await publications()).toHaveLength(0);
    // A finite overlap alone cannot recover arbitrary commit delay. Cold
    // recovery must retain an explicit full replay path, not invent a timestamp.
    expect(await sweep({ since: new Date(0) })).toBe(1);
    expect((await publications()).map((row) => row.conversationId)).toEqual([
      late.conversationId,
    ]);
  });

  it("keeps concurrent sweep retries idempotent", async () => {
    await fixture();
    await Promise.all([sweep(), sweep()]);
    expect(await publications()).toHaveLength(1);
  });

  it("does not publish or suppress using another company's endpoint, origin link or publication", async () => {
    const valid = await fixture();
    const badEndpoint = await fixture();
    const badOrigin = await fixture();
    await db
      .update(chatEndpoints)
      .set({ companyId: otherCompany })
      .where(eq(chatEndpoints.id, badEndpoint.endpointId));
    await db
      .update(chatMessageLinks)
      .set({ companyId: otherCompany })
      .where(eq(chatMessageLinks.conversationId, badOrigin.conversationId));
    await db.insert(chatPublications).values({
      companyId: otherCompany,
      endpointId: valid.endpointId,
      conversationId: valid.conversationId,
      issueId: issue,
      idempotencyKey: `run:${valid.runId}:working:${valid.endpointId}`,
      state: "pending",
      payload: {},
    });
    expect(await sweep()).toBe(1);
    expect(
      (await publications())
        .filter((row) => row.companyId === company)
        .map((row) => row.conversationId),
    ).toEqual([valid.conversationId]);
  });

  it("preserves final-presentation and owned-question suppression inside the window", async () => {
    const undecided = await fixture(since, "succeeded");
    await db
      .update(heartbeatRuns)
      .set({ resultJson: null })
      .where(eq(heartbeatRuns.id, undecided.runId));
    const final = await fixture(since, "succeeded");
    const finalCommentId = id(nextIdentity++);
    await db.insert(issueComments).values({
      id: finalCommentId,
      companyId: company,
      issueId: issue,
      authorType: "agent",
      authorAgentId: agent,
      createdByRunId: final.runId,
      body: "Selected final",
      metadata: { authorizationReason: "paperclip_runner_protocol" },
    } as typeof issueComments.$inferInsert);
    await db.insert(chatPublications).values({
      companyId: company,
      endpointId: final.endpointId,
      conversationId: final.conversationId,
      issueId: issue,
      commentId: finalCommentId,
      idempotencyKey: "selected-final",
      state: "pending",
      payload: {},
    });
    const question = await fixture(since, "failed");
    await db.insert(issueThreadInteractions).values({
      id: id(nextIdentity++),
      companyId: company,
      issueId: issue,
      sourceRunId: question.runId,
      createdByAgentId: agent,
      kind: "ask_user_questions",
      status: "pending",
    } as typeof issueThreadInteractions.$inferInsert);
    expect(await sweep()).toBe(0);
    expect((await publications()).map((row) => row.key)).toEqual([
      "selected-final",
    ]);
  });
});
