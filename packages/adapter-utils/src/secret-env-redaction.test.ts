import { describe, expect, it } from "vitest";
import {
  collectKnownSecretEnvValues,
  createSecretEnvRedactionStream,
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

  it("redacts overlapping occurrences as one range", () => {
    expect(redactKnownSecretEnvValues("BBBBB", ["BBBB"])).toBe(
      "***REDACTED***",
    );
  });

  it("is a no-op when there is nothing to redact", () => {
    expect(redactKnownSecretEnvValues("hello world", [])).toBe("hello world");
    expect(redactKnownSecretEnvValues("", ["x-secret-value"])).toBe("");
  });
});

describe("createSecretEnvRedactionStream", () => {
  const SECRET = "postgres://user:p4ssw0rd@db.internal:5432/paperclip";

  it("redacts a secret split across two chunks", () => {
    const stream = createSecretEnvRedactionStream([SECRET]);
    const split = 20;
    const out =
      stream.push("head " + SECRET.slice(0, split)) +
      stream.push(SECRET.slice(split) + " tail") +
      stream.flush();
    expect(out).not.toContain(SECRET);
    expect(out).toBe("head ***REDACTED*** tail");
  });

  it("redacts a secret split one character at a time", () => {
    const stream = createSecretEnvRedactionStream([SECRET]);
    let out = "";
    for (const ch of "x" + SECRET + "y") out += stream.push(ch);
    out += stream.flush();
    expect(out).not.toContain(SECRET);
    expect(out).toBe("x***REDACTED***y");
  });

  it("does not drop, duplicate or reorder output when nothing matches", () => {
    const stream = createSecretEnvRedactionStream([SECRET]);
    const chunks = ["alpha ", "beta ", "gamma ", "delta"];
    let out = "";
    for (const chunk of chunks) out += stream.push(chunk);
    out += stream.flush();
    expect(out).toBe(chunks.join(""));
  });

  it("does not split a complete match when its suffix is also a secret prefix", () => {
    const stream = createSecretEnvRedactionStream(["abcabc"]);
    const out = stream.push("abcabc") + stream.flush();
    expect(out).toBe("***REDACTED***");
  });

  it("retains a shorter safe suffix when a longer candidate crosses a match", () => {
    const secret = "AAABAAA";
    const stream = createSecretEnvRedactionStream([secret]);
    const out = stream.push("AAABAAAA") + stream.push("AABAAA") + stream.flush();
    expect(out).not.toContain(secret);
    expect(out).toBe("***REDACTED******REDACTED***");
  });

  it("redacts periodic overlapping values across chunks", () => {
    const secret = "ABABAB";
    const stream = createSecretEnvRedactionStream([secret]);
    const out = stream.push("ABABABAB") + stream.push("ABAB") + stream.flush();
    expect(out).not.toContain(secret);
    expect(out).toBe("***REDACTED***ABAB");
  });

  it("redacts repeated-character overlaps across chunks", () => {
    const secret = "BBBBBB";
    const stream = createSecretEnvRedactionStream([secret]);
    const out = stream.push("BBBBBBB") + stream.push("BBBBB") + stream.flush();
    expect(out).not.toContain(secret);
    expect(out).toBe("***REDACTED***BBBBB");
  });

  it("passes chunks straight through when there are no secrets", () => {
    const stream = createSecretEnvRedactionStream([]);
    expect(stream.push("anything at all")).toBe("anything at all");
    expect(stream.flush()).toBe("");
  });

  it("holds back no more than the longest secret", () => {
    const stream = createSecretEnvRedactionStream([SECRET]);
    const emitted = stream.push("z".repeat(10_000));
    expect(10_000 - emitted.length).toBeLessThan(SECRET.length);
  });
});
