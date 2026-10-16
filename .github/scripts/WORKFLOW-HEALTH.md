# Workflow health checks

Use actionlint **1.7.12** to validate GitHub job schemas, expression contexts,
and local reusable calls. Generic YAML parsing is not sufficient. The regression
suite walks the Docker, Release, Source Smoke, Release Smoke, and Workflow Health
call graphs, including the unchanged Release Verify and Runner Chaos callees.

```sh
GOBIN="${PAPERCLIP_RUN_SCRATCH_DIR:-$HOME/.local/bin}" go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
ACTIONLINT="${PAPERCLIP_RUN_SCRATCH_DIR:-$HOME/.local/bin}/actionlint" \
  node --test scripts/source-onboard-smoke.test.mjs scripts/ci-workflow-health.test.mjs
node --test scripts/__tests__/release-verify-workflow.test.mjs
```

`ACTIONLINT` selects an existing validator; otherwise the tests use `actionlint`
from PATH. A missing validator fails the tests. These checks disable optional
ShellCheck/Pyflakes integrations, not actionlint's GitHub-aware semantic checks.
Positive validation uses real workflow filenames so actionlint resolves local
reusable-call contracts. In-memory mutations use `-stdin-filename` with the real
workflow path; anonymous stdin would omit those contract checks. Negative cases
must reject unknown callee inputs, caller-level `continue-on-error` on reusable
jobs, and `runner.temp` in job-level env. Other cases exercise mixed-case image
paths, fork publication guards, source-smoke failures, and the `ci-ok` result gate.

Workflow Health runs on PRs without a workflow-level path filter. Its read-only
`changes` job selects affected work. Its Git path list disables rename detection
to include both removed and added paths; moving an in-scope harness into docs
cannot skip its validation. Real Git rename fixtures cover harness and dependency
moves, reverse moves, and unrelated docs-only moves across all scopes.
Only docs-only diffs skip scoped checks: `doc/**/*.md`, `README.md`, and
`CONTRIBUTING.md`. Every other path runs them, including unknown top-level
paths, `skills/`, `announcements/`, `.npmrc`, and `.pnpmfile.*`. An empty diff
also runs them. Unknown scopes warn and run all scoped work as a fail-open fallback.
The selector script `scripts/ci-affected-work.mjs` runs from a sparse checkout of
`master`, never from the PR base (a deploy branch may predate it); the base
commit only supplies diff objects, and the pull request head is fetched only as
diff data. The triple-dot diff still uses the event's base and head SHAs. The
workflow files that gate a pull request still come from its merge commit;
`pr.yml` pins the trusted workflow to master, so trusted-workflow wiring takes
effect on PRs only after it merges.
Master pushes and nightly schedules always run all scoped checks. Its single bare `ci-ok` job (Workflow Health) rejects scope errors, failed validation,
and unexpected skips. The trusted PR workflow mirrors this with a `pr`-scoped
`changes` job gating every heavy lane at job level and a single `ci / ci-ok` check (the `ci-ok` job in `pr-trusted.yml`, reported through the `ci` caller job in `pr.yml`);
`verify` and `e2e` stay as legacy aggregates underneath it. Switching
repository protection to `ci / ci-ok` (not the bare Workflow Health `ci-ok`) is a repo-admin step tracked separately and
does not happen in a workflow change. Existing repository-required checks remain unchanged.
The other repaired workflows use the same scoped changes job; their explicit
release/source selections run their full existing verification lanes.

## Fork non-publication boundary

In non-canonical repositories, Docker builds and loads a local amd64 production
image on `ubuntu-latest`, then verifies orphan reaping. This lane does not log
into a registry, use registry cache exports, grant package/OIDC write access,
export digests, create manifests, attest, or publish. All upstream Docker
publish jobs require `github.repository == 'paperclipai/paperclip'`. Registry
paths are normalized once per job with `${GITHUB_REPOSITORY,,}` before use.
Canonical upstream multi-architecture builds and promotion guards are retained.

Release package/image/tag/notes writers also require the canonical repository.
A fork master push therefore cannot start a publisher. Fork scheduled smoke
remains diagnostic only: fixing invalid YAML must not grant publication.
The exact-source nightly smoke remains mandatory before any eligible real
nightly publication. Only the published-artifact nightly call passes
`informational: true`; the called workflow supports this at ordinary job level,
keeps failing-step evidence and diagnostic uploads, and records actual outcomes
in summaries. Manual and beta published-smoke calls default to blocking.

Do not dispatch or rerun publishing workflows to test this boundary. Inspect
post-merge automatic Docker, Release, and Workflow Health results at the exact
merge SHA. Require the fork local-build result and skipped publisher jobs;
parser validation alone is not proof that a hosted image build passed.

## Mirror PR test groups

Upstream mirror PRs target bases named `mirror/base-*`, `mirror-base/*`, or
`mirror/upstream-*`. On those bases, each `General tests` matrix entry asks the
PR head's `scripts/run-vitest-stable.mjs --mode general --dry-run` which groups
it defines. A group the head does not define is skipped, with a notice and a
step-summary line. It is never reported as passed. If the head group list
cannot be read, the group runs. Ordinary PRs always run their group.

The resolver comes from master, not from the PR merge commit. The policy job
checks the PR's current base tip, not the base pinned when the event fired.
