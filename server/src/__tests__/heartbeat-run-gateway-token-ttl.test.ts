import { afterEach, describe, expect, it } from "vitest";
import { heartbeatRunGatewayTokenTtlMs } from "../services/heartbeat.js";

const ENV_KEY = "PAPERCLIP_RUN_GATEWAY_TOKEN_TTL_MS";
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe("heartbeat run gateway token TTL", () => {
  it("defaults to 24 hours when the override is unset", () => {
    delete process.env[ENV_KEY];
    expect(heartbeatRunGatewayTokenTtlMs()).toBe(24 * 60 * 60 * 1_000);
  });

  it("honors a positive millisecond override", () => {
    process.env[ENV_KEY] = String(60 * 60 * 1_000);
    expect(heartbeatRunGatewayTokenTtlMs()).toBe(60 * 60 * 1_000);
  });

  it("falls back to the default for missing or invalid overrides", () => {
    for (const value of ["", "0", "-5", "not-a-number"]) {
      process.env[ENV_KEY] = value;
      expect(heartbeatRunGatewayTokenTtlMs()).toBe(24 * 60 * 60 * 1_000);
    }
  });
});
