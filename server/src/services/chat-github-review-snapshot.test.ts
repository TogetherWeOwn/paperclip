import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { captureGitHubReviewSnapshot, githubSnapshotReader, type GitHubReviewReader } from "./chat-github-review-snapshot.js";
import type { GitHubReviewEventContext } from "@paperclipai/shared";

const head = "b".repeat(40), base = "a".repeat(40), mergeBase = "e".repeat(40);
const event: GitHubReviewEventContext = { event: "mention", deliveryId: "event", repositoryId: "1", repository: "acme/repo", pullNumber: 7,
  headSha: head, baseSha: base, baseBranch: "main", title: "PR", body: "Original", draft: false,
  author: { id: "1", login: "author", isBot: false }, sender: { id: "1", login: "author" }, labels: [] };
const expected = { headSha: head, baseSha: base, pullNumber: 7 };
function provider(overrides: (path: string) => unknown = () => undefined): GitHubReviewReader {
  return { request: async <T>(path: string) => {
    const overridden = overrides(path);
    if (overridden !== undefined) return overridden as T;
    if (path === "/pulls/7") return { head: { sha: head }, base: { sha: base }, body: "Original" } as T;
    if (path.includes("/compare/")) return { merge_base_commit: { sha: mergeBase } } as T;
    if (path.includes("/check-runs?")) return { check_runs: [] } as T;
    return [] as T;
  } };
}

describe("sealed GitHub review snapshot", () => {
  it("rejects edits during capture rather than pretending an old created_at pins bytes", async () => {
    let calls = 0;
    await expect(captureGitHubReviewSnapshot(provider(path => path.includes("/issues/7/comments?")
      ? [{ created_at: "2000-01-01", body: ++calls === 1 ? "old" : "PRIMARY_CANARY" }] : undefined), event)).rejects.toThrow("mutated");
  });
  it("rejects head changes and truncated inventories", async () => {
    await expect(captureGitHubReviewSnapshot(provider(path => path === "/pulls/7"
      ? { head: { sha: "c".repeat(40) }, base: { sha: base } } : undefined), event)).rejects.toThrow("head_changed");
    await expect(captureGitHubReviewSnapshot(provider(path => path.includes("/files?") ? Array(100).fill({ filename: "large.ts" }) : undefined), event)).rejects.toThrow("truncated");
  });
  it("does not mint a live capability for absent corrupt or mismatched snapshots", async () => {
    const snapshot = await captureGitHubReviewSnapshot(provider(), event);
    const live = vi.fn();
    expect(() => githubSnapshotReader(undefined, expected, live)).toThrow("live reads are forbidden");
    expect(() => githubSnapshotReader({ ...snapshot, responses: {} }, expected, live)).toThrow("Invalid sealed");
    expect(() => githubSnapshotReader(snapshot, { ...expected, headSha: "c".repeat(40) }, live)).toThrow("Invalid sealed");
    expect(live).not.toHaveBeenCalled();
  });
  it("never falls back for missing mutable routes writes or arbitrary refs", async () => {
    const snapshot = await captureGitHubReviewSnapshot(provider(), event);
    const live = vi.fn();
    const reader = githubSnapshotReader(snapshot, expected, live);
    for (const route of ["/pulls/8", "/contents/a?ref=main", `/contents/a?ref=${base}`, `/compare/${base}...${"c".repeat(40)}?per_page=1&page=1`, "/issues/7/comments?per_page=99&page=1"])
      await expect(reader.request(route)).rejects.toThrow();
    await expect(reader.request("/pulls/7", { method: "POST", body: {} })).rejects.toThrow();
    expect(await reader.request("/issues/7/comments?per_page=100&page=100")).toEqual([]);
    expect(live).not.toHaveBeenCalled();
  });
  it("serves all captured pages and returns detached copies", async () => {
    const snapshot = await captureGitHubReviewSnapshot(provider(path => path.includes("/comments?")
      ? path.endsWith("page=1") ? Array(100).fill({ body: "original" }) : [{ body: "last" }] : undefined), event);
    const reader = githubSnapshotReader(snapshot, expected, vi.fn());
    const first = await reader.request<Array<{ body: string }>>("/issues/7/comments?per_page=100&page=1");
    first[0]!.body = "MUTATED";
    expect((await reader.request<Array<{ body: string }>>("/issues/7/comments?per_page=100&page=1"))[0]!.body).toBe("original");
    expect(await reader.request("/issues/7/comments?per_page=100&page=2")).toEqual([{ body: "last" }]);
    expect(await reader.request("/issues/7/comments?per_page=100&page=3")).toEqual([]);
  });
  it("verifies pinned blobs and refuses symlinks unavailable bytes and traversal", async () => {
    const snapshot = await captureGitHubReviewSnapshot(provider(), event);
    const valid = { type: "file", content: Buffer.from("source").toString("base64"), encoding: "base64", size: 6,
      sha: createHash("sha1").update("blob 6\0source").digest("hex") };
    const request = vi.fn(async () => valid);
    const reader = githubSnapshotReader(snapshot, expected, request as GitHubReviewReader["request"]);
    expect(await reader.request(`/contents/a?ref=${head}`)).toMatchObject({ content: valid.content });
    for (const path of ["../a", "%2e%2e/a", "a//b", "a%00b", "a%5cb"])
      await expect(reader.request(`/contents/${path}?ref=${head}`)).rejects.toThrow();
    for (const result of [{ ...valid, sha: "c".repeat(40) }, { ...valid, type: "symlink" }, { ...valid, encoding: "none" }]) {
      request.mockResolvedValueOnce(result);
      await expect(reader.request(`/contents/a?ref=${head}`)).rejects.toThrow();
    }
    expect(request).toHaveBeenCalledTimes(4);
  });
});
