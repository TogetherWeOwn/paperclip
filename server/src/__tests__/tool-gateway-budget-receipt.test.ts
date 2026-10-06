import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Both gateway injection sites must emit a bounded receipt (numeric success
// or undefined/error degradation) correlated with safe run/request IDs.
// Behavior is preserved: the host-computed value still overwrites caller
// JSON, and undefined still means absent downstream.
const here = dirname(fileURLToPath(import.meta.url));
const gatewaySrc = readFileSync(join(here, "../services/tool-gateway.ts"), "utf8");

describe("tool-gateway budget receipts", () => {
  it("emits success and degradation receipts at both injection sites", () => {
    const hits = gatewaySrc.match(/budget fraction (injected|absent; omitted from stamp|lookup failed; omitted from stamp)/g) ?? [];
    // Two sites (plugin execute + gateway execute) × success/absent/error.
    expect(hits.length).toBeGreaterThanOrEqual(6);
    expect(gatewaySrc).toContain("toBoundedBudgetFractionReceipt");
  });

  it("correlates receipts with safe run/request IDs only", () => {
    expect(gatewaySrc).toContain("runId:");
    expect(gatewaySrc).toContain("invocationId");
    // No prompts, raw args, credentials, or headers in the receipt logger
    // objects: extract each logger call that emits a budget receipt.
    const receiptCalls = gatewaySrc.match(/logger\.(info|warn)\(\s*\{[^}]*\}[\s\S]{0,120}?budget fraction/g) ?? [];
    expect(receiptCalls.length).toBeGreaterThan(0);
    for (const block of receiptCalls) {
      expect(block).not.toContain("effectiveParameters");
      expect(block).not.toContain("requestedParameters");
      expect(block).not.toContain("callerHeaders");
      expect(block).not.toContain("prompt");
    }
  });

  it("preserves overwrite semantics (host value wins, undefined means absent)", () => {
    expect(gatewaySrc).toContain("budgetSpentFraction: h5Fraction");
    expect(gatewaySrc).toContain("budgetSpentFraction: b2Fraction");
  });

  it("stamps the raw fraction (rounding is log-only for router gating)", () => {
    // The router gates on the stamped value with >= thresholds, so the stamp
    // must stay unrounded; only the logged number is rounded to 4dp.
    expect(gatewaySrc).toContain("h5Fraction = h5Receipt.injected ? h5Raw : undefined");
    expect(gatewaySrc).toContain("b2Fraction = b2Receipt.injected ? b2Raw : undefined");
  });
});
