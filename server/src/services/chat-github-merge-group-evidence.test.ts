import { describe, expect, it } from "vitest";
import {
  createMergeGroupGitHubReader,
  readMergeGroupCheckRuns,
  type MergeGroupGitHubRequest,
} from "./chat-github-merge-group-carry.js";
import {
  decideMergeGroupCarry,
  type MergeGroupContext,
  type MergeGroupGitHub,
} from "./chat-github-merge-group.js";

// Ported from the independent native-carry security audit bundle
// (`native-carry-security-evidence-637fd81.zip`, pinned 637fd81), finding F3.
// Raw compare/tree responses are validated before projection: exact totals,
// explicit boolean truncation, valid IDs/modes, and nonempty unique paths.
// Uncertainty is rejected, never defaulted.

const H = "a".repeat(40);
const B = "b".repeat(40);
const G = "c".repeat(40);
const endpointId = "audit-endpoint";
const appId = "5191093";
const reader = (raw: unknown) =>
  createMergeGroupGitHubReader(async <T,>() => raw as T);
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

describe("required fail-closed API evidence (F3)", () => {
  it("rejects a compare response with an unknown total", async () => {
    expect(
      await reader({
        commits: [
          {
            sha: G,
            parents: [{ sha: B }],
            commit: { message: "Reviewed change (#12)" },
          },
        ],
      }).getCompare(B, G),
    ).toBeNull();
  });

  it("marks a short compare page as truncated evidence, never complete", async () => {
    // total 3 with 1 returned commit: unseen commits may exist, so the page
    // projects to truncated (rejected downstream), never to complete.
    expect(
      await reader({
        total_commits: 3,
        commits: [
          {
            sha: G,
            parents: [{ sha: B }],
            commit: { message: "Reviewed change (#12)" },
          },
        ],
      }).getCompare(B, G),
    ).toMatchObject({ truncated: true });
  });

  it("rejects compare commits with malformed object identities", async () => {
    expect(
      await reader({
        total_commits: 1,
        commits: [
          {
            sha: "not-a-sha",
            parents: [{ sha: B }],
            commit: { message: "Reviewed change (#12)" },
          },
        ],
      }).getCompare(B, G),
    ).toBeNull();
    expect(
      await reader({
        total_commits: 1,
        commits: [
          {
            sha: G,
            parents: [{ sha: "xyz" }],
            commit: { message: "Reviewed change (#12)" },
          },
        ],
      }).getCompare(B, G),
    ).toBeNull();
  });

  it("rejects a tree with no explicit truncation status", async () => {
    expect(
      await reader({
        sha: G,
        tree: [{ path: "a.ts", type: "blob", mode: "100644", sha: H }],
      }).getTree(G),
    ).toBeNull();
  });

  it("rejects a blob entry with missing mode and object identity", async () => {
    expect(
      await reader({
        sha: G,
        truncated: false,
        tree: [{ path: "a.ts", type: "blob" }],
      }).getTree(G),
    ).toBeNull();
  });

  it("rejects duplicate tree paths", async () => {
    expect(
      await reader({
        sha: G,
        truncated: false,
        tree: [
          { path: "a.ts", type: "blob", mode: "100644", sha: H },
          { path: "a.ts", type: "blob", mode: "100644", sha: H },
        ],
      }).getTree(G),
    ).toBeNull();
  });

  it("does not treat an extra malformed group blob as proven absence", async () => {
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
      getTree: async (sha) => {
        if (sha !== G)
          return {
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
          };
        return reader({
          sha: G,
          truncated: false,
          tree: [
            { path: "a.ts", type: "blob", mode: "100644", sha: "2".repeat(40) },
            { path: "unreviewed.ts", type: "blob" },
          ],
        }).getTree(G);
      },
      listReviewChecks: async () => [
        {
          appId,
          externalId: `${endpointId}:12:${H}`,
          status: "completed",
          conclusion: "success",
        },
      ],
    });
    const input = {
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
    expect((await decideMergeGroupCarry(ctx, github(), input)).ok).toBe(false);
  });
});

describe("strict evidence readers (R7)", () => {
  const validEntry = {
    path: "src/a.ts",
    type: "blob",
    mode: "100644",
    sha: H,
  };
  const treeOf = (entries: unknown[]) =>
    reader({ sha: G, truncated: false, tree: entries }).getTree(G);

  it("rejects duplicate comparison commit identities", async () => {
    // Two entries with the same SHA satisfy the reported total but prove
    // nothing about completeness: uniqueness is required.
    const dup = {
      sha: G,
      parents: [{ sha: B }, { sha: H }],
      commit: { message: "Merge pull request #12 from alice/feature" },
    };
    expect(
      await reader({
        total_commits: 2,
        commits: [dup, { ...dup }],
      }).getCompare(B, G),
    ).toBeNull();
  });

  it.each([
    "../unreviewed.ts",
    "/absolute.ts",
    "a//b.ts",
    "a/./b.ts",
    "nul\0byte.ts",
    "a/../b.ts",
  ])("rejects malformed tree path %j", async (path) => {
    expect(await treeOf([{ ...validEntry, path }])).toBeNull();
  });

  it("preserves valid leaf modes and whitespace filenames", async () => {
    expect(
      await treeOf([
        { path: "run.sh", type: "blob", mode: "100755", sha: H },
        { path: "link", type: "blob", mode: "120000", sha: H },
        { path: "vendor/lib", type: "commit", mode: "160000", sha: H },
        { path: "dir with space/a b.ts", type: "blob", mode: "100644", sha: H },
      ]),
    ).not.toBeNull();
  });

  it("rejects non-positive or unsafe check-run ids", async () => {
    for (const id of [-1, 0, 9007199254740992]) {
      await expect(
        readMergeGroupCheckRuns(
          (async () => ({
            total_count: 1,
            check_runs: [
              {
                id,
                status: "completed",
                external_id: "carry:e:g",
                app: { id: 5191093 },
              },
            ],
          })) as MergeGroupGitHubRequest,
          G,
        ),
      ).rejects.toThrow(/could not be listed/);
    }
  });

  it("rejects coerced app identities without String() coercion", async () => {
    // A raw array App ID must not coerce to the expected producer identity.
    expect(
      await reader({
        total_count: 1,
        check_runs: [
          {
            id: 7,
            status: "completed",
            conclusion: "success",
            external_id: "x",
            app: { id: ["5191093"] },
          },
        ],
      }).listReviewChecks(H),
    ).toBeNull();
    await expect(
      readMergeGroupCheckRuns(
        (async () => ({
          total_count: 1,
          check_runs: [
            {
              id: 7,
              status: "completed",
              external_id: "x",
              app: { id: ["5191093"] },
            },
          ],
        })) as MergeGroupGitHubRequest,
        G,
      ),
    ).rejects.toThrow(/could not be listed/);
    // Numeric and digit-string App IDs remain valid evidence.
    expect(
      await reader({
        total_count: 1,
        check_runs: [
          {
            id: 7,
            status: "completed",
            conclusion: "success",
            external_id: "x",
            app: { id: 5191093 },
          },
        ],
      }).listReviewChecks(H),
    ).toHaveLength(1);
    expect(
      await reader({
        total_count: 1,
        check_runs: [
          {
            id: 7,
            status: "completed",
            conclusion: "success",
            external_id: "x",
            app: { id: "5191093" },
          },
        ],
      }).listReviewChecks(H),
    ).toHaveLength(1);
  });
});
