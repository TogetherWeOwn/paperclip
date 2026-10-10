import { describe, expect, it } from "vitest";
import { createDecisionRetentionSweep } from "../services/decision-retention.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createDecisionRetentionSweep", () => {
  it("skips ticks while a sweep is still running", async () => {
    const pending = deferred<number>();
    let feedBuilds = 0;
    const sweep = createDecisionRetentionSweep({
      archiveIdleItems: () => {
        feedBuilds += 1;
        return pending.promise;
      },
      deliverNotifications: async () => ({ notifiedAgents: 0, delivered: 0 }),
      feedSweepIntervalMs: 0,
    });

    const first = sweep.run();
    expect(first).not.toBeNull();
    expect(sweep.run()).toBeNull();
    expect(sweep.run()).toBeNull();

    pending.resolve(2);
    await expect(first).resolves.toEqual({ feedSwept: true, archived: 2, notifiedAgents: 0, delivered: 0 });
    expect(feedBuilds).toBe(1);

    await sweep.run();
    expect(feedBuilds).toBe(2);
  });

  it("builds the feed at most once per interval but delivers notifications every sweep", async () => {
    let nowMs = 1_000;
    let feedBuilds = 0;
    let deliveries = 0;
    const sweep = createDecisionRetentionSweep({
      archiveIdleItems: async () => {
        feedBuilds += 1;
        return 0;
      },
      deliverNotifications: async () => {
        deliveries += 1;
        return { notifiedAgents: 1, delivered: 1 };
      },
      feedSweepIntervalMs: 60_000,
      now: () => nowMs,
    });

    await expect(sweep.run()).resolves.toMatchObject({ feedSwept: true });
    nowMs += 30_000;
    await expect(sweep.run()).resolves.toEqual({ feedSwept: false, archived: 0, notifiedAgents: 1, delivered: 1 });
    nowMs += 30_000;
    await expect(sweep.run()).resolves.toMatchObject({ feedSwept: true });

    expect(feedBuilds).toBe(2);
    expect(deliveries).toBe(3);
  });

  it("releases the single-flight slot after a failed sweep", async () => {
    let attempts = 0;
    const sweep = createDecisionRetentionSweep({
      archiveIdleItems: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("feed build failed");
        return 0;
      },
      deliverNotifications: async () => ({ notifiedAgents: 0, delivered: 0 }),
      feedSweepIntervalMs: 0,
    });

    await expect(sweep.run()).rejects.toThrow("feed build failed");
    await expect(sweep.run()).resolves.toMatchObject({ feedSwept: true });
    expect(attempts).toBe(2);
  });
});
