import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { defaultSuiteWeight, loadShardDurations } from "../general-server-shard.mjs";
import { IGNORED_SPECS, listE2eSpecs, selectE2eShard } from "../e2e-shard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "e2e-shard.mjs");
const durationsManifest = path.join(repoRoot, "scripts", "e2e-shard-durations.json");
const playwrightConfig = path.join(repoRoot, "tests", "e2e", "playwright.config.ts");
const prCallerWorkflow = path.join(repoRoot, ".github", "workflows", "pr.yml");
const trustedPrWorkflowPath = ".github/workflows/pr-trusted.yml";
const trustedPrWorkflow = path.join(repoRoot, trustedPrWorkflowPath);

const SHARD_COUNT = 8;

function runShard(args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function readTrustedPrWorkflow() {
  const caller = readFileSync(prCallerWorkflow, "utf8");
  assert.match(
    caller,
    /^\s+uses: TogetherWeOwn\/paperclip\/\.github\/workflows\/pr-trusted\.yml@master\s*$/m,
    "pr.yml must call this fork's trusted workflow from master, not upstream's",
  );
  // Validate proposed workflow changes locally; CI executes the merged master version.
  return readFileSync(trustedPrWorkflow, "utf8");
}

function readWorkflowJobs(workflow) {
  const jobs = new Map();
  let current = null;
  for (const line of workflow.split("\n")) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current && /^\S/.test(line)) current = null;
    if (current) jobs.get(current).push(line);
  }
  for (const [id, lines] of jobs) jobs.set(id, lines.join("\n"));
  return jobs;
}

// Pull a step's `run: |` body out of the trusted workflow so the test executes
// the exact script CI runs.
function extractStepScript(stepName) {
  const lines = readFileSync(trustedPrWorkflow, "utf8").split("\n");
  const start = lines.findIndex((line) => line === `      - name: ${stepName}`);
  assert.notEqual(start, -1, `trusted workflow must define the step "${stepName}"`);
  const runAt = lines.findIndex((line, index) => index > start && line === "        run: |");
  assert.notEqual(runAt, -1, `step "${stepName}" must have a multi-line run script`);
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const QUALITY_GATE_TOOLING_STEP = "Detect phase-1 quality-gate tooling on the base commit";

function git(cwd, ...args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=ci-test", "-c", "user.email=ci-test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// Commit each package.json body in order; returns the commit SHAs.
function commitPackageJsons(repo, bodies) {
  return bodies.map((body) => {
    writeFileSync(path.join(repo, "package.json"), body);
    git(repo, "add", "package.json");
    git(repo, "commit", "-q", "-m", "package.json");
    return git(repo, "rev-parse", "HEAD");
  });
}

function runQualityGateToolingDetection(repo, baseSha) {
  const output = path.join(repo, "..", `github-output-${path.basename(repo)}`);
  writeFileSync(output, "");
  const result = spawnSync("bash", ["-e", "-c", extractStepScript(QUALITY_GATE_TOOLING_STEP)], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, BASE_SHA: baseSha, GITHUB_OUTPUT: output },
  });
  return { status: result.status, stderr: result.stderr, output: readFileSync(output, "utf8").trim() };
}

function runVerifyAggregate(overrides) {
  const result = spawnSync("bash", ["-e", "-c", extractStepScript("Fail if any split verify lane failed")], {
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
  });
  return result.status;
}

function runStackScope(stack, prBaseRef) {
  const workflow = readFileSync(trustedPrWorkflow, "utf8");
  const match = workflow.match(
    /      - name: Select stacked PR CI scope[\s\S]*?        run: \|\n([\s\S]*?)\n\n  policy:/,
  );
  assert.ok(match, "trusted workflow must define the stacked PR scope script");
  const script = match[1]
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const scratch = mkdtempSync(path.join(tmpdir(), "paperclip-stack-scope-"));
  const output = path.join(scratch, "github-output");

  try {
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        PR_BASE_REF: prBaseRef,
        STACK_JSON: JSON.stringify(stack),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the e2e shards form a complete, non-overlapping partition", () => {
  const specs = listE2eSpecs();
  assert.ok(specs.length > 0, "expected a non-empty e2e spec set");

  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    runShard(["--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const combined = shards.flat();
  assert.equal(combined.length, specs.length, "every spec must land on exactly one shard");
  assert.deepEqual([...combined].sort(), [...specs].sort());
  for (const shard of shards) {
    assert.ok(shard.length > 0, "no shard may be empty — Playwright fails a run with no matching specs");
  }
});

test("the ignored spec list matches playwright.config.ts testIgnore", () => {
  const config = readFileSync(playwrightConfig, "utf8");
  const match = config.match(/testIgnore:\s*\[([^\]]*)\]/);
  assert.ok(match, "expected a testIgnore array in playwright.config.ts");
  const configured = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual([...configured].sort(), [...IGNORED_SPECS].sort());
});

test("the duration manifest only names specs that still exist", () => {
  const durations = loadShardDurations(durationsManifest);
  assert.ok(Object.keys(durations).length > 0, "expected a populated duration manifest");
  const specs = new Set(listE2eSpecs());
  for (const file of Object.keys(durations)) {
    assert.ok(specs.has(file), `duration manifest names a spec that no longer runs: ${file}`);
  }
});

test("the weighted partition keeps the shards close to balanced", () => {
  const durations = loadShardDurations(durationsManifest);
  const specs = listE2eSpecs();
  // New specs use the scheduler's median estimate until measured durations exist.
  const fallbackWeight = defaultSuiteWeight(durations);
  const weights = Array.from({ length: SHARD_COUNT }, (_, index) =>
    selectE2eShard(specs, index, SHARD_COUNT, durations).reduce((sum, file) => sum + (durations[file] ?? fallbackWeight), 0),
  );

  const heaviest = Math.max(...weights);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Round-robin/count-based sharding would strand the ~168s smoke-lab spec on
  // one runner alongside other specs. Assert the weighted split stays within
  // 15% of an even cut so a future spec-time regression surfaces here instead
  // of on the PR critical path. A single indivisible spec (smoke-lab) can
  // legitimately exceed the even cut on its own, so the bound is floored at
  // the largest per-spec weight — the best any file-level partition can do.
  const largestSpec = Math.max(...specs.map((file) => durations[file] ?? fallbackWeight));
  const bound = Math.max((total / SHARD_COUNT) * 1.15, largestSpec);
  assert.ok(
    heaviest <= bound,
    `heaviest shard ${heaviest}ms exceeds the balance bound (${bound}ms)`,
  );
});

test("shard arguments are validated", () => {
  for (const args of [
    ["--shard-index", "2", "--shard-count", "2"],
    ["--shard-index", "-1", "--shard-count", "2"],
    ["--shard-index", "0", "--shard-count", "0"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0, `expected failure for ${args.join(" ")}`);
  }
});

test("pr.yml calls the trusted PR workflow from master", () => {
  assert.ok(readTrustedPrWorkflow().length > 0);
});

test("the trusted PR workflow keeps a stable aggregate check named e2e over the shard matrix", () => {
  // Branch protection requires a check literally named `e2e`. The shards run
  // as `e2e shard (n/3)`, so the aggregate job below is what keeps the
  // required-check contract intact — same pattern as the `verify` aggregate.
  const workflow = readTrustedPrWorkflow();
  const jobs = readWorkflowJobs(workflow);

  const aggregate = jobs.get("e2e");
  assert.ok(aggregate, "pr-trusted.yml must define an `e2e` job to satisfy branch protection");
  assert.match(aggregate, /^ {4}name: e2e$/m, "the aggregate job must be named exactly `e2e`");
  assert.match(aggregate, /^ {4}if: \$\{\{ always\(\) \}\}$/m, "the aggregate must run even when a shard fails");
  assert.match(
    aggregate,
    /^ {4}needs: \[gate, (?:policy, )?e2e_shards\]$/m,
    "the aggregate must depend on the runner gate, optional policy gate, and shard matrix",
  );
  assert.match(
    aggregate,
    /test "\$E2E_SHARDS_RESULT" = "success"/,
    "the aggregate must fail unless every shard succeeded",
  );

  const shards = jobs.get("e2e_shards");
  assert.ok(shards, "pr-trusted.yml must define the `e2e_shards` matrix job");
  const matrixEntries = [
    ...shards.matchAll(
      /^ {10}- shard_index: (?<shardIndex>\d+)\n {12}shard_count: (?<shardCount>\d+)\n {12}shard_label: (?<shardLabel>\d+\/\d+)$/gm,
    ),
  ].map((match) => ({
    shardIndex: Number(match.groups.shardIndex),
    shardCount: Number(match.groups.shardCount),
    shardLabel: match.groups.shardLabel,
  }));

  assert.equal(matrixEntries.length, SHARD_COUNT, "the shard matrix must define exactly SHARD_COUNT entries");
  assert.deepEqual(
    matrixEntries.map((entry) => entry.shardIndex).sort((a, b) => a - b),
    Array.from({ length: SHARD_COUNT }, (_, index) => index),
    "the shard matrix must define each shard index exactly once",
  );
  for (const entry of matrixEntries) {
    assert.equal(entry.shardCount, SHARD_COUNT, "each shard matrix entry must use the same SHARD_COUNT");
    assert.equal(entry.shardLabel, `${entry.shardIndex + 1}/${SHARD_COUNT}`, "each shard label must match its index");
  }
});

test("the trusted PR workflow limits full CI to merge-relevant stack layers", () => {
  const workflow = readFileSync(trustedPrWorkflow, "utf8");
  const jobs = readWorkflowJobs(workflow);
  const gate = jobs.get("gate");

  assert.match(gate, /^ {6}full_ci: \$\{\{ steps\.scope\.outputs\.full_ci \}\}$/m);
  assert.match(gate, /STACK_JSON: \$\{\{ toJSON\(github\.event\.pull_request\.stack\) \}\}/);
  assert.match(gate, /stack_position == stack_size/);
  assert.match(gate, /"\$stack_base_ref" == "\$PR_BASE_REF"/);

  for (const jobId of [
    "typecheck_release_registry",
    "general_tests",
    "verify_paperclip_runner",
    "build",
    "verify_serialized_server",
    "canary_dry_run",
    "e2e_shards",
  ]) {
    assert.match(
      jobs.get(jobId),
      /^ {4}if: \$\{\{ needs\.gate\.outputs\.full_ci == 'true' \}\}$/m,
      `${jobId} must run only when the gate selects full CI`,
    );
  }

  // The quality-gates lane also requires the base commit to carry the phase-1
  // tooling. The decision comes from the policy job's base-commit detection.
  assert.match(
    jobs.get("quality_gates"),
    /^ {4}if: \$\{\{ needs\.gate\.outputs\.full_ci == 'true' && needs\.policy\.outputs\.quality_gate_tooling == 'true' \}\}$/m,
    "quality_gates must run when full CI is selected and the base commit has the phase-1 tooling",
  );

  assert.doesNotMatch(
    jobs.get("policy"),
    /needs\.gate\.outputs\.full_ci/,
    "the policy job must run on every PR layer",
  );

  const verify = jobs.get("verify");
  assert.match(
    verify,
    /^ {4}needs: \[gate, policy, typecheck_release_registry, general_tests, verify_paperclip_runner, build, docker_context_integrity, quality_gates\]$/m,
  );
  assert.match(verify, /POLICY_RESULT: \$\{\{ needs\.policy\.result \}\}/);
  assert.match(verify, /test "\$TYPECHECK_RELEASE_REGISTRY_RESULT" = "skipped"/);
  assert.match(verify, /test "\$GENERAL_TESTS_RESULT" = "skipped"/);
  // Runner verification must participate in the legacy aggregate required
  // check, or a runner regression could be merged while `verify` succeeds.
  assert.match(verify, /RUNNER_VERIFICATION_RESULT: \$\{\{ needs\.verify_paperclip_runner\.result \}\}/);
  assert.match(verify, /test "\$RUNNER_VERIFICATION_RESULT" = "success"/);
  assert.match(verify, /test "\$RUNNER_VERIFICATION_RESULT" = "skipped"/);
  assert.match(verify, /test "\$BUILD_RESULT" = "skipped"/);
  // Both halves of the docker-context lane's gating: the result must be
  // wired into the aggregate's env AND asserted successful on full CI —
  // dropping either would let `verify` pass after the lane fails.
  assert.match(verify, /DOCKER_CONTEXT_INTEGRITY_RESULT: \$\{\{ needs\.docker_context_integrity\.result \}\}/);
  assert.match(verify, /test "\$DOCKER_CONTEXT_INTEGRITY_RESULT" = "success"/);
  assert.match(verify, /test "\$DOCKER_CONTEXT_INTEGRITY_RESULT" = "skipped"/);
  // Both halves of the quality-gates lane's gating: the result must be
  // wired into the aggregate's env AND asserted successful on full CI —
  // dropping either would let `verify` pass after the lane fails.
  assert.match(verify, /QUALITY_GATES_RESULT: \$\{\{ needs\.quality_gates\.result \}\}/);
  assert.match(verify, /test "\$QUALITY_GATES_RESULT" = "success"/);
  assert.match(verify, /test "\$QUALITY_GATES_RESULT" = "skipped"/);
  assert.match(verify, /QUALITY_GATE_TOOLING: \$\{\{ needs\.policy\.outputs\.quality_gate_tooling \}\}/);

  const e2e = jobs.get("e2e");
  assert.match(e2e, /^ {4}needs: \[gate, policy, e2e_shards\]$/m);
  assert.match(e2e, /POLICY_RESULT: \$\{\{ needs\.policy\.result \}\}/);
  assert.match(e2e, /false\) test "\$E2E_SHARDS_RESULT" = "skipped"/);
});

test("master carries the phase-1 quality-gate tooling its own gate depends on", () => {
  // The lane is skipped on base lines whose package.json lacks this script. If
  // master lost it, every later PR would skip the gate without a failing check.
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(typeof pkg.scripts["test:quality-gates"], "string");
  assert.ok(existsSync(path.join(repoRoot, "scripts", "quality-gates")));
});

test("the quality-gates lane is skipped only for a base commit without the tooling", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "paperclip-quality-gate-tooling-"));
  try {
    const repo = path.join(scratch, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    const withScript = JSON.stringify({ scripts: { "test:quality-gates": "node --test" } });
    const withoutScript = JSON.stringify({ scripts: { test: "vitest" } });
    const [baseWith, headWithout] = commitPackageJsons(repo, [withScript, withoutScript]);

    // A PR that deletes the tooling is still judged by its base, which has it.
    assert.deepEqual(runQualityGateToolingDetection(repo, baseWith), {
      status: 0,
      stderr: "",
      output: "available=true",
    });

    // A base line that predates the tooling skips the lane, even when the PR
    // head adds the script back.
    commitPackageJsons(repo, [withScript]);
    const detection = runQualityGateToolingDetection(repo, headWithout);
    assert.equal(detection.status, 0, detection.stderr);
    assert.equal(detection.output, "available=false");

    const [noScripts] = commitPackageJsons(repo, [JSON.stringify({ name: "no-scripts" })]);
    assert.equal(runQualityGateToolingDetection(repo, noScripts).output, "available=false");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("quality-gate tooling detection fails closed on any doubt", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "paperclip-quality-gate-tooling-"));
  try {
    const repo = path.join(scratch, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    const [broken] = commitPackageJsons(repo, ["{ not json"]);
    git(repo, "rm", "-q", "package.json");
    git(repo, "commit", "-q", "-m", "drop package.json");
    const noPackageJson = git(repo, "rev-parse", "HEAD");

    for (const [label, baseSha] of [
      ["unreadable package.json", broken],
      ["package.json absent at the base commit", noPackageJson],
      ["malformed SHA", "not-a-sha"],
      ["unknown SHA", "0".repeat(40)],
    ]) {
      const detection = runQualityGateToolingDetection(repo, baseSha);
      assert.notEqual(detection.status, 0, `${label} must fail the policy job`);
      assert.equal(detection.output, "", `${label} must not publish a tooling decision`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("verify accepts a skipped quality-gates lane only when the base has no tooling", () => {
  // Tooling present: the lane must have run and passed.
  assert.equal(runVerifyAggregate({}), 0);
  assert.notEqual(runVerifyAggregate({ QUALITY_GATES_RESULT: "failure" }), 0);
  assert.notEqual(runVerifyAggregate({ QUALITY_GATES_RESULT: "cancelled" }), 0);
  assert.notEqual(
    runVerifyAggregate({ QUALITY_GATES_RESULT: "skipped" }),
    0,
    "a skipped lane must not satisfy verify on a base that has the tooling",
  );

  // No tooling on the base: the lane is skipped, and anything else is wrong.
  assert.equal(runVerifyAggregate({ QUALITY_GATE_TOOLING: "false", QUALITY_GATES_RESULT: "skipped" }), 0);
  assert.notEqual(runVerifyAggregate({ QUALITY_GATE_TOOLING: "false", QUALITY_GATES_RESULT: "success" }), 0);
  assert.notEqual(runVerifyAggregate({ QUALITY_GATE_TOOLING: "false", QUALITY_GATES_RESULT: "failure" }), 0);

  // No decision (detection did not publish one): fail rather than guess.
  assert.notEqual(runVerifyAggregate({ QUALITY_GATE_TOOLING: "", QUALITY_GATES_RESULT: "skipped" }), 0);
  assert.notEqual(runVerifyAggregate({ QUALITY_GATE_TOOLING: "", QUALITY_GATES_RESULT: "success" }), 0);

  // The skip never relaxes any other lane.
  assert.notEqual(
    runVerifyAggregate({ QUALITY_GATE_TOOLING: "false", QUALITY_GATES_RESULT: "skipped", BUILD_RESULT: "failure" }),
    0,
  );
  assert.notEqual(
    runVerifyAggregate({ QUALITY_GATE_TOOLING: "false", QUALITY_GATES_RESULT: "skipped", POLICY_RESULT: "failure" }),
    0,
  );

  // Stacked middle layers still skip every lane, whatever the tooling decision.
  const middleLayer = {
    FULL_CI: "false",
    TYPECHECK_RELEASE_REGISTRY_RESULT: "skipped",
    GENERAL_TESTS_RESULT: "skipped",
    RUNNER_VERIFICATION_RESULT: "skipped",
    BUILD_RESULT: "skipped",
    DOCKER_CONTEXT_INTEGRITY_RESULT: "skipped",
    QUALITY_GATES_RESULT: "skipped",
  };
  assert.equal(runVerifyAggregate(middleLayer), 0);
  assert.notEqual(runVerifyAggregate({ ...middleLayer, QUALITY_GATES_RESULT: "success" }), 0);
});

test("the stacked PR scope selector runs full CI only where intended", () => {
  assert.equal(runStackScope(null, "master").full_ci, "true");
  assert.equal(
    runStackScope({ position: 11, size: 11, base: { ref: "master" } }, "stack-10").full_ci,
    "true",
  );
  assert.equal(
    runStackScope({ position: 1, size: 11, base: { ref: "master" } }, "master").full_ci,
    "true",
  );
  assert.equal(
    runStackScope({ position: 6, size: 11, base: { ref: "master" } }, "stack-5").full_ci,
    "false",
  );
  assert.equal(
    runStackScope({ position: "invalid", size: 11, base: { ref: "master" } }, "stack-5").full_ci,
    "true",
  );
});

test("the trusted PR workflow passes the shard's spec filter to Playwright without a literal --", () => {
  // `pnpm run test:e2e -- $specs` forwards the literal separator to Playwright,
  // so the specs after it are not applied as file filters.
  const workflow = readTrustedPrWorkflow();
  assert.ok(
    !/pnpm run test:e2e --\s/.test(workflow),
    "pr-trusted.yml must not insert a literal `--` between `pnpm run test:e2e` and the spec filter",
  );
  assert.match(
    workflow,
    /pnpm run test:e2e \$specs/,
    "pr-trusted.yml e2e_shards must invoke `pnpm run test:e2e $specs`",
  );
});

test("the trusted PR workflow regenerates stale stacked lockfiles", () => {
  // Validate the proposed workflow here. The caller executes the merged master
  // workflow; edits to this workflow take effect after code-owner review and merge.
  const workflow = readFileSync(trustedPrWorkflow, "utf8");
  assert.match(
    workflow,
    /policy:\n    needs: \[gate\][\s\S]{0,160}timeout-minutes: 10/,
    "the unconditional resolution step needs the same timeout headroom as the lockfile refresh workflow",
  );
  const policy = workflow.split("  policy:\n")[1].split("  typecheck_release_registry:\n")[0];
  assert.doesNotMatch(
    policy,
    /cache: pnpm|uses: actions\/cache/,
    "resolution-only policy must not restore or save a dependency store",
  );
  assert.match(
    policy,
    /pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile/,
    "the policy job must resolve the complete merge tree without rewriting platform metadata",
  );

  // Test lanes no longer wait on a policy-job artifact: each install step
  // resolves a stale lockfile inline, so a manifest-changing or stacked PR
  // still installs while the policy job validates resolution in parallel.
  // The quality_gates lane follows the same inline-resolution pattern, so it
  // is the 8th counted install (was 7 before the phase-1 gates lane).
  const fallbackInstalls = workflow.match(
    /if ! pnpm install --frozen-lockfile; then\n[\s\S]{0,240}?pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile\n\s+pnpm install --frozen-lockfile\n\s+fi/g,
  ) ?? [];
  assert.equal(
    fallbackInstalls.length,
    8,
    "every downstream install job must resolve a stale lockfile inline",
  );
  assert.doesNotMatch(
    workflow,
    /Restore regenerated PR lockfile|lockfile_regenerated|name: pr-lockfile/,
    "the policy lockfile artifact chain must stay removed; it put the policy job on every lane's critical path",
  );
});
