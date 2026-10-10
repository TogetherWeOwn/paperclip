import { describe, expect, it } from "vitest";
import { githubPullThreadKey } from "./chat-github-events.js";

describe("githubPullThreadKey", () => {
  it("normalizes repository casing so one PR maps to one key", () => {
    // The automatic-review path binds `github:acme/<repo>:<pr>` while the
    // adapter mention path binds `github:Acme/<repo>:<pr>`. Both must resolve
    // to one card.
    expect(githubPullThreadKey("github:Acme/demo-app:568")).toBe(
      "github:acme/demo-app:568",
    );
    expect(githubPullThreadKey("github:acme/demo-app:568")).toBe(
      "github:acme/demo-app:568",
    );
  });

  it("rejects review-comment, issue, and non-GitHub threads", () => {
    expect(githubPullThreadKey("github:owner/repo:42:rc:123")).toBeNull();
    expect(githubPullThreadKey("github:owner/repo:issue:42")).toBeNull();
    expect(githubPullThreadKey("github:owner/repo")).toBeNull();
    expect(githubPullThreadKey("github:owner/repo:0")).toBeNull();
    expect(githubPullThreadKey("github:owner/repo:abc")).toBeNull();
    expect(githubPullThreadKey("slack:C123:456")).toBeNull();
    expect(githubPullThreadKey("")).toBeNull();
  });
});
