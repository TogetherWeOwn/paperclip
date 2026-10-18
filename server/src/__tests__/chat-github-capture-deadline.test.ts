import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { GITHUB_PRIMARY_SEAL_WAIT_MS, prepareGitHubPairEvent } from "../services/chat-github-shadow.js";

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getExperimental: async () => ({ githubReviewShadowEnabled: true }) }),
}));
vi.mock("../services/chat-github-client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/chat-github-client.js")>(),
  githubBotRepositoryToken: async () => "fixture-token",
}));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("GitHub capture admission deadline", () => {
  it("bounds the optional primary wait to at most ten seconds", () => {
    expect(GITHUB_PRIMARY_SEAL_WAIT_MS).toBeGreaterThan(0);
    expect(GITHUB_PRIMARY_SEAL_WAIT_MS).toBeLessThanOrEqual(10_000);
  });
  it.each(["headers", "body"] as const)("aborts a stalled %s read at the original window, not 15 seconds after recovery", async stalled => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-18T00:00:14.000Z"));
    // Native AbortSignal timers do not use Vitest's clock. This implementation
    // preserves the real API's cancellation semantics on our deterministic clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/files?")) {
        signal = init!.signal!;
        // Deliberately ignore AbortSignal, as a broken transport can. Neither
        // stalled headers nor an unfinished response body may hold the sweep.
        if (stalled === "headers") { await blocked; return Response.json([]); }
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
      }
      return Response.json({ title: "fixture", body: "", draft: false, labels: [],
        head: { sha: "b".repeat(40) }, base: { sha: "a".repeat(40), ref: "main" }, user: { id: 42, login: "author" } });
    });
    const input: Parameters<typeof prepareGitHubPairEvent>[1] = {
      endpoint: { id: "endpoint", companyId: "company", botUsername: "review-bot", botExternalId: "1" } as never,
      repositoryId: "97531", repository: "org/repo", threadId: "github:org/repo:81", eventId: "event",
      principal: { externalId: "42", handle: "author" },
      pending: { version: 1, admittedAt: "2026-10-18T00:00:00.000Z", settingsEpoch: "epoch", revision: 1,
        providerEventId: "event", arms: [] },
    };
    let result: Awaited<ReturnType<typeof prepareGitHubPairEvent>> | undefined;
    const capture = prepareGitHubPairEvent({} as Db, input, transport).then(value => { result = value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(signal).toBeDefined();
      expect(timeout).toHaveBeenCalledWith(1000);
      await vi.advanceTimersByTimeAsync(999);
      expect(result).toBeUndefined();
      expect(signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal!.aborted).toBe(true);
      expect(result).toMatchObject({ snapshotFailure: "admission_snapshot_late" });
      expect(result?.snapshot).toBeUndefined();
    } finally {
      release();
      body?.enqueue(new TextEncoder().encode("[]"));
      body?.close();
      await vi.advanceTimersByTimeAsync(30_000);
      await capture;
    }
  });
});
