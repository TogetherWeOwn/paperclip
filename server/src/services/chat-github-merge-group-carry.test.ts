import { describe, expect, it, vi } from "vitest";
import {
  createMergeGroupGitHubReader,
  mergeGroupCarryEnabled,
  readMergeGroupCheckRuns,
  planMergeGroupCheckPublication,
  parseMergeGroupCheckReceipt,
  isDefinitiveProviderRejection,
  type MergeGroupCheckRunRef,
  type MergeGroupGitHubRequest,
} from "./chat-github-merge-group-carry.js";
import {
  decideMergeGroupCarry,
  mergeGroupCarryExternalId,
  type MergeGroupContext,
} from "./chat-github-merge-group.js";

const ENDPOINT = "endpoint-1";
const APP_ID = "5191093";
const REPO = "example-org/example-repo";
const GROUP = "e".repeat(40);
const HEAD_A = "a".repeat(40);
const BASE_C = "c".repeat(40);
/** Previous queue state: the base tip for a fresh group. */
const PARENT = BASE_C;

function context(): MergeGroupContext {
  return {
    deliveryId: "delivery-1",
    repositoryId: "987654321",
    repository: REPO,
    groupSha: GROUP,
    groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${PARENT}`,
    baseSha: "c".repeat(40),
    baseRef: "refs/heads/main",
    installationId: "167976984",
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

describe("check publication receipt validation", () => {
  const receipt = () => ({
    id: 123, head_sha: GROUP, external_id: mergeGroupCarryExternalId(ENDPOINT, GROUP),
    app: { id: Number(APP_ID) }, status: "completed", conclusion: "success",
  });
  const parse = (response: unknown) => parseMergeGroupCheckReceipt({
    response, ctx: context(), endpointId: ENDPOINT, appId: APP_ID, expectedConclusion: "success",
  });

  it("accepts a complete matching receipt", () => {
    expect(parse(receipt())).toEqual({ checkId: "123" });
    expect(parse({ ...receipt(), head_sha: GROUP.toUpperCase(), id: "123" })).toEqual({ checkId: "123" });
  });

  it.each([
    ["wrong head", { head_sha: HEAD_A }],
    ["missing head", { head_sha: undefined }],
    ["wrong external id", { external_id: "other" }],
    ["wrong app", { app: { id: 42 } }],
    ["unfinished status", { status: "in_progress" }],
    ["wrong conclusion", { conclusion: "action_required" }],
    ["zero id", { id: 0 }],
    ["unsafe numeric id", { id: Number.MAX_SAFE_INTEGER + 1 }],
    ["invalid string id", { id: "01" }],
  ])("rejects %s", (_name, change) => {
    expect(parse({ ...receipt(), ...change })).toBeNull();
  });

  it.each([400, 401, 403, 404, 422])("treats HTTP %i as definitive", (providerStatus) => {
    expect(isDefinitiveProviderRejection({ details: { providerStatus } })).toBe(true);
  });

  it.each([429, 500, 502, 503, 504, 418, "400", undefined])("treats status %s as ambiguous", (providerStatus) => {
    expect(isDefinitiveProviderRejection({ details: { providerStatus } })).toBe(false);
    expect(isDefinitiveProviderRejection(new Error("network failure"))).toBe(false);
  });
});

describe("mergeGroupCarryEnabled", () => {
  it("is inert unless explicitly enabled", () => {
    expect(mergeGroupCarryEnabled({ mergeGroupCarryEnabled: true })).toBe(true);
    expect(mergeGroupCarryEnabled({ mergeGroupCarryEnabled: false })).toBe(
      false,
    );
    expect(mergeGroupCarryEnabled({})).toBe(false);
    expect(mergeGroupCarryEnabled(null)).toBe(false);
    expect(mergeGroupCarryEnabled(undefined)).toBe(false);
  });
});

describe("createMergeGroupGitHubReader", () => {
  function readerFor(routes: Record<string, unknown>, onPath?: (path: string) => void) {
    async function impl(path: string): Promise<unknown> {
      onPath?.(path);
      if (!(path in routes)) throw new Error(`no fixture for ${path}`);
      const value = routes[path];
      if (value instanceof Error) throw value;
      return value;
    }
    const request = vi.fn(impl);
    const readerRequest: MergeGroupGitHubRequest = <T,>(path: string) =>
      request(path) as Promise<T>;
    return { reader: createMergeGroupGitHubReader(readerRequest), request };
  }

  const treeEntry = { path: "src/a.ts", mode: "100644", type: "blob", sha: "f".repeat(40) };

  it("maps pull, compare, tree, and check-run payloads", async () => {
    const { reader, request } = readerFor({
      "/pulls/12": {
        number: 12,
        head: { sha: HEAD_A },
        base: { sha: "d".repeat(40) },
        state: "open",
        merged: false,
      },
      "/compare/aaa...eee": {
        total_commits: 1,
        commits: [
          {
            sha: GROUP,
            parents: [{ sha: PARENT }, { sha: HEAD_A }],
            commit: { message: "Merge pull request #12 from alice/feature" },
          },
        ],
      },
      "/git/trees/eee?recursive=1": {
        sha: GROUP,
        truncated: false,
        tree: [treeEntry],
      },
      [`/git/ref/heads/gh-readonly-queue/main/pr-12-${PARENT}`]: {
        ref: `refs/heads/gh-readonly-queue/main/pr-12-${PARENT}`,
        object: { sha: GROUP, type: "commit" },
      },
      [`/compare/${"d".repeat(40)}...${HEAD_A}`]: {
        merge_base_commit: { sha: "7".repeat(40) },
      },
      "/commits/aaa/check-runs?check_name=Paperclip%20Review&per_page=100": {
        total_count: 1,
        check_runs: [
          {
            id: 7,
            status: "completed",
            conclusion: "success",
            external_id: `${ENDPOINT}:12:${HEAD_A}`,
            app: { id: Number(APP_ID) },
          },
        ],
      },
    });
    expect(await reader.getPull(12)).toEqual({
      number: 12,
      headSha: HEAD_A,
      baseSha: "d".repeat(40),
      state: "open",
      merged: false,
    });
    const compare = await reader.getCompare("aaa", "eee");
    expect(compare).toEqual({
      truncated: false,
      commits: [
        {
          sha: GROUP,
          parents: [PARENT, HEAD_A],
          message: "Merge pull request #12 from alice/feature",
        },
      ],
    });
    expect(await reader.getRefSha(`refs/heads/gh-readonly-queue/main/pr-12-${PARENT}`)).toBe(GROUP);
    expect(await reader.getMergeBase("d".repeat(40), HEAD_A)).toBe("7".repeat(40));
    expect(await reader.getTree("eee")).toEqual({
      sha: GROUP,
      truncated: false,
      entries: [treeEntry],
    });
    expect(await reader.listReviewChecks("aaa")).toEqual([
      {
        appId: APP_ID,
        externalId: `${ENDPOINT}:12:${HEAD_A}`,
        status: "completed",
        conclusion: "success",
      },
    ]);
    expect(request).toHaveBeenCalled();
    void json;
  });

  it("treats a short compare page as truncated evidence", async () => {
    const { reader } = readerFor({
      "/compare/aaa...eee": {
        total_commits: 251,
        commits: [
          {
            sha: GROUP,
            parents: [{ sha: PARENT }],
            commit: { message: "squash (#12)" },
          },
        ],
      },
    });
    const compare = await reader.getCompare("aaa", "eee");
    expect(compare?.truncated).toBe(true);
  });

  it("returns null when GitHub reads fail or are malformed", async () => {
    const { reader } = readerFor({
      "/pulls/12": new Error("boom"),
      "/compare/aaa...eee": { commits: "nope" },
      "/git/trees/eee?recursive=1": { sha: GROUP },
      "/commits/aaa/check-runs?check_name=Paperclip%20Review&per_page=100": null,
    });
    expect(await reader.getPull(12)).toBeNull();
    expect(await reader.getCompare("aaa", "eee")).toBeNull();
    expect(await reader.getTree("eee")).toBeNull();
    expect(await reader.listReviewChecks("aaa")).toBeNull();
  });
});

describe("check-run evidence completeness", () => {
  const run = (id: number, externalId = `${ENDPOINT}:12:${HEAD_A}`) => ({
    id,
    status: "completed",
    conclusion: "success",
    external_id: externalId,
    app: { id: Number(APP_ID) },
  });
  const path = "/commits/aaa/check-runs?check_name=Paperclip%20Review&per_page=100";
  function readerFor(value: unknown) {
    const request: MergeGroupGitHubRequest = (async () =>
      value) as MergeGroupGitHubRequest;
    return createMergeGroupGitHubReader(request);
  }

  it("fails closed when total_count is missing, malformed, or exceeds the page", async () => {
    expect(await readerFor({ check_runs: [run(1)] }).listReviewChecks("aaa")).toBeNull();
    expect(
      await readerFor({ total_count: "1", check_runs: [run(1)] }).listReviewChecks("aaa"),
    ).toBeNull();
    expect(
      await readerFor({ total_count: -1, check_runs: [] }).listReviewChecks("aaa"),
    ).toBeNull();
    // 150 exist; only the first page was returned: truncated, never "no success".
    expect(
      await readerFor({ total_count: 150, check_runs: [run(1)] }).listReviewChecks("aaa"),
    ).toBeNull();
    // Fewer than the page claims is equally unreliable evidence.
    expect(
      await readerFor({ total_count: 0, check_runs: [run(1)] }).listReviewChecks("aaa"),
    ).toBeNull();
    expect(
      await readerFor({ total_count: 1, check_runs: [run(1)] }).listReviewChecks("aaa"),
    ).toHaveLength(1);
    expect(path).toContain("per_page=100");
  });

  it("reads group check runs strictly and never degrades an error to an empty list", async () => {
    const ok = await readMergeGroupCheckRuns(
      (async () => ({
        total_count: 1,
        check_runs: [run(9, `carry:${ENDPOINT}:${GROUP}`)],
      })) as MergeGroupGitHubRequest,
      GROUP,
    );
    expect(ok).toEqual([
      { id: 9, status: "completed", externalId: `carry:${ENDPOINT}:${GROUP}`, appId: APP_ID },
    ]);
    const bad: unknown[] = [
      null,
      "nope",
      {},
      { total_count: 1 },
      { total_count: 1, check_runs: [{ ...run(1), id: "1" }] },
      { total_count: 1, check_runs: [{ ...run(1), external_id: undefined }] },
      { total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => run(i + 1)) },
      { total_count: 2, check_runs: [run(1)] },
    ];
    for (const value of bad)
      await expect(
        readMergeGroupCheckRuns((async () => value) as MergeGroupGitHubRequest, GROUP),
      ).rejects.toThrow(/could not be listed/);
    await expect(
      readMergeGroupCheckRuns(
        (async () => {
          throw new Error("HTTP 502");
        }) as MergeGroupGitHubRequest,
        GROUP,
      ),
    ).rejects.toThrow("HTTP 502");
  });

  it("rejects unsafe queue refs and merge-base inputs before any request", async () => {
    const request = vi.fn(async () => ({}));
    const reader = createMergeGroupGitHubReader(
      request as unknown as MergeGroupGitHubRequest,
    );
    for (const ref of [
      "refs/heads/../x",
      "refs/tags/v1",
      "refs/heads/a b",
      "refs/heads/a//b",
      "refs/heads/a?x=1",
    ])
      expect(await reader.getRefSha(ref)).toBeNull();
    expect(await reader.getMergeBase("main", HEAD_A)).toBeNull();
    expect(await reader.getMergeBase(HEAD_A, "x/../y")).toBeNull();
    expect(request).not.toHaveBeenCalled();
    // A different ref in the body, or a non-commit object, is not the group.
    const wrong = createMergeGroupGitHubReader((async () => ({
      ref: "refs/heads/gh-readonly-queue/main/other",
      object: { sha: GROUP, type: "commit" },
    })) as MergeGroupGitHubRequest);
    expect(
      await wrong.getRefSha(`refs/heads/gh-readonly-queue/main/pr-12-${PARENT}`),
    ).toBeNull();
  });
});

describe("planMergeGroupCheckPublication", () => {
  const existing: MergeGroupCheckRunRef[] = [
    { id: 9, status: "completed", externalId: `carry:${ENDPOINT}:${GROUP}`, appId: APP_ID },
  ];

  it("patches the carried check in place on a matching run", async () => {
    const verdict = await decideMergeGroupCarry(
      context(),
      {
        getPull: async () => ({ number: 12, headSha: HEAD_A, baseSha: "d".repeat(40), state: "open", merged: false }),
        getCompare: async () => ({
          truncated: false,
          commits: [
            {
              sha: HEAD_A,
              parents: ["d".repeat(40)],
              message: "Add feature A",
            },
            {
              sha: GROUP,
              parents: [PARENT, HEAD_A],
              message: "Merge pull request #12 from alice/feature",
            },
          ],
        }),
        getMergeBase: async () => "d".repeat(40),
        getRefSha: async () => GROUP,
        getTree: async (sha: string) =>
          sha === "c".repeat(40) || sha === "d".repeat(40)
            ? { sha, truncated: false, entries: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: "f".repeat(40) }] }
            : { sha, truncated: false, entries: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: "9".repeat(40) }] },
        listReviewChecks: async () => [
          { appId: APP_ID, externalId: `${ENDPOINT}:12:${HEAD_A}`, status: "completed", conclusion: "success" },
        ],
      },
      {
        endpointId: ENDPOINT,
        appId: APP_ID,
        eventAgeMs: 1_000,
        maxEventAgeMs: 30 * 60_000,
        configurationRevision: 3,
        reviews: [
          { pullNumber: 12, headSha: HEAD_A, state: "completed", complete: true, score: 5, conclusion: "success", configurationRevision: 3 },
        ],
      },
    );
    expect(verdict.ok).toBe(true);
    const plan = planMergeGroupCheckPublication({
      ctx: context(),
      endpointId: ENDPOINT,
      appId: APP_ID,
      verdict,
      existingChecks: [],
      detailsUrl: null,
    });
    expect(plan.method).toBe("POST");
    expect(plan.path).toBe("/check-runs");
    expect(plan.body).toMatchObject({
      name: "Paperclip Review",
      head_sha: GROUP,
      external_id: `carry:${ENDPOINT}:${GROUP}`,
      status: "completed",
      conclusion: "success",
    });
    expect(plan.body.output.title).toContain("carried");
    expect(plan.body.output.summary).toContain("#12");
    expect(plan.body.output.summary).toContain(HEAD_A);
    expect(plan.body.output.summary).not.toContain("TOG-");
    expect(plan.body.output.summary).not.toContain(ENDPOINT);

    const repatch = planMergeGroupCheckPublication({
      ctx: context(),
      endpointId: ENDPOINT,
      appId: APP_ID,
      verdict,
      existingChecks: existing,
      detailsUrl: "https://example.test/x",
    });
    expect(repatch.method).toBe("PATCH");
    expect(repatch.path).toBe("/check-runs/9");
    expect(repatch.body.details_url).toBe("https://example.test/x");
  });

  it("publishes fail-closed verdicts as action_required, adopting any prior run", async () => {
    const verdict = await decideMergeGroupCarry(
      context(),
      {
        getPull: async () => null,
        getCompare: async () => null,
        getTree: async () => null,
        getMergeBase: async () => null,
        getRefSha: async () => null,
        listReviewChecks: async () => [],
      },
      {
        endpointId: ENDPOINT,
        appId: APP_ID,
        eventAgeMs: 1_000,
        maxEventAgeMs: 30 * 60_000,
        configurationRevision: 3,
        reviews: [],
      },
    );
    expect(verdict.ok).toBe(false);
    const fresh = planMergeGroupCheckPublication({
      ctx: context(),
      endpointId: ENDPOINT,
      appId: APP_ID,
      verdict,
      existingChecks: [],
      detailsUrl: null,
    });
    expect(fresh.method).toBe("POST");
    expect(fresh.path).toBe("/check-runs");
    expect(fresh.body.conclusion).toBe("action_required");
    expect(fresh.body.output.summary).not.toContain("TOG-");
    expect(fresh.body.output.summary).not.toContain(ENDPOINT);

    // A prior run on the same group key is adopted in place: completed to
    // completed updates can change the conclusion, so no second run is needed.
    const adopt = planMergeGroupCheckPublication({
      ctx: context(),
      endpointId: ENDPOINT,
      appId: APP_ID,
      verdict,
      existingChecks: existing,
      detailsUrl: null,
    });
    expect(adopt.method).toBe("PATCH");
    expect(adopt.path).toBe("/check-runs/9");
    expect(adopt.body.conclusion).toBe("action_required");
  });

  it("ignores check runs from other apps or other idempotency keys", () => {
    const verdict = {
      ok: true as const,
      code: "carry" as const,
      externalId: `carry:${ENDPOINT}:${GROUP}`,
      groupSha: GROUP,
      carried: [{ pullNumber: 12, headSha: HEAD_A }],
    };
    const plan = planMergeGroupCheckPublication({
      ctx: context(),
      endpointId: ENDPOINT,
      appId: APP_ID,
      verdict,
      existingChecks: [
        { id: 1, status: "completed", externalId: `carry:${ENDPOINT}:${GROUP}`, appId: "other-app" },
        { id: 2, status: "completed", externalId: "other:key", appId: APP_ID },
      ],
      detailsUrl: null,
    });
    expect(plan.method).toBe("POST");
  });
});
