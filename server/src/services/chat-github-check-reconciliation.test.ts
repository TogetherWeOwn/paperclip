import { describe, expect, it, vi } from "vitest";
import {
  findGitHubReviewChecks,
  hasReconciledGitHubCheckUrl,
  rememberGitHubCheckUrl,
  type GitHubReviewCheckRun,
} from "./chat-github-check-reconciliation.js";

function checkRun(
  id: number,
  externalId: string,
  appId: number,
  detailsUrl?: string,
): GitHubReviewCheckRun {
  return {
    id,
    external_id: externalId,
    details_url: detailsUrl,
    app: { id: appId },
  };
}

describe("GitHub review check reconciliation", () => {
  it("finds every matching check across results pages", async () => {
    const externalId = "endpoint:pull:head";
    const publicUrl = "https://github.com/paperclipai/paperclip/pull/91";
    const staleUrl = "https://github.com/paperclipai/paperclip/issues/91";
    const publicCheck = checkRun(1, externalId, 42, publicUrl);
    const firstPage = [
      publicCheck,
      ...Array.from({ length: 99 }, (_, index) =>
        checkRun(index + 2, `other:${index}`, 42),
      ),
    ];
    const staleCheck = checkRun(101, externalId, 42, staleUrl);
    const requested: string[] = [];
    const found = await findGitHubReviewChecks(
      async (path) => {
        requested.push(path);
        return {
          check_runs: requested.length === 1 ? firstPage : [staleCheck],
        };
      },
      "a".repeat(40),
      externalId,
      "42",
    );

    expect(found).toEqual([publicCheck, staleCheck]);
    expect(requested).toHaveLength(2);
    const firstQuery = new URL(
      requested[0]!,
      "https://api.github.com",
    ).searchParams;
    expect(firstQuery.get("check_name")).toBe("Paperclip Review");
    expect(firstQuery.get("filter")).toBe("all");
    expect(firstQuery.get("app_id")).toBe("42");
    expect(firstQuery.get("per_page")).toBe("100");
    expect(firstQuery.get("page")).toBe("1");
    expect(
      new URL(requested[1]!, "https://api.github.com").searchParams.get("page"),
    ).toBe("2");
  });

  it("stops when a page is not full", async () => {
    let requests = 0;
    const found = await findGitHubReviewChecks(
      async () => {
        requests += 1;
        return { check_runs: [checkRun(1, "unrelated", 42)] };
      },
      "b".repeat(40),
      "endpoint:pull:head",
      "42",
    );

    expect(found).toEqual([]);
    expect(requests).toBe(1);
  });

  it("caches verified URLs by app and external id with a bounded LRU", () => {
    const url = "https://github.com/owner/repo/pull/1";
    rememberGitHubCheckUrl("known", "42", url);
    expect(hasReconciledGitHubCheckUrl("known", "42", url)).toBe(true);
    expect(
      hasReconciledGitHubCheckUrl(
        "known",
        "42",
        "https://github.com/owner/repo/pull/2",
      ),
    ).toBe(false);
    expect(hasReconciledGitHubCheckUrl("known", "43", url)).toBe(false);

    for (let index = 0; index <= 512; index += 1) {
      if (index === 511) expect(hasReconciledGitHubCheckUrl("known", "42", url)).toBe(true);
      rememberGitHubCheckUrl(`bounded-${index}`, "42", url);
    }
    expect(hasReconciledGitHubCheckUrl("known", "42", url)).toBe(true);
    expect(hasReconciledGitHubCheckUrl("bounded-0", "42", url)).toBe(false);
  });

  it("rechecks URLs after the verification cache expires", () => {
    vi.useFakeTimers();
    try {
      const url = "https://github.com/owner/repo/pull/1";
      rememberGitHubCheckUrl("expires", "42", url);
      expect(hasReconciledGitHubCheckUrl("expires", "42", url)).toBe(true);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(hasReconciledGitHubCheckUrl("expires", "42", url)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
