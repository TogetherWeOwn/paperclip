# Non-AST deterministic checks

These are **offline/CI assets, not installed production gates**. No repository workflow, ruleset, card, or runtime configuration was changed. Commands below run from a disposable checkout of the target repository unless stated otherwise. Do not run application, deployment, migration-apply, or runbook commands against this host. All recipe examples are parsed, never executed.

```bash
ASSETS=/home/ubuntu/paperclip-enterprise-company/ops/analysis/meta-only-quality/assets
HEAD_SHA=$(git rev-parse HEAD)
: "${BASE_REF:?Set the fetched target branch, e.g. origin/main or origin/master}"
BASE_SHA=$(git merge-base "$BASE_REF" "$HEAD_SHA")
export ASSETS HEAD_SHA BASE_SHA
```

## N-exact-head — build/lint/test failures (recurring)

**Tools:** the existing required CI producers, GitHub CLI, and `non_ast.py exact-head`. Source examples: two-bot-next#700 (`F0604`, missing PgPool), #86 (`F0475`, E0507), two-web-next#547 (`F0808`, Biome), ops-tooling#824 (`F0368`, illegal reusable-workflow timeout).

Fetch *all* pages, bind the SHA, trusted producer app, and latest attempt; do not accept an old green, neutral, skipped, missing, or running check. Obtain the approved required producer list/app IDs from the trusted base, not the PR. The example checks only `ci-ok`; repeat `--required` for every approved producer. Paperclip has different producer names. This does not change the existing Review requirement.

```bash
gh api --paginate --slurp "repos/$REPO/commits/$HEAD_SHA/check-runs?per_page=100" > checks.json
python3 "$ASSETS/non_ast.py" exact-head --sha "$HEAD_SHA" --checks checks.json \
  --required "ci-ok@${TRUSTED_ACTIONS_APP_ID:?}"
```

Typical offline producer commands (not a substitute for DB/ignored-test jobs):

```bash
# Rust bot: run in CI with its pinned Rust toolchain, not on rbx1 (no cargo installed).
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
# Hono/SvelteKit web: existing root scripts; the web/ subtree has its own manifest/lock.
npm ci
npm run check:offline
npm run test:coverage
# Ops: syntax/lint only; never import arbitrary ops modules as a syntax check.
ruff check .
ruff format --check .
git ls-files -z '*.sh' | xargs -0 -r shellcheck -S warning
git ls-files -z '*.sh' | xargs -0 -r shfmt -d
# Workflows in every repository:
actionlint
zizmor .github/workflows
# Paperclip: use its existing CI producers and package-manager scripts;
# do not guess that upstream ci / verify and ci / e2e are this fork's live names.
pnpm install --frozen-lockfile
pnpm -r --if-present typecheck
```

`--if-present` is intentionally **not** completeness evidence; inventory the expected packages separately. Existing compiler errors, clippy failures and known red suites get N-exact-head mappings; a speculative future regression does not.

## N-ci-inventory — a suite is present but never executed (recurring)

Examples: ops-tooling#747 (`F0158`), #754 (`F0192`), #868 (`F0449`); paperclip#58 (`F0029`, `F0031`); web#629 (`F0889`). `verify-fast --parse-only`, a source import, an unused local list, and a filename in a workflow comment are **not execution**.

```bash
python3 "$ASSETS/non_ast.py" ci-inventory --repo . --manifest "$TRUSTED_SUITE_INVENTORY"
```

Manifest schema (data supplied/attested from the trusted base during adoption):

```json
{"suites":[{"suite":"test_example.py","workflow":".github/workflows/ci.yml","job":"tests","step":"Run suite","command":"python3 -m unittest test_example"}]}
```

The supplied gate discovers tracked test files, rejects missing rows, verifies the job and one exact standalone runner command, ignores comments, and rejects parse-only/advisory/conditional/reusable invocations. Command substrings inside echo, compound shell, wrappers and early-exit steps do not qualify. It establishes **only explicit suite arguments in structurally unconditional local steps**, not actual execution. Workflow triggers, upstream job dependencies, runner setup, unittest discovery, npm scripts, Rust target expansion, change selectors, matrix jobs and reusable workflows need runner-specific execution manifests and exact-head receipts. The checklist contains the corresponding narrow caller/selector question. This prototype is not a full CI interpreter, and **no blanket historical recall credit is assigned to it**.

## N-patch-coverage — changed executable lines, not aggregate coverage (recurring TEST-WEAK)

**Tools:** cargo-llvm-cov / Vitest V8 / coverage.py and diff-cover. Compare to the merge-base, not the live target tip (web#651 `F0908`, paperclip#39 `F0005`). Coverage measures execution, not meaningful assertions, so it receives no generic TEST-WEAK recall credit.

```bash
# Rust (pinned CI toolchain):
cargo llvm-cov --workspace --cobertura --output-path coverage.xml
diff-cover coverage.xml --compare-branch "$BASE_SHA" --fail-under=80
# Web (project supplies @vitest/coverage-v8):
npx --no-install vitest run --coverage --coverage.reporter=cobertura
diff-cover coverage/cobertura-coverage.xml --compare-branch "$BASE_SHA" --fail-under=80
# Python offline suites, in the suite directory:
coverage run --branch -m unittest discover
coverage xml -o coverage.xml
diff-cover coverage.xml --compare-branch "$BASE_SHA" --fail-under=80
# Paperclip: select the existing Vitest project/shards, then merge coverage before diff-cover.
```

Require the expected test-count/target inventory and a nonempty coverage artifact. A nonexistent file, uncollected test, empty report, or skipped ignored DB suite cannot pass merely because the denominator is zero. Run ignored DB targets on disposable CI Postgres; never point them at production.

## N-mutation — vacuity, copied implementations, weak assertions (recurring)

Examples: bot#712 `F0618`, #763 `F0701`; ops#859 `F0445`; web#692 `F0936`/`F0937`. A surviving mutant is evidence of a gap, not a reason to weaken the mutant. Setup failures, compile errors, timeouts, and missing ExecutionContext are not behavioral kills.

```bash
# Web: existing exact entry points; the runner returns 0 even with survivors.
node ci/mutation-sessions-join.mjs --selftest
node ci/mutation-sessions-join.mjs
# Rust: cargo-mutants v27.1.0 supports file filtering, NOT --in-diff.
cargo mutants --file crates/core/src/self_roles.rs --timeout 300
# Ops: in an isolated mutmut-configured fixture/package, never real broker executors.
mutmut run
mutmut results
# Common fail-closed normalized receipt check (adapter output must be independently attested):
python3 "$ASSETS/non_ast.py" mutation --report mutation-normalized.json
```

Normalized schema: `{"mutants":[{"id":"M1","status":"killed","kill_kind":"assertion","baseline_passed":true,"restored_sha256":"<actual restored-file SHA256>"}]}`. The validator rejects empty runs, survivors, stale/setup kills, missing baseline and missing restoration. It validates a receipt; it does **not** magically infer kill causality or execute the repository-specific mutant adapters. Those adapters and frozen-test provenance remain integration work. Consequently this document does **not** count every weak-test finding as caught by mutation tooling.

Use changed-file selection derived with `git diff --name-only -z "$BASE_SHA" "$HEAD_SHA"` and a NUL-safe argv builder. Never interpolate arbitrary filenames into shell command text. For precise vacuity, run the fixed tests against both the fixed implementation and the reverted/key-line-mutated implementation in isolated checkouts; require clean baseline success and assertion failure on the mutant.

## N-regen-diff — generated docs, catalogs and snapshots (recurring)

Examples: ops#749 `F0162`, bot#675 `F0588`. **Narrow command mappings only:** bot#760 `F0690` has an incorrect generator inventory, so regeneration alone remains green and does NOT catch it. Ops#761 `F0201` has a correct snapshot but no CI wiring, so a successful one-off comparison is NOT proof that the missing gate exists.

```bash
# Bot: exact generator is an ignored test, not a guessed generator script.
cargo test -p two-bot-core --test reference_docs regenerate_reference_docs -- --ignored
git diff --exit-code -- docs/
cargo test -p two-bot-core --test reference_docs
# Ops runbook: stream comparison is read-only.
./operator_runbook.sh render | diff -u docs/OPERATOR-RUNBOOK.md -
# Ops split freeze inventory, using the trusted base tree to prevent self-exemption:
cut -d'|' -f1 vendor/toolkit-files.txt | sort -u | grep -v '^plugins/model-selection/' \
  | comm -23 - <(git ls-tree -r --name-only "$BASE_SHA" | sort -u) > generated-freeze-list.txt
# Compare generated-freeze-list.txt with the data lines of the declared snapshot;
# resolve the snapshot path/header format from its generator declaration, not a guess.
# Web: verified existing config/doc cross-check entry point.
npm run config:check
```

Generator commands that mutate tracked files belong only in disposable CI checkouts. Require both the regenerated diff and generator-input inventory tests. `git diff --exit-code` cannot detect a generator that faithfully reproduces a wrong table.

## N-lockfiles — all lockfiles and frozen installs (recurring family)

Examples: web#538 `F0795` missed `web/package-lock.json`; bot#757 `F0685`/`F0686` missed `fuzz/Cargo.lock`; paperclip#39 `F0005`/`F0007` compared a live re-resolution with an honest lockfile.

```bash
python3 "$ASSETS/non_ast.py" lockfiles --repo .
# Web: audit BOTH independent lockfiles, no install/postinstall scripts required.
npm audit --package-lock-only --audit-level=high
npm audit --prefix web --package-lock-only --audit-level=high
# Bot: audit workspace and fuzz lockfile explicitly.
cargo deny check advisories
cargo audit --file fuzz/Cargo.lock
cargo check --manifest-path fuzz/Cargo.toml --locked
# Paperclip:
pnpm audit --audit-level high
pnpm install --frozen-lockfile --ignore-scripts
node --test .github/scripts/tests/check-pr-lockfile.test.mjs
```

Inventory is not vulnerability scanning; audit exit status is not a missing-lockfile detector. Keep both. Frozen install checks lock/manifest compatibility, **not byte identity with today's resolver**. Offline/advisory-database-unavailable is unknown/failure, not clean. Commands were not run against these repos on rbx1.

## N-migration-lock — migration inventory and ordering

Example bot#679 `F0592`; web and Paperclip also have existing migration checkers. Do not apply DDL as a review check.

```bash
# Bot's existing hash/order/immutability contract:
python3 scripts/check-migrations.py
# Supplemental reusable inventory check:
python3 "$ASSETS/non_ast.py" migration-lock --repo . --lock migrations.lock \
  --glob 'crates/*/migrations/*.sql'
# Web:
bash ci/check-migration-numbers.sh
node --test ci/check-migration-history-selftest.mjs
# Paperclip:
node --test .github/scripts/tests/check-pr-migration-order.test.mjs
```

DDL timeout separation (bot#765 `F0704`) is not inferred from SQL text alone: quote runtime connection options and migration executor; exercise long DDL only on disposable Postgres.

## N-text-nul — text must remain reviewable

Example web#692 `F0938`. This reads bytes; AST rules cannot reliably scan a file hidden as binary.

```bash
python3 "$ASSETS/non_ast.py" nul --repo .
```

## N-runbook-shell — env export, URL quoting, parseable recipes (recurring)

Examples ops#565 `F0091`/`F0094`, #660 `F0117`, #668 `F0122`, #793 `F0282`. Extract recognized shell/env/cron fences and inline backtick cron recipes; strip five numeric cron scheduling fields and an optional recognized system-crontab user without executing the command. Both per-user and system crontabs are supported. ShellCheck plus the supplied Bash rules catches syntax/quoting/export hazards. Other inline commands, named-month schedules and unrecognized users require explicit extraction, not an absence-of-hits claim.

```bash
python3 "$ASSETS/non_ast.py" extract-shell --input ops/tog-6886/OPERATOR.md --output "$ASSETS/evidence/runbook-shell"
find "$ASSETS/evidence/runbook-shell" -name '*.sh' -print0 | xargs -0 -r -n1 bash -n
find "$ASSETS/evidence/runbook-shell" -name '*.sh' -print0 | xargs -0 -r shellcheck -S warning
npx --yes --package @ast-grep/cli@0.50.0 ast-grep scan \
  --config "$ASSETS/rules/sgconfig.yml" "$ASSETS/evidence/runbook-shell"
```

Use a fresh task-specific output directory when adopting this recipe; stale extracted files must not contaminate a run. An unset secret in a synthetic env is expected; never source production env files during validation.

## Other recurrent families: commands and honest boundaries

| Family / corpus examples | Tool + exact entry point | What still needs a bounded fixture or named excerpt |
|---|---|---|
| Regex pathological no-match (`F0292`, `F0433`) | supplied `py-redos-*` ast-grep rules; `timeout 60s python3 -m unittest test_upstream_lint` and `timeout 60s python3 -m unittest test_github_runner_bundle` | Existing suites alone missed these cases; use the two supplied positive patterns as new adversarial fixtures. A timeout is failure, not a kill. |
| Changed-diff prefixes / rename parsing (`F0252`, `F0254`, `F0398`, `F0410`) | `python3 -m unittest test_upstream_lint` | Add `--no-prefix`, pure rename, binary numstat, empty/malformed diff cases; no claim those cases exist today. Prefer Git's NUL-delimited machine format over reparsing display diffs. |
| Shell grammar and source guard blind spots (`F0393`–`F0411`) | `bash -n` plus `shellcheck`; `python3 -m unittest test_upstream_lint` | Grammar fixtures for nested substitutions, heredoc comments and multiline spans. A script parsing successfully does not prove the custom coverage parser agrees. |
| Dockerfile/BuildKit parser differential (`F0105`–`F0112`) | `docker buildx build --network=none --no-cache --progress=plain --file fixtures/Dockerfile fixtures` | Fixture directory is **not supplied**: isolated builder, local/pinned base and deliberate bypass corpus required before execution. Do not run untrusted Dockerfile recipes on rbx1. These findings stay judgment/uncovered rather than being waved through by generic Docker lint. |
| Cross-language literal/catalog drift (`F0293`, `F0312`, `F0739`, `F0769`) | `cargo test -p two-bot-core --test settings_catalog_acceptance`; `npm --prefix wrangler test` (bot wrapper; node:test, not Vitest) | Actual consumer set must be compared with producer enum/registry, not a second copied list. Checklist supplies excerpt comparison; no universal AST proof. |
| Heartbeat/cadence/timeout arithmetic (`F0095`, `F0118`, `F0133`, `F0183`, `F0233`, `F0624`) | `python3 -m unittest test_github_runner_bundle` (ops runner-contract suite) | Different repos store cadences in different places; quote real scheduler and thresholds. No invented general heartbeat checker or coverage credit. |
| Parallel global state (`F0600`, `F0615`) | Rust test-global-* warnings; `cargo test -p two-bot-discord --test custom_command_runtime -- --test-threads=8` | Package name verified in crates/discord/Cargo.toml; randomized repeat/stress testing is not a deterministic proof. Prefer per-test state or one shared lock. |
| Stat/open identity (`F0348`, `F0349`) | supplied `ts-path-stat-then-stream` ast-grep rule | Alias/dataflow variants need a forced atomic-replacement fixture. Default TypeScript grammar is explicitly mapped to .cjs/.mjs/.js. |
| SAST rule schema / bad CLI (`F0370`, `F0375`, `F0376`, `F0377`) | `semgrep --validate --config rules/`; `semgrep --test --config rules/`; `actionlint` | Do not use `python -m semgrep`; package entry point differs. Validate pinned tool versions and do not hide failures with continue-on-error. |

The Dockerfile, arbitrary-parser, causal-history, lock-order, and cross-process-state problems are **not solved by these generic commands**. Their absence from automatic coverage is deliberate. Recurrence does not make a semantic defect expressible as an AST rule.

## Local validation actually performed

```bash
PYTHONDONTWRITEBYTECODE=1 python3 "$ASSETS/test_non_ast.py" -v
PYTHONDONTWRITEBYTECODE=1 python3 "$ASSETS/validate_assets.py" --cleanup
```

Receipts: `rules/validation.json`, `rules/validation.txt`, `rules/non-ast-validation.txt`, `rules/historical-replay.json`. Non-AST unit tests use temporary fixtures only under assets and delete them. Repository builds, cargo tests, mutation campaigns, audits, Docker builds and database jobs above were **not** executed in this task.
