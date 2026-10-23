import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = fileURLToPath(new URL("./__fixtures__/server-utils-stdin.acceptance.ts", import.meta.url));
const tsxLoader = createRequire(new URL("../../../cli/package.json", import.meta.url)).resolve("tsx/esm");
let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(), "stdin-acceptance-"));
});
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function runScenario(mode: string) {
  return spawnSync(process.execPath, ["--import", tsxLoader, fixture, mode], {
    cwd: root,
    // No instance config, DB URL, live launcher, credentials, or NODE_OPTIONS.
    env: { PATH: path.dirname(process.execPath), HOME: scratch, TMPDIR: scratch },
    encoding: "utf8",
    timeout: 12_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
}

function expectSurvivingParent(result: ReturnType<typeof runScenario>) {
  expect(result.error, String(result.error)).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout.trim());
}

describe("runChildProcess closed stdin acceptance", () => {
  it.each([0, 73])("survives stdin closed before delivery and preserves exit %i (8 attempts)", (exitCode) => {
    expect(expectSurvivingParent(runScenario(`closed-${exitCode}`))).toEqual({ completed: 8, exitCode });
  });

  it.each([0, 73])("survives immediate child exit %i during a buffered prompt write (8 attempts)", (exitCode) => {
    expect(expectSurvivingParent(runScenario(`race-${exitCode}`))).toEqual({ completed: 8, exitCode });
  });

  it("delivers an ordinary multi-byte prompt without truncation and settles teardown", () => {
    expect(expectSurvivingParent(runScenario("echo"))).toMatchObject({ bytes: 27 });
  });

  it.skipIf(process.platform === "win32")("keeps cancellation effective after stdin closes", () => {
    expect(expectSurvivingParent(runScenario("cancel"))).toEqual({ interrupted: "cancel" });
  });

  it.skipIf(process.platform === "win32")("keeps timeout effective after stdin closes", () => {
    expect(expectSurvivingParent(runScenario("timeout"))).toEqual({ interrupted: "timeout" });
  });

  it("does not silently swallow unrelated stdin write errors", () => {
    const result = runScenario("non-pipe");
    expect(result.error, String(result.error)).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    if (result.status === 0) {
      expect(JSON.parse(result.stdout.trim()).observed.join("\n")).toContain("stdin-non-pipe-sentinel EIO");
    } else {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stdin-non-pipe-sentinel EIO");
    }
  });
});
