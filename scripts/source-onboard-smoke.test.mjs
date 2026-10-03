import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Pins the wiring that makes the exact-source smoke an effective gate.
//
// The fork's nightly selector promotes a published canary by tag, but the
// fork has published no canary since September 5 — so smoke_nightly tests a
// 400-commit-old artifact against this week's contracts and fails every
// night. The source smoke instead boots the exact selected source and runs
// the unchanged release suite against it. These assertions keep the new lane
// from being silently disconnected or weakened.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "source-onboard-smoke.sh");
const script = readFileSync(scriptPath, "utf8");
const sourceWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "source-smoke.yml"),
  "utf8",
);
const releaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

test("smoke script is executable and parses", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath]);
});

test("smoke script keeps its load-bearing assertions", () => {
  assert.match(script, /^set -euo pipefail$/m);
  // Boots the checked-out source, never a published package.
  assert.match(script, /cli\/src\/index\.ts.*onboard --yes --bind lan/);
  assert.doesNotMatch(script, /npx --yes "paperclipai@\$/);
  assert.doesNotMatch(script, /PAPERCLIPAI_VERSION/);
  // Records the exact source under test for the diagnostics.
  assert.match(script, /SOURCE_SHA="\$\(git -C "\$REPO_ROOT" rev-parse HEAD\)"/);
  // Refuses to certify a server that is not the booted source.
  assert.match(script, /is not the booted source/);
  // Fails when the server never serves health.
  assert.match(script, /wait_for_http "\$PAPERCLIP_PUBLIC_URL\/api\/health"/);
  // Reuses the Docker harness's provider-mock shape: one hardcoded endpoint
  // answered locally, everything else a loud 404, product untouched.
  assert.match(script, /api\.anthropic\.com/);
  assert.match(script, /provider mock: unexpected endpoint/);
  assert.match(script, /NODE_EXTRA_CA_CERTS/);
  // Privilege is explicit and minimal: the mock binds loopback 443 and maps
  // the one hostname through /etc/hosts, and only that boot runs elevated.
  assert.match(script, /server\.listen\(443, "127\.0\.0\.1"/);
  assert.match(script, />>\/etc\/hosts/);
  // The throwaway password never reaches the log line or the uploaded env:
  // it travels in curl bodies (never echoed, no xtrace) and a step-scoped
  // file the upload does not include.
  assert.doesNotMatch(script, /Smoke admin credentials:.*SMOKE_ADMIN_PASSWORD/);
  assert.match(sourceWorkflow, /source-smoke\.pw/);
  assert.doesNotMatch(sourceWorkflow, /source-smoke\.env\n/);
  // Reports the server pid so the workflow can stop it after the suite.
  assert.match(script, /SMOKE_SERVER_PID/);
});

test("source-smoke workflow checks out the selected source and runs the release suite", () => {
  assert.match(sourceWorkflow, /ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/);
  assert.match(sourceWorkflow, /expected="\$\{\{ inputs\.source_sha \|\| github\.sha \}\}"/);
  assert.match(sourceWorkflow, /persist-credentials: false/);
  // No pnpm cache: the checkout is a caller-supplied SHA, and a cache keyed
  // on the lockfile could restore dependencies the selected source never had.
  assert.doesNotMatch(sourceWorkflow, /cache: pnpm/);
  assert.match(sourceWorkflow, /scripts\/source-onboard-smoke\.sh/);
  // Privilege is explicit and scoped: only the mock/server boot runs
  // elevated (443 bind + hosts entry); install, suite, and upload do not.
  assert.match(sourceWorkflow, /sudo -E env/);
  assert.equal(
    (sourceWorkflow.match(/sudo -E env/g) ?? []).length,
    1,
    "exactly one sudo step: the mock/server boot",
  );
  assert.match(sourceWorkflow, /pnpm run test:release-smoke/);
  assert.match(sourceWorkflow, /PAPERCLIP_PLAYWRIGHT_CHANNEL: "chrome"/);
  assert.match(sourceWorkflow, /google-chrome --version/);
  // Least privilege: the workflow declares no write beyond checkout.
  assert.match(sourceWorkflow, /permissions: \{\}/);
  assert.match(sourceWorkflow, /contents: read/);
  // Diagnostics must survive the run with the source identity attached.
  assert.match(sourceWorkflow, /source-onboard-smoke\.log/);
  assert.match(sourceWorkflow, /source-smoke\.env/);
  assert.match(sourceWorkflow, /if-no-files-found: error/);
  assert.match(sourceWorkflow, /tests\/release-smoke\/playwright-report\//);
  // The lane is exercisable before it gates anything: a manual dispatch
  // with an optional SHA, so its first run is never the production gate.
  assert.match(sourceWorkflow, /workflow_dispatch:/);
  assert.match(sourceWorkflow, /source_sha:\n\s+description: Full commit SHA/);
  // The redact step actually receives the credential: it sources the same
  // step-scoped file the suite step does — and it tolerates the boot step
  // having failed before writing that file, when there is nothing to redact.
  const redact = sourceWorkflow.split("Redact the credential")[1] ?? "";
  assert.match(redact.split("- name:")[0], /source-smoke\.pw/);
  assert.match(redact.split("- name:")[0], /if \[\[ ! -f .*source-smoke\.pw/);
});

test("nightly promotion is gated on the source smoke; the stale published lane is informational", () => {
  assert.match(releaseWorkflow, /smoke_nightly_published:\n\s+needs: select_nightly/);
  // Informational, never blocking: the inherited stale canary fails nightly
  // while fork canary publication is absent, so its result is ignored.
  const published = releaseWorkflow.split("smoke_nightly_published:\n")[1].split("smoke_nightly_source:")[0];
  assert.match(published, /continue-on-error: true/);
  assert.match(releaseWorkflow, /smoke_nightly_source:\n\s+needs: select_nightly/);
  // Both nightly caller jobs carry the caller's least privilege explicitly:
  // `permissions` is a valid caller-job key beside `uses`, and the called
  // workflow's own blocks are the second layer, not the only one.
  const nightlyCallers = releaseWorkflow.split("smoke_nightly_published:\n")[1].split("publish_nightly:")[0];
  assert.equal(
    (nightlyCallers.match(/permissions:\n\s+contents: read/g) ?? []).length,
    2,
    "both smoke_nightly_* caller jobs declare contents: read",
  );
  assert.match(
    releaseWorkflow,
    /source_sha: \$\{\{ needs\.select_nightly\.outputs\.sha \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /needs: \[select_nightly, smoke_nightly_source\]/,
  );
  assert.match(
    releaseWorkflow,
    /needs\.smoke_nightly_source\.result == 'success'/,
  );
  // The published lane's result gates nothing: a stale-canary failure must
  // never veto a source-verified candidate.
  assert.doesNotMatch(releaseWorkflow, /needs\.smoke_nightly_published\.result/);
  // The old single-gate references must be gone: one stale `smoke_nightly`
  // would silently gate on a job that no longer exists.
  assert.doesNotMatch(releaseWorkflow, /needs\.smoke_nightly\.result/);
  assert.doesNotMatch(releaseWorkflow, /\[select_nightly, smoke_nightly\]/);
});

test("beta still routes through the published-artifact smoke only", () => {
  assert.match(
    releaseWorkflow,
    /smoke_beta:\n\s+needs: publish_beta/,
  );
  assert.doesNotMatch(
    releaseWorkflow.match(/smoke_beta:[\s\S]*?(?=\n  # ----- Stable lane)/)?.[0] ?? "",
    /source-smoke/,
  );
});
