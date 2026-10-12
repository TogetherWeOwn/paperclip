import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// The quality_gates job lives in the trusted workflow on master, but its
// scripts live in the PR's checkout. A PR whose base branch predates the gates
// (deploy/tog6, 2026-10-12) has no scripts, so every gate step failed and the
// required `ci / verify` went red. These tests pin the guard that makes the
// job skip cleanly instead.

const workflow = readFileSync(
  new URL("../../.github/workflows/pr-trusted.yml", import.meta.url),
  "utf8",
);
const jobMatch = workflow.match(
  /^ {2}quality_gates:\n([\s\S]*?)(?=^ {2}[a-z_][a-z_0-9]*:\n|$(?![\s\S]))/m,
);
assert.ok(jobMatch, "quality_gates job not found in pr-trusted.yml");
const steps = jobMatch[1].split("\n      - ").slice(1);
const detectIndex = steps.findIndex((step) =>
  step.includes("id: detect_gates"),
);
const GUARD = "steps.detect_gates.outputs.present == 'true'";

test("quality_gates detects whether the checked-out tree carries the gate scripts", () => {
  assert.ok(detectIndex >= 0, "no step with id: detect_gates");
  const checkoutIndex = steps.findIndex((step) =>
    step.includes("uses: actions/checkout@"),
  );
  assert.ok(
    checkoutIndex >= 0 && checkoutIndex < detectIndex,
    "detection must run after checkout and before every gate step",
  );
});

test("every quality_gates step after detection is guarded by the detection output", () => {
  assert.ok(detectIndex >= 0, "no step with id: detect_gates");
  const unguarded = steps
    .slice(detectIndex + 1)
    .filter((step) => !step.includes(GUARD))
    .map((step) => step.split("\n")[0]);
  assert.deepEqual(unguarded, []);
});

function runDetect(files) {
  assert.ok(detectIndex >= 0, "no step with id: detect_gates");
  const step = steps[detectIndex];
  const runMatch = step.match(/\n {8}run: \|\n((?: {10}.*\n?|\n)+)/);
  assert.ok(runMatch, "detect_gates step has no run block");
  const script = runMatch[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "detect-gates-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const output = path.join(dir, ".github_output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: dir,
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    return {
      status: result.status,
      stdout: result.stdout,
      output: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("detection reports present=true when the tree has the gate scripts and the package script", () => {
  const result = runDetect({
    "scripts/quality-gates/biome-changed.mjs": "",
    "package.json": '{"scripts":{"test:quality-gates":"node --test"}}',
  });
  assert.equal(result.status, 0);
  assert.match(result.output, /^present=true$/m);
});

test("detection reports present=false and exits 0 when the base predates the gates", () => {
  const result = runDetect({
    "package.json": '{"scripts":{"test":"vitest"}}',
  });
  assert.equal(result.status, 0);
  assert.match(result.output, /^present=false$/m);
  assert.match(result.stdout, /::notice/);
});

test("detection reports present=false when only the scripts directory is present", () => {
  const result = runDetect({
    "scripts/quality-gates/biome-changed.mjs": "",
    "package.json": '{"scripts":{"test":"vitest"}}',
  });
  assert.equal(result.status, 0);
  assert.match(result.output, /^present=false$/m);
});
