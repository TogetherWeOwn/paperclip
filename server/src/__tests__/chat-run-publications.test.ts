import { randomUUID } from "node:crypto";
import {
  agents,
  chatConversations,
  chatEndpoints,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contextUuid,
  enqueueChatRunMilestones,
  wakeCommentLinkMatch,
} from "../services/chat-run-publications.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

// Postgres prints a uuid column cast to text as `(alias.col)::text` and a run
// context read as `(alias.context_snapshot ->> 'key'::text)`. The sweep's old
// `column::text = context ->> 'key'` form is exactly one next to the other
// around `=`, in either order.
const CONTEXT_READ = String.raw`(?:\w+\.)?context_snapshot\s*->>\s*'\w+'::text`;
const COLUMN_AS_TEXT = String.raw`\((?:\w+\.)?\w+\)::text`;
const TEXT_CAST_CONTEXT_COMPARES = [
  new RegExp(String.raw`${COLUMN_AS_TEXT}\)*\s*=\s*\(*${CONTEXT_READ}`),
  new RegExp(String.raw`${CONTEXT_READ}\)*\s*=\s*\(*${COLUMN_AS_TEXT}`),
  // Postgres hashes a correlated EXISTS into a subplan, so the cast moves
  // into the subplan's output. The raw issueId read compared with a subplan
  // column is how that shows up; the guarded form compares a CASE ... END.
  /context_snapshot\s*->>\s*'issueId'::text\)\s*=\s*\(hashed SubPlan \d+\)\.col\d+/,
];

function hasTextCastContextCompare(condition: string) {
  return TEXT_CAST_CONTEXT_COMPARES.some((pattern) => pattern.test(condition));
}

// context key -> the uuid column the sweep compares it with.
const GUARDED_CONTEXT_KEYS = {
  issueId: "issue_id",
  interactionId: "id",
  sourceRunId: "source_run_id",
  wakeCommentId: "comment_id",
  commentId: "comment_id",
} as const;

function hasGuardedUuidCompare(
  conditions: string[],
  column: string,
  contextKey: string,
) {
  const guarded = new RegExp(
    String.raw`\b${column}\s*=\s*CASE WHEN \(\([\w.]*context_snapshot ->> '${contextKey}'::text\) ~ `,
  );
  return conditions.some((condition) => guarded.test(condition));
}

function collectPlanConditions(node: unknown, conditions: string[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectPlanConditions(child, conditions);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && /(Filter|Cond)$/.test(key)) {
        conditions.push(value);
      } else {
        collectPlanConditions(value, conditions);
      }
    }
  }
  return conditions;
}

// The milestone sweep used to compare `uuid_column::text = context ->> 'x'`.
// These tests pin that the guarded uuid form returns the same truth value
// for every context shape, including malformed ids, so the sweep can use
// its indexes without changing which milestone rows it selects.
describeEmbeddedPostgres("chat run milestone context id matching", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-chat-run-publications-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function scalarPair(ctx: ReturnType<typeof sql>) {
    const target = "a1111111-b222-c333-d444-e55555555555";
    const result = (await db.execute(
      sql`select
        (${target}::uuid)::text = (${ctx}) as old_match,
        ${target}::uuid = ${contextUuid(sql`(${ctx})`)} as new_match`,
    )) as unknown as Array<{
      old_match: boolean | null;
      new_match: boolean | null;
    }>;
    return result[0]!;
  }

  it("matches the old ::text comparison for every context shape", async () => {
    const target = "a1111111-b222-c333-d444-e55555555555";
    const cases: Array<{ ctx: string | null; expected: boolean | null }> = [
      { ctx: target, expected: true },
      { ctx: "99999999-8888-7777-6666-555555555555", expected: false },
      // uuid::text is lowercase, so uppercase never matched before either.
      { ctx: target.toUpperCase(), expected: false },
      { ctx: `{${target}}`, expected: false },
      { ctx: target.replaceAll("-", ""), expected: false },
      { ctx: "not-a-uuid", expected: false },
      { ctx: "", expected: false },
      { ctx: ` ${target} `, expected: false },
      { ctx: null, expected: null },
    ];
    for (const { ctx, expected } of cases) {
      const row = await scalarPair(
        ctx === null ? sql`null::text` : sql`${ctx}::text`,
      );
      // All call sites are filter positions (join/where/exists), where the
      // guarded form's NULL and the text form's false both reject the row.
      expect(row.new_match ?? false, `ctx=${JSON.stringify(ctx)}`).toBe(
        row.old_match ?? false,
      );
      expect(row.new_match ?? false, `ctx=${JSON.stringify(ctx)}`).toBe(
        expected ?? false,
      );
    }
  });

  it("keeps wake-comment matching equivalent to the ? operator form", async () => {
    const commentId = randomUUID();
    const snapshots: Array<{
      snapshot: Record<string, unknown>;
      expected: boolean;
    }> = [
      { snapshot: { wakeCommentId: commentId }, expected: true },
      { snapshot: { commentId }, expected: true },
      { snapshot: { wakeCommentIds: [commentId] }, expected: true },
      {
        snapshot: { wakeCommentIds: ["not-a-uuid", commentId] },
        expected: true,
      },
      { snapshot: { wakeCommentIds: ["not-a-uuid"] }, expected: false },
      { snapshot: { wakeCommentIds: [] }, expected: false },
      { snapshot: { wakeCommentId: "not-a-uuid" }, expected: false },
      { snapshot: { wakeCommentId: commentId.toUpperCase() }, expected: false },
      { snapshot: {}, expected: false },
      // Non-array shapes keep the original `?` semantics via the fallback.
      { snapshot: { wakeCommentIds: { [commentId]: true } }, expected: true },
      { snapshot: { wakeCommentIds: { other: true } }, expected: false },
    ];
    for (const { snapshot, expected } of snapshots) {
      const snapshotSql = sql`${JSON.stringify(snapshot)}::jsonb`;
      const result = (await db.execute(
        sql`select
          (
            ${commentId}::uuid::text = (${snapshotSql} ->> 'wakeCommentId')
            or ${commentId}::uuid::text = (${snapshotSql} ->> 'commentId')
            or (${snapshotSql} -> 'wakeCommentIds') ? ${commentId}::uuid::text
          ) as old_match,
          ${wakeCommentLinkMatch(sql`${commentId}::uuid`, snapshotSql)} as new_match`,
      )) as unknown as Array<{
        old_match: boolean | null;
        new_match: boolean | null;
      }>;
      const label = `snapshot=${JSON.stringify(snapshot)}`;
      expect(result[0]!.new_match ?? false, label).toBe(
        result[0]!.old_match ?? false,
      );
      expect(result[0]!.new_match ?? false, label).toBe(expected);
    }
  });

  // `EXPLAIN` runs on the exact statements the sweep sends, so a call site
  // that goes back to `column::text = context ->> 'x'` fails here even though
  // every behavior test above would still pass.
  it("keeps the sweep's uuid filters free of text casts on indexed columns", async () => {
    // drizzle reads the logger when it builds each query; the test db is
    // not created with one, so swap it in for the length of one sweep.
    const session = db.session as unknown as {
      logger: { logQuery(query: string, params: unknown[]): void };
      client: {
        unsafe(
          query: string,
          params: unknown[],
        ): Promise<Array<Record<string, unknown>>>;
      };
    };
    const originalLogger = session.logger;
    const sweepQueries: Array<{ query: string; params: unknown[] }> = [];
    session.logger = {
      logQuery: (query, params) => {
        sweepQueries.push({ query, params });
      },
    };
    try {
      await enqueueChatRunMilestones(db);
    } finally {
      session.logger = originalLogger;
    }
    // Milestone candidates and safe native progress candidates.
    expect(sweepQueries.length).toBeGreaterThanOrEqual(2);

    const conditions: string[] = [];
    for (const { query, params } of sweepQueries) {
      const rows = await session.client.unsafe(
        `explain (format json) ${query}`,
        params,
      );
      collectPlanConditions(rows[0]?.["QUERY PLAN"], conditions);
    }
    expect(conditions.length).toBeGreaterThan(0);

    expect(conditions.filter(hasTextCastContextCompare)).toEqual([]);
    for (const [contextKey, column] of Object.entries(GUARDED_CONTEXT_KEYS)) {
      expect(
        hasGuardedUuidCompare(conditions, column, contextKey),
        `${column} = guarded uuid of context ${contextKey}`,
      ).toBe(true);
    }
  });

  it("flags the pre-fix text-cast comparison shapes", () => {
    const preFix = [
      "((heartbeat_runs.context_snapshot ->> 'issueId'::text) = (chat_conversations.issue_id)::text)",
      "((question_delivery.issue_id)::text = (heartbeat_runs.context_snapshot ->> 'issueId'::text))",
      "((interaction.id)::text = (heartbeat_runs.context_snapshot ->> 'interactionId'::text))",
      "((comment_id)::text = (context_snapshot ->> 'wakeCommentId'::text))",
      "((context_snapshot ->> 'issueId'::text) = (hashed SubPlan 2).col2)",
    ];
    for (const condition of preFix) {
      expect(hasTextCastContextCompare(condition), condition).toBe(true);
    }
    const guarded = [
      "(id = CASE WHEN ((heartbeat_runs.context_snapshot ->> 'interactionId'::text) ~ '^x$'::text) THEN ((heartbeat_runs.context_snapshot ->> 'interactionId'::text))::uuid ELSE NULL::uuid END)",
      // Text compares between two text values are not index blockers.
      "((question_prompt.payload ->> 'interactionId'::text) = (interaction_id)::text)",
      "((heartbeat_runs.context_snapshot -> 'wakeCommentIds'::text) ? (comment_id)::text)",
      "(CASE WHEN ((context_snapshot ->> 'issueId'::text) ~ '^x$'::text) THEN ((context_snapshot ->> 'issueId'::text))::uuid ELSE NULL::uuid END = (hashed SubPlan 2).col2)",
    ];
    for (const condition of guarded) {
      expect(hasTextCastContextCompare(condition), condition).toBe(false);
    }
  });

  it("does not throw on malformed context ids during the milestone sweep", async () => {
    const company = await db
      .insert(companies)
      .values({
        name: `Malformed ${randomUUID()}`,
        issuePrefix: `MF${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Sweep Agent" })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Sweep issue" })
      .returning()
      .then((rows) => rows[0]!);
    const application = await db
      .insert(toolApplications)
      .values({
        companyId: company.id,
        name: `Chat ${randomUUID()}`,
        type: "mcp",
      })
      .returning()
      .then((rows) => rows[0]!);
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId: company.id,
        applicationId: application.id,
        name: "Chat connection",
        uid: `chat-${randomUUID()}`,
        transport: "chat_sdk",
        connectionPurpose: "channel",
      })
      .returning()
      .then((rows) => rows[0]!);
    const endpoint = await db
      .insert(chatEndpoints)
      .values({
        companyId: company.id,
        connectionId: connection.id,
        provider: "slack",
        publicId: `slack-${randomUUID()}`,
        assignedAgentId: agent.id,
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(chatConversations).values({
      companyId: company.id,
      endpointId: endpoint.id,
      issueId: issue.id,
      externalConversationId: `conv-${randomUUID()}`,
      externalLabel: "Sweep conversation",
    });
    // Valid issue binding (forces the interaction/wake predicates to be
    // evaluated for this candidate) with malformed continuation ids.
    await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "failed",
      contextSnapshot: {
        issueId: issue.id,
        source: "issue.interaction.accept",
        interactionId: "not-a-uuid",
        sourceRunId: "also-not-a-uuid",
        wakeCommentId: "not-a-uuid",
        wakeCommentIds: ["not-a-uuid"],
      },
    });
    // Malformed issue binding must simply not join any conversation.
    await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "failed",
      contextSnapshot: {
        issueId: "not-a-uuid",
        source: "chat:slack",
        wakeCommentId: "not-a-uuid",
      },
    });
    await expect(enqueueChatRunMilestones(db)).resolves.toBe(0);
  });
});
