import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/pr-trusted.yml", import.meta.url),
  "utf8",
);

function jobBody(name) {
  const match = workflow.match(
    new RegExp(
      `^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[a-z_][a-z_0-9]*:\\n|$(?![\\s\\S]))`,
      "m",
    ),
  );
  assert.ok(match, `${name} job not found in pr-trusted.yml`);
  return match[1];
}

function stepScript(job, name) {
  const lines = job.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `workflow step not found: ${name}`);
  const runAt = lines.findIndex(
    (line, index) => index > start && line === "        run: |",
  );
  assert.notEqual(runAt, -1, `step has no multiline run block: ${name}`);
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const policy = jobBody("policy");
const qualityGates = jobBody("quality_gates");
const verify = jobBody("verify");
const detectScript = stepScript(
  policy,
  "Detect phase-1 quality-gate tooling on the base commit",
);
const verifyScript = stepScript(verify, "Fail if any split verify lane failed");

function runGit(cwd, ...args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=ci-test",
      "-c",
      "user.email=ci-test@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const scratch = mkdtempSync(
    path.join(tmpdir(), "paperclip-quality-gate-tooling-"),
  );
  const repo = path.join(scratch, "repo");
  mkdirSync(repo);
  runGit(repo, "init", "-q", "-b", "main");
  return { scratch, repo };
}

function commitPackageJson(repo, body) {
  writeFileSync(path.join(repo, "package.json"), body);
  runGit(repo, "add", "package.json");
  runGit(repo, "commit", "-q", "--allow-empty", "-m", "package.json");
  return runGit(repo, "rev-parse", "HEAD");
}

function runDetection(repo, baseSha) {
  const output = path.join(repo, "..", "github-output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-e", "-c", detectScript], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, BASE_SHA: baseSha, GITHUB_OUTPUT: output },
  });
  return {
    status: result.status,
    output: readFileSync(output, "utf8").trim(),
    stderr: result.stderr,
  };
}

function runVerify(overrides = {}) {
  return spawnSync("bash", ["-e", "-c", verifyScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      FULL_CI: "true",
      POLICY_RESULT: "success",
      TYPECHECK_RELEASE_REGISTRY_RESULT: "success",
      GENERAL_TESTS_RESULT: "success",
      RUNNER_VERIFICATION_RESULT: "success",
      BUILD_RESULT: "success",
      DOCKER_CONTEXT_INTEGRITY_RESULT: "success",
      QUALITY_GATES_RESULT: "success",
      QUALITY_GATE_TOOLING: "true",
      ...overrides,
    },
  }).status;
}

test("policy decides gate availability from base commit and fails closed", () => {
  assert.match(policy, /^ {4}outputs:\n {6}quality_gate_tooling:/m);
  assert.match(policy, /id: quality_gate_tooling/);
  assert.match(
    policy,
    /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  );
  assert.match(
    qualityGates,
    /^ {4}if: \$\{\{ needs\.gate\.outputs\.full_ci == 'true' && needs\.policy\.outputs\.quality_gate_tooling == 'true' \}\}$/m,
  );
  assert.doesNotMatch(qualityGates, /steps\.detect_gates/);
  assert.match(
    verify,
    /QUALITY_GATE_TOOLING: \$\{\{ needs\.policy\.outputs\.quality_gate_tooling \}\}/,
  );
});

test("base commit controls the decision even when the PR head changes the tooling", () => {
  const { scratch, repo } = makeRepo();
  try {
    const tooling = JSON.stringify({
      scripts: { "test:quality-gates": "node --test" },
    });
    const noTooling = JSON.stringify({ scripts: { test: "vitest" } });
    const baseWithTooling = commitPackageJson(repo, tooling);
    commitPackageJson(repo, noTooling);
    assert.deepEqual(runDetection(repo, baseWithTooling), {
      status: 0,
      output: "available=true",
      stderr: "",
    });

    const baseWithoutTooling = commitPackageJson(repo, noTooling);
    commitPackageJson(repo, tooling);
    assert.deepEqual(runDetection(repo, baseWithoutTooling), {
      status: 0,
      output: "available=false",
      stderr: "",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("detection fails closed for malformed, missing, or unreadable base data", () => {
  const { scratch, repo } = makeRepo();
  try {
    const malformedJson = commitPackageJson(repo, "{ not json");
    runGit(repo, "rm", "-q", "package.json");
    runGit(repo, "commit", "-q", "-m", "remove package.json");
    const missingPackage = runGit(repo, "rev-parse", "HEAD");

    for (const [label, baseSha] of [
      ["malformed SHA", "not-a-sha"],
      ["unknown commit", "0".repeat(40)],
      ["invalid package JSON", malformedJson],
      ["missing package.json", missingPackage],
    ]) {
      const result = runDetection(repo, baseSha);
      assert.notEqual(result.status, 0, `${label} must fail policy`);
      assert.equal(result.output, "", `${label} must not publish a decision`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("verify accepts a skipped lane only when policy reports no base tooling", () => {
  assert.equal(runVerify(), 0);
  for (const overrides of [
    { QUALITY_GATES_RESULT: "failure" },
    { QUALITY_GATES_RESULT: "cancelled" },
    { QUALITY_GATES_RESULT: "skipped" },
    { QUALITY_GATE_TOOLING: "" },
    { QUALITY_GATE_TOOLING: "false", QUALITY_GATES_RESULT: "success" },
    { QUALITY_GATE_TOOLING: "false", QUALITY_GATES_RESULT: "failure" },
    {
      QUALITY_GATE_TOOLING: "false",
      QUALITY_GATES_RESULT: "skipped",
      BUILD_RESULT: "failure",
    },
    {
      QUALITY_GATE_TOOLING: "false",
      QUALITY_GATES_RESULT: "skipped",
      POLICY_RESULT: "failure",
    },
  ]) {
    assert.notEqual(
      runVerify(overrides),
      0,
      `unexpected verify success for ${JSON.stringify(overrides)}`,
    );
  }
  assert.equal(
    runVerify({
      QUALITY_GATE_TOOLING: "false",
      QUALITY_GATES_RESULT: "skipped",
    }),
    0,
  );
});

test("master carries the quality-gate tooling its own gate depends on", () => {
  const root = new URL("../../", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(typeof pkg.scripts["test:quality-gates"], "string");
  assert.ok(existsSync(new URL("scripts/quality-gates", root)));
});
