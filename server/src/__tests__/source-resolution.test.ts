import { validatePrpEvent } from "@paperclipai/paperclip-runner";
import { probeAcpxClaudeInstallation } from "@paperclipai/paperclip-runner/live";
import { definePlugin } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

describe("server development source resolution", () => {
  it("loads the SDK root and testing subpath without a package build", () => {
    expect(typeof definePlugin).toBe("function");
    expect(typeof createTestHarness).toBe("function");
  });

  it("loads runner source and its checked-in generated protocol validators", () => {
    const result = validatePrpEvent({});
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(typeof probeAcpxClaudeInstallation).toBe("function");
  });
});
