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
});
