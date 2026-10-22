import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  chatDeliveries,
  chatEndpoints,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  describePairCaptureError,
  failGitHubPairCapture,
  type PairCapture,
} from "../services/chat-github-shadow.js";
import { githubShadowCaptureClaimStaleMs } from "../services/chat-github-shadow-timing.js";

describe("pair-capture failure cause", () => {
  it("keeps the message and PGSTATE code", () => {
    const deadlock = new Error("deadlock detected");
    (deadlock as { code?: string }).code = "40P01";
    expect(describePairCaptureError(deadlock)).toEqual({ error: "deadlock detected", errorCode: "40P01" });
  });
  it("finds the code through a wrapping cause", () => {
    const root = new Error("deadlock detected");
    (root as { code?: string }).code = "40P01";
    expect(describePairCaptureError(new Error("admission transaction failed", { cause: root })))
      .toEqual({ error: "admission transaction failed", errorCode: "40P01" });
  });
  it("stringifies non-errors without a code", () => {
    expect(describePairCaptureError("boom")).toEqual({ error: "boom" });
    expect(describePairCaptureError(new Error("plain"))).toEqual({ error: "plain" });
  });
  it("ignores non-string codes", () => {
    const weird = new Error("weird");
    (weird as unknown as { code?: unknown }).code = 42;
    expect(describePairCaptureError(weird)).toEqual({ error: "weird" });
  });
});

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("pair-capture claim release (real PostgreSQL, no network)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-pair-capture-release-");
      db = createDb(temporary.connectionString);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  async function fixture(attempts: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pair-capture fixture",
      issuePrefix: `P${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pair-capture agent", adapterType: "codex_local" });
    const application = randomUUID();
    const connection = randomUUID();
    await db.insert(toolApplications).values({ id: application, companyId, name: "GitHub", type: "chat" });
    await db.insert(toolConnections).values({
      id: connection, companyId, applicationId: application, uid: randomUUID(),
      name: "GitHub", transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId: connection, provider: "github",
      publicId: randomUUID(), assignedAgentId: agentId, status: "active",
    });
    const capture: PairCapture = { id: randomUUID(), startedAt: new Date().toISOString(), attempts };
    const [delivery] = await db.insert(chatDeliveries).values({
      companyId,
      endpointId,
      providerEventId: `github:acme/repo:7:${randomUUID()}`,
      deduplicationKey: randomUUID(),
      eventKind: "message",
      normalizedEvent: {
        githubPairingPending: {
          version: 1, admittedAt: new Date().toISOString(), settingsEpoch: "epoch",
          revision: 1, providerEventId: "event", arms: [],
        },
        githubPairingCapture: capture,
      },
    }).returning();
    return { delivery: delivery!, capture };
  }

  async function readEvent(deliveryId: string) {
    const [row] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, deliveryId));
    return row!.normalizedEvent as Record<string, any>;
  }

  it("keeps a fresh claim without release (sweep failures back off)", async () => {
    const { delivery, capture } = await fixture(1);
    await failGitHubPairCapture(db, delivery.id, capture, "pair_admission_failed");
    const event = await readEvent(delivery.id);
    expect(event.githubPairingCapture).toMatchObject({
      id: capture.id, attempts: 1, lastError: "pair_admission_failed", startedAt: capture.startedAt,
    });
    expect(event.githubPairingPending).toBeDefined();
    expect(Date.now() - Date.parse(event.githubPairingCapture.startedAt))
      .toBeLessThan(githubShadowCaptureClaimStaleMs());
  });

  it("releases a dead kick claim past the stale window (sweep reclaims immediately)", async () => {
    const { delivery, capture } = await fixture(1);
    await failGitHubPairCapture(db, delivery.id, capture, "pair_admission_failed", { releaseClaim: true });
    const event = await readEvent(delivery.id);
    expect(event.githubPairingCapture).toMatchObject({
      id: capture.id, attempts: 1, lastError: "pair_admission_failed",
    });
    expect(event.githubPairingPending).toBeDefined();
    expect(Date.now() - Date.parse(event.githubPairingCapture.startedAt))
      .toBeGreaterThan(githubShadowCaptureClaimStaleMs());
  });

  it("tombstones pending after 3 attempts even with release", async () => {
    const { delivery, capture } = await fixture(3);
    await failGitHubPairCapture(db, delivery.id, capture, "pair_admission_failed", { releaseClaim: true });
    const event = await readEvent(delivery.id);
    expect(event.githubPairingPending).toBeUndefined();
    expect(event.githubPairingCapture).toBeUndefined();
    expect(event.githubPairingFailure).toMatchObject({ reason: "pair_admission_failed", attempts: 3 });
  });

  it("fences a stale worker by capture id", async () => {
    const { delivery, capture } = await fixture(1);
    await failGitHubPairCapture(db, delivery.id, { ...capture, id: randomUUID() },
      "pair_admission_failed", { releaseClaim: true });
    const event = await readEvent(delivery.id);
    expect(event.githubPairingCapture).toMatchObject({ id: capture.id, startedAt: capture.startedAt });
    expect(event.githubPairingCapture.lastError).toBeUndefined();
  });
});
