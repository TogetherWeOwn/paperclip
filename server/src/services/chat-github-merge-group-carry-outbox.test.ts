import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  chatActions,
  chatEndpointLeases,
  chatEndpointResources,
  chatEndpoints,
  chatGithubCarryRuns,
  chatGitHubConfigurations,
  chatGitHubReviews,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issues,
  startEmbeddedPostgresTestDatabase,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { MergeGroupContext } from "./chat-github-merge-group.js";

vi.mock("./chat-github-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-github-client.js")>()),
  githubBotRepositoryToken: async () => "installation-token",
}));

const { githubMergeGroupCarryService, MERGE_GROUP_CARRY_MAX_EVENT_AGE_MS } = await import(
  "./chat-github-merge-group-carry.js"
);

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

// Unique per run so a shared test database cannot collide on the globally
// unique App id of live endpoints.
const APP_ID = String(7_000_000_000 + Math.floor(Math.random() * 900_000_000));
const REPO = "example-org/example-repo";
const REPO_ID = "987654321";
const HEAD = "a".repeat(40);
const BASE_NEW = "c".repeat(40);
const BASE_OLD = "d".repeat(40);
const GROUP = "e".repeat(40);
/** Previous queue state: the base tip for a fresh group. */
const PARENT = BASE_NEW;
const GROUP_REF = `refs/heads/gh-readonly-queue/main/pr-12-${PARENT}`;
const FILE = "f".repeat(40);
const FILE_V2 = "9".repeat(40);
const OTHER = "8".repeat(40);

type RunRecord = {
  id: number;
  head_sha: string;
  external_id: string;
  status: string;
  conclusion: string;
  app: { id: number };
};

/** In-memory GitHub: serves the evidence for one clean merge-method group and
 * records every call so tests can prove which writes happened. */
function fakeGitHub(endpointId: string) {
  const state = {
    calls: [] as Array<{ method: string; path: string }>,
    runs: [] as RunRecord[],
    nextRunId: 100,
    refSha: GROUP,
    listing: "ok" as "ok" | "malformed" | "truncated" | "missing_total" | "error",
    listingLag: false,
    post: "ok" as "ok" | "error" | "lose_response" | "accept_then_502_once" | "empty_receipt",
    // Fires inside the final group-check listing so a test can revoke
    // configuration mid-listing (R1). Awaited before the listing responds.
    onGroupListing: undefined as (() => void | Promise<void>) | undefined,
  };
  const entries = (a: string) => ({
    sha: "x",
    truncated: false,
    tree: [
      { path: "src/a.ts", mode: "100644", type: "blob", sha: a },
      { path: "src/b.ts", mode: "100644", type: "blob", sha: OTHER },
    ],
  });
  const trees: Record<string, unknown> = {
    [GROUP]: entries(FILE_V2),
    [HEAD]: entries(FILE_V2),
    [BASE_OLD]: entries(FILE),
    [BASE_NEW]: entries(FILE),
  };
  const prefix = `https://api.github.com/repos/${REPO}`;
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.slice(prefix.length);
    state.calls.push({ method, path });
    if (path === "/pulls/12")
      return json({
        number: 12,
        head: { sha: HEAD },
        base: { sha: BASE_NEW },
        state: "open",
        merged: false,
      });
    if (path === `/compare/${BASE_NEW}...${GROUP}`)
      return json({
        total_commits: 2,
        commits: [
          {
            sha: HEAD,
            parents: [{ sha: BASE_OLD }],
            commit: { message: "Add the reviewed feature" },
          },
          {
            sha: GROUP,
            parents: [{ sha: PARENT }, { sha: HEAD }],
            commit: { message: "Merge pull request #12 from alice/feature" },
          },
        ],
      });
    if (path === `/compare/${BASE_NEW}...${HEAD}`)
      return json({ merge_base_commit: { sha: BASE_OLD } });
    if (path === `/git/ref/heads/gh-readonly-queue/main/pr-12-${PARENT}`)
      return json({ ref: GROUP_REF, object: { sha: state.refSha, type: "commit" } });
    const tree = /^\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(path);
    if (tree) {
      const found = trees[tree[1]!];
      return found ? json({ ...(found as object), sha: tree[1] }) : json({}, 404);
    }
    if (path.startsWith(`/commits/${HEAD}/check-runs`))
      return json({
        total_count: 1,
        check_runs: [
          {
            id: 7,
            status: "completed",
            conclusion: "success",
            external_id: `${endpointId}:12:${HEAD}`,
            app: { id: Number(APP_ID) },
          },
        ],
      });
    if (path.startsWith(`/commits/${GROUP}/check-runs`)) {
      if (state.onGroupListing) {
        const hook = state.onGroupListing;
        state.onGroupListing = undefined;
        await hook();
      }
      if (state.listing === "error") return json({ message: "boom" }, 502);
      if (state.listing === "malformed") return json({ check_runs: "nope", total_count: 0 });
      if (state.listing === "missing_total") return json({ check_runs: state.runs });
      if (state.listing === "truncated")
        return json({ total_count: state.runs.length + 40, check_runs: state.runs });
      if (state.listingLag) return json({ total_count: 0, check_runs: [] });
      return json({ total_count: state.runs.length, check_runs: state.runs });
    }
    if (method === "POST" && path === "/check-runs") {
      // A definitive rejection: the provider refused before applying, so no
      // write is in flight and a retry may POST fresh.
      if (state.post === "error") return json({ message: "boom" }, 422);
      const body = JSON.parse(String(init?.body));
      const run: RunRecord = {
        id: state.nextRunId++,
        head_sha: body.head_sha,
        external_id: body.external_id,
        status: body.status,
        conclusion: body.conclusion,
        app: { id: Number(APP_ID) },
      };
      state.runs.push(run);
      if (state.post === "lose_response") throw new TypeError("socket hang up");
      if (state.post === "accept_then_502_once") {
        // Ambiguous upstream failure: the write landed, the response is a
        // gateway error, and the next listing lags behind.
        state.post = "ok";
        state.listingLag = true;
        return json({ message: "Bad Gateway" }, 502);
      }
      // An empty success body proves nothing was created (R4).
      if (state.post === "empty_receipt") return json({});
      // A positive receipt names the created check (R4).
      return json(run);
    }
    const patch = /^\/check-runs\/(\d+)$/.exec(path);
    if (method === "PATCH" && patch) {
      const run = state.runs.find((r) => r.id === Number(patch[1]));
      if (!run) return json({}, 404);
      run.conclusion = JSON.parse(String(init?.body)).conclusion;
      return json(run);
    }
    return json({ message: `unexpected ${method} ${path}` }, 404);
  }) as typeof fetch;
  return {
    state,
    fetchImpl,
    posts: () => state.calls.filter((c) => c.method === "POST").length,
    patches: () => state.calls.filter((c) => c.method === "PATCH").length,
    writes: () => state.calls.filter((c) => c.method !== "GET").length,
  };
}

suite("merge-group carry outbox (real PostgreSQL, fake GitHub)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase("paperclip-carry-outbox-");
      db = createDb(temporary.connectionString);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  let ids: Awaited<ReturnType<typeof seed>>;
  const seededEndpointIds: string[] = [];
  async function seed(enabled = true) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Carry outbox",
      issuePrefix: `C${companyId.slice(0, 7)}`,
    });
    await db
      .insert(agents)
      .values({ id: agentId, companyId, name: "Reviewer", adapterType: "codex_local" });
    await db
      .insert(toolApplications)
      .values({ id: applicationId, companyId, name: "GitHub", type: "chat" });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      uid: randomUUID(),
      name: "GitHub",
      transport: "chat_sdk",
      connectionPurpose: "channel",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId,
      provider: "github",
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      botExternalId: APP_ID,
    });
    await db.insert(chatEndpointResources).values({
      companyId,
      endpointId,
      type: "repository",
      providerResourceId: REPO,
      label: REPO,
      enabled: true,
      availability: "available",
      metadata: { providerRepositoryId: REPO_ID },
    });
    await db.insert(chatGitHubConfigurations).values({
      endpointId,
      companyId,
      revision: 3,
      configuration: { mergeGroupCarryEnabled: enabled } as never,
      updatedByUserId: "fixture",
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review" });
    await db.insert(chatGitHubReviews).values({
      companyId,
      endpointId,
      issueId,
      repositoryId: REPO_ID,
      repository: REPO,
      pullNumber: 12,
      headSha: HEAD,
      deliveryId: randomUUID(),
      configurationRevision: 3,
      policySnapshot: {} as never,
      event: {} as never,
      state: "completed",
      assessment: { complete: true, score: 5 } as never,
      conclusion: "success",
    });
    seededEndpointIds.push(endpointId);
    return { companyId, endpointId };
  }
  beforeEach(async () => {
    // The App id is globally unique among live endpoints; release only the
    // endpoints this suite seeded, and drop only their outbox rows
    // (processPending is not endpoint-scoped, so stale rows would be picked up).
    if (seededEndpointIds.length > 0) {
      await db.delete(chatActions).where(inArray(chatActions.endpointId, seededEndpointIds));
      await db
        .update(chatEndpoints)
        .set({ botExternalId: null })
        .where(inArray(chatEndpoints.id, seededEndpointIds));
    }
    ids = await seed();
  });

  const context = (deliveryId: string): MergeGroupContext => ({
    deliveryId,
    repositoryId: REPO_ID,
    repository: REPO,
    groupSha: GROUP,
    groupRef: GROUP_REF,
    baseSha: BASE_NEW,
    baseRef: "refs/heads/main",
    installationId: "1",
  });
  async function endpoint() {
    const [row] = await db
      .select()
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, ids.endpointId));
    return row!;
  }
  async function enqueue(
    service: ReturnType<typeof githubMergeGroupCarryService>,
    deliveryId = randomUUID(),
  ) {
    await service.enqueue(await endpoint(), context(deliveryId), true, "ok", 3);
    const [action] = await db
      .select()
      .from(chatActions)
      .where(eq(chatActions.providerActionId, `github-merge-carry:${deliveryId}`));
    return action!;
  }
  const action = async (id: string) =>
    (await db.select().from(chatActions).where(eq(chatActions.id, id)))[0]!;
  const carryRun = async () =>
    (
      await db
        .select()
        .from(chatGithubCarryRuns)
        .where(eq(chatGithubCarryRuns.endpointId, ids.endpointId))
    )[0];
  const retryNow = (id: string) =>
    db
      .update(chatActions)
      .set({
        result: { attempts: 1, retryable: true, retryAt: new Date(0).toISOString() },
      })
      .where(eq(chatActions.id, id));

  it("publishes one success check and records the receipt", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    await service.processPending();
    expect(github.posts()).toBe(1);
    expect(github.state.runs[0]).toMatchObject({ conclusion: "success", head_sha: GROUP });
    expect(await action(queued.id)).toMatchObject({ status: "processed" });
    expect(await carryRun()).toMatchObject({
      status: "processed",
      verdictOk: true,
      configurationRevision: 3,
      checkId: "100",
    });
    // The lease is released once the outbox settles.
    expect(await db.select().from(chatEndpointLeases)).toHaveLength(0);
  });

  it("recovers after a first transient failure instead of returning early forever", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    github.state.post = "error";
    await service.processPending();
    expect(await action(queued.id)).toMatchObject({
      status: "failed",
      result: expect.objectContaining({ retryable: true, attempts: 1 }),
    });
    // The prior owner left the carry row mid-flight.
    expect((await carryRun())?.status).toBe("processing");
    github.state.post = "ok";
    await retryNow(queued.id);
    await service.processPending();
    expect(await action(queued.id)).toMatchObject({ status: "processed" });
    expect(await carryRun()).toMatchObject({ status: "processed", verdictOk: true });
    expect(github.state.runs).toHaveLength(1);
  });

  it("does not duplicate a check when the POST response was lost", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    github.state.post = "lose_response";
    await service.processPending();
    expect(github.state.runs).toHaveLength(1);
    expect((await action(queued.id)).status).toBe("failed");
    github.state.post = "ok";
    await retryNow(queued.id);
    await service.processPending();
    expect(github.state.runs).toHaveLength(1);
    expect(github.posts()).toBe(1);
    expect(github.patches()).toBe(1);
    expect(await action(queued.id)).toMatchObject({ status: "processed" });
  });

  it.each(["malformed", "truncated", "missing_total", "error"] as const)(
    "never POSTs when the check listing is %s",
    async (listing) => {
      const github = fakeGitHub(ids.endpointId);
      github.state.listing = listing;
      const service = githubMergeGroupCarryService(db, github.fetchImpl);
      const queued = await enqueue(service);
      await service.processPending();
      expect(github.writes()).toBe(0);
      expect(await action(queued.id)).toMatchObject({
        status: "failed",
        result: expect.objectContaining({ retryable: true }),
      });
      expect((await carryRun())?.status).not.toBe("processed");
    },
  );

  it("takes over a crashed owner's processing row once its lease has expired", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    await db.insert(chatGithubCarryRuns).values({
      companyId: ids.companyId,
      endpointId: ids.endpointId,
      repositoryId: REPO_ID,
      repository: REPO,
      groupSha: GROUP,
      baseSha: BASE_NEW,
      heads: [],
      deliveryId: "crashed-delivery",
      configurationRevision: 3,
      status: "processing",
      externalId: `carry:${ids.endpointId}:${GROUP}`,
    });
    const leaseKey = `github-publication:${REPO_ID}:merge-group:${GROUP}`;
    await db.insert(chatEndpointLeases).values({
      companyId: ids.companyId,
      endpointId: ids.endpointId,
      leaseKey,
      token: "dead-owner",
      expiresAt: new Date(Date.now() + 60_000),
    });
    // While the dead owner's lease is still live nothing may run.
    await service.processPending();
    expect(github.state.calls).toHaveLength(0);
    expect((await action(queued.id)).status).toBe("received");
    await db
      .update(chatEndpointLeases)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(chatEndpointLeases.endpointId, ids.endpointId),
          eq(chatEndpointLeases.leaseKey, leaseKey),
        ),
      );
    await service.processPending();
    expect(await action(queued.id)).toMatchObject({ status: "processed" });
    expect(github.posts()).toBe(1);
  });

  it("serializes concurrent duplicate deliveries into one provider write", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const first = await enqueue(service);
    const second = await enqueue(service);
    await Promise.all([service.processPending(), service.processPending()]);
    await service.processPending();
    expect(github.posts()).toBe(1);
    expect(github.writes()).toBe(1);
    expect((await action(first.id)).status).toBe("processed");
    expect(await action(second.id)).toMatchObject({ status: "processed" });
    expect(github.state.runs).toHaveLength(1);
  });

  it("re-judges a processed group when the policy revision changed", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    await enqueue(service);
    await service.processPending();
    expect(github.state.runs[0]!.conclusion).toBe("success");
    await db
      .update(chatGitHubConfigurations)
      .set({ revision: 4 })
      .where(eq(chatGitHubConfigurations.endpointId, ids.endpointId));
    const redelivery = await enqueue(service);
    await service.processPending();
    // The review was recorded under revision 3, so the group no longer carries
    // and the existing run is patched, never duplicated.
    expect(github.posts()).toBe(1);
    expect(github.patches()).toBe(1);
    expect(github.state.runs[0]!.conclusion).toBe("action_required");
    expect(await action(redelivery.id)).toMatchObject({ status: "processed" });
    expect(await carryRun()).toMatchObject({ configurationRevision: 4, code: "stale_policy" });
  });

  it("answers a same-revision redelivery without any new provider call", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    await enqueue(service);
    await service.processPending();
    const callsAfterFirst = github.state.calls.length;
    const again = await enqueue(service);
    await service.processPending();
    expect(github.state.calls).toHaveLength(callsAfterFirst);
    expect(await action(again.id)).toMatchObject({
      status: "processed",
      result: expect.objectContaining({ replayed: true }),
    });
  });

  it("re-judges redelivery when a newer same-head review rejects an earlier success", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    await enqueue(service);
    await service.processPending();
    expect(github.state.runs[0]).toMatchObject({ conclusion: "success" });

    const [original] = await db.select().from(chatGitHubReviews)
      .where(eq(chatGitHubReviews.endpointId, ids.endpointId));
    await db.update(chatGitHubReviews).set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(chatGitHubReviews.id, original!.id));
    await db.insert(chatGitHubReviews).values({
      companyId: original!.companyId, endpointId: original!.endpointId,
      issueId: original!.issueId, repositoryId: REPO_ID, repository: REPO,
      pullNumber: 12, headSha: HEAD, deliveryId: randomUUID(),
      configurationRevision: 3, policySnapshot: {} as never, event: {} as never,
      state: "completed", assessment: { complete: true, score: 4 } as never,
      conclusion: "action_required", createdAt: new Date("2021-01-01T00:00:00Z"),
    });

    const callsBefore = github.state.calls.length;
    const again = await enqueue(service);
    await service.processPending();
    expect((await action(again.id)).result).not.toMatchObject({ replayed: true });
    expect(github.state.calls.length).toBeGreaterThan(callsBefore);
    expect(github.posts()).toBe(1);
    expect(github.patches()).toBe(1);
    expect(github.state.runs[0]).toMatchObject({ conclusion: "action_required" });
    expect(await carryRun()).toMatchObject({ verdictOk: false, code: "weak_review" });
  });

  it("does not carry when the live queue ref no longer points at the group", async () => {
    const github = fakeGitHub(ids.endpointId);
    github.state.refSha = "1".repeat(40);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    await enqueue(service);
    await service.processPending();
    expect(github.state.runs[0]!.conclusion).toBe("action_required");
    expect(await carryRun()).toMatchObject({ verdictOk: false, code: "stale_head" });
  });

  it("cancels without calling GitHub when carry is disabled after enqueue", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    await db
      .update(chatGitHubConfigurations)
      .set({ configuration: { mergeGroupCarryEnabled: false } as never })
      .where(eq(chatGitHubConfigurations.endpointId, ids.endpointId));
    await service.processPending();
    expect(github.state.calls).toHaveLength(0);
    expect(await action(queued.id)).toMatchObject({
      status: "cancelled",
      result: { code: "carry_disabled" },
    });
  });

  it("does not POST success when the flag is revoked during the final listing (R1)", async () => {
    const github = fakeGitHub(ids.endpointId);
    github.state.onGroupListing = async () => {
      await db
        .update(chatGitHubConfigurations)
        .set({ configuration: { mergeGroupCarryEnabled: false } as never })
        .where(eq(chatGitHubConfigurations.endpointId, ids.endpointId));
    };
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    await service.processPending();
    expect(github.posts()).toBe(0);
    expect((await action(queued.id)).status).not.toBe("processed");
  });

  it("keeps one POST across an accepted write, a 502, and a lagging empty listing (R3)", async () => {
    const github = fakeGitHub(ids.endpointId);
    github.state.post = "accept_then_502_once";
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    await service.processPending();
    // The first POST landed (one run exists) but answered 502: ambiguous, so
    // the intent is kept and the action stays retryable.
    expect(github.state.runs).toHaveLength(1);
    expect(await action(queued.id)).toMatchObject({
      status: "failed",
      result: expect.objectContaining({ retryable: true }),
    });
    // The lagging empty listing cannot prove absence: no second POST.
    await retryNow(queued.id);
    await service.processPending();
    expect(github.posts()).toBe(1);
    expect(github.state.runs).toHaveLength(1);
    // Once the listing catches up, the run is adopted in place and settles.
    github.state.listingLag = false;
    await retryNow(queued.id);
    await service.processPending();
    expect(github.posts()).toBe(1);
    expect(github.patches()).toBe(1);
    expect(await action(queued.id)).toMatchObject({ status: "processed" });
    expect(await carryRun()).toMatchObject({ status: "processed", verdictOk: true });
  });

  it("never settles processed on an empty success receipt (R4)", async () => {
    const github = fakeGitHub(ids.endpointId);
    github.state.post = "empty_receipt";
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    await service.processPending();
    // HTTP 200 `{}` is ambiguity, not success: no processed settlement, the
    // intent is kept for reconciliation.
    expect(await action(queued.id)).toMatchObject({
      status: "failed",
      result: expect.objectContaining({ retryable: true }),
    });
    expect((await carryRun())?.status).not.toBe("processed");
    // The recorded write reconciles through the listing on retry.
    github.state.post = "ok";
    await retryNow(queued.id);
    await service.processPending();
    expect(await action(queued.id)).toMatchObject({ status: "processed" });
    expect(await carryRun()).toMatchObject({ status: "processed", checkId: "100" });
  });

  it("recovers reconcile-only after attempt eight instead of stranding ambiguous work (R5)", async () => {
    const github = fakeGitHub(ids.endpointId);
    github.state.post = "lose_response";
    github.state.listingLag = true;
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    const retryableNow = async () => {
      const current = await action(queued.id);
      await db
        .update(chatActions)
        .set({
          result: {
            ...(current.result as Record<string, unknown>),
            retryAt: new Date(0).toISOString(),
          },
        })
        .where(eq(chatActions.id, queued.id));
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      await service.processPending();
      await retryableNow();
    }
    // Eight ambiguous attempts: exactly one POST ever, the action stays
    // retryable in reconcile-only recovery, and the row keeps its intent.
    expect(github.posts()).toBe(1);
    expect(github.patches()).toBe(0);
    const exhausted = await action(queued.id);
    expect(exhausted.status).toBe("failed");
    expect(exhausted.result).toMatchObject({ retryable: true, reconcileOnly: true });
    const stranded = await carryRun();
    expect(stranded).toMatchObject({ status: "processing" });
    expect(stranded?.publicationAttempt).not.toBeNull();
    // The listing catches up: the original write is adopted, never re-posted.
    github.state.listingLag = false;
    await service.processPending();
    expect(github.posts()).toBe(1);
    expect(github.patches()).toBe(1);
    expect(await action(queued.id)).toMatchObject({ status: "processed" });
    expect(await carryRun()).toMatchObject({ status: "processed", verdictOk: true });
  });

  it("retires reconcile-only work through explicit supersession (R5)", async () => {
    const github = fakeGitHub(ids.endpointId);
    github.state.post = "lose_response";
    github.state.listingLag = true;
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    await service.processPending();
    await retryNow(queued.id);
    await service.processPending();
    expect(github.posts()).toBe(1);
    // The queue regenerated while the listing stayed empty: the work is
    // terminally superseded, with an explicit code on both rows.
    github.state.refSha = "1".repeat(40);
    await retryNow(queued.id);
    await service.processPending();
    expect(github.posts()).toBe(1);
    expect(await action(queued.id)).toMatchObject({
      status: "cancelled",
      result: { code: "carry_superseded" },
    });
    expect(await carryRun()).toMatchObject({
      status: "failed",
      code: "carry_superseded",
      publicationAttempt: null,
    });
  });

  it.each(["malformed", "truncated", "missing_total", "error"] as const)(
    "expires an ambiguous intent even when the check listing stays %s",
    async (listing) => {
      const github = fakeGitHub(ids.endpointId);
      github.state.post = "lose_response";
      const service = githubMergeGroupCarryService(db, github.fetchImpl);
      const queued = await enqueue(service);
      await service.processPending();
      expect((await carryRun())?.publicationAttempt).not.toBeNull();
      const callsBeforeExpiry = github.state.calls.length;

      github.state.listing = listing;
      await db.update(chatActions).set({
        createdAt: new Date(Date.now() - MERGE_GROUP_CARRY_MAX_EVENT_AGE_MS - 1000),
        result: { attempts: 8, retryable: true, reconcileOnly: true, retryAt: new Date(0).toISOString() },
      }).where(eq(chatActions.id, queued.id));
      await service.processPending();

      expect(await action(queued.id)).toMatchObject({
        status: "cancelled",
        result: { code: "carry_expired" },
      });
      expect(await carryRun()).toMatchObject({
        status: "failed",
        code: "carry_expired",
        publicationAttempt: null,
      });
      expect(github.posts()).toBe(1);
      expect(github.patches()).toBe(0);
      expect(github.state.calls).toHaveLength(callsBeforeExpiry);
      const callsAfterExpiry = github.state.calls.length;
      await service.processPending();
      expect(github.state.calls).toHaveLength(callsAfterExpiry);
    },
  );

  it("keeps an unexpired intent retryable through a listing failure and later adopts it", async () => {
    const github = fakeGitHub(ids.endpointId);
    github.state.post = "lose_response";
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    const queued = await enqueue(service);
    await service.processPending();
    github.state.listing = "error";
    await db.update(chatActions).set({
      result: { attempts: 8, retryable: true, reconcileOnly: true, retryAt: new Date(0).toISOString() },
    }).where(eq(chatActions.id, queued.id));
    await service.processPending();
    expect(await action(queued.id)).toMatchObject({
      status: "failed",
      result: expect.objectContaining({ attempts: 9, retryable: true, reconcileOnly: true }),
    });
    expect(await carryRun()).toMatchObject({ status: "processing" });
    expect((await carryRun())?.publicationAttempt).not.toBeNull();

    github.state.listing = "ok";
    await retryNow(queued.id);
    await service.processPending();
    expect(await action(queued.id)).toMatchObject({ status: "processed" });
    expect(await carryRun()).toMatchObject({ status: "processed", publicationAttempt: null });
    expect(github.posts()).toBe(1);
    expect(github.patches()).toBe(1);
  });

  it.each(["disabled", "generation", "resource", "endpoint", "configuration_missing"] as const)(
    "preserves the ambiguous intent while cancelling after %s changes",
    async (change) => {
      const github = fakeGitHub(ids.endpointId);
      github.state.post = "lose_response";
      const service = githubMergeGroupCarryService(db, github.fetchImpl);
      const queued = await enqueue(service);
      await service.processPending();
      expect(await carryRun()).toMatchObject({ status: "processing" });
      expect((await carryRun())?.publicationAttempt).not.toBeNull();
      const callsBeforeRetry = github.state.calls.length;

      if (change === "disabled") {
        await db.update(chatGitHubConfigurations)
          .set({ configuration: { mergeGroupCarryEnabled: false } as never })
          .where(eq(chatGitHubConfigurations.endpointId, ids.endpointId));
      } else if (change === "generation") {
        const setup = { ...(await endpoint()).setup, runtimeGeneration: 1 };
        await db.update(chatEndpoints).set({ setup })
          .where(eq(chatEndpoints.id, ids.endpointId));
      } else if (change === "resource") {
        await db.update(chatEndpointResources).set({ enabled: false })
          .where(eq(chatEndpointResources.endpointId, ids.endpointId));
      } else if (change === "endpoint") {
        await db.update(chatEndpoints).set({ status: "paused" })
          .where(eq(chatEndpoints.id, ids.endpointId));
      } else {
        await db.delete(chatGitHubConfigurations)
          .where(eq(chatGitHubConfigurations.endpointId, ids.endpointId));
      }
      await retryNow(queued.id);
      await service.processPending();

      const code = change === "disabled" ? "carry_disabled" : "connection_changed";
      expect(await action(queued.id)).toMatchObject({ status: "cancelled", result: { code } });
      expect(await carryRun()).toMatchObject({ status: "failed", code });
      expect((await carryRun())?.publicationAttempt).not.toBeNull();
      expect(github.state.calls).toHaveLength(callsBeforeRetry);
      expect(github.posts()).toBe(1);
      expect(github.patches()).toBe(0);
      await service.processPending();
      expect(github.state.calls).toHaveLength(callsBeforeRetry);
    },
  );

  it.each(["disabled", "generation"] as const)(
    "reconciles a redelivery without a second POST after %s changes with a lagging listing",
    async (change) => {
      const github = fakeGitHub(ids.endpointId);
      github.state.post = "lose_response";
      github.state.listingLag = true;
      const service = githubMergeGroupCarryService(db, github.fetchImpl);
      const queued = await enqueue(service);
      await service.processPending();
      expect(github.posts()).toBe(1);
      expect(github.state.runs).toHaveLength(1);
      const pendingAttempt = (await carryRun())?.publicationAttempt;
      expect(pendingAttempt).toMatchObject({ method: "POST", ambiguous: true });

      if (change === "disabled") {
        await db.update(chatGitHubConfigurations)
          .set({ configuration: { mergeGroupCarryEnabled: false } as never })
          .where(eq(chatGitHubConfigurations.endpointId, ids.endpointId));
      } else {
        const setup = { ...(await endpoint()).setup, runtimeGeneration: 1 };
        await db.update(chatEndpoints).set({ setup })
          .where(eq(chatEndpoints.id, ids.endpointId));
      }
      await retryNow(queued.id);
      await service.processPending();
      expect(await action(queued.id)).toMatchObject({ status: "cancelled" });

      if (change === "disabled") {
        await db.update(chatGitHubConfigurations)
          .set({ configuration: { mergeGroupCarryEnabled: true } as never })
          .where(eq(chatGitHubConfigurations.endpointId, ids.endpointId));
      }
      // A new delivery uses the live generation. An empty, lagging listing
      // still cannot prove the earlier POST did not land, even after revoke.
      github.state.post = "ok";
      const redelivery = await enqueue(service);
      await service.processPending();
      expect(github.posts()).toBe(1);
      expect(github.state.runs).toHaveLength(1);
      expect(await action(redelivery.id)).toMatchObject({
        status: "failed",
        result: expect.objectContaining({ code: "carry_ambiguous_write", retryable: true }),
      });
      expect((await carryRun())?.publicationAttempt).toEqual(pendingAttempt);

      // A failed listing also leaves the intent retryable, not permission to
      // POST. Once the provider catches up, reconcile the original check.
      github.state.listing = "error";
      await retryNow(redelivery.id);
      await service.processPending();
      expect(await action(redelivery.id)).toMatchObject({
        status: "failed",
        result: expect.objectContaining({ retryable: true }),
      });
      expect((await carryRun())?.publicationAttempt).toEqual(pendingAttempt);
      expect(github.posts()).toBe(1);

      github.state.listing = "ok";
      github.state.listingLag = false;
      await retryNow(redelivery.id);
      await service.processPending();
      expect(await action(redelivery.id)).toMatchObject({ status: "processed" });
      expect(await carryRun()).toMatchObject({ status: "processed", publicationAttempt: null });
      expect(github.posts()).toBe(1);
      expect(github.patches()).toBe(1);
      expect(github.state.runs).toHaveLength(1);
    },
  );

  it("does not regress a processed carry when a redelivery is cancelled after disabling", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    await enqueue(service);
    await service.processPending();
    const completed = await carryRun();
    const again = await enqueue(service);
    await db.update(chatGitHubConfigurations)
      .set({ configuration: { mergeGroupCarryEnabled: false } as never })
      .where(eq(chatGitHubConfigurations.endpointId, ids.endpointId));
    const callsBeforeRetry = github.state.calls.length;
    await service.processPending();
    expect(await action(again.id)).toMatchObject({ status: "cancelled", result: { code: "carry_disabled" } });
    expect(await carryRun()).toEqual(completed);
    expect(github.state.calls).toHaveLength(callsBeforeRetry);
  });

  it("re-judges a redelivery after the review completes instead of replaying weak_review (R2)", async () => {
    const github = fakeGitHub(ids.endpointId);
    const service = githubMergeGroupCarryService(db, github.fetchImpl);
    // The exact head carries an incomplete 4/5 review: fail-closed publication.
    await db
      .update(chatGitHubReviews)
      .set({
        assessment: { complete: true, score: 4 } as never,
        conclusion: "action_required",
      })
      .where(eq(chatGitHubReviews.endpointId, ids.endpointId));
    const first = await enqueue(service);
    await service.processPending();
    expect(github.state.runs[0]).toMatchObject({ conclusion: "action_required" });
    expect(await action(first.id)).toMatchObject({ status: "processed" });
    expect(await carryRun()).toMatchObject({ verdictOk: false, code: "weak_review" });
    // The same head completes 5/5; a new delivery for the same group must
    // recompute and publish success, not replay the stale weak verdict.
    await db
      .update(chatGitHubReviews)
      .set({
        assessment: { complete: true, score: 5 } as never,
        conclusion: "success",
      })
      .where(eq(chatGitHubReviews.endpointId, ids.endpointId));
    const callsBefore = github.state.calls.length;
    const second = await enqueue(service);
    await service.processPending();
    const redelivery = await action(second.id);
    expect(redelivery.result).not.toMatchObject({ replayed: true });
    expect(github.state.calls.length).toBeGreaterThan(callsBefore);
    expect(github.posts()).toBe(1);
    expect(github.patches()).toBe(1);
    expect(github.state.runs[0]).toMatchObject({ conclusion: "success" });
    expect(await carryRun()).toMatchObject({ verdictOk: true, code: "carry" });
  });
});
