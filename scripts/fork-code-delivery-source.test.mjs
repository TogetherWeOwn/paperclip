import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const document = YAML.parseDocument(readFileSync(new URL("../.github/workflows/fork-code-delivery-source.yml", import.meta.url), "utf8"));
const workflow = document.toJS();
const job = workflow.jobs.generate;
const step = (name) => {
  const found = job.steps.find((value) => value.name === name);
  assert.ok(found, `Missing workflow step: ${name}`);
  return found;
};

test("generation is limited to the selected same-fork draft source", () => {
  assert.deepEqual(document.errors, []);
  assert.deepEqual(Object.keys(workflow.on), ["push", "pull_request"]);
  assert.deepEqual(workflow.on.push.branches, ["verify/native-pr-completion-guard"]);
  assert.match(job.if, /github\.event_name == 'push'/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/verify\/native-pr-completion-guard'/);
  const identity = step("Bind workflow and direct source identities");
  assert.match(identity.run, /len\(prs\) == 1/);
  assert.match(identity.run, /pr\['head'\]\['sha'\] == event\['after'\] == os\.environ\['GITHUB_SHA'\]/);
  assert.match(identity.run, /pr\['state'\] == 'open' and pr\['draft'\] is True/);
  assert.deepEqual(workflow.on.pull_request.branches, ["master"]);
  assert.match(job.if, /github\.repository == 'TogetherWeOwn\/paperclip'/);
  assert.match(job.if, /head\.repo\.full_name == 'TogetherWeOwn\/paperclip'/);
  assert.match(job.if, /head\.ref == 'verify\/native-pr-completion-guard'/);
});

test("source identity is distinct from workflow and synthetic merge identity", () => {
  const identity = step("Bind workflow and direct source identities");
  assert.match(identity.run, /pr\['base'\]\['repo'\]\['full_name'\] == repo/);
  assert.match(identity.run, /re\.fullmatch\(r'\[0-9a-f\]\{40\}', source\)/);
  for (const field of ["source_sha", "source_tree", "workflow_sha", "pr_head_sha", "pr_base_sha", "pr_merge_sha", "event_sha", "stock_base_sha", "run_url"]) {
    assert.ok(identity.run.includes(`'${field}'`), `Missing provenance field ${field}`);
  }
  const checkout = step("Checkout the exact same-fork source without credentials");
  assert.equal(checkout.with.ref, "${{ steps.identity.outputs.source_sha }}");
  const verification = step("Verify checked-out bytes before source execution");
  assert.match(verification.run, /git rev-parse 'HEAD\^\{tree\}'/);
  assert.match(verification.run, /SOURCE_TREE/);
  assert.ok(job.steps.indexOf(verification) < job.steps.indexOf(step("Frozen install with every lifecycle script disabled")));
});

test("generation has read-only permissions, pinned actions and no script exceptions", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job.environment, undefined);
  for (const action of job.steps.filter((value) => value.uses)) {
    assert.match(action.uses, /^[\w/-]+@[0-9a-f]{40}$/);
    if (action.uses.startsWith("actions/checkout@")) {
      assert.equal(action.with["persist-credentials"], false);
      assert.equal(action.with.submodules, false);
    }
  }
  const install = step("Frozen install with every lifecycle script disabled");
  assert.match(install.run, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(install.run, /lacks native minimumReleaseAge/);
  const source = step("Verify checked-out bytes before source execution");
  assert.match(source.run, /git ls-files '\*pnpmfile\*'/);
  assert.match(source.run, /workspace-hooks\.json/);
  assert.equal(job.steps.filter((value) => value.env?.GH_TOKEN).length, 1);
  for (const value of Object.values(job.env)) assert.doesNotMatch(String(value), /secrets\./);
});

test("subsystem checks use integrated bytes and cannot pass with skipped PostgreSQL tests", () => {
  const candidate = step("Verify the integrated direct-source delivery subsystem");
  assert.ok(candidate["timeout-minutes"] <= 20);
  assert.match(candidate.run, /git diff --exit-code HEAD -- packages\/db\/src\/migrations/);
  assert.match(candidate.run, /git ls-files --others --exclude-standard packages\/db\/src\/migrations/);
  assert.match(candidate.run, /CREATE FUNCTION code_delivery_terminal_guard/);
  assert.match(candidate.run, /pnpm exec vitest run --maxWorkers=1 --no-file-parallelism/);
  for (const name of ["code-delivery-migration.test.ts", "code-delivery-terminal-guards.test.ts", "issue-code-delivery-persistence.test.ts"]) {
    assert.ok(candidate.run.includes(name));
  }
  assert.match(candidate.run, /result\['numPendingTests'\] == 0/);
  assert.match(candidate.run, /len\(files\) == 12/);
  assert.match(candidate.run, /candidate-db-typecheck pnpm --filter @paperclipai\/db typecheck/);
  assert.match(candidate.run, /candidate-server-typecheck pnpm --filter @paperclipai\/server typecheck/);
  assert.match(candidate.run, /PIPESTATUS/);
  assert.match(candidate.run, /candidate-tests\.json/);
});

test("generation is bounded and failures still retain diff and logs", () => {
  assert.ok(job["timeout-minutes"] <= 40);
  const generate = step("Generate migration source without database access");
  assert.match(generate.run, /test -z "\$\{DATABASE_URL:-\}"/);
  assert.match(generate.run, /timeout .*12m pnpm db:generate/);
  assert.match(generate.run, /PIPESTATUS/);
  const report = step("Retain all generation changes and failure evidence");
  assert.equal(report.if, "always()");
  for (const evidence of ["generation.patch", "generation-status.txt", "unexpected_changes", "dependency-hooks.json", "SHA256SUMS"]) {
    assert.ok(report.run.includes(evidence), `Missing artifact data ${evidence}`);
  }
  assert.match(report.run, /'qualified': False/);
  assert.match(report.run, /'candidate_outcome': os\.environ\['CANDIDATE_OUTCOME'\]/);
  assert.match(report.run, /if not result\['subsystem_checks_succeeded'\]/);
  assert.match(report.run, /raise SystemExit\(1\)/);
  const upload = step("Upload generated source and logs even on failure");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["if-no-files-found"], "error");
});
