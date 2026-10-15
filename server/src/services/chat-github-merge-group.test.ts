import { describe, expect, it } from "vitest";
import {
  decideMergeGroupCarry,
  mergeGroupCarryCheckBody,
  mergeGroupCarryExternalId,
  parseMergeGroupEvent,
  parseMergeGroupQueuedPrs,
  sameMergeGroupCarryFingerprint,
  type MergeGroupCarryInput,
  type MergeGroupContext,
  type MergeGroupGitHub,
  type MergeGroupReviewRecord,
} from "./chat-github-merge-group.js";

const ENDPOINT = "endpoint-1";
const APP_ID = "5191093";
const REPO = "togetherweown/nntunev2";
const REPO_ID = "987654321";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE_NEW = "c".repeat(40);
const BASE_OLD = "d".repeat(40);
const GROUP = "e".repeat(40);

function context(overrides: Partial<MergeGroupContext> = {}): MergeGroupContext {
  return {
    deliveryId: "delivery-1",
    repositoryId: REPO_ID,
    repository: REPO,
    groupSha: GROUP,
    groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${HEAD_A.slice(0, 12)}`,
    baseSha: BASE_NEW,
    baseRef: "refs/heads/main",
    installationId: "167976984",
    ...overrides,
  };
}

function review(
  overrides: Partial<MergeGroupReviewRecord> = {},
): MergeGroupReviewRecord {
  return {
    pullNumber: 12,
    headSha: HEAD_A,
    state: "completed",
    complete: true,
    score: 5,
    conclusion: "success",
    configurationRevision: 3,
    ...overrides,
  };
}

function input(overrides: Partial<MergeGroupCarryInput> = {}): MergeGroupCarryInput {
  return {
    endpointId: ENDPOINT,
    appId: APP_ID,
    eventAgeMs: 1_000,
    maxEventAgeMs: 30 * 60_000,
    reviews: [review()],
    ...overrides,
  };
}

type Entry = [path: string, sha: string | null];
function tree(sha: string, entries: Entry[], truncated = false) {
  return {
    sha,
    truncated,
    entries: entries.map(([path, entrySha]) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: entrySha,
    })),
  };
}

const FILE = "f".repeat(40);
const FILE_V2 = "9".repeat(40);
const OTHER = "8".repeat(40);

function github(overrides: Partial<MergeGroupGitHub> = {}): MergeGroupGitHub {
  const base: MergeGroupGitHub = {
    getPull: async () => ({
      number: 12,
      headSha: HEAD_A,
      baseSha: BASE_OLD,
      state: "open",
      merged: false,
    }),
    getCompare: async () => ({
      truncated: false,
      commits: [
        {
          sha: GROUP,
          parents: 2,
          message: "Merge pull request #12 from alice/feature",
        },
      ],
    }),
    getTree: async (sha: string) => {
      if (sha === GROUP)
        return tree(GROUP, [
          ["src/a.ts", FILE_V2],
          ["src/b.ts", OTHER],
        ]);
      if (sha === HEAD_A)
        return tree(HEAD_A, [
          ["src/a.ts", FILE_V2],
          ["src/b.ts", OTHER],
        ]);
      if (sha === BASE_OLD)
        return tree(BASE_OLD, [
          ["src/a.ts", FILE],
          ["src/b.ts", OTHER],
        ]);
      if (sha === BASE_NEW)
        return tree(BASE_NEW, [
          ["src/a.ts", FILE],
          ["src/b.ts", OTHER],
        ]);
      return null;
    },
    listReviewChecks: async () => [
      {
        appId: APP_ID,
        externalId: `${ENDPOINT}:12:${HEAD_A}`,
        status: "completed",
        conclusion: "success",
      },
    ],
  };
  return { ...base, ...overrides };
}

function webhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "checks_requested",
    repository: { id: 987654321, full_name: "TogetherWeOwn/nntunev2" },
    installation: { id: 167976984 },
    sender: { id: 42, login: "github-merge-queue[bot]" },
    merge_group: {
      head_sha: GROUP,
      head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${HEAD_A.slice(0, 12)}`,
      base_sha: BASE_NEW,
      base_ref: "refs/heads/main",
      head_commit: { id: GROUP, message: "Merge branch" },
    },
    ...overrides,
  };
}

describe("parseMergeGroupEvent", () => {
  it("parses a checks_requested payload and pins group identities", () => {
    const parsed = parseMergeGroupEvent(webhookPayload(), "delivery-1");
    expect(parsed).toEqual({
      deliveryId: "delivery-1",
      repositoryId: REPO_ID,
      repository: REPO,
      groupSha: GROUP,
      groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${HEAD_A.slice(0, 12)}`,
      baseSha: BASE_NEW,
      baseRef: "refs/heads/main",
      installationId: "167976984",
    });
  });

  it("rejects destroyed actions and malformed payloads", () => {
    expect(
      parseMergeGroupEvent(webhookPayload({ action: "destroyed" }), "d"),
    ).toBeNull();
    expect(parseMergeGroupEvent({ action: "checks_requested" }, "d")).toBeNull();
    expect(
      parseMergeGroupEvent(
        webhookPayload({
          merge_group: {
            head_sha: "not-a-sha",
            head_ref: "refs/heads/main",
            base_sha: BASE_NEW,
            base_ref: "refs/heads/main",
          },
        }),
        "d",
      ),
    ).toBeNull();
  });
});

describe("parseMergeGroupQueuedPrs", () => {
  it("parses single and multi-PR refs and rejects foreign refs", () => {
    expect(
      parseMergeGroupQueuedPrs(
        "refs/heads/gh-readonly-queue/main/pr-12-abc1234def56",
      ),
    ).toEqual([{ pullNumber: 12, shortSha: "abc1234def56" }]);
    expect(
      parseMergeGroupQueuedPrs(
        "refs/heads/gh-readonly-queue/release/v2/pr-7-abc1-pr-8-def2",
      ),
    ).toEqual([
      { pullNumber: 7, shortSha: "abc1" },
      { pullNumber: 8, shortSha: "def2" },
    ]);
    expect(parseMergeGroupQueuedPrs("refs/heads/main")).toBeNull();
    expect(parseMergeGroupQueuedPrs("refs/heads/gh-readonly-queue/main")).toBeNull();
  });
});

describe("decideMergeGroupCarry", () => {
  it("carries a valid single-PR group with an empty diff-of-diff", async () => {
    const verdict = await decideMergeGroupCarry(context(), github(), input());
    expect(verdict).toEqual({
      ok: true,
      code: "carry",
      externalId: `carry:${ENDPOINT}:${GROUP}`,
      groupSha: GROUP,
      carried: [{ pullNumber: 12, headSha: HEAD_A }],
    });
  });

  it("carries a clean base-drift group (base moved, PR files merge cleanly)", async () => {
    const verdict = await decideMergeGroupCarry(context(), github(), input());
    expect(verdict.ok).toBe(true);
  });

  it("fails closed when no review record exists for the exact head", async () => {
    const verdict = await decideMergeGroupCarry(
      context(),
      github(),
      input({ reviews: [] }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("missing_review");
  });

  it("fails closed on a 4-of-5 assessment and on incomplete reviews", async () => {
    for (const record of [
      review({ score: 4 }),
      review({ complete: false }),
      review({ conclusion: "action_required" }),
      review({ state: "running" }),
    ]) {
      const verdict = await decideMergeGroupCarry(
        context(),
        github(),
        input({ reviews: [record] }),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.code).toBe("weak_review");
    }
  });

  it("fails closed on a stale head (PR moved after the group was cut)", async () => {
    const moved = HEAD_B;
    const verdict = await decideMergeGroupCarry(
      context(),
      github({
        getPull: async () => ({
          number: 12,
          headSha: moved,
          baseSha: BASE_OLD,
          state: "open",
          merged: false,
        }),
      }),
      input(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("stale_head");
  });

  it("fails closed when the live success check run is absent on the head", async () => {
    const verdict = await decideMergeGroupCarry(
      context(),
      github({ listReviewChecks: async () => [] }),
      input(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("check_mismatch");
  });

  it("fails closed on a nonempty delta (group carries an unreviewed change)", async () => {
    const verdict = await decideMergeGroupCarry(
      context(),
      github({
        getTree: async (sha: string) => {
          if (sha === GROUP)
            return tree(GROUP, [
              ["src/a.ts", FILE_V2],
              ["src/b.ts", OTHER],
              ["src/sneaky.ts", FILE],
            ]);
          return github().getTree(sha);
        },
      }),
      input(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("nonempty_delta");
    if (!verdict.ok)
      expect(verdict.detail).toContain("src/sneaky.ts");
  });

  it("fails closed when base interaction rewrites a reviewed file", async () => {
    const rewritten = "7".repeat(40);
    const verdict = await decideMergeGroupCarry(
      context(),
      github({
        getTree: async (sha: string) => {
          if (sha === GROUP)
            return tree(GROUP, [
              ["src/a.ts", rewritten],
              ["src/b.ts", OTHER],
            ]);
          return github().getTree(sha);
        },
      }),
      input(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("nonempty_delta");
  });

  it("carries a multi-PR group when every head is reviewed and trees partition", async () => {
    const ctx = context({
      groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${HEAD_A.slice(0, 8)}-pr-13-${HEAD_B.slice(0, 8)}`,
    });
    const gh = github({
      getPull: async (n: number) =>
        n === 12
          ? { number: 12, headSha: HEAD_A, baseSha: BASE_OLD, state: "open", merged: false }
          : { number: 13, headSha: HEAD_B, baseSha: BASE_OLD, state: "open", merged: false },
      getCompare: async () => ({
        truncated: false,
        commits: [
          { sha: "1".repeat(40), parents: 2, message: "Merge pull request #12 from alice/a" },
          { sha: GROUP, parents: 2, message: "Merge pull request #13 from bob/b" },
        ],
      }),
      getTree: async (sha: string) => {
        if (sha === GROUP)
          return tree(GROUP, [
            ["src/a.ts", FILE_V2],
            ["src/c.ts", FILE_V2],
            ["src/b.ts", OTHER],
          ]);
        if (sha === HEAD_A)
          return tree(HEAD_A, [
            ["src/a.ts", FILE_V2],
            ["src/b.ts", OTHER],
          ]);
        if (sha === HEAD_B)
          return tree(HEAD_B, [
            ["src/a.ts", FILE],
            ["src/c.ts", FILE_V2],
            ["src/b.ts", OTHER],
          ]);
        return github().getTree(sha);
      },
      listReviewChecks: async (headSha: string) => [
        {
          appId: APP_ID,
          externalId: `${ENDPOINT}:${headSha === HEAD_A ? 12 : 13}:${headSha}`,
          status: "completed",
          conclusion: "success",
        },
      ],
    });
    const verdict = await decideMergeGroupCarry(
      ctx,
      gh,
      input({
        reviews: [review(), review({ pullNumber: 13, headSha: HEAD_B })],
      }),
    );
    expect(verdict).toEqual({
      ok: true,
      code: "carry",
      externalId: `carry:${ENDPOINT}:${GROUP}`,
      groupSha: GROUP,
      carried: [
        { pullNumber: 12, headSha: HEAD_A },
        { pullNumber: 13, headSha: HEAD_B },
      ],
    });
  });

  it("fails closed when two queued PRs touch the same file", async () => {
    const ctx = context({
      groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${HEAD_A.slice(0, 8)}-pr-13-${HEAD_B.slice(0, 8)}`,
    });
    const gh = github({
      getPull: async (n: number) =>
        n === 12
          ? { number: 12, headSha: HEAD_A, baseSha: BASE_OLD, state: "open", merged: false }
          : { number: 13, headSha: HEAD_B, baseSha: BASE_OLD, state: "open", merged: false },
      getCompare: async () => ({
        truncated: false,
        commits: [
          { sha: "1".repeat(40), parents: 2, message: "Merge pull request #12 from alice/a" },
          { sha: GROUP, parents: 2, message: "Merge pull request #13 from bob/b" },
        ],
      }),
      getTree: async (sha: string) => {
        if (sha === GROUP || sha === HEAD_A || sha === HEAD_B)
          return tree(sha, [
            ["src/a.ts", FILE_V2],
            ["src/b.ts", OTHER],
          ]);
        return github().getTree(sha);
      },
      listReviewChecks: async (headSha: string) => [
        {
          appId: APP_ID,
          externalId: `${ENDPOINT}:${headSha === HEAD_A ? 12 : 13}:${headSha}`,
          status: "completed",
          conclusion: "success",
        },
      ],
    });
    const verdict = await decideMergeGroupCarry(
      ctx,
      gh,
      input({
        reviews: [review(), review({ pullNumber: 13, headSha: HEAD_B })],
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("pr_overlap");
  });

  it("fails closed on truncated trees, failed lookups, and empty groups", async () => {
    const truncated = await decideMergeGroupCarry(
      context(),
      github({
        getTree: async (sha: string) =>
          sha === GROUP
            ? { ...tree(GROUP, []), truncated: true }
            : github().getTree(sha),
      }),
      input(),
    );
    expect(truncated.ok).toBe(false);
    expect(truncated.code).toBe("truncated_evidence");

    const failed = await decideMergeGroupCarry(
      context(),
      github({ getPull: async () => null }),
      input(),
    );
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe("evidence_unavailable");

    const empty = await decideMergeGroupCarry(
      context(),
      github({ getCompare: async () => ({ truncated: false, commits: [] }) }),
      input({ reviews: [review()] }),
      );
    expect(empty.ok).toBe(false);
    expect(empty.code).toBe("ambiguous_group");
  });

  it("fails closed on expired events without carrying", async () => {
    const verdict = await decideMergeGroupCarry(
      context(),
      github(),
      input({ eventAgeMs: 60 * 60_000, maxEventAgeMs: 30 * 60_000 }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("expired");
  });

  it("never synthesizes success from an unparseable ref", async () => {
    const verdict = await decideMergeGroupCarry(
      context({ groupRef: "refs/heads/main" }),
      github(),
      input(),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("ambiguous_group");
  });
});

describe("carry idempotency", () => {
  it("keys verdicts by endpoint and group SHA and compares fingerprints", () => {
    expect(mergeGroupCarryExternalId(ENDPOINT, GROUP)).toBe(
      `carry:${ENDPOINT}:${GROUP}`,
    );
    const fingerprint = {
      endpointId: ENDPOINT,
      appId: APP_ID,
      groupSha: GROUP,
      baseSha: BASE_NEW,
      heads: [{ pullNumber: 12, headSha: HEAD_A }],
    };
    expect(sameMergeGroupCarryFingerprint(fingerprint, { ...fingerprint })).toBe(
      true,
    );
    expect(
      sameMergeGroupCarryFingerprint(fingerprint, {
        ...fingerprint,
        heads: [{ pullNumber: 12, headSha: HEAD_B }],
      }),
    ).toBe(false);
    expect(
      sameMergeGroupCarryFingerprint(fingerprint, {
        ...fingerprint,
        baseSha: BASE_OLD,
      }),
    ).toBe(false);
  });
});

describe("mergeGroupCarryCheckBody", () => {
  it("renders a public-safe summary naming carried heads", async () => {
    const verdict = await decideMergeGroupCarry(context(), github(), input());
    const body = mergeGroupCarryCheckBody(REPO, verdict);
    expect(body.title).toContain("carried");
    expect(body.summary).toContain(`#12`);
    expect(body.summary).toContain(HEAD_A);
    expect(body.summary).not.toContain("TOG-");
    expect(body.summary).not.toContain(ENDPOINT);
  });

  it("renders the exact fail reason without internal identifiers", async () => {
    const verdict = await decideMergeGroupCarry(
      context(),
      github(),
      input({ reviews: [] }),
    );
    const body = mergeGroupCarryCheckBody(REPO, verdict);
    expect(body.title).toContain("cannot be carried");
    expect(body.summary).toContain("#12");
    expect(body.summary).not.toContain("TOG-");
    expect(body.summary).not.toContain(ENDPOINT);
  });
});
