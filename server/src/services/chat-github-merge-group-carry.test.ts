import { describe, expect, it, vi } from "vitest";
import {
  createMergeGroupGitHubReader,
  mergeGroupCarryEnabled,
  planMergeGroupCheckPublication,
  type MergeGroupCheckRunRef,
  type MergeGroupGitHubRequest,
} from "./chat-github-merge-group-carry.js";
import {
  decideMergeGroupCarry,
  type MergeGroupContext,
} from "./chat-github-merge-group.js";

const ENDPOINT = "endpoint-1";
const APP_ID = "5191093";
const REPO = "togetherweown/nntunev2";
const GROUP = "e".repeat(40);
const HEAD_A = "a".repeat(40);

function context(): MergeGroupContext {
  return {
    deliveryId: "delivery-1",
    repositoryId: "987654321",
    repository: REPO,
    groupSha: GROUP,
    groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${HEAD_A.slice(0, 12)}`,
    baseSha: "c".repeat(40),
    baseRef: "refs/heads/main",
    installationId: "167976984",
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

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
            parents: [{ sha: "1".repeat(40) }, { sha: "2".repeat(40) }],
            commit: { message: "Merge pull request #12 from alice/feature" },
          },
        ],
      },
      "/git/trees/eee?recursive=1": {
        sha: GROUP,
        truncated: false,
        tree: [treeEntry],
      },
      "/commits/aaa/check-runs?check_name=Paperclip%20Review&per_page=100": {
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
        { sha: GROUP, parents: 2, message: "Merge pull request #12 from alice/feature" },
      ],
    });
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
            parents: [{ sha: "1".repeat(40) }],
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
          commits: [{ sha: GROUP, parents: 2, message: "Merge pull request #12 from alice/feature" }],
        }),
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
        listReviewChecks: async () => [],
      },
      {
        endpointId: ENDPOINT,
        appId: APP_ID,
        eventAgeMs: 1_000,
        maxEventAgeMs: 30 * 60_000,
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
