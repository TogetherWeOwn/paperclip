import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";
import { createDb } from "./client.js";
import {
  agents, chatEndpoints, chatGitHubConfigurations,
  companies, issues, toolApplications, toolConnections,
} from "./schema/index.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("GitHub shadow arm forward migration", () => {
  it("upgrades pre-arm schema without changing legacy configuration, primary reviews, or labeled shadows", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-shadow-upgrade-");
    const admin = postgres(temporary.connectionString, { max: 1, onnotice: () => {} });
    // A second empty database in our disposable cluster: replay the actual
    // journal up to the previous migration, seed legacy rows, then upgrade.
    await admin.unsafe('CREATE DATABASE "shadow_legacy"');
    const url = new URL(temporary.connectionString);
    url.pathname = "/shadow_legacy";
    const legacy = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const db = createDb(url.toString());
    try {
      const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      const migrationTag = "0297_new_sunspot";
      const index = journal.entries.findIndex((entry) => entry.tag === migrationTag);
      expect(index).toBeGreaterThan(0);
      const apply = async (tag: string) => {
        const migration = await readFile(new URL(`./migrations/${tag}.sql`, import.meta.url), "utf8");
        await legacy.begin(async (tx) => {
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await tx.unsafe(statement);
          }
        });
      };
      for (const entry of journal.entries.slice(0, index)) await apply(entry.tag);
      expect((await legacy`select to_regclass('public.chat_github_review_arms') as relation`)[0].relation).toBeNull();

      const companyId = randomUUID();
      const agentId = randomUUID();
      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const endpointId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Legacy shadow", issuePrefix: "LEG" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Primary" });
      await db.insert(toolApplications).values({ id: applicationId, companyId, name: "GitHub", type: "chat" });
      await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, uid: randomUUID(), name: "GitHub", transport: "chat_sdk", connectionPurpose: "channel" });
      await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, provider: "github", publicId: randomUUID() });
      const policy = defaultGitHubReviewPolicy();
      await db.insert(chatGitHubConfigurations).values({
        companyId, endpointId, revision: 7, updatedByUserId: "legacy-owner",
        configuration: { version: 1, toolsEnabled: false, responsibleUserId: "legacy-owner", memberAccess: "all_linked", people: [], defaults: policy, repositories: {}, shadow: { enabled: true, label: "old-shadow" } },
      });
      const [issue] = await db.insert(issues).values({ companyId, title: "Pre-upgrade review" }).returning();
      for (const shadowLabel of [null, "old-shadow"]) {
        // Seed the historical schema explicitly: today's Drizzle INSERT also
        // names admission_delivery_id, which is only introduced by 0308.
        await legacy`insert into chat_github_reviews (company_id, endpoint_id, issue_id, repository_id,
          repository, pull_number, head_sha, delivery_id, configuration_revision, policy_snapshot, event, shadow_label)
          values (${companyId}::uuid, ${endpointId}::uuid, ${issue.id}::uuid, '1', 'example/repo', 1,
            ${"a".repeat(40)}, ${randomUUID()}, 7, ${JSON.stringify(policy)}::jsonb, '{}'::jsonb, ${shadowLabel})`;
      }
      const beforeConfig = await db.select().from(chatGitHubConfigurations);
      const beforeReviews = await legacy`select * from chat_github_reviews order by id`;
      const beforeEndpoint = await db.select().from(chatEndpoints);
      await apply(migrationTag);
      expect(await db.select().from(chatGitHubConfigurations)).toEqual(beforeConfig);
      expect(await legacy`select * from chat_github_reviews order by id`).toEqual(beforeReviews);
      expect(await db.select().from(chatEndpoints)).toEqual(beforeEndpoint);
      expect(await legacy`select * from chat_github_review_arms`).toHaveLength(0);
      expect((await legacy`select count(*)::int as count from pg_trigger where tgrelid = 'chat_github_review_arms'::regclass and tgname = 'chat_github_review_arm_immutable'`)[0].count).toBe(1);
    } finally {
      await db.$client.end();
      await legacy.end();
      await admin.end();
      await temporary.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
