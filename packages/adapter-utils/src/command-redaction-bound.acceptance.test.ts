import { Worker } from "node:worker_threads";
import { beforeAll, describe, expect, it } from "vitest";
import { redactCommandText, redactDiagnosticText } from "./command-redaction.js";

const signaturePrefix = '{"type":"thinking","signature":"';
const signatureSuffix = '","message":"token budget ready"}\n';
const signature = "Ab9-".repeat(12_500).slice(
  0,
  50_000 - signaturePrefix.length - signatureSuffix.length,
);
const signatureLog = signaturePrefix + signature + signatureSuffix;

// A synchronous regex cannot be interrupted by a Vitest timeout. Run the real
// module in a terminable worker, with no inherited run credentials or services.
async function redactInWorker(input: string) {
  const moduleUrl = new URL("./command-redaction.ts", import.meta.url).href;
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     import(workerData.moduleUrl).then(({ redactDiagnosticText }) => {
       const start = performance.now();
       const output = redactDiagnosticText(workerData.input);
       parentPort.postMessage({ output, elapsedMs: performance.now() - start });
     }).catch((error) => { throw error; });`,
    {
      eval: true,
      execArgv: [],
      env: {},
      workerData: { moduleUrl, input },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    },
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{ output: string; elapsedMs: number }>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("redaction exceeded the 20s worker safety limit")), 20_000);
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`redaction worker exited before a result (${code})`)));
    });
  } finally {
    clearTimeout(deadline);
    await worker.terminate();
  }
}

describe("bounded command redaction acceptance", () => {
  let largeResult: Awaited<ReturnType<typeof redactInWorker>>;

  beforeAll(async () => {
    largeResult = await redactInWorker(signatureLog);
  }, 25_000);

  it("preserves a 50k-character signature-heavy diagnostic exactly", () => {
    expect(signatureLog).toHaveLength(50_000);
    expect(largeResult.output).toBe(signatureLog);
  });

  it("redacts the 50k-character pathological input in less than one second", () => {
    // Measure only the redactor, not worker startup/import. Keep this assertion
    // separate from output correctness so dropping text cannot satisfy the gate.
    expect(largeResult.elapsedMs).toBeLessThan(1_000);
  });

  it("preserves ordinary text and dotted identifiers", () => {
    for (const input of [
      "Build finished: 12 files, 0 errors.\n",
      "executor.coreTools.integrations.list plan.security.credentials.md",
      'Status: ready; {"tokenBudget":4000,"credentialHandling":"harness"}',
    ]) {
      expect(redactCommandText(input)).toBe(input);
      expect(redactDiagnosticText(input)).toBe(input);
    }
  });

  it.each([
    ["API_KEY=acceptance-env-value status=ok", "API_KEY=***REDACTED*** status=ok"],
    ["tool --api-key-prod acceptance-cli-value --count 2", "tool --api-key-prod ***REDACTED*** --count 2"],
    ["Authorization: Bearer acceptance-bearer-value", "Authorization: Bearer ***REDACTED***"],
    ["key sk-acceptance0123456789 done", "key ***REDACTED*** done"],
    ["key ghp_acceptance0123456789012345 done", "key ***REDACTED*** done"],
    [
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature0123456789",
      "jwt ***REDACTED***",
    ],
    ['{"token":"acceptance-json-value","status":"ok"}', '{"token":"***REDACTED***","status":"ok"}'],
    [String.raw`{\"password\":\"acceptance-escaped-value\"}`, String.raw`{\"password\":\"***REDACTED***\"}`],
  ])("keeps credential coverage and exact output for %s", (input, expected) => {
    const output = redactDiagnosticText(input);
    expect(output).toBe(expected);
    expect(redactDiagnosticText(output)).toBe(expected);
  });

  it("redacts a credential JWT with a 50k-character signature completely", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0." + "a".repeat(50_000);
    const { output } = await redactInWorker("credential " + jwt + " status=ok");
    expect(output).toBe("credential ***REDACTED*** status=ok");
    expect(output).not.toContain(jwt);
  }, 25_000);

  it("does not lose a credential after a long signature", async () => {
    const input = signatureLog + "API_KEY=acceptance-tail-value status=ok";
    const { output } = await redactInWorker(input);
    expect(output).toBe(signatureLog + "API_KEY=***REDACTED*** status=ok");
    expect(output).not.toContain("acceptance-tail-value");
  }, 25_000);
});
