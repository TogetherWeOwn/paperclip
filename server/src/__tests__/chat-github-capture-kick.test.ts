import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { GitHubReviewEventContext } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { kickGitHubPairCapture, prepareGitHubPairEvent, setGitHubPairCaptureKickForTests, settleGitHubPairCaptureKicks } from "../services/chat-github-shadow.js";
import {
  githubShadowCaptureClaimStaleMs, githubShadowCaptureWindowMs, githubShadowSnapshotBudgetMs, parseGitHubShadowDurationMs,
} from "../services/chat-github-shadow-timing.js";
import { captureGitHubReviewSnapshot, type GitHubReviewReader } from "../services/chat-github-review-snapshot.js";

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getExperimental: async () => ({ githubReviewShadowEnabled: true }) }),
}));
vi.mock("../services/chat-github-client.js", async importOriginal => {
  const original = await importOriginal<typeof import("../services/chat-github-client.js")>();
  return {
    ...original,
    githubBotRepositoryToken: async () => "fixture-token",
    // Shadow capture routes through the shared helper; keep the fixture token
    // so these timing tests never touch credential resolution.
    githubBotRepositoryRequest: async <T>(
      _db: unknown, _companyId: string, _endpointId: string, _repositoryId: string,
      path: string, options: Parameters<typeof original.githubBotRequest>[3] = {},
      fetchImpl: typeof fetch = fetch,
    ): Promise<T> => original.githubBotRequest<T>(fetchImpl, "fixture-token", path, options),
  };
});

const ENV = ["PAPERCLIP_GITHUB_SHADOW_CAPTURE_WINDOW_MS", "PAPERCLIP_GITHUB_SHADOW_SNAPSHOT_BUDGET_MS"] as const;
const saved = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
afterEach(() => {
  setGitHubPairCaptureKickForTests(undefined);
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GitHub shadow capture timing configuration", () => {
  it.each([
    [undefined, 15_000], ["", 15_000], ["  ", 15_000], ["abc", 15_000], ["12.5", 15_000], ["-1", 15_000], ["0", 15_000],
    ["1e5", 15_000], ["99999999999999999999", 15_000],
    ["1", 5_000], ["4999", 5_000], ["5000", 5_000], ["60000", 60_000], [" 45000 ", 45_000], ["300000", 300_000], ["300001", 300_000],
  ] as const)("parses %j as %i ms", (raw, expected) => {
    expect(parseGitHubShadowDurationMs(raw)).toBe(expected);
    expect(githubShadowCaptureWindowMs({ PAPERCLIP_GITHUB_SHADOW_CAPTURE_WINDOW_MS: raw })).toBe(expected);
    expect(githubShadowSnapshotBudgetMs({ PAPERCLIP_GITHUB_SHADOW_SNAPSHOT_BUDGET_MS: raw })).toBe(expected);
  });
  it("reads the two variables independently", () => {
    const env = { PAPERCLIP_GITHUB_SHADOW_CAPTURE_WINDOW_MS: "60000", PAPERCLIP_GITHUB_SHADOW_SNAPSHOT_BUDGET_MS: "20000" };
    expect(githubShadowCaptureWindowMs(env)).toBe(60_000);
    expect(githubShadowSnapshotBudgetMs(env)).toBe(20_000);
  });
  it("keeps the historical 30 s claim staleness and outlives any configured window", () => {
    expect(githubShadowCaptureClaimStaleMs({})).toBe(30_000);
    for (const raw of ["5000", "60000", "300000"]) {
      const env = { PAPERCLIP_GITHUB_SHADOW_CAPTURE_WINDOW_MS: raw };
      expect(githubShadowCaptureClaimStaleMs(env)).toBeGreaterThan(githubShadowCaptureWindowMs(env));
    }
  });
  it("honours a configured admission window instead of a fixed 15 s", async () => {
    process.env.PAPERCLIP_GITHUB_SHADOW_CAPTURE_WINDOW_MS = "60000";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T00:00:30.000Z"));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const transport = vi.fn<typeof fetch>(async () => { throw new Error("stop after deadline is computed"); });
    await prepareGitHubPairEvent({} as Db, {
      endpoint: { id: "endpoint", companyId: "company", botUsername: "review-bot", botExternalId: "1" } as never,
      repositoryId: "97531", repository: "org/repo", threadId: "github:org/repo:81", eventId: "event",
      principal: { externalId: "42", handle: "author" },
      pending: { version: 1, admittedAt: "2026-10-18T00:00:00.000Z", settingsEpoch: "epoch", revision: 1, providerEventId: "event", arms: [] },
    }, transport);
    // 30 s after admission: 30 s of a 60 s window remain (15 s would be late, 0).
    expect(timeout).toHaveBeenCalledWith(30_000);
  });
  it("applies the configured snapshot read budget", async () => {
    const head = "b".repeat(40), base = "a".repeat(40);
    const event: GitHubReviewEventContext = { event: "mention", deliveryId: "event", repositoryId: "1", repository: "acme/repo", pullNumber: 7,
      headSha: head, baseSha: base, baseBranch: "main", title: "PR", body: "", draft: false,
      author: { id: "1", login: "author", isBot: false }, sender: { id: "1", login: "author" }, labels: [] };
    const slowProvider = (): GitHubReviewReader => {
      let advanced = false;
      return { request: async <T>(path: string) => {
        // The first read takes 7 s of wall clock.
        if (!advanced) { advanced = true; vi.setSystemTime(Date.now() + 7_000); }
        if (path === "/pulls/7") return { head: { sha: head }, base: { sha: base }, body: "" } as T;
        if (path.includes("/compare/")) return { merge_base_commit: { sha: "e".repeat(40) } } as T;
        if (path.includes("/check-runs?")) return { check_runs: [] } as T;
        return [] as T;
      } };
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
    await expect(captureGitHubReviewSnapshot(slowProvider(), event, undefined, "repository_artifact_disabled")).resolves.toBeDefined();
    process.env.PAPERCLIP_GITHUB_SHADOW_SNAPSHOT_BUDGET_MS = "5000";
    await expect(captureGitHubReviewSnapshot(slowProvider(), event, undefined, "repository_artifact_disabled"))
      .rejects.toThrow("snapshot_capture_budget_exceeded");
  });
});

describe("GitHub paired capture admission kick", () => {
  it.each(["hanging", "throwing", "rejecting"] as const)("never blocks or throws into the caller (%s capture)", async mode => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let release!: () => void;
    const kick = vi.fn(mode === "hanging" ? () => new Promise<void>(resolve => { release = resolve; })
      : mode === "throwing" ? () => { throw new Error("injected synchronous capture failure"); }
        : async () => { throw new Error("injected capture rejection"); });
    setGitHubPairCaptureKickForTests(kick);
    const deliveryId = `kick-${mode}`;
    expect(kickGitHubPairCapture({} as Db, deliveryId, fetch)).toBeUndefined();
    // Not even started on the caller's stack: the primary path continues first.
    expect(kick).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(kick).toHaveBeenCalledTimes(1));
    if (mode === "hanging") {
      // A second kick for an in-flight delivery is a no-op.
      kickGitHubPairCapture({} as Db, deliveryId, fetch);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(kick).toHaveBeenCalledTimes(1);
      release();
    } else {
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.objectContaining({ deliveryId }),
        "GitHub paired snapshot capture kick failed; recovery sweep will retry"));
    }
    await settleGitHubPairCaptureKicks();
    // Settled kicks leave the in-flight set: a later wake may kick again.
    kickGitHubPairCapture({} as Db, deliveryId, fetch);
    await vi.waitFor(() => expect(kick).toHaveBeenCalledTimes(2));
    release?.();
    await settleGitHubPairCaptureKicks();
  });
  it("bounds how long a sweep waits for a stalled kick", async () => {
    process.env.PAPERCLIP_GITHUB_SHADOW_CAPTURE_WINDOW_MS = "5000";
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let release!: () => void;
    setGitHubPairCaptureKickForTests(() => new Promise<void>(resolve => { release = resolve; }));
    kickGitHubPairCapture({} as Db, "kick-stalled", fetch);
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    const sweep = settleGitHubPairCaptureKicks().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await sweep;
    // A later sweep does not wait again for the same stalled kick.
    let again = false;
    const next = settleGitHubPairCaptureKicks().then(() => { again = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toBe(true);
    await next;
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
});
