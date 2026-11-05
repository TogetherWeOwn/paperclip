import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createCodeDeliveryGitHubReader, type CodeDeliveryPullRequestIdentity } from "../services/code-delivery-github.js";

const authorization = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../services/project-git-authorization.js", () => ({ projectGitAuthorizationService: () => authorization }));
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const identity: CodeDeliveryPullRequestIdentity = {
  projectId: "project-a", workspaceId: "source-a", repository: "acme/repo", repositoryId: "123",
  number: 17, baseRef: "main", reviewedHeadSha: HEAD,
};
const pull = () => ({
  number: 17, url: "https://api.github.com/repos/acme/repo/pulls/17", html_url: "https://github.com/acme/repo/pull/17",
  base: { ref: "main", repo: { id: 123, full_name: "acme/repo", url: "https://api.github.com/repos/acme/repo" } },
  head: { sha: HEAD, repo: { full_name: "fork/repo" } }, draft: false, merged: true, state: "closed",
  merged_at: "2026-01-02T03:04:05Z", merge_commit_sha: MERGE,
});
function fixture(body: unknown = pull()) {
  authorization.resolve.mockResolvedValue("fixture-token");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
  const read = createCodeDeliveryGitHubReader({} as Db, { fetch });
  return { read, fetch };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("authenticated code delivery observations", () => {
  it("reads the canonical PR through exact saved project consent, retaining merge and head proof", async () => {
    const f = fixture();
    expect(await f.read("company-a", [identity])).toEqual({ status: "observed", pullRequests: [{
      repository: "acme/repo", repositoryId: "123", number: 17, baseRef: "main", headSha: HEAD,
      draft: false, state: "merged", mergedAt: "2026-01-02T03:04:05Z", mergeCommitSha: MERGE,
      observedAt: expect.stringMatching(/^\d{4}-/),
    }] });
    expect(authorization.resolve).toHaveBeenCalledWith({
      companyId: "company-a", projectId: "project-a", workspaceId: "source-a",
      expectedRepository: "acme/repo", requireAuthentication: true,
    }, { projectId: "project-a", workspaceId: "source-a", operation: "inspect" });
    expect(f.fetch).toHaveBeenCalledWith("https://api.github.com/repos/acme/repo/pulls/17", {
      redirect: "error", cache: "no-store", signal: expect.any(AbortSignal), headers: {
        accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: "Bearer fixture-token",
      },
    });
  });

  it.each([null, "denied"])("never falls back to anonymous or ambient credentials when project authorization is %s", async mode => {
    const f = fixture();
    if (mode === null) authorization.resolve.mockResolvedValueOnce(null);
    else authorization.resolve.mockRejectedValueOnce(new Error("sensitive authorization response"));
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "authorization_unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["open", false, "open"], ["draft", true, "open"], ["closed unmerged", false, "closed"],
  ])("does not convert %s or a test merge commit into merged evidence", async (_label, draft, state) => {
    const f = fixture({ ...pull(), merged: false, state, draft, merged_at: null });
    expect(await f.read("company-a", [identity])).toMatchObject({ status: "observed", pullRequests: [{
      state, draft, mergedAt: null, mergeCommitSha: null,
    }] });
  });

  it.each([true, false])("ignores stale display labels for merged=%s", async merged => {
    const f = fixture({ ...pull(), merged, state: merged ? "closed" : "open", merged_at: merged ? pull().merged_at : null,
      labels: [{ name: merged ? "active" : "merged" }] });
    expect(await f.read("company-a", [identity])).toMatchObject({ status: "observed", pullRequests: [{ state: merged ? "merged" : "open" }] });
  });

  it("retains the actual head rather than echoing the reviewed claim", async () => {
    const changedHead = "c".repeat(40);
    const f = fixture({ ...pull(), head: { sha: changedHead } });
    expect(await f.read("company-a", [identity])).toMatchObject({ status: "observed", pullRequests: [{ headSha: changedHead }] });
  });

  it.each([
    ["missing merged timestamp", { merged_at: null }], ["partial timestamp", { merged_at: undefined }],
    ["invalid timestamp", { merged_at: "yesterday" }], ["impossible timestamp", { merged_at: "2026-02-30T00:00:00Z" }],
    ["missing merge SHA", { merge_commit_sha: null }], ["invalid merge SHA", { merge_commit_sha: "test-merge" }],
    ["missing merged flag", { merged: undefined }], ["string merged flag", { merged: "true" }],
    ["merged draft", { draft: true }], ["partial draft", { draft: undefined }],
    ["merged but open", { state: "open" }], ["missing state", { state: undefined }],
    ["wrong PR number", { number: 18 }], ["string PR number", { number: "17" }],
    ["wrong PR API URL", { url: "https://api.github.com/repos/other/repo/pulls/17" }],
    ["wrong PR URL", { html_url: "https://github.com/other/repo/pull/17" }],
    ["missing head", { head: null }], ["invalid head", { head: { sha: "short" } }],
    ["wrong base", { base: { ...pull().base, ref: "release" } }],
    ["wrong canonical repository", { base: { ...pull().base, repo: { ...pull().base.repo, full_name: "other/repo" } } }],
    ["wrong repository identity", { base: { ...pull().base, repo: { ...pull().base.repo, id: 124 } } }],
    ["missing repository identity", { base: { ...pull().base, repo: { ...pull().base.repo, id: undefined } } }],
    ["wrong repository API URL", { base: { ...pull().base, repo: { ...pull().base.repo, url: "https://host.invalid/repo" } } }],
    ["unmerged with merged timestamp", { merged: false }],
  ])("rejects %s", async (_label, patch) => {
    const f = fixture({ ...pull(), ...patch });
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "invalid_response" });
  });

  it.each([null, [], "merged", { state: "merged" }])("rejects noncanonical payload %j", async body => {
    const f = fixture(body);
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "invalid_response" });
  });

  it.each([401, 403, 404, 429, 500, 503, 301, 302, 307, 308, 204, 206])("fails closed on HTTP %s without following a Location", async status => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(null, { status, headers: { location: "https://host.invalid/sensitive" } }));
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "provider_unavailable" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { repository: "https://host.invalid/acme/repo" }, { repository: "acme/../secret" }, { repository: "acme/.." },
    { repository: "acme/repo?token=secret" }, { repository: "acme/repo#fragment" }, { repository: "acme/repo\n" },
    { repositoryId: "" }, { repositoryId: "-1" }, { repositoryId: "1.5" }, { repositoryId: "00123" },
    { number: 0 }, { number: -1 }, { number: 1.5 }, { number: Number.MAX_SAFE_INTEGER + 1 },
    { baseRef: "" }, { baseRef: "main\n" }, { reviewedHeadSha: "" }, { projectId: "" }, { workspaceId: "" },
  ])("rejects an invalid identity before acquiring credentials: %j", async patch => {
    const f = fixture();
    expect(await f.read("company-a", [{ ...identity, ...patch }])).toEqual({ status: "unavailable", reason: "invalid_identity" });
    expect(authorization.resolve).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("needs no provider or consent for a genuinely empty obligation set", async () => {
    const f = fixture();
    expect(await f.read("company-a", [])).toEqual({ status: "observed", pullRequests: [] });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(authorization.resolve).not.toHaveBeenCalled();
  });

  it("rejects duplicates and request-budget overflow before any provider access", async () => {
    const f = fixture();
    expect(await f.read("company-a", [identity, { ...identity, repository: "ACME/REPO" }])).toMatchObject({ status: "unavailable", reason: "invalid_identity" });
    expect(await f.read("company-a", Array.from({ length: 17 }, (_, i) => ({ ...identity, number: i + 1 })))).toMatchObject({ status: "unavailable", reason: "invalid_identity" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(authorization.resolve).not.toHaveBeenCalled();
  });

  it("observes every PR across repositories with separate scoped authorization and one deadline", async () => {
    const f = fixture();
    const second = { ...identity, projectId: "project-b", workspaceId: "source-b", repository: "other/repo", repositoryId: "456", number: 18 };
    f.fetch.mockResolvedValueOnce(Response.json(pull())).mockResolvedValueOnce(Response.json({
      ...pull(), number: 18, url: "https://api.github.com/repos/other/repo/pulls/18", html_url: "https://github.com/other/repo/pull/18",
      base: { ref: "main", repo: { id: 456, full_name: "other/repo", url: "https://api.github.com/repos/other/repo" } },
    }));
    expect(await f.read("company-a", [identity, second])).toMatchObject({ status: "observed", pullRequests: [{ number: 17 }, { number: 18, repositoryId: "456" }] });
    expect(authorization.resolve).toHaveBeenCalledTimes(2);
    expect(authorization.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "project-b", workspaceId: "source-b", expectedRepository: "other/repo" }), expect.anything());
    expect(f.fetch.mock.calls[0]![1]!.signal).toBe(f.fetch.mock.calls[1]![1]!.signal);
  });

  it("does not return partial observations if any owned PR is unavailable", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(Response.json(pull())).mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect(await f.read("company-a", [identity, { ...identity, number: 18 }])).toEqual({ status: "unavailable", reason: "provider_unavailable" });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("reauthorizes and reads live state on every call without caching labels or snapshots", async () => {
    const f = fixture();
    expect(await f.read("company-a", [identity])).toMatchObject({ status: "observed" });
    authorization.resolve.mockRejectedValueOnce(new Error("revoked"));
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "authorization_unavailable" });
    f.fetch.mockResolvedValueOnce(Response.json({ ...pull(), head: { sha: "c".repeat(40) } }));
    expect(await f.read("company-a", [identity])).toMatchObject({ status: "observed", pullRequests: [{ headSha: "c".repeat(40) }] });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(authorization.resolve).toHaveBeenCalledTimes(3);
  });

  it("snapshots identities before asynchronous authorization", async () => {
    const f = fixture();
    const supplied = { ...identity };
    authorization.resolve.mockImplementationOnce(async () => { supplied.repository = "other/repo"; supplied.number = 99; return "fixture-token"; });
    expect(await f.read("company-a", [supplied])).toMatchObject({ status: "observed", pullRequests: [{ repository: "acme/repo", number: 17 }] });
    expect(f.fetch).toHaveBeenCalledWith("https://api.github.com/repos/acme/repo/pulls/17", expect.anything());
  });

  it("accepts case-insensitive repository and SHA spelling without substituting the identity", async () => {
    const f = fixture({ ...pull(), head: { sha: HEAD.toUpperCase() }, merge_commit_sha: MERGE.toUpperCase() });
    expect(await f.read("company-a", [{ ...identity, repository: "ACME/REPO" }])).toMatchObject({ status: "observed", pullRequests: [{ repository: "acme/repo", headSha: HEAD, mergeCommitSha: MERGE }] });
  });

  it("cancels an oversized stream and returns no evidence", async () => {
    const f = fixture(), cancel = vi.fn();
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel })));
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "response_too_large" });
    expect(cancel).toHaveBeenCalled();
  });

  it.each(["{invalid", "", "[null]"])("rejects invalid or partial JSON %j", async body => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(body));
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "invalid_response" });
  });

  it("cancels a stalled body on the shared deadline without waiting for another chunk", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => {
      setImmediate(() => controller.abort());
      return new Response(new ReadableStream({ cancel }));
    });
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "deadline_exceeded" });
    expect(cancel).toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledWith(20_000);
  });

  it("passes cancellation to the active HTTP request", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const f = fixture();
    f.fetch.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("sensitive timeout response")), { once: true });
      controller.abort();
    }));
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "deadline_exceeded" });
  });

  it("does not log or return sensitive provider failures", async () => {
    const f = fixture();
    f.fetch.mockRejectedValueOnce(new Error("fixture-token sensitive provider response"));
    expect(await f.read("company-a", [identity])).toEqual({ status: "unavailable", reason: "provider_unavailable" });
  });
});
