import { describe, expect, it } from "vitest";
import {
  RUN_GATEWAY_TOKEN_DEFAULT_TTL_MS,
  RUN_GATEWAY_TOKEN_MAX_TTL_MS,
  RUN_GATEWAY_TOKEN_MIN_TTL_MS,
  runGatewayTokenTtlMs,
} from "./run-preparation.js";

describe("runGatewayTokenTtlMs", () => {
  it("uses one hour when the variable is not set", () => {
    expect(RUN_GATEWAY_TOKEN_DEFAULT_TTL_MS).toBe(60 * 60 * 1000);
    expect(runGatewayTokenTtlMs({})).toBe(RUN_GATEWAY_TOKEN_DEFAULT_TTL_MS);
    expect(runGatewayTokenTtlMs({ PAPERCLIP_RUN_GATEWAY_TOKEN_TTL_MS: "  " })).toBe(RUN_GATEWAY_TOKEN_DEFAULT_TTL_MS);
  });

  it("uses a whole number of milliseconds from the variable", () => {
    expect(runGatewayTokenTtlMs({ PAPERCLIP_RUN_GATEWAY_TOKEN_TTL_MS: "86400000" })).toBe(86_400_000);
    expect(runGatewayTokenTtlMs({ PAPERCLIP_RUN_GATEWAY_TOKEN_TTL_MS: String(RUN_GATEWAY_TOKEN_MIN_TTL_MS) }))
      .toBe(RUN_GATEWAY_TOKEN_MIN_TTL_MS);
  });

  it.each(["24h", "8.64e7", "-1", "1e6", "0", "59999"])("uses the default for %s", (value) => {
    expect(runGatewayTokenTtlMs({ PAPERCLIP_RUN_GATEWAY_TOKEN_TTL_MS: value })).toBe(RUN_GATEWAY_TOKEN_DEFAULT_TTL_MS);
  });

  it("limits the lifetime to seven days", () => {
    expect(RUN_GATEWAY_TOKEN_MAX_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(runGatewayTokenTtlMs({ PAPERCLIP_RUN_GATEWAY_TOKEN_TTL_MS: "999999999999" })).toBe(RUN_GATEWAY_TOKEN_MAX_TTL_MS);
  });
});
