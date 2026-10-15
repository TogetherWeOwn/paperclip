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

describe("proof fingerprint and replay predicate", () => {
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
  const replayArgs = () => ({
    stored: proof(),
    endpointId,
    appId,
    ctx,
    configurationRevision: 3,
    runtimeGeneration: 0,
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
});
