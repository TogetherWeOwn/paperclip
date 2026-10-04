import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { affectedWork } from "./ci-affected-work.mjs";

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
const job = (text, id) => text.split(`\n  ${id}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
const lint = (text) => spawnSync(process.env.ACTIONLINT || "actionlint", ["-shellcheck=", "-pyflakes=", "-"], {
  input: text, encoding: "utf8",
});

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
    const result = lint(text);
    assert.equal(result.status, 0, `${name}: ${result.error || result.stdout || result.stderr}`);
    for (const [, callee] of text.matchAll(/uses: \.\/\.github\/workflows\/([\w-]+)\.yml/g)) pending.push(callee);
  }
});

test("semantic validation rejects caller-level continue-on-error on a reusable workflow", () => {
  const text = workflow("release").replace("  smoke_nightly_published:\n", "  smoke_nightly_published:\n    continue-on-error: true\n");
  const result = lint(text);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /continue-on-error.*not available/);
});

test("semantic validation rejects runner context in job-level env", () => {
  const text = workflow("source-smoke").replace("  smoke_source:\n", "  smoke_source:\n    env:\n      SMOKE_LOG_FILE: ${{ runner.temp }}/source-onboard-smoke.log\n");
  const result = lint(text);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /context "runner" is not allowed here/);
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
