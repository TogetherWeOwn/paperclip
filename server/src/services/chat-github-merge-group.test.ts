import { describe, expect, it } from "vitest";
import {
  decideMergeGroupCarry,
  mergeGroupCarryCheckBody,
  mergeGroupCarryExternalId,
  parseMergeGroupEvent,
  parseMergeGroupQueuedPrs,
  verifyMergeGroupTreeOwnership,
  sameMergeGroupCarryFingerprint,
  type MergeGroupCarryInput,
  type MergeGroupContext,
  type MergeGroupGitHub,
  type MergeGroupReviewRecord,
} from "./chat-github-merge-group.js";

const ENDPOINT = "endpoint-1";
const APP_ID = "5191093";
const REPO = "example-org/example-repo";
const REPO_ID = "987654321";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE_NEW = "c".repeat(40);
const BASE_OLD = "d".repeat(40);
const GROUP = "e".repeat(40);
/** Real queue form: the ref suffix and the group commit's first parent are
 * the previous queue state (here the base tip for a fresh group), never the
 * PR head. Comparisons are complete `git log BASE..HEAD` inventories: the
 * reviewed branch commits appear alongside the queue merge commit(s). */
const PARENT = BASE_NEW;
const GROUP_REF = `refs/heads/gh-readonly-queue/main/pr-12-${PARENT}`;

function context(overrides: Partial<MergeGroupContext> = {}): MergeGroupContext {
  return {
    deliveryId: "delivery-1",
    repositoryId: REPO_ID,
    repository: REPO,
    groupSha: GROUP,
    groupRef: GROUP_REF,
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
    configurationRevision: 3,
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
          sha: HEAD_A,
          parents: [BASE_OLD],
          message: "Add feature A",
        },
        {
          sha: GROUP,
          parents: [PARENT, HEAD_A],
          message: "Merge pull request #12 from alice/feature",
        },
      ],
    }),
    getMergeBase: async () => BASE_OLD,
    getRefSha: async () => GROUP,
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
    repository: { id: 987654321, full_name: "Example-Org/example-repo" },
    installation: { id: 167976984 },
    sender: { id: 42, login: "github-merge-queue[bot]" },
    merge_group: {
      head_sha: GROUP,
      head_ref: GROUP_REF,
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
      groupRef: GROUP_REF,
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

  it("pins the group to the real queue form, where the ref suffix is the parent and not the PR head", async () => {
    expect(PARENT.startsWith(HEAD_A.slice(0, 12))).toBe(false);
    const verdict = await decideMergeGroupCarry(context(), github(), input());
    expect(verdict.ok).toBe(true);

    const wrongParent = await decideMergeGroupCarry(
      context({
        groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${"5".repeat(40)}`,
      }),
      github(),
      input(),
    );
    expect(wrongParent.ok).toBe(false);
    expect(wrongParent.code).toBe("ambiguous_group");

    const notTheGroup = await decideMergeGroupCarry(
      context(),
      github({
        getCompare: async () => ({
          truncated: false,
          commits: [
            { sha: "1".repeat(40), parents: [PARENT], message: "docs (#12)" },
          ],
        }),
      }),
      input(),
    );
    expect(notTheGroup.ok).toBe(false);
    expect(notTheGroup.code).toBe("ambiguous_group");
  });

  it("fails closed when the live queue ref no longer resolves to the group sha", async () => {
    const regenerated = await decideMergeGroupCarry(
      context(),
      github({ getRefSha: async () => "9".repeat(40) }),
      input(),
    );
    expect(regenerated.ok).toBe(false);
    expect(regenerated.code).toBe("stale_head");
    const unreadable = await decideMergeGroupCarry(
      context(),
      github({ getRefSha: async () => null }),
      input(),
    );
    expect(unreadable.ok).toBe(false);
    expect(unreadable.code).toBe("evidence_unavailable");
    const threw = await decideMergeGroupCarry(
      context(),
      github({
        getRefSha: async () => {
          throw new Error("boom");
        },
      }),
      input(),
    );
    expect(threw.code).toBe("evidence_unavailable");
  });

  it("pins merge-method groups to the immutable second parent", async () => {
    const mergeCompare = (second: string) => async () => ({
      truncated: false,
      commits: [
        {
          sha: second,
          parents: [BASE_OLD],
          message: "Add feature A",
        },
        {
          sha: GROUP,
          parents: [PARENT, second],
          message: "Merge pull request #12 from alice/feature",
        },
      ],
    });
    const pinned = await decideMergeGroupCarry(
      context(),
      github({ getCompare: mergeCompare(HEAD_A) }),
      input(),
    );
    expect(pinned.ok).toBe(true);
    const moved = await decideMergeGroupCarry(
      context(),
      github({ getCompare: mergeCompare(HEAD_B) }),
      input(),
    );
    expect(moved.ok).toBe(false);
    expect(moved.code).toBe("stale_head");
  });

  it("fails closed when the queued head moved past its merge-method pin", async () => {
    // The group binds HEAD_A immutably while the pull now points at HEAD_B
    // with different content: the pin mismatch fails closed before any tree
    // comparison runs. (Unbound squash shapes fail as ambiguous_group
    // instead; see the identity suite.)
    const verdict = await decideMergeGroupCarry(
      context(),
      github({
        getPull: async () => ({
          number: 12,
          headSha: HEAD_B,
          baseSha: BASE_OLD,
          state: "open",
          merged: false,
        }),
        getTree: async (sha: string) =>
          sha === HEAD_B
            ? tree(HEAD_B, [
                ["src/a.ts", "7".repeat(40)],
                ["src/b.ts", OTHER],
              ])
            : github().getTree(sha),
        listReviewChecks: async () => [
          {
            appId: APP_ID,
            externalId: `${ENDPOINT}:12:${HEAD_B}`,
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
      input({ reviews: [review({ headSha: HEAD_B })] }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("stale_head");
  });

  it("fails closed when a queued pull request is closed or already merged", async () => {
    for (const patch of [{ state: "closed" }, { merged: true }]) {
      const verdict = await decideMergeGroupCarry(
        context(),
        github({
          getPull: async () => ({
            number: 12,
            headSha: HEAD_A,
            baseSha: BASE_OLD,
            state: "open",
            merged: false,
            ...patch,
          }),
        }),
        input(),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.code).toBe("stale_head");
    }
  });

  it("fails closed when the review came from an obsolete policy revision", async () => {
    for (const revision of [2, 4]) {
      const verdict = await decideMergeGroupCarry(
        context(),
        github(),
        input({ reviews: [review({ configurationRevision: revision })] }),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.code).toBe("stale_policy");
      expect(verdict).toMatchObject({ failedPullNumber: 12 });
    }
    const current = await decideMergeGroupCarry(
      context(),
      github(),
      input({ configurationRevision: 9, reviews: [review({ configurationRevision: 9 })] }),
    );
    expect(current.ok).toBe(true);
  });

  it("diffs each pull request against its merge base, not the moving target tip", async () => {
    const drift = "5".repeat(40);
    const verdict = await decideMergeGroupCarry(
      context(),
      github({
        getPull: async () => ({
          number: 12,
          headSha: HEAD_A,
          baseSha: BASE_NEW,
          state: "open",
          merged: false,
        }),
        getMergeBase: async (baseSha: string, headSha: string) =>
          baseSha === BASE_NEW && headSha === HEAD_A ? BASE_OLD : null,
        getTree: async (sha: string) => {
          if (sha === GROUP || sha === BASE_NEW)
            return tree(sha, [
              ["src/a.ts", sha === GROUP ? FILE_V2 : FILE],
              ["src/b.ts", drift],
            ]);
          return github().getTree(sha);
        },
      }),
      input(),
    );
    expect(verdict.ok).toBe(true);
    const noMergeBase = await decideMergeGroupCarry(
      context(),
      github({ getMergeBase: async () => null }),
      input(),
    );
    expect(noMergeBase.ok).toBe(false);
    expect(noMergeBase.code).toBe("evidence_unavailable");
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
      groupRef: `refs/heads/gh-readonly-queue/main/pr-13-${"1".repeat(40)}`,
    });
    const gh = github({
      getPull: async (n: number) =>
        n === 12
          ? { number: 12, headSha: HEAD_A, baseSha: BASE_OLD, state: "open", merged: false }
          : { number: 13, headSha: HEAD_B, baseSha: BASE_OLD, state: "open", merged: false },
      getCompare: async () => ({
        truncated: false,
        commits: [
          { sha: HEAD_A, parents: [BASE_OLD], message: "Work on A" },
          { sha: "1".repeat(40), parents: [PARENT, HEAD_A], message: "Merge pull request #12 from alice/a" },
          { sha: HEAD_B, parents: [BASE_OLD], message: "Work on B" },
          { sha: GROUP, parents: ["1".repeat(40), HEAD_B], message: "Merge pull request #13 from bob/b" },
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
      groupRef: `refs/heads/gh-readonly-queue/main/pr-13-${"1".repeat(40)}`,
    });
    const gh = github({
      getPull: async (n: number) =>
        n === 12
          ? { number: 12, headSha: HEAD_A, baseSha: BASE_OLD, state: "open", merged: false }
          : { number: 13, headSha: HEAD_B, baseSha: BASE_OLD, state: "open", merged: false },
      getCompare: async () => ({
        truncated: false,
        commits: [
          { sha: HEAD_A, parents: [BASE_OLD], message: "Work on A" },
          { sha: "1".repeat(40), parents: [PARENT, HEAD_A], message: "Merge pull request #12 from alice/a" },
          { sha: HEAD_B, parents: [BASE_OLD], message: "Work on B" },
          { sha: GROUP, parents: ["1".repeat(40), HEAD_B], message: "Merge pull request #13 from bob/b" },
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

  it("ignores directory tree nodes so disjoint files under one directory do not overlap", async () => {
    const dir = (sha: string, dirSha: string) => {
      const base = tree(sha, []);
      return {
        ...base,
        entries: [
          { path: "src", mode: "040000", type: "tree", sha: dirSha },
          ...base.entries,
        ],
      };
    };
    const ctx = context({
      groupRef: `refs/heads/gh-readonly-queue/main/pr-13-${"1".repeat(40)}`,
    });
    const gh = github({
      getPull: async (n: number) => ({
        number: n,
        headSha: n === 12 ? HEAD_A : HEAD_B,
        baseSha: BASE_OLD,
        state: "open",
        merged: false,
      }),
      getCompare: async () => ({
        truncated: false,
        commits: [
          { sha: HEAD_A, parents: [BASE_OLD], message: "Work on A" },
          { sha: "1".repeat(40), parents: [PARENT, HEAD_A], message: "Merge pull request #12 from alice/a" },
          { sha: HEAD_B, parents: [BASE_OLD], message: "Work on B" },
          { sha: GROUP, parents: ["1".repeat(40), HEAD_B], message: "Merge pull request #13 from bob/b" },
        ],
      }),
      getTree: async (sha: string) => {
        const file = (path: string, blob: string) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: blob,
        });
        const withDir = (dirSha: string, files: ReturnType<typeof file>[]) => ({
          ...dir(sha, dirSha),
          entries: [...dir(sha, dirSha).entries, ...files],
        });
        if (sha === GROUP)
          return withDir("t3", [file("src/a.ts", FILE_V2), file("src/c.ts", FILE_V2)]);
        if (sha === HEAD_A)
          return withDir("t1", [file("src/a.ts", FILE_V2), file("src/c.ts", FILE)]);
        if (sha === HEAD_B)
          return withDir("t2", [file("src/a.ts", FILE), file("src/c.ts", FILE_V2)]);
        if (sha === BASE_OLD || sha === BASE_NEW)
          return withDir("t0", [file("src/a.ts", FILE), file("src/c.ts", FILE)]);
        return null;
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
      input({ reviews: [review(), review({ pullNumber: 13, headSha: HEAD_B })] }),
    );
    expect(verdict.ok).toBe(true);
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

// Compact, sanitized reduction of a real queue group tree set: base drift
// added docs/queue-proof-a.md after the PR branched, the PR added
// docs/queue-proof-c.md, and the shared "docs" directory hash differs in all
// four trees. Only leaf blobs may decide ownership; directory nodes are noise.
// (Commit metadata is merge-method: only merge-method groups carry a head
// binding the decision can prove.)
describe("real queue group tree shape", () => {
  const sha = (char: string) => char.repeat(40);
  const blob = (path: string, blobSha: string) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: blobSha,
  });
  const dir = (path: string, dirSha: string) => ({
    path,
    mode: "040000",
    type: "tree",
    sha: dirSha,
  });
  const SRC = [dir("src", sha("1")), blob("src/main.ts", sha("2"))];
  const A = blob("docs/queue-proof-a.md", sha("a"));
  const C = blob("docs/queue-proof-c.md", sha("c"));
  const trees: Record<string, ReturnType<typeof blob>[]> = {
    [sha("d")]: [...SRC, dir("docs", sha("3")), A, C],
    [sha("b")]: [...SRC, dir("docs", sha("4")), A],
    [sha("e")]: [...SRC, dir("docs", sha("5")), C],
    [sha("f")]: [...SRC, dir("docs", sha("6"))],
  };
  const PR = 21;

  it("carries a merge-method group whose base drifted, ignoring directory nodes", async () => {
    const verdict = await decideMergeGroupCarry(
      context({
        groupSha: sha("d"),
        groupRef: `refs/heads/gh-readonly-queue/main/pr-${PR}-${sha("b")}`,
        baseSha: sha("b"),
      }),
      github({
        getPull: async () => ({
          number: PR,
          headSha: sha("e"),
          baseSha: sha("9"),
          state: "open",
          merged: false,
        }),
        getCompare: async () => ({
          truncated: false,
          commits: [
            {
              sha: sha("e"),
              parents: [sha("f")],
              message: "Queue proof change",
            },
            {
              sha: sha("d"),
              parents: [sha("b"), sha("e")],
              message: `Merge pull request #${PR} from example/queue-proof`,
            },
          ],
        }),
        getMergeBase: async () => sha("f"),
        getRefSha: async () => sha("d"),
        getTree: async (treeSha) =>
          trees[treeSha]
            ? { sha: treeSha, truncated: false, entries: trees[treeSha]! }
            : null,
        listReviewChecks: async () => [
          {
            appId: APP_ID,
            externalId: `${ENDPOINT}:${PR}:${sha("e")}`,
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
      input({ reviews: [review({ pullNumber: PR, headSha: sha("e") })] }),
    );
    expect(verdict).toMatchObject({ ok: true, code: "carry" });
  });
});

describe("verifyMergeGroupTreeOwnership directory nodes", () => {
  const node = (path: string, type: string, sha: string) => ({
    path,
    mode: type === "tree" ? "040000" : "100644",
    type,
    sha,
  });
  const map = (entries: ReturnType<typeof node>[]) =>
    new Map(entries.map((entry) => [entry.path, entry]));
  it("ignores directory nodes passed directly by a caller", () => {
    // Base drift touched docs/other.md; the PR only touched src/a.ts. The
    // docs directory hash differs between group and PR trees, which is noise.
    const result = verifyMergeGroupTreeOwnership({
      groupTree: map([
        node("docs", "tree", "1".repeat(40)),
        node("docs/other.md", "blob", "2".repeat(40)),
        node("src/a.ts", "blob", FILE_V2),
      ]),
      baseTree: map([
        node("docs", "tree", "3".repeat(40)),
        node("docs/other.md", "blob", "2".repeat(40)),
        node("src/a.ts", "blob", FILE),
      ]),
      prs: [
        {
          pullNumber: 12,
          baseTree: map([
            node("docs", "tree", "4".repeat(40)),
            node("src/a.ts", "blob", FILE),
          ]),
          headTree: map([
            node("docs", "tree", "5".repeat(40)),
            node("src/a.ts", "blob", FILE_V2),
          ]),
        },
      ],
    });
    expect(result).toEqual({ ok: true });
  });
});
