import { describe, expect, it } from "vitest";
import {
  githubHeadGreenState,
  githubHeadTransition,
  type GitHubCheckRunSummary,
} from "./chat-github-green-gate.js";

const run = (
  name: string,
  status: string,
  conclusion: string | null,
  started_at = "2026-10-10T10:00:00Z",
  id = 1,
): GitHubCheckRunSummary => ({ name, status, conclusion, started_at, id });

describe("githubHeadGreenState", () => {
  it("is green when every required check completed green", () => {
    expect(
      githubHeadGreenState(
        [run("ci-ok", "completed", "success"), run("pr-lint", "completed", "skipped")],
        ["ci-ok", "pr-lint", "Paperclip Review"],
      ),
    ).toBe("green");
  });

  it("ignores the Paperclip Review check itself", () => {
    expect(
      githubHeadGreenState(
        [run("ci-ok", "completed", "success"), run("Paperclip Review", "completed", "failure")],
        ["ci-ok"],
      ),
    ).toBe("green");
  });

  it("is pending while a required check is missing or running", () => {
    expect(githubHeadGreenState([run("lint", "completed", "success")], ["ci-ok"])).toBe(
      "pending",
    );
    expect(githubHeadGreenState([run("ci-ok", "in_progress", null)], ["ci-ok"])).toBe(
      "pending",
    );
  });

  it("does not wait on slow non-required checks", () => {
    expect(
      githubHeadGreenState(
        [run("ci-ok", "completed", "success"), run("nightly", "in_progress", null)],
        ["ci-ok"],
      ),
    ).toBe("green");
  });

  it("is red when any completed check failed, required or not", () => {
    expect(
      githubHeadGreenState(
        [run("ci-ok", "completed", "success"), run("e2e", "completed", "failure")],
        ["ci-ok"],
      ),
    ).toBe("red");
  });

  it("uses the latest attempt of a re-run check", () => {
    expect(
      githubHeadGreenState(
        [
          run("ci-ok", "completed", "failure", "2026-10-10T10:00:00Z", 1),
          run("ci-ok", "completed", "success", "2026-10-10T10:05:00Z", 2),
        ],
        ["ci-ok"],
      ),
    ).toBe("green");
  });

  it("without required checks needs at least one check and all of them green", () => {
    expect(githubHeadGreenState([], [])).toBe("pending");
    expect(githubHeadGreenState([run("a", "in_progress", null)], [])).toBe("pending");
    expect(githubHeadGreenState([run("a", "completed", "success")], [])).toBe("green");
  });
});

describe("githubHeadTransition", () => {
  const head = "a".repeat(40);
  it("reports the new head on synchronize", () => {
    expect(
      githubHeadTransition({
        action: "synchronize",
        repository: { id: 42 },
        pull_request: { number: 7, head: { sha: head.toUpperCase() } },
      }),
    ).toEqual({ repositoryId: "42", pullNumber: 7, currentHeadSha: head });
  });

  it("reports no current head on close", () => {
    expect(
      githubHeadTransition({
        action: "closed",
        repository: { id: "42" },
        pull_request: { number: 7, head: { sha: head } },
      }),
    ).toEqual({ repositoryId: "42", pullNumber: 7, currentHeadSha: null });
  });

  it("ignores other actions and malformed payloads", () => {
    expect(
      githubHeadTransition({
        action: "opened",
        repository: { id: 42 },
        pull_request: { number: 7, head: { sha: head } },
      }),
    ).toBeNull();
    expect(
      githubHeadTransition({
        action: "synchronize",
        repository: { id: 42 },
        pull_request: { number: 7, head: { sha: "nope" } },
      }),
    ).toBeNull();
    expect(githubHeadTransition(null)).toBeNull();
  });
});
