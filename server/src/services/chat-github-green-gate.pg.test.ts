import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  chatDeliveries,
  chatEndpoints,
  chatGitHubReviews,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issues,
  startEmbeddedPostgresTestDatabase,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  GITHUB_GREEN_REVIEW_MAX_ATTEMPTS,
  githubGreenReviewAttempt,
  supersedeQueuedGitHubReviews,
} from "./chat-github-green-gate.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const REPO = "97531";
const PR = 42;
let serial = 0;
const nextId = () => String(5_000_000 + Date.now() % 1_000_000 * 100 + ++serial);

suite("GitHub green-gate persistence (real PostgreSQL, no network)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase(
        "paperclip-github-green-gate-",
      );
      db = createDb(temporary.connectionString);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const endpointId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const application = randomUUID();
    const connection = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Green gate fixture",
      issuePrefix: `G${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reviewer",
      adapterType: "codex_local",
    });
    await db
      .insert(toolApplications)
      .values({ id: application, companyId, name: "GitHub", type: "chat" });
    await db.insert(toolConnections).values({
      id: connection,
      companyId,
      applicationId: application,
      uid: randomUUID(),
      name: "GitHub",
      transport: "chat_sdk",
      connectionPurpose: "channel",
      enabled: true,
      status: "active",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId: connection,
      provider: "github",
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      providerAccountId: nextId(),
      botExternalId: nextId(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review card",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const review = async (
      headSha: string,
      state: NonNullable<(typeof chatGitHubReviews.$inferInsert)["state"]>,
      extra: { assessed?: boolean; deliveryId?: string } = {},
    ) => {
      const [row] = await db
        .insert(chatGitHubReviews)
        .values({
          companyId,
          endpointId,
          issueId,
          repositoryId: REPO,
          repository: "acme/app",
          pullNumber: PR,
          headSha,
          deliveryId: extra.deliveryId ?? randomUUID(),
          configurationRevision: 1,
          policySnapshot: {} as never,
          event: {} as never,
          state,
          ...(extra.assessed ? { assessment: { score: 5 } as never } : {}),
        })
        .returning();
      return row!;
    };
    const stateOf = async (id: string) =>
      (
        await db
          .select({ state: chatGitHubReviews.state })
          .from(chatGitHubReviews)
          .where(eq(chatGitHubReviews.id, id))
      )[0]!.state;
    /** Production shape: the review row stores the chat_deliveries row id. */
    const delivery = async (
      deliveryId: string,
      state: NonNullable<(typeof chatDeliveries.$inferInsert)["state"]> = "processed",
    ) => {
      const [row] = await db
        .insert(chatDeliveries)
        .values({
          companyId,
          endpointId,
          providerEventId: `github:x:pr-event:${deliveryId}`,
          deduplicationKey: `pr-event:${deliveryId}`,
          eventKind: "mention",
          normalizedEvent: { githubAutomatic: { context: { deliveryId } } },
          state,
        })
        .returning({ id: chatDeliveries.id });
      return row!.id;
    };
    return { companyId, endpointId, review, stateOf, delivery };
  }

  it("supersedes only never-started queued rows of older heads on synchronize", async () => {
    const f = await fixture();
    const stale = await f.review(OLD, "queued");
    const current = await f.review(NEW, "queued");
    const assessed = await f.review(OLD, "queued", { assessed: true });
    const running = await f.review(OLD, "running");
    const done = await f.review(OLD, "completed", { assessed: true });
    const changed = await supersedeQueuedGitHubReviews(db, {
      companyId: f.companyId,
      endpointId: f.endpointId,
      repositoryId: REPO,
      pullNumber: PR,
      currentHeadSha: NEW,
    });
    expect(changed).toBe(1);
    expect(await f.stateOf(stale.id)).toBe("superseded");
    expect(await f.stateOf(current.id)).toBe("queued");
    expect(await f.stateOf(assessed.id)).toBe("queued");
    expect(await f.stateOf(running.id)).toBe("running");
    expect(await f.stateOf(done.id)).toBe("completed");
  });

  it("supersedes every never-started queued row when the pull request closes", async () => {
    const f = await fixture();
    const a = await f.review(OLD, "queued");
    const b = await f.review(NEW, "queued");
    const other = await f.review(NEW, "completed", { assessed: true });
    expect(
      await supersedeQueuedGitHubReviews(db, {
        companyId: f.companyId,
        endpointId: f.endpointId,
        repositoryId: REPO,
        pullNumber: PR,
        currentHeadSha: null,
      }),
    ).toBe(2);
    expect(await f.stateOf(a.id)).toBe("superseded");
    expect(await f.stateOf(b.id)).toBe("superseded");
    expect(await f.stateOf(other.id)).toBe("completed");
  });

  it.each(["error", "incomplete", "superseded"] as const)(
    "retries a head whose review ended %s under a fresh delivery id, then stops",
    async (failedState) => {
      const f = await fixture();
      const scope = {
        companyId: f.companyId,
        endpointId: f.endpointId,
        repositoryId: REPO,
        pullNumber: PR,
        headSha: NEW,
      };
      const base = `checks-green:${REPO}:${PR}:${NEW}`;
      expect(await githubGreenReviewAttempt(db, scope)).toEqual({
        kind: "ready",
        deliveryId: base,
        attempt: 1,
      });
      await f.review(NEW, failedState, { deliveryId: await f.delivery(base) });
      expect(await githubGreenReviewAttempt(db, scope)).toEqual({
        kind: "ready",
        deliveryId: `${base}:attempt-2`,
        attempt: 2,
      });
      await f.review(NEW, failedState, {
        deliveryId: await f.delivery(`${base}:attempt-2`),
      });
      expect(await githubGreenReviewAttempt(db, scope)).toEqual({
        kind: "ready",
        deliveryId: `${base}:attempt-3`,
        attempt: 3,
      });
      await f.review(NEW, failedState, {
        deliveryId: await f.delivery(`${base}:attempt-3`),
      });
      expect(GITHUB_GREEN_REVIEW_MAX_ATTEMPTS).toBe(3);
      expect(await githubGreenReviewAttempt(db, scope)).toEqual({
        kind: "retries_exhausted",
      });
    },
  );

  it("spends an attempt whose delivery failed before writing a review row", async () => {
    const f = await fixture();
    const scope = {
      companyId: f.companyId,
      endpointId: f.endpointId,
      repositoryId: REPO,
      pullNumber: PR,
      headSha: NEW,
    };
    const base = `checks-green:${REPO}:${PR}:${NEW}`;
    await f.delivery(base, "failed");
    expect(await githubGreenReviewAttempt(db, scope)).toEqual({
      kind: "ready",
      deliveryId: `${base}:attempt-2`,
      attempt: 2,
    });
    await f.delivery(`${base}:attempt-2`, "received");
    expect(await githubGreenReviewAttempt(db, scope)).toEqual({
      kind: "already_requested",
    });
  });

  it("reports a live or finished review and an in-flight request instead of repeating it", async () => {
    const f = await fixture();
    const scope = {
      companyId: f.companyId,
      endpointId: f.endpointId,
      repositoryId: REPO,
      pullNumber: PR,
      headSha: NEW,
    };
    const deliveryRowId = await f.delivery(`checks-green:${REPO}:${PR}:${NEW}`);
    expect(await githubGreenReviewAttempt(db, scope)).toEqual({
      kind: "already_requested",
    });
    await f.review(NEW, "running", { deliveryId: deliveryRowId });
    expect(await githubGreenReviewAttempt(db, scope)).toEqual({
      kind: "already_reviewed",
    });
  });
});
