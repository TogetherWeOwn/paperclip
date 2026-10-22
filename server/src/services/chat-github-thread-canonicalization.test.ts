import { createGitHubAdapter } from "@chat-adapter/github";
import { describe, expect, it } from "vitest";

describe("GitHub adapter thread-id canonicalization", () => {
  // The pnpm patch on @chat-adapter/github lowercases owner/repo at every
  // thread-id minting point. Pin the real (patched) adapter here so a future
  // adapter bump or patch regeneration that drops those hunks goes red
  // instead of silently splitting PR threads and review runs again.
  // Dummy PAT: construction performs no network I/O; encodeThreadId and
  // getInstallationKey are pure functions of their inputs.
  const adapter = createGitHubAdapter({
    webhookSecret: "synthetic-webhook",
    token: "synthetic-pat",
  });

  it("mints PR, issue, and review-comment thread ids in lowercase", () => {
    expect(
      adapter.encodeThreadId({
        owner: "PaperclipAI",
        repo: "Paperclip",
        prNumber: 84,
      }),
    ).toBe("github:paperclipai/paperclip:84");
    expect(
      adapter.encodeThreadId({
        owner: "PaperclipAI",
        repo: "Paperclip",
        prNumber: 84,
        type: "issue",
      }),
    ).toBe("github:paperclipai/paperclip:issue:84");
    expect(
      adapter.encodeThreadId({
        owner: "PaperclipAI",
        repo: "Paperclip",
        prNumber: 84,
        reviewCommentId: 99080,
      }),
    ).toBe("github:paperclipai/paperclip:84:rc:99080");
  });

  it("canonicalizes installation keys to lowercase", () => {
    const keyed = adapter as unknown as {
      getInstallationKey(owner: string, repo: string): string;
    };
    expect(keyed.getInstallationKey("PaperclipAI", "Paperclip")).toBe(
      "github:install:paperclipai/paperclip",
    );
  });
});
