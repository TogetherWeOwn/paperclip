import { describe, expect, it } from "vitest";
import {
  collectKnownSecretEnvValues,
  KNOWN_SECRET_ENV_VAR_NAMES,
  redactKnownSecretEnvValues,
} from "./secret-env-redaction.js";

describe("collectKnownSecretEnvValues", () => {
  it("collects values for known secret env names only", () => {
    const values = collectKnownSecretEnvValues({
      DATABASE_URL: "postgres://user:pass@host:5432/db",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-abcdefghijklmnop",
    });
    expect(values).toContain("postgres://user:pass@host:5432/db");
    expect(values).toContain("sk-ant-abcdefghijklmnop");
    expect(values).not.toContain("/usr/bin");
  });

  it("drops values shorter than the minimum redactable length", () => {
    const values = collectKnownSecretEnvValues({ DATABASE_URL: "x" });
    expect(values).toHaveLength(0);
  });

  it("supports extending the denylist by name, not by learning from values", () => {
    const values = collectKnownSecretEnvValues(
      { CUSTOM_TENANT_SECRET: "some-extended-secret-value" },
      ["CUSTOM_TENANT_SECRET"],
    );
    expect(values).toContain("some-extended-secret-value");
  });

  it("includes the seed names from the originating scan", () => {
    for (const name of [
      "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "BETTER_AUTH_SECRET",
    ]) {
      expect(KNOWN_SECRET_ENV_VAR_NAMES).toContain(name);
    }
  });
});

describe("redactKnownSecretEnvValues", () => {
  it("replaces every occurrence of a known secret value", () => {
    const out = redactKnownSecretEnvValues(
      "DATABASE_URL=leaked-secret-value\nagain: leaked-secret-value",
      ["leaked-secret-value"],
    );
    expect(out).not.toContain("leaked-secret-value");
    expect(out.match(/\*\*\*REDACTED\*\*\*/g)?.length).toBe(2);
  });

  it("prefers the longer match when one secret value is a substring of another", () => {
    const out = redactKnownSecretEnvValues("prefix-secret-suffix-tail", [
      "prefix-secret-suffix-tail",
      "secret-suffix",
    ]);
    expect(out).toBe("***REDACTED***");
  });

  it("is a no-op when there is nothing to redact", () => {
    expect(redactKnownSecretEnvValues("hello world", [])).toBe("hello world");
    expect(redactKnownSecretEnvValues("", ["x-secret-value"])).toBe("");
  });
});
