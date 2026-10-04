import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { affectedWork } from "./ci-affected-work.mjs";

const workflowPath = (name) => fileURLToPath(new URL(`../.github/workflows/${name}.yml`, import.meta.url));
const workflow = (name) => readFileSync(workflowPath(name), "utf8");
const job = (text, id) => text.split(`\n  ${id}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
const lint = (name, text) => spawnSync(process.env.ACTIONLINT || "actionlint", [
  "-shellcheck=", "-pyflakes=",
  ...(text === undefined ? [workflowPath(name)] : ["-stdin-filename", workflowPath(name), "-"]),
], { input: text, encoding: "utf8" });

// This is a GitHub-aware parser, not a YAML/regex validity approximation. CI
// installs the pinned validator before these tests; missing tooling fails closed.
test("GitHub accepts repaired workflows and the complete local reusable-call graph", () => {
  const pending = ["docker", "release", "source-smoke", "release-smoke", "workflow-health"];
  const visited = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const text = workflow(name);
    const result = lint(name);
    assert.equal(result.status, 0, `${name}: ${result.error || result.stdout || result.stderr}`);
    for (const [, callee] of text.matchAll(/uses: \.\/\.github\/workflows\/([\w-]+)\.yml/g)) pending.push(callee);
  }
});

test("semantic validation rejects caller-level continue-on-error on a reusable workflow", () => {
  const text = workflow("release").replace("  smoke_nightly_published:\n", "  smoke_nightly_published:\n    continue-on-error: true\n");
  const result = lint("release", text);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /continue-on-error.*not available/);
});

test("semantic validation rejects runner context in job-level env", () => {
  const text = workflow("source-smoke").replace("  smoke_source:\n", "  smoke_source:\n    env:\n      SMOKE_LOG_FILE: ${{ runner.temp }}/source-onboard-smoke.log\n");
  const result = lint("source-smoke", text);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /context "runner" is not allowed here/);
});

test("semantic validation rejects unknown inputs to local reusable workflows", () => {
  const text = workflow("release").replace("      informational: true\n", "      unknown_informational: true\n");
  assert.match(text, /unknown_informational: true/);
  const result = lint("release", text);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /input "unknown_informational" is not defined/);
});

test("all registry paths consume the normalized mixed-case repository name", () => {
  const docker = workflow("docker");
  assert.doesNotMatch(docker, /ghcr\.io\/\$\{\{ github\.repository \}\}/);
  for (const id of ["build-and-push", "merge-and-push", "promote_canary_channel", "build-only"]) {
    const block = job(docker, id);
    const normalize = block.match(/run: (echo "IMAGE=ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}" >> "\$GITHUB_ENV")/);
    assert.ok(normalize, `${id} must normalize before any registry use`);
    const result = spawnSync("bash", ["-eu", "-c", normalize[1].replace(' >> "$GITHUB_ENV"', "")], {
      encoding: "utf8", env: { GITHUB_REPOSITORY: "TogetherWeOwn/PaperClip" },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "IMAGE=ghcr.io/togetherweown/paperclip");
    assert.ok(block.indexOf(normalize[1]) < block.indexOf("${{ env.IMAGE }}"), `${id} consumes the normalized path`);
  }
});

test("fork Docker builds cannot login, push, export cache, or attest", () => {
  const docker = workflow("docker");
  for (const id of ["build-and-push", "merge-and-push", "promote_canary_channel"]) {
    assert.match(job(docker, id), /if:.*github\.repository == 'paperclipai\/paperclip'/, `${id} rejects forks`);
  }
  const build = job(docker, "build-only");
  assert.match(build, /github\.repository != 'paperclipai\/paperclip'/);
  assert.match(build, /runs-on: ubuntu-latest/);
  assert.match(build, /contents: read/);
  assert.match(build, /persist-credentials: false/);
  assert.match(build, /push: false/);
  assert.match(build, /load: true/);
  assert.match(build, /assert-orphan-reaping\.sh/);
  assert.doesNotMatch(build, /login-action|secrets\.|(?:packages|id-token|attestations): write|cache-to:|push=true|push-to-registry/);
});

test("fork release routes cannot publish packages, tags, images, or notes", () => {
  const release = workflow("release");
  for (const id of ["publish_preview", "publish_image_preview", "publish_canary", "publish_nightly", "publish_beta", "publish_stable", "draft_stable_notes", "canonicalize_stable_notes"]) {
    const condition = job(release, id).match(/^    if: (.+)(?:\n      .+)*/m)?.[0] ?? "";
    assert.match(condition, /github\.repository == 'paperclipai\/paperclip'/, `${id} rejects forks`);
  }
});

function condition(block) {
  const value = block.match(/^    if: (.+)(?:\n      .+)*/m)?.[0];
  assert.ok(value, "expected an explicit job gate");
  return value.replace(/^    if: (?:>-\n)?/, "").replace(/\$\{\{|\}\}/g, "").trim();
}

test("forks reject every publishing job even with otherwise successful prerequisites", () => {
  for (const [name, ids] of [["docker", ["build-and-push", "merge-and-push", "promote_canary_channel"]],
    ["release", ["publish_preview", "publish_image_preview", "publish_canary", "publish_nightly", "publish_beta", "publish_stable", "draft_stable_notes", "canonicalize_stable_notes"]]]) {
    for (const id of ids) {
      const expression = condition(job(workflow(name), id));
      // Use only checked-in expressions; no untrusted event text is evaluated.
      const evaluate = new Function("github", "inputs", "needs", "cancelled", "startsWith", `return Boolean(${expression});`);
      const needs = {
        changes: { outputs: { affected: "true" } },
        plan_preview: { outputs: { image: "true", packages: "true" } },
        package_preview: { result: "success" },
        image_preview: { result: "success" },
        select_nightly: { outputs: { proceed: "true" } },
        smoke_nightly_source: { result: "success" },
        select_beta: { result: "success", outputs: { mode: "candidate" } },
        verify_beta_candidate: { result: "success" },
        publish_beta: { result: "success" },
        preflight_stable: { outputs: { notes_mode: "master_beta" } },
        publish_stable: { result: "success" },
      };
      for (const event_name of ["push", "schedule", "workflow_dispatch"]) {
        for (const channel of ["stable", "beta", "nightly", "preview"]) {
          const inputs = { channel, dry_run: false };
          const github = { repository: "TogetherWeOwn/paperclip", ref: "refs/heads/master", event_name };
          assert.equal(evaluate(github, inputs, needs, () => false, (a, b) => a.startsWith(b)), false, `${id}: ${event_name}/${channel}`);
        }
      }
      // The repository guard narrows only fork behavior. Existing upstream
      // eligibility remains reachable for the corresponding release lane.
      const channel = id === "publish_beta" ? "beta" : id === "publish_stable" ? "stable" : "nightly";
      const github = { repository: "paperclipai/paperclip", ref: id === "promote_canary_channel" ? "refs/tags/canary/v1" : "refs/heads/master", event_name: id === "publish_canary" ? "push" : "workflow_dispatch" };
      assert.equal(evaluate(github, { channel, dry_run: false }, needs, () => false, (a, b) => a.startsWith(b)), true, `${id}: upstream eligibility`);
      if (id === "publish_nightly") {
        for (const result of ["failure", "cancelled", "skipped"]) {
          needs.smoke_nightly_source.result = result;
          assert.equal(evaluate(github, { channel, dry_run: false }, needs, () => false, (a, b) => a.startsWith(b)), false, `source smoke ${result} must block publication`);
        }
      }
    }
  }
});

test("changes gates omit unrelated PR work but run full master/nightly and dependency changes", () => {
  for (const scope of ["docker", "smoke", "release", "workflows"]) {
    assert.equal(affectedWork("pull_request", scope, ["doc/PRODUCT.md"]), false);
    for (const event of ["push", "schedule", "workflow_dispatch", "workflow_call"]) assert.equal(affectedWork(event, scope, []), true);
    for (const file of [".github/workflows/docker.yml", "packages/db/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/paperclip-runner/runner/Cargo.lock", "patches/postgres.patch"]) {
      assert.equal(affectedWork("pull_request", scope, [file]), true, `${scope}: ${file}`);
    }
  }
  assert.equal(affectedWork("pull_request", "docker", ["Dockerfile"]), true);
  assert.equal(affectedWork("pull_request", "workflows", ["scripts/source-onboard-smoke.test.mjs"]), true);
  assert.equal(affectedWork("pull_request", "workflows", ["ui/src/App.tsx"]), false);
  assert.throws(() => affectedWork("schedule", "unknown", []), /Unknown CI scope/);
});

test("PR selection includes removed and added paths in real Git renames", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.RUNNER_TEMP || tmpdir();
  const selector = fileURLToPath(new URL("./ci-affected-work.mjs", import.meta.url));
  const cases = [
    ["scripts/source-onboard-smoke.sh", "doc/archived-smoke.sh", true],
    ["packages/fixture/package.json", "doc/archived-package.txt", true],
    ["doc/archived-smoke.sh", "scripts/source-onboard-smoke.sh", true],
    ["doc/unrelated.md", "doc/moved.md", false],
  ];
  for (const [from, to, expected] of cases) {
    const root = mkdtempSync(join(scratch, "ci-affected-work-"));
    const git = (...args) => execFileSync("git", ["-c", "user.name=CI Fixture", "-c", "user.email=ci-fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8",
    }).trim();
    try {
      git("init", "-q");
      mkdirSync(dirname(join(root, from)), { recursive: true });
      writeFileSync(join(root, from), "unchanged fixture\n");
      git("add", ".");
      git("commit", "-qm", "fixture base");
      const base = git("rev-parse", "HEAD");
      mkdirSync(dirname(join(root, to)), { recursive: true });
      renameSync(join(root, from), join(root, to));
      git("add", "-A");
      git("commit", "-qm", "fixture rename");
      const head = git("rev-parse", "HEAD");
      // Prove this is a detected rename, not a delete/add fixture by accident.
      assert.match(git("diff", "--name-status", "--find-renames", `${base}...${head}`), /^R100\s/);
      const output = join(root, "output");
      for (const scope of ["workflows", "docker", "smoke", "release"]) {
        writeFileSync(output, "");
        const result = spawnSync(process.execPath, [selector], {
          cwd: root, encoding: "utf8",
          env: { PATH: process.env.PATH, CI_EVENT: "pull_request", CI_SCOPE: scope, CI_BASE_SHA: base, CI_HEAD_SHA: head, GITHUB_OUTPUT: output },
        });
        assert.equal(result.status, 0, result.error || result.stdout || result.stderr);
        assert.equal(readFileSync(output, "utf8"), `affected=${expected}\n`, `${scope}: ${from} -> ${to}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("new CI aggregator fails on scope errors and affected failures, and accepts only deliberate skips", () => {
  const block = job(workflow("workflow-health"), "ci-ok");
  assert.match(block, /if: always\(\)/);
  const script = block.split("        run: |\n")[1];
  for (const [changes, affected, validate, success] of [["success", "true", "success", true], ["success", "false", "skipped", true], ["failure", "false", "skipped", false], ["success", "true", "skipped", false], ["success", "true", "failure", false], ["success", "", "success", false]]) {
    const result = spawnSync("bash", ["-eu", "-c", script], {
      env: { CHANGES_RESULT: changes, AFFECTED: affected, VALIDATE_RESULT: validate }, encoding: "utf8",
    });
    assert.equal(result.status === 0, success);
  }
});
