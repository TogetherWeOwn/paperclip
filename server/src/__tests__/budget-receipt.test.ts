import { describe, expect, it } from "vitest";
import {
  toBoundedBudgetFractionReceipt,
  toBoundedReapReceipt,
} from "../services/budget-receipt.js";

describe("toBoundedBudgetFractionReceipt", () => {
  it("bounds a numeric fraction to 4 decimals with injected=true", () => {
    expect(toBoundedBudgetFractionReceipt(0.123456)).toEqual({
      injected: true,
      budgetSpentFraction: 0.1235,
    });
  });

  it("preserves overspend above 1 without clamping", () => {
    const receipt = toBoundedBudgetFractionReceipt(1.5);
    expect(receipt.injected).toBe(true);
    expect(receipt.budgetSpentFraction).toBe(1.5);
  });

  it("maps undefined and non-finite to an absent stamp", () => {
    expect(toBoundedBudgetFractionReceipt(undefined)).toEqual({ injected: false });
    expect(toBoundedBudgetFractionReceipt(NaN)).toEqual({ injected: false });
    expect(toBoundedBudgetFractionReceipt(Infinity)).toEqual({ injected: false });
  });

  it("emits only the bounded number (no raw payload passthrough)", () => {
    const receipt = toBoundedBudgetFractionReceipt(0.1);
    expect(Object.keys(receipt).sort()).toEqual(["budgetSpentFraction", "injected"]);
    expect(typeof receipt.budgetSpentFraction).toBe("number");
  });
});

describe("toBoundedReapReceipt", () => {
  it("extracts bounded router cancel counts", () => {
    expect(
      toBoundedReapReceipt({ runId: "run-1", cancelled: 2, alreadyTerminal: 1, failed: 0 }),
    ).toEqual({ cancelled: 2, alreadyTerminal: 1, failed: 0, unshaped: false });
  });

  it("counts the router's real array-of-IDs result shape", () => {
    expect(
      toBoundedReapReceipt({
        runId: "worker-run-9",
        cancelled: ["req-1", "req-2"],
        alreadyTerminal: ["req-3"],
        failed: [],
      }),
    ).toEqual({ cancelled: 2, alreadyTerminal: 1, failed: 0, unshaped: false });
  });

  it("accepts boolean counts as 0/1", () => {
    expect(
      toBoundedReapReceipt({ cancelled: true, alreadyTerminal: false, failed: 0 }),
    ).toEqual({ cancelled: 1, alreadyTerminal: 0, failed: 0, unshaped: false });
  });

  it("marks null, missing, or out-of-range shapes without payload passthrough", () => {
    for (const shaped of [null, undefined, "ok", 42, {}, { cancelled: 1 }]) {
      const receipt = toBoundedReapReceipt(shaped);
      expect(receipt.unshaped).toBe(true);
      expect(receipt).toEqual({ cancelled: 0, alreadyTerminal: 0, failed: 0, unshaped: true });
    }
    expect(toBoundedReapReceipt({ cancelled: -1, alreadyTerminal: 0, failed: 0 }).unshaped).toBe(true);
  });

  it("never passes the worker payload through", () => {
    const receipt = toBoundedReapReceipt({
      runId: "run-1",
      cancelled: 1,
      alreadyTerminal: 0,
      failed: 0,
      extra: "unbounded",
    });
    expect("extra" in receipt).toBe(false);
    expect("runId" in receipt).toBe(false);
    expect(Object.keys(receipt).sort()).toEqual([
      "alreadyTerminal",
      "cancelled",
      "failed",
      "unshaped",
    ]);
  });
});
