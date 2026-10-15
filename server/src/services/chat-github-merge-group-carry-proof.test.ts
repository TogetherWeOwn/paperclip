import { describe, expect, it, vi } from "vitest";
import {
  chatActions,
  chatEndpoints,
  chatGithubCarryRuns,
  chatGitHubConfigurations,
  chatGitHubReviews,
} from "@paperclipai/db";

// Ported from the independent native-carry security audit bundle
// (`native-carry-security-evidence-637fd81.zip`, pinned 637fd81):
// finding F2 (write-boundary freshness) and F4 (repository isolation).
// Service-control-flow counterexamples with a scripted one-row database
// double and a held-lease double — not a PostgreSQL/lease test. The local
// DB/lease doubles are explicit; F2 is also directly visible in the absence
// of a revalidation between evaluation and the provider write.
//
// NOTE: the group fixture is merge-method (finding F1): the queue commit
// immutably pins the queued head as its second parent. Squash shapes fail
// closed as ambiguous_group (see chat-github-merge-group-identity.test.ts).
vi.mock("./chat-github-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./chat-github-client.js")
  >()),
  githubBotRepositoryToken: async () => "fixture-token-not-a-credential",
}));
vi.mock("./chat-github-publication-lease.js", () => ({
  GitHubPublicationLeaseLost: class extends Error {},
  withGitHubPublicationLease: async (
    db: unknown,
    _scope: unknown,
    fetch: typeof globalThis.fetch,
    operation: (lease: unknown) => unknown,
  ) => operation({ fetch, commit: (write: (tx: unknown) => unknown) => write(db) }),
}));
vi.mock("./cloud-runtime-identity.js", () => ({ runtimePublicOrigin: () => null }));
const { githubMergeGroupCarryService } = await import(
  "./chat-github-merge-group-carry.js"
);

const H = "a".repeat(40);
const B = "b".repeat(40);
const G = "c".repeat(40);
const NEXT = "d".repeat(40);
const endpointId = "endpoint-fixture";
const companyId = "company-fixture";
const repoId = "123";
const repo = "fixture/repository";
const groupRef = `refs/heads/gh-readonly-queue/main/pr-12-${B}`;
const clone = <T,>(value: T): T => structuredClone(value);
type Row = Record<string, any>;

function fixture() {
  const state = {
    action: null as Row | null,
    carry: null as Row | null,
    nextId: 1,
    config: {
      endpointId,
      companyId,
      revision: 3,
      configuration: { mergeGroupCarryEnabled: true },
    },
    endpoint: {
      id: endpointId,
      companyId,
      status: "active",
      botExternalId: "5191093",
      setup: { runtimeGeneration: 0 },
    },
    resource: {
      enabled: true,
      availability: "available",
      providerResourceId: repo,
      metadata: { providerRepositoryId: repoId },
    },
    reviews: [
      {
        endpointId,
        repositoryId: repoId,
        pullNumber: 12,
        headSha: H,
        state: "completed",
        assessment: { complete: true, score: 5 },
        conclusion: "success",
        configurationRevision: 3,
      },
    ],
    calls: [] as Array<{ method: string; path: string; body?: Row }>,
    runs: [] as Row[],
    refSha: G,
    headSha: H,
    postMode: "ok",
    listingLag: false,
    onLastTree: undefined as (() => void) | undefined,
  };
  const chain = (execute: () => unknown): any => {
    const q: any = {};
    for (const name of [
      "where",
      "limit",
      "orderBy",
      "innerJoin",
      "onConflictDoNothing",
      "returning",
    ])
      q[name] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve().then(execute).then(resolve, reject);
    return q;
  };
  const db: any = {
    select: () => ({
      from: (table: unknown) =>
        chain(() => {
          if (table === chatActions)
            return state.action &&
              ["received", "failed"].includes(state.action.status)
              ? [clone(state.action)]
              : [];
          if (table === chatEndpoints)
            return [
              {
                endpoint: clone(state.endpoint),
                resource: clone(state.resource),
                configuration: clone(state.config.configuration),
                revision: state.config.revision,
                companyPrefix: "FIX",
              },
            ];
          if (table === chatGitHubConfigurations) return [clone(state.config)];
          if (table === chatGitHubReviews) return clone(state.reviews);
          if (table === chatGithubCarryRuns)
            return state.carry ? [clone(state.carry)] : [];
          throw new Error("Unexpected select table");
        }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) =>
        chain(() => {
          if (table === chatActions) {
            state.action = {
              id: `action-${state.nextId++}`,
              createdAt: new Date(),
              result: null,
              ...clone(values),
            };
            return [{ id: state.action.id }];
          }
          if (table === chatGithubCarryRuns) {
            // Mirrors the migrated UNIQUE(endpoint_id, repository_id, group_sha).
            if (
              state.carry &&
              state.carry.endpointId === values.endpointId &&
              state.carry.repositoryId === values.repositoryId &&
              state.carry.groupSha === values.groupSha
            )
              return [];
            state.carry = { id: `carry-${state.nextId++}`, ...clone(values) };
            return [{ id: state.carry.id }];
          }
          throw new Error("Unexpected insert table");
        }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) =>
        chain(() => {
          if (table === chatActions && state.action)
            Object.assign(state.action, clone(values));
          else if (table === chatGithubCarryRuns && state.carry)
            Object.assign(state.carry, clone(values));
          else throw new Error("Unexpected update table");
          return [];
        }),
    }),
  };
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "") + url.search;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ method, path, body });
    if (path === "/pulls/12")
      return response({
        number: 12,
        head: { sha: state.headSha },
        base: { sha: B },
        state: "open",
        merged: false,
      });
    if (path === `/compare/${B}...${G}`)
      return response({
        total_commits: 1,
        commits: [
          {
            sha: G,
            parents: [{ sha: B }, { sha: H }],
            commit: { message: "Merge pull request #12 from alice/feature" },
          },
        ],
      });
    if (path === `/compare/${B}...${H}`)
      return response({ merge_base_commit: { sha: B } });
    if (path === `/git/ref/heads/gh-readonly-queue/main/pr-12-${B}`)
      return response({
        ref: groupRef,
        object: { sha: state.refSha, type: "commit" },
      });
    if (path.startsWith("/git/trees/")) {
      const sha = path.slice("/git/trees/".length, -"?recursive=1".length);
      if (sha === H && state.onLastTree) {
        const hook = state.onLastTree;
        state.onLastTree = undefined;
        hook();
      }
      return response({
        sha: "9".repeat(40),
        truncated: false,
        tree: [
          {
            path: "a.ts",
            mode: "100644",
            type: "blob",
            sha: sha === B ? "1".repeat(40) : "2".repeat(40),
          },
        ],
      });
    }
    if (path.startsWith(`/commits/${H}/check-runs`))
      return response({
        total_count: 1,
        check_runs: [
          {
            id: 7,
            external_id: `${endpointId}:12:${H}`,
            status: "completed",
            conclusion: "success",
            app: { id: 5191093 },
          },
        ],
      });
    if (path.startsWith(`/commits/${G}/check-runs`)) {
      const visible = state.listingLag ? [] : state.runs;
      return response({ total_count: visible.length, check_runs: visible });
    }
    if (method === "POST" && path === "/check-runs") {
      const run = { id: 100 + state.runs.length, ...body, app: { id: 5191093 } };
      state.runs.push(run);
      if (state.postMode === "lose_response")
        throw new TypeError("Fixture: provider accepted POST, response was lost");
      return response({ id: run.id });
    }
    if (method === "PATCH" && path.startsWith("/check-runs/")) {
      const run = state.runs.find((r) => r.id === Number(path.split("/").pop()));
      if (!run) throw new Error("Unknown check id");
      Object.assign(run, body);
      return response({ id: run.id });
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  }) as typeof fetch;
  const service = githubMergeGroupCarryService(db, fetchImpl);
  const enqueue = async (repositoryId = repoId, repository = repo) =>
    service.enqueue(
      state.endpoint as never,
      {
        deliveryId: `delivery-${state.nextId++}`,
        repositoryId,
        repository,
        groupSha: G,
        groupRef,
        baseSha: B,
        baseRef: "refs/heads/main",
        installationId: "1",
      },
      true,
      "fixture",
      3,
    );
  return { state, service, enqueue };
}

describe("service control-flow controls (DB and lease doubles)", () => {
  it("publishes the nominal fixture and records its receipt", async () => {
    const f = fixture();
    await f.enqueue();
    await f.service.processPending();
    expect(f.state.runs).toHaveLength(1);
    expect(f.state.runs[0]?.conclusion).toBe("success");
    expect(f.state.action?.status).toBe("processed");
    expect(f.state.carry?.checkId).toBe("100");
  });

  it("does not contact GitHub when disabled before dispatch", async () => {
    const f = fixture();
    await f.enqueue();
    f.state.config.configuration.mergeGroupCarryEnabled = false;
    await f.service.processPending();
    expect(f.state.calls).toHaveLength(0);
    expect(f.state.action?.status).toBe("cancelled");
  });

  it("adopts a lost POST when its check is visible on retry", async () => {
    const f = fixture();
    await f.enqueue();
    f.state.postMode = "lose_response";
    await f.service.processPending();
    expect(f.state.action?.status).toBe("failed");
    f.state.postMode = "ok";
    f.state.action!.result.retryAt = new Date(0).toISOString();
    await f.service.processPending();
    expect(f.state.runs).toHaveLength(1);
    expect(f.state.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
});

describe("required freshness at the publication boundary (F2)", () => {
  it.each(["policy revision", "native flag", "endpoint generation", "queue ref", "PR head"] as const)(
    "does not publish success after %s changes during evidence reads",
    async (change) => {
      const f = fixture();
      await f.enqueue();
      f.state.onLastTree = () => {
        if (change === "policy revision") f.state.config.revision = 4;
        if (change === "native flag")
          f.state.config.configuration.mergeGroupCarryEnabled = false;
        if (change === "endpoint generation")
          f.state.endpoint.setup.runtimeGeneration = 1;
        if (change === "queue ref") f.state.refSha = NEXT;
        if (change === "PR head") f.state.headSha = NEXT;
      };
      await f.service.processPending();
      expect(
        f.state.calls.filter((c) => c.method !== "GET" && c.body?.conclusion === "success"),
      ).toHaveLength(0);
    },
  );
});

describe("required repository isolation (F4)", () => {
  it("does not reuse a processed verdict from another repository with the same Git commit", async () => {
    const f = fixture();
    await f.enqueue();
    await f.service.processPending();
    f.state.calls.length = 0;
    f.state.resource.metadata.providerRepositoryId = "456";
    f.state.resource.providerResourceId = "fixture/second-repository";
    await f.enqueue("456", "fixture/second-repository");
    await f.service.processPending();
    expect(f.state.action?.result?.replayed).not.toBe(true);
  });
});

describe("required ambiguous-write recovery (F5)", () => {
  it("does not POST again after an ambiguous accepted write hidden by listing lag", async () => {
    const f = fixture();
    await f.enqueue();
    f.state.postMode = "lose_response";
    await f.service.processPending();
    expect(f.state.action?.status).toBe("failed");
    expect(f.state.runs).toHaveLength(1);
    f.state.postMode = "ok";
    f.state.listingLag = true;
    f.state.action!.result.retryAt = new Date(0).toISOString();
    await f.service.processPending();
    // The first POST landed (one run exists) but its response was lost; the
    // lagging empty listing cannot prove absence, so no second POST follows.
    expect(f.state.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(f.state.runs).toHaveLength(1);
  });
});
