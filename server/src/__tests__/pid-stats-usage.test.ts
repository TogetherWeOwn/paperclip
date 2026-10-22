import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectPidStatsForUsageJson } from "../services/pid-stats-usage.js";

describe("selectPidStatsForUsageJson", () => {
  it("mirrors pidStats from resultJson into the usage spread", () => {
    const pidStats = {
      limit: 512,
      peak: 600,
      lastCount: 600,
      enforced: "poll",
      exceeded: true,
    };
    expect(
      selectPidStatsForUsageJson({ stdout: "", pidStats }),
    ).toEqual({ pidStats });
  });

  it("returns an empty spread when the adapter carried no accounting", () => {
    expect(selectPidStatsForUsageJson({ stdout: "" })).toEqual({});
    expect(selectPidStatsForUsageJson(null)).toEqual({});
    expect(selectPidStatsForUsageJson(undefined)).toEqual({});
    expect(selectPidStatsForUsageJson("not-an-object")).toEqual({});
    expect(selectPidStatsForUsageJson({ pidStats: null })).toEqual({});
  });

  it("pins the heartbeat usageJson mirror call site", () => {
    // The helper test above pins the helper, not heartbeat calling it: the
    // usageJson spread lives inside heartbeatService's run-finalization
    // closure, which has no narrower behavioral seam. This source pin fails
    // if the mirror call is ever deleted or detached from resultJson.
    const heartbeatSource = readFileSync(
      new URL("../services/heartbeat.ts", import.meta.url),
      "utf8",
    );
    expect(heartbeatSource).toContain(
      "...selectPidStatsForUsageJson(adapterResult.resultJson)",
    );
  });
});
