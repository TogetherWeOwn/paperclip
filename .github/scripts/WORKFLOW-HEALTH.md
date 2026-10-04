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
Negative cases must reject caller-level `continue-on-error` on reusable jobs and
`runner.temp` in job-level env. Other cases exercise mixed-case image paths,
fork publication guards, source-smoke failures, and the `ci-ok` result gate.

Workflow Health runs on PRs without a workflow-level path filter. Its read-only
`changes` job selects affected work. Dependency, lockfile, patch, and `.github`
changes run all scoped checks. Master pushes and nightly schedules always run
all scoped checks. Its single `ci-ok` job rejects scope errors, failed validation,
and unexpected skips. Existing repository-required checks remain unchanged.
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
