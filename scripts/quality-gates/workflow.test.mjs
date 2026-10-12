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
  "Detect phase-1 quality-gate tooling on the merge commit's base parent",
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

function runDetection(repo) {
  const output = path.join(repo, "..", "github-output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-e", "-c", detectScript], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output },
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

const TOOLING = JSON.stringify({
  scripts: { "test:quality-gates": "node --test" },
});
const NO_TOOLING = JSON.stringify({ scripts: { test: "vitest" } });

function mergePrIntoMain(repo, baseBody, prWork) {
  commitPackageJson(repo, baseBody);
  runGit(repo, "checkout", "-q", "-b", "pr");
  prWork();
  runGit(repo, "checkout", "-q", "main");
  return runGit(repo, "rev-parse", "HEAD");
}

test("policy decides gate availability from the merge base parent and fails closed", () => {
  assert.match(
    policy,
    /^ {4}outputs:\n {6}quality_gate_tooling: \$\{\{ steps\.quality_gate_tooling\.outputs\.available \}\}$/m,
  );
  assert.match(policy, /id: quality_gate_tooling/);
  assert.doesNotMatch(
    policy,
    /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
    "detection must not read the stale event base.sha",
  );
  assert.match(detectScript, /git rev-parse HEAD\^1/);
  assert.match(detectScript, /rev-list --parents/);
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

test("base parent controls the decision even when the PR head changes the tooling", () => {
  const { scratch, repo } = makeRepo();
  try {
    // Base parent has the tooling; the PR head deletes it. The lane must run.
    commitPackageJson(repo, TOOLING);
    runGit(repo, "checkout", "-q", "-b", "pr");
    commitPackageJson(repo, NO_TOOLING);
    runGit(repo, "checkout", "-q", "main");
    runGit(repo, "merge", "-q", "--no-ff", "pr", "-m", "merge pr");
    assert.deepEqual(runDetection(repo), {
      status: 0,
      output: "available=true",
      stderr: "",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const second = makeRepo();
  try {
    const { repo: repo2 } = second;
    // Base parent lacks the tooling; the PR head adds it. The lane must skip:
    // a PR cannot switch the lane on or off from its own head.
    commitPackageJson(repo2, NO_TOOLING);
    runGit(repo2, "checkout", "-q", "-b", "pr");
    commitPackageJson(repo2, TOOLING);
    runGit(repo2, "checkout", "-q", "main");
    runGit(repo2, "merge", "-q", "--no-ff", "pr", "-m", "merge pr");
    assert.deepEqual(runDetection(repo2), {
      status: 0,
      output: "available=false",
      stderr: "",
    });
  } finally {
    rmSync(second.scratch, { recursive: true, force: true });
  }
});

test("stale merge-base without tooling does not skip a lane the merge tree can run", () => {
  const { scratch, repo } = makeRepo();
  try {
    // A: old base without tooling (the stale event base.sha merge-base).
    commitPackageJson(repo, NO_TOOLING);
    runGit(repo, "checkout", "-q", "-b", "pr");
    runGit(repo, "commit", "-q", "--allow-empty", "-m", "pr work");
    runGit(repo, "checkout", "-q", "main");
    // B: current base tip with tooling.
    commitPackageJson(repo, TOOLING);
    runGit(repo, "merge", "-q", "--no-ff", "pr", "-m", "merge pr");
    const mergeBase = runGit(repo, "merge-base", "HEAD^1", "HEAD^2");
    const baseParentPkg = runGit(
      repo,
      "show",
      `${runGit(repo, "rev-parse", "HEAD^1")}:package.json`,
    );
    assert.ok(
      baseParentPkg.includes("test:quality-gates"),
      "base parent must carry the tooling for this fixture",
    );
    const mergeBasePkg = runGit(repo, "show", `${mergeBase}:package.json`);
    assert.ok(
      !mergeBasePkg.includes("test:quality-gates"),
      "merge-base must lack the tooling for this fixture",
    );
    // The merge tree carries the tooling, so the lane must run.
    assert.deepEqual(runDetection(repo), {
      status: 0,
      output: "available=true",
      stderr: "",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("detection fails closed for non-merge checkouts and unreadable base data", () => {
  const { scratch, repo } = makeRepo();
  try {
    // A linear HEAD is not a PR merge commit: no decision may be published.
    commitPackageJson(repo, TOOLING);
    const linear = runDetection(repo);
    assert.notEqual(linear.status, 0, "linear checkout must fail policy");
    assert.equal(linear.output, "", "linear checkout must not publish a decision");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const badJson = makeRepo();
  try {
    const { repo: repo2 } = badJson;
    commitPackageJson(repo2, "{ not json");
    runGit(repo2, "checkout", "-q", "-b", "pr");
    runGit(repo2, "commit", "-q", "--allow-empty", "-m", "pr work");
    runGit(repo2, "checkout", "-q", "main");
    runGit(repo2, "merge", "-q", "--no-ff", "pr", "-m", "merge pr");
    const result = runDetection(repo2);
    assert.notEqual(result.status, 0, "invalid package JSON must fail policy");
    assert.equal(result.output, "", "invalid package JSON must not publish a decision");
  } finally {
    rmSync(badJson.scratch, { recursive: true, force: true });
  }

  const missing = makeRepo();
  try {
    const { repo: repo3 } = missing;
    commitPackageJson(repo3, TOOLING);
    runGit(repo3, "rm", "-q", "package.json");
    runGit(repo3, "commit", "-q", "-m", "remove package.json");
    runGit(repo3, "checkout", "-q", "-b", "pr");
    runGit(repo3, "commit", "-q", "--allow-empty", "-m", "pr work");
    runGit(repo3, "checkout", "-q", "main");
    runGit(repo3, "merge", "-q", "--no-ff", "pr", "-m", "merge pr");
    const result = runDetection(repo3);
    assert.notEqual(result.status, 0, "missing package.json must fail policy");
    assert.equal(result.output, "", "missing package.json must not publish a decision");
  } finally {
    rmSync(missing.scratch, { recursive: true, force: true });
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
