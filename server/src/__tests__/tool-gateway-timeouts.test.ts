import { describe, expect, it } from "vitest";
import { interactiveToolTimeoutMs } from "../services/tool-gateway.js";

describe("interactiveToolTimeoutMs", () => {
  it("gives review-bot and plugin tools more than the 10s interactive default", () => {
    expect(interactiveToolTimeoutMs("paperclip_github_chat", undefined)).toBe(45_000);
    expect(interactiveToolTimeoutMs("paperclip_plugin", undefined)).toBe(30_000);
  });

  it("keeps the 10s default for other providers", () => {
    expect(interactiveToolTimeoutMs("mcp_remote_http", undefined)).toBe(10_000);
    expect(interactiveToolTimeoutMs("provider_rest", undefined)).toBe(10_000);
  });

  it("honours an explicit caller timeout within the 60s ceiling", () => {
    expect(interactiveToolTimeoutMs("paperclip_github_chat", 5_000)).toBe(5_000);
    expect(interactiveToolTimeoutMs("mcp_remote_http", 120_000)).toBe(60_000);
  });
});
