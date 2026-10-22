import { describe, expect, it } from "vitest";
import {
  REDACTED_COMMAND_TEXT_VALUE,
  redactCommandText,
  redactDiagnosticText,
} from "./command-redaction.js";

describe("redactDiagnosticText", () => {
  it("redacts a JSON secret field value", () => {
    const input = '{"token":"opaque-value","status":"error"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
    // The non-secret field keeps its value.
    expect(output).toContain('"status":"error"');
  });

  it("redacts an api_key JSON field with whitespace around the colon", () => {
    const input = '{ "api_key" : "sk-secret-123" }';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("sk-secret-123");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret field value", () => {
    // A diagnostic can carry a JSON string, so the double quotes appear as `\"`.
    const input = '{\\"token\\":\\"opaque-value\\"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(
      `\\"token\\":\\"${REDACTED_COMMAND_TEXT_VALUE}\\"`,
    );
  });

  it("still redacts a shell KEY=value secret", () => {
    const input = "ANTHROPIC_API_KEY=super-secret-value claude --print";
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("super-secret-value");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped quoted assignment across a literal newline", () => {
    const input = String.raw`authorization=\"Bearer first-line
second-line\" status=401`;
    const expected = String.raw`authorization=\"***REDACTED***\" status=401`;
    const output = redactDiagnosticText(input);
    expect(output).toBe(expected);
    expect(redactDiagnosticText(output)).toBe(expected);
  });

  it("keeps non-secret text and non-secret JSON fields intact", () => {
    const input = '{"status":"ok","message":"probe finished"}';
    expect(redactDiagnosticText(input)).toBe(input);
  });

  it("redacts the secret but keeps a non-secret marker in the same string", () => {
    const input = 'DIAGMARKER1234 said {"authorization":"Bearer opaque"}';
    const output = redactDiagnosticText(input);
    expect(output).toContain("DIAGMARKER1234");
    expect(output).not.toContain("opaque");
  });

  it("redacts a JSON secret value that contains an escaped quote", () => {
    // The value holds an escaped quote, so a naive matcher stops at the `\"` and
    // leaves the rest of the credential. The marker sits after the escaped quote.
    const input = '{"token":"pre\\"MARKERQUOTE_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_A");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts a JSON secret value that contains an escaped backslash", () => {
    const input = '{"secret":"pre\\\\MARKERBACKSLASH_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_A");
    expect(output).toContain(`"secret":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts an escaped-JSON secret value that contains an escaped quote", () => {
    // A diagnostic can carry a serialized JSON string, so the whole JSON is
    // escaped a second time. The inner value still holds an escaped quote.
    const innerJson = '{"token":"pre\\"MARKERQUOTE_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret value that contains an escaped backslash", () => {
    const innerJson = '{"password":"pre\\\\MARKERBACKSLASH_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });
});

describe("redactCommandText JWT windows", () => {
  const JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  it("redacts a three-segment JWT in unstructured text", () => {
    const output = redactCommandText(`session=${JWT} status=ok`);
    expect(output).not.toContain(JWT);
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
    expect(output).toContain("status=ok");
  });

  it("redacts a dotted GitHub token shape via its JWT window", () => {
    // The first segment is too short for the classic-token shape, so only
    // the JWT window catches this (the live-host helper JSON shape).
    const dotted = "ghs_FAKEHEADER00000001.eyJmYWtlIjoidGVzdCJ9.FAKEs1gnatur3s3gment00";
    const output = redactCommandText(`stdout ${dotted}`);
    expect(output).not.toContain(dotted);
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("keeps an exact public helper address readable", () => {
    const address = "executor.coreTools.integrations.list";
    expect(redactCommandText(`Call tools.${address}({})`)).toBe(
      `Call tools.${address}({})`,
    );
  });

  it("redacts a public address with a secret suffix", () => {
    const output = redactCommandText(
      "executor.coreTools.integrations.list.privateSecretSuffix",
    );
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("leaves short dot runs alone", () => {
    expect(redactCommandText("version 1.2.3 ok")).toBe("version 1.2.3 ok");
    expect(redactCommandText("host aaaabbbb.ccccdddd up")).toBe(
      "host aaaabbbb.ccccdddd up",
    );
  });

  it("redacts a long dashy line in linear time (no quadratic backtracking)", () => {
    // Regression test for sink-hot-path stalls: the run matcher consumes
    // each char once, so a 32KB dashy access line costs milliseconds. The
    // old single-regexp JWT plus unbounded assignment affixes cost ~1.4s
    // here (quadratic: 4x per doubling), stalling the event loop on every
    // unauthenticated request carrying a long path. The dots mirror a real
    // access line (timestamp millis, HTTP version) and keep the secret gate
    // open so the scan actually runs; the bound sits ~100x above the linear
    // cost and ~3x below the quadratic cost on reference hardware.
    const line = `2026-10-22T03:27:04.541Z stdout GET /${"ab-".repeat(10922)} HTTP/1.1`;
    expect(line.length).toBeGreaterThan(30 * 1024);
    redactDiagnosticText(line); // JIT warmup, untimed
    const start = performance.now();
    const output = redactDiagnosticText(line);
    const elapsed = performance.now() - start;
    expect(output).toBe(line); // no secrets: byte-identical, just fast
    expect(elapsed).toBeLessThan(500);
  });
});
