import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  contextUuid,
  enqueueChatRunMilestones,
  wakeCommentLinkMatch,
} from "../services/chat-run-publications.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

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
