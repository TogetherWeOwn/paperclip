import { describe, expect, it } from "vitest";
import {
  buildMergeGroupProofFingerprint,
  decideMergeGroupCarry,
  mergeGroupProofReplayMatches,
  type MergeGroupCarryInput,
  type MergeGroupContext,
  type MergeGroupGitHub,
} from "./chat-github-merge-group.js";

// Ported from the independent native-carry security audit bundle
// (`native-carry-security-evidence-637fd81.zip`, pinned 637fd81), finding F1.
// Every queued group member must be immutably bound to its exact PR head via
// a merge-method commit (second parent); squash/rebase shapes and
// unrecognized commits carry no such binding and must fail closed as
// ambiguous_group, never synthesized from the current head or matching trees.
//
// NOTE on the nominal control: the audit's nominal fixture is a squash group
// and is *unprovable by construction* (finding F1a below uses the identical
// shape to demonstrate substitution). A pure decision cannot accept the
// nominal while rejecting the substitution, so the nominal is ported here in
// the provable merge-method shape. Squash acceptance is asserted as rejection.

const H = "a".repeat(40);
const B = "b".repeat(40);
const G = "c".repeat(40);
const O = "d".repeat(40);
const NEW = "e".repeat(40);
const endpointId = "audit-endpoint";
const appId = "5191093";
const check = {
  id: 123,
  name: "Paperclip Review",
  head_sha: H,
  app: { id: 5191093 },
  external_id: `${endpointId}:12:${H}`,
  status: "completed",
  conclusion: "success",
};
const ctx: MergeGroupContext = {
  deliveryId: "audit-delivery",
  repositoryId: "987654321",
  repository: "fixture/repository",
  groupSha: G,
  groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${B}`,
  baseSha: B,
  baseRef: "refs/heads/main",
  installationId: "123",
};
const input: MergeGroupCarryInput = {
  endpointId,
  appId,
  eventAgeMs: 1000,
  maxEventAgeMs: 30000,
  configurationRevision: 3,
  reviews: [
    {
      pullNumber: 12,
      headSha: H,
      state: "completed",
      complete: true,
      score: 5,
      conclusion: "success",
      configurationRevision: 3,
    },
  ],
};
const github = (): MergeGroupGitHub => ({
  getPull: async () => ({
    number: 12,
    headSha: H,
    baseSha: B,
    state: "open",
    merged: false,
  }),
  getCompare: async () => ({
    truncated: false,
    commits: [
      {
        sha: G,
        parents: [B, H],
        message: "Merge pull request #12 from alice/feature",
      },
    ],
  }),
  getMergeBase: async () => B,
  getRefSha: async () => G,
  getTree: async (sha) => ({
    sha,
    truncated: false,
    entries: [
      {
        path: "a.ts",
        type: "blob",
        mode: "100644",
        sha: sha === B ? "1".repeat(40) : "2".repeat(40),
      },
    ],
  }),
  listReviewChecks: async () => [
    {
      appId,
      externalId: check.external_id,
      status: "completed",
      conclusion: "success",
    },
  ],
});

describe("merge-method identity proof", () => {
  it("carries a merge-method group pinned to the exact queued head", async () => {
    expect((await decideMergeGroupCarry(ctx, github(), input)).ok).toBe(true);
  });

  it("rejects a merge-method group whose head moved past the pinned head", async () => {
    const gh = github();
    gh.getPull = async () => ({
      number: 12,
      headSha: NEW,
      baseSha: B,
      state: "open",
      merged: false,
    });
    expect((await decideMergeGroupCarry(ctx, gh, input)).ok).toBe(false);
  });
});

describe("required exact queued head and complete membership (F1)", () => {
  it("does not substitute a new same-tree reviewed head for an unreviewed squashed head", async () => {
    // The queued squash G was cut from H. Before evaluation, PR12 moves to NEW,
    // a distinct commit with identical tree. Only NEW has a native review.
    const gh = github();
    gh.getPull = async () => ({
      number: 12,
      headSha: NEW,
      baseSha: B,
      state: "open",
      merged: false,
    });
    gh.getCompare = async () => ({
      truncated: false,
      commits: [{ sha: G, parents: [B], message: "Reviewed change (#12)" }],
    });
    gh.listReviewChecks = async () => [
      {
        appId,
        externalId: `${endpointId}:12:${NEW}`,
        status: "completed",
        conclusion: "success",
      },
    ];
    const movedInput = {
      ...input,
      reviews: [{ ...input.reviews[0]!, headSha: NEW }],
    };
    const verdict = await decideMergeGroupCarry(ctx, gh, movedInput);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("ambiguous_group");
  });

  it("does not accept an unexplained group commit merely because the net leaf tree matches", async () => {
    const gh = github();
    gh.getCompare = async () => ({
      truncated: false,
      commits: [
        { sha: O, parents: [B], message: "Opaque member without a PR hint" },
        { sha: G, parents: [O], message: "Reviewed change (#12)" },
      ],
    });
    const group = {
      ...ctx,
      groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${O}`,
    };
    const verdict = await decideMergeGroupCarry(group, gh, input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("ambiguous_group");
  });

  it("rejects a squash group even when the current head matches the review", async () => {
    // The audit nominal shape: squash commit, current head reviewed, trees
    // match. Unprovable by construction (see substitution test above).
    const gh = github();
    gh.getCompare = async () => ({
      truncated: false,
      commits: [{ sha: G, parents: [B], message: "Reviewed change (#12)" }],
    });
    const verdict = await decideMergeGroupCarry(ctx, gh, input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("ambiguous_group");
  });

  it("rejects conflicting pinned heads for one pull request inside a group", async () => {
    const gh = github();
    gh.getCompare = async () => ({
      truncated: false,
      commits: [
        {
          sha: O,
          parents: [B, H],
          message: "Merge pull request #12 from alice/feature",
        },
        {
          sha: G,
          parents: [O, NEW],
          message: "Merge pull request #12 from alice/retry",
        },
      ],
    });
    const group = {
      ...ctx,
      groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${O}`,
    };
    const verdict = await decideMergeGroupCarry(group, gh, input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("ambiguous_group");
  });

  it("rejects a queue-ref pull request with no merge-method entry in the group", async () => {
    const gh = github();
    gh.getCompare = async () => ({
      truncated: false,
      commits: [
        {
          sha: G,
          parents: [B, H],
          message: "Merge pull request #12 from alice/feature",
        },
      ],
    });
    const group = {
      ...ctx,
      groupRef: `refs/heads/gh-readonly-queue/main/pr-99-${B}`,
    };
    const verdict = await decideMergeGroupCarry(group, gh, input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("ambiguous_group");
  });
});

describe("complete merge-method comparisons carry branch ancestry (R6)", () => {
  // GitHub's compare commits are `git log BASE..HEAD`: the reviewed branch
  // commits appear alongside the queue merge commit(s). Every non-merge
  // commit must attribute through an exact pinned head's ancestry, and the
  // first-parent spine must reach the base without gaps.
  const branchGithub = (
    commits: { sha: string; parents: string[]; message: string }[],
  ): MergeGroupGitHub => {
    const gh = github();
    gh.getCompare = async () => ({ truncated: false, commits });
    return gh;
  };

  it("carries a single-PR group whose comparison includes the reviewed branch commit", async () => {
    // Real objects: B; H parent B; G parents B,H with H's tree. B..G = H,G.
    const gh = branchGithub([
      { sha: H, parents: [B], message: "Add the reviewed feature" },
      {
        sha: G,
        parents: [B, H],
        message: "Merge pull request #12 from alice/feature",
      },
    ]);
    const verdict = await decideMergeGroupCarry(ctx, gh, input);
    expect(verdict.ok).toBe(true);
  });

  it("carries a branch head stacked on its own prior commit", async () => {
    // H1a is not itself a queued head; it is attributed as the single-parent
    // ancestor of the pinned head H inside the same comparison.
    const H1A = "1".repeat(40);
    const gh = branchGithub([
      { sha: H1A, parents: [B], message: "Part one of the feature" },
      { sha: H, parents: [H1A], message: "Part two of the feature" },
      {
        sha: G,
        parents: [B, H],
        message: "Merge pull request #12 from alice/feature",
      },
    ]);
    const verdict = await decideMergeGroupCarry(ctx, gh, input);
    expect(verdict.ok).toBe(true);
  });

  it("carries a two-PR group with chained queue merges", async () => {
    const H1 = "1".repeat(40);
    const H2 = "2".repeat(40);
    const G1 = "f".repeat(40);
    const BASE_BLOB = "0".repeat(40);
    const A_BLOB = "7".repeat(40);
    const B_BLOB = "8".repeat(40);
    const multiCtx: MergeGroupContext = {
      ...ctx,
      groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${G1.slice(0, 8)}-pr-13-${G1.slice(0, 8)}`,
    };
    const multiInput: MergeGroupCarryInput = {
      endpointId,
      appId,
      eventAgeMs: 1000,
      maxEventAgeMs: 30000,
      configurationRevision: 3,
      reviews: [
        {
          pullNumber: 12,
          headSha: H1,
          state: "completed",
          complete: true,
          score: 5,
          conclusion: "success",
          configurationRevision: 3,
        },
        {
          pullNumber: 13,
          headSha: H2,
          state: "completed",
          complete: true,
          score: 5,
          conclusion: "success",
          configurationRevision: 3,
        },
      ],
    };
    const trees: Record<string, Record<string, string>> = {
      [B]: { "a.ts": BASE_BLOB, "b.ts": BASE_BLOB },
      [H1]: { "a.ts": A_BLOB, "b.ts": BASE_BLOB },
      [H2]: { "a.ts": BASE_BLOB, "b.ts": B_BLOB },
      [G]: { "a.ts": A_BLOB, "b.ts": B_BLOB },
    };
    const treeOf = (sha: string) => ({
      sha,
      truncated: false,
      entries: Object.entries(trees[sha] ?? {}).map(([path, blob]) => ({
        path,
        type: "blob",
        mode: "100644",
        sha: blob,
      })),
    });
    const gh: MergeGroupGitHub = {
      getPull: async (n) =>
        n === 12
          ? { number: 12, headSha: H1, baseSha: B, state: "open", merged: false }
          : n === 13
            ? { number: 13, headSha: H2, baseSha: B, state: "open", merged: false }
            : null,
      getCompare: async () => ({
        truncated: false,
        commits: [
          { sha: H1, parents: [B], message: "PR twelve work" },
          {
            sha: G1,
            parents: [B, H1],
            message: "Merge pull request #12 from alice/first",
          },
          { sha: H2, parents: [B], message: "PR thirteen work" },
          {
            sha: G,
            parents: [G1, H2],
            message: "Merge pull request #13 from bob/second",
          },
        ],
      }),
      getMergeBase: async () => B,
      getRefSha: async () => G,
      getTree: async (sha) => treeOf(sha),
      listReviewChecks: async (headSha) => [
        {
          appId,
          externalId: `${endpointId}:${headSha === H1 ? 12 : 13}:${headSha}`,
          status: "completed",
          conclusion: "success",
        },
      ],
    };
    const verdict = await decideMergeGroupCarry(multiCtx, gh, multiInput);
    expect(verdict.ok).toBe(true);
  });

  it("rejects a group whose first-parent spine has a gap", async () => {
    // G's first parent is not the base and is absent from the comparison: the
    // spine from the group back to the base cannot be proven.
    const MISSING = "f".repeat(40);
    const gh = branchGithub([
      { sha: H, parents: [B], message: "Add the reviewed feature" },
      {
        sha: G,
        parents: [MISSING, H],
        message: "Merge pull request #12 from alice/feature",
      },
    ]);
    const gapped = {
      ...ctx,
      groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${MISSING.slice(0, 8)}`,
    };
    const verdict = await decideMergeGroupCarry(gapped, gh, input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("ambiguous_group");
  });

  it("rejects an ordinary commit that attributes to no pinned head", async () => {
    // X is a well-formed single-parent commit, but it is neither a queued
    // head nor an ancestor of one: unknown code must never slip through.
    const X = "1".repeat(40);
    const gh = branchGithub([
      { sha: X, parents: [B], message: "Unrelated work" },
      { sha: H, parents: [B], message: "Add the reviewed feature" },
      {
        sha: G,
        parents: [B, H],
        message: "Merge pull request #12 from alice/feature",
      },
    ]);
    const verdict = await decideMergeGroupCarry(ctx, gh, input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("ambiguous_group");
  });

  it("rejects exotic non-merge shapes that cannot attribute", async () => {
    // A root commit inside the comparison has no parent to attribute through.
    const X = "1".repeat(40);
    const gh = branchGithub([
      { sha: X, parents: [], message: "Orphan root" },
      { sha: H, parents: [B], message: "Add the reviewed feature" },
      {
        sha: G,
        parents: [B, H],
        message: "Merge pull request #12 from alice/feature",
      },
    ]);
    const verdict = await decideMergeGroupCarry(ctx, gh, input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("ambiguous_group");
  });
});

describe("proof fingerprint and replay predicate (R2)", () => {
  const proof = () =>
    buildMergeGroupProofFingerprint({
      endpointId,
      appId,
      ctx,
      heads: [{ pullNumber: 12, headSha: H }],
      reviews: input.reviews,
      configurationRevision: 3,
      runtimeGeneration: 0,
    });
  const currentReviews = () => [
    {
      pullNumber: 12,
      headSha: H,
      complete: true,
      score: 5,
      conclusion: "success",
      configurationRevision: 3,
    },
  ];
  const replayArgs = () => ({
    stored: proof(),
    endpointId,
    appId,
    ctx,
    configurationRevision: 3,
    runtimeGeneration: 0,
    verdictOk: true,
    currentReviews: currentReviews(),
  });

  it("matches an identical proof and normalizes head case", async () => {
    expect(mergeGroupProofReplayMatches(replayArgs())).toBe(true);
    expect(
      mergeGroupProofReplayMatches({
        ...replayArgs(),
        ctx: { ...ctx, groupSha: G.toUpperCase() },
      }),
    ).toBe(true);
  });

  it("rejects repository, ref, base, revision, and generation drift", async () => {
    expect(
      mergeGroupProofReplayMatches({
        ...replayArgs(),
        ctx: { ...ctx, repositoryId: "456" },
      }),
    ).toBe(false);
    expect(
      mergeGroupProofReplayMatches({
        ...replayArgs(),
        ctx: { ...ctx, groupRef: `refs/heads/gh-readonly-queue/main/pr-12-${H}` },
      }),
    ).toBe(false);
    expect(
      mergeGroupProofReplayMatches({
        ...replayArgs(),
        ctx: { ...ctx, baseSha: H },
      }),
    ).toBe(false);
    expect(
      mergeGroupProofReplayMatches({ ...replayArgs(), configurationRevision: 4 }),
    ).toBe(false);
    expect(
      mergeGroupProofReplayMatches({ ...replayArgs(), runtimeGeneration: 1 }),
    ).toBe(false);
    expect(mergeGroupProofReplayMatches({ ...replayArgs(), stored: null })).toBe(
      false,
    );
  });

  it("never replays a version-1 proof without review outcomes", async () => {
    const legacy = { ...proof(), version: 1 as const };
    expect(
      mergeGroupProofReplayMatches({ ...replayArgs(), stored: legacy }),
    ).toBe(false);
  });

  it("never replays a stored non-carry verdict", async () => {
    expect(
      mergeGroupProofReplayMatches({ ...replayArgs(), verdictOk: false }),
    ).toBe(false);
  });

  it("re-judges when the stored review no longer matches current evidence", async () => {
    // The 4/5 -> 5/5 case: stored weak_review proof must not replay once the
    // same head carries a completed 5/5 success.
    const weakStored = buildMergeGroupProofFingerprint({
      endpointId,
      appId,
      ctx,
      heads: [{ pullNumber: 12, headSha: H }],
      reviews: [
        {
          pullNumber: 12,
          headSha: H,
          state: "completed",
          complete: true,
          score: 4,
          conclusion: "action_required",
          configurationRevision: 3,
        },
      ],
      configurationRevision: 3,
      runtimeGeneration: 0,
    });
    expect(
      mergeGroupProofReplayMatches({ ...replayArgs(), stored: weakStored }),
    ).toBe(false);
    // A changed conclusion on the same score also forces re-judgment.
    expect(
      mergeGroupProofReplayMatches({
        ...replayArgs(),
        currentReviews: [
          {
            pullNumber: 12,
            headSha: H,
            complete: true,
            score: 5,
            conclusion: "action_required",
            configurationRevision: 3,
          },
        ],
      }),
    ).toBe(false);
  });

  it("uses the newest review when duplicate head rows are replayed", () => {
    const olderSuccess = currentReviews()[0]!;
    const newerRejection = { ...olderSuccess, headSha: H.toUpperCase(), score: 4, conclusion: "action_required" };
    expect(mergeGroupProofReplayMatches({
      ...replayArgs(), currentReviews: [newerRejection, olderSuccess],
    })).toBe(false);
    expect(mergeGroupProofReplayMatches({
      ...replayArgs(), currentReviews: [olderSuccess, newerRejection],
    })).toBe(true);
  });

  it("rejects malformed stored heads and reviews", async () => {
    const malformed = [
      { ...proof(), heads: [] as never },
      { ...proof(), heads: [{ pullNumber: 12, headSha: "not-a-sha" }] as never },
      { ...proof(), heads: [{ pullNumber: -1, headSha: H }] as never },
      {
        ...proof(),
        reviews: [{ pullNumber: 99, headSha: H, configurationRevision: 3 }] as never,
      },
    ];
    for (const stored of malformed)
      expect(mergeGroupProofReplayMatches({ ...replayArgs(), stored })).toBe(
        false,
      );
  });
});
