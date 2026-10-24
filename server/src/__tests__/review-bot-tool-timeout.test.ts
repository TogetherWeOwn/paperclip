import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Exercise the exact deadline policy without dispatching an external provider.
const source = readFileSync(new URL("../services/tool-gateway.ts", import.meta.url), "utf8");
const constants = ["DEFAULT_TOOL_TIMEOUT_MS", "GITHUB_BOT_TOOL_TIMEOUT_MS"].map((name) =>
  source.match(new RegExp(`const ${name} = [0-9_]+;`))?.[0] ?? "",
).join("\n");
const policy = source.match(/function timeoutMs\(value: number \| undefined(?:, tool\?: ToolGatewayDescriptor)?\) \{[\s\S]*?\n\}/)![0]
  .replace("value: number | undefined", "value")
  .replace(", tool?: ToolGatewayDescriptor", ", tool");
const timeoutMs = runInNewContext(`${constants}\n${policy}\ntimeoutMs`) as
  (value: number | undefined, tool?: { providerType: string }) => number;

describe("review bot tool deadline policy", () => {
  it("gives review publication the full supported default deadline", () => {
    expect(timeoutMs(undefined, { providerType: "paperclip_github_chat" })).toBe(60_000);
    expect(timeoutMs(Number.NaN, { providerType: "paperclip_github_chat" })).toBe(60_000);
  });
  it("preserves the ordinary tool default", () => {
    expect(timeoutMs(undefined)).toBe(10_000);
    expect(timeoutMs(undefined, { providerType: "paperclip_plugin" })).toBe(10_000);
  });
  it("preserves explicit deadlines, clamps and rounding for every provider", () => {
    for (const providerType of ["paperclip_plugin", "paperclip_github_chat"]) {
      expect(timeoutMs(2_500.8, { providerType })).toBe(2_500);
      expect(timeoutMs(0, { providerType })).toBe(1);
      expect(timeoutMs(120_000, { providerType })).toBe(60_000);
    }
  });
});
