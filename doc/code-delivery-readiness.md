# Native code-delivery readiness candidate

Status: **incomplete reference implementation; not deployable**.

The candidate retains code-delivery ownership independently of task presentation.
Work-product URLs and snapshots discover associations; their labels, deletion,
reclassification or movement cannot authorize completion or remove retained
obligations. Canonical registration and independent delivery decisions have
separate server-owned provenance.

## Ownership of the implementation

- `code-delivery-github.ts` owns bounded authenticated GitHub observations using
  existing project/workspace consent. Anonymous display reads cannot certify
  delivery. It performs no subprocess credential lookup.
- `code-delivery-authority.ts`, `code-delivery-registration.ts`, and
  `code-delivery-decisions.ts` own company-scoped registration, independent
  adjudication, exact-head acceptance and retained ownership transfers.
- `code-delivery-readiness-policy.ts` evaluates every owned obligation, retained
  association and independently authorized outcome.
- `code-delivery-readiness.ts` prepares remote evidence outside mutation locks,
  then re-locks, compares the complete saved snapshot and consumes the prepared
  evidence with the terminal mutation.
- `issue-code-delivery.ts` connects that protocol to the common issue update
  service. Shared issue mutation code does not interpret GitHub payloads.

## Mutation protocol

`prepare(companyId, issueId, effectiveStatus, actor, expectedIssueRevision?)`
returns an opaque process-local token. Nonterminal effective results return null
without querying delivery state or contacting GitHub. A supplied expected
revision binds preparation to the task on which the caller computed its policy
transition; an intervening change fails before provider access.

`apply(transaction, ..., token, mutate)` claims that token once and uses a nested
savepoint for current authorization, snapshot comparison, receipt creation,
mutation, consumption validation and audit. All provider reads occur during
preparation, not while this savepoint holds task locks. Issue re-locking uses
`NOWAIT`; lock conflicts and deadlocks become a typed readiness revision conflict,
not an implicit retry with cached proof.

The common `issues.update` service requires server-only `options.codeDelivery`
for an effective `done` or `cancelled` write. This is not HTTP input. The
prepared actor must match the mutation's agent/run or user attribution. Missing
preparation, reconstructed receipt JSON, system calls without a supported actor,
and terminal timestamps without the corresponding status fail closed. Earlier
native approvals whose effective result is `in_review` do not require delivery
proof.

A failed savepoint removes any post-commit publications/actions appended by that
attempt while preserving the caller's earlier entries. The outer transaction
owner still owns delivery after successful outer commit; releasing a savepoint
is not permission to publish or stop a process.

The common terminal write owns the task's update timestamp and certified revision.
Its interaction-expiry call skips the redundant task touch, while retaining
interaction expiry, linked-action revocation and their normal publications.
Other expiry callers retain the default touch. Receipt settlement still rejects
any subsequent task revision within the certifying transaction.

## Explicitly incomplete integration

**REST terminal updates currently return `409 code_delivery_not_ready` with
reason `terminal_effects_preparation_required`, including genuinely merged
cases.** A pure effective-status preflight runs before private-project creation,
interrupt handling or run/goal stops. It permits an earlier review approval that
still advances to `in_review`. This is a temporary fail-closed boundary, not a
finished positive completion path or an exemption for agent-owned tasks.

The common terminal mutation now authors run-stop intents in the receipt's own
savepoint, after the terminal SQL write consumes that receipt. The heartbeat-owned
`issue-terminal-stops.ts` acceptance boundary checks company/task/run binding,
current transaction and terminal revision, locks a bounded set of exact run targets
with NOWAIT, and writes one `stop_run` effect per receipt/run. It makes no process,
provider or goal-control calls. Rollback removes the intent with the status and
receipt; another connection cannot read it until outer commit.

**This new effect schema is awaiting supported Actions migration generation and
integration. No effect dispatcher or scheduler registration exists yet.** The
candidate remains uninstalled and REST still fails closed. Accepting an intent
is not stopping a run, proving physical termination, or authorizing successor
execution. Goal-stop acceptance and fenced delivery/retry/settlement remain
required before enabling REST completion. Merely moving the provider read before
the existing physical stop is insufficient: a later revision conflict must leave
the run and goal untouched.

Native finalization and other common-service callers without preparation also
fail closed. A completed-run/system preparation authority has not been
implemented; it must revalidate server-derived source/run and current project
consent without borrowing ambient human credentials. Direct SQL writers, terminal
creation/import, lifecycle deletion/export, supersession and all-writer/race
acceptance remain incomplete.

Migration `0434_brainy_franklin_richards.sql` includes the generated receipt and
consumption tables plus the terminal guard, immutable history and deferred
settlement checks. Its schema snapshot and journal came from the supported
Actions generator; only SQL received custom trigger definitions. Applying the
migration would activate a fail-closed database backstop, including for terminal
creation/import and direct SQL updates. No running instance has applied it.
Writer preparation, durable effects and full acceptance remain incomplete: do
not install this candidate or claim universal usable completion from the SQL
backstop alone.

## Verification limits

Exact-source Actions run `41992896333` at
`50308eee54dc4507f726f199131b271b88b35660` passed all thirteen selected
suites: **450 tests, zero failed/skipped/pending/todo**, database/server
typechecks and module boundaries. Migration regeneration changed no source.
That qualification precedes the terminal-effect acceptance changes. Their new
schema, custom SQL guard fragment and persistence regressions are unverified;
the fragment must be reviewed and integrated with the Actions-generated migration.
No new local tests, typecheck, build, generation or installation ran. Prior failures
below remain part of the retained qualification history. This targeted successful
run is not full-repository or REST/native/all-writer acceptance.

The first integrated direct-source Actions run at
`51e6b0194169c0414ebde07b8bf2d60d7a9d7171` executed 428 tests: 418 passed and
10 failed, with none skipped. Migration regeneration produced no source changes.
Ten suites passed, including the complete-schema migration, executable SQL guard,
readiness policy and common-service denial suites. Six registration tests failed
on fixtures missing the required work-product provider; four boundary tests failed
because a reset hook returned a mock that Vitest then invoked as teardown.
These failures remain part of the evidence, not a successful qualification.

The follow-up fixes those fixtures and the reset hook. New common-service
PostgreSQL regression sources exercise independently classified non-code
completion/cancellation, exact merged-head receipt consumption, competing
preparations, outer-transaction rollback and changed review rounds. Denial snapshots now include delivery
intents, obligations, decisions, discoveries, ownership, receipts and consumption
rows alongside task/run/interaction state. The provider is controlled in these
tests; this is not live GitHub or REST/native-finalizer acceptance. Only the
previously failing single boundary test was reproduced locally and passed after
the hook fix. The new persistence cases await exact-source Actions execution.

The next Actions run at `c7c59dc2a15dea9f4808a25d0cdc20d56d5cedfe` executed
434 tests: **423 passed, 11 failed, none skipped**. The failures exposed an
additional post-consumption task touch in interaction expiry, incomplete native
review-state fixtures and an exact-window SQL fixture using two different clock
reads. The current changes remove only that redundant touch, complete the review
fixtures and use a stable statement timestamp for the receipt window; they do not
relax receipt or independent-adjudicator validation. A single merged-proof
common-service test failed before and passed after the touch repair. Its ten
unselected tests were skipped by the explicit name filter, not verified locally.
The revised suites and typechecks await new exact-source Actions results.

Required verification, including full typecheck/test/build and exact-head check
links, belongs on GitHub Actions. Local diagnostic execution is limited to an
authorized focused failing-test reproduction. This candidate is not ready for
implementation review, upstream publication or installation.

## Fork-only migration generation

`.github/workflows/fork-code-delivery-source.yml` is supporting verification
infrastructure for the public source-transport fork only. It runs for the
same-fork `verify/native-pr-completion-guard` draft PR targeting `master` in
`TogetherWeOwn/paperclip`. It also accepts pushes to that exact fork ref, but
requires a single open draft PR with the same repository, base and exact push
SHA before execution. This permits direct-source generation when a conflicting
fork base prevents GitHub from scheduling `pull_request` workflows, without
merging the fork base into the stock-based candidate. The conflict and missing
ordinary PR checks remain gates; a push run does not satisfy them. It does not
run for upstream or other PR heads. This workflow is not part of the proposed
upstream subsystem.

The job checks out the event's complete source SHA, not the synthetic PR merge.
It compares the checkout's SHA and tree with GitHub's canonical commit response
before executing source. Its artifact records source SHA/tree, workflow/control
SHA, PR head/base/merge, event SHA, stock base, run URL and tool versions. These
identities are distinct even when some values happen to match.

Generation runs on a disposable GitHub-hosted runner with read-only repository
permissions, no persisted checkout credentials, no production environment, no
shared caches and bounded install/generation timeouts. It uses the source's
Node version file and package-manager pin, frozen dependencies and
`--ignore-scripts`. Root, workspace and dependency install hooks are disabled;
there are no native-build exceptions. A pnpm hook file fails preflight. The
pinned pnpm 9.15.4 does not support the native three-day release-age filter;
frozen installation does not retrospectively prove dependency age or safety.
No package-manager upgrade or lockfile change is included.

The job calls the supported `pnpm db:generate` command without a database URL.
It uploads complete generation diff data, new/changed SQL and snapshots,
journal/pruning changes, commands, exit codes, hook inventories, full failure
logs and SHA-256 checksums. Changes outside migration source fail the result.
Generation never applies migrations, commits, pushes, publishes or deploys.
After generation, the subsystem-check step requires an unchanged migration tree
and the integrated terminal guard. It explicitly runs the reviewed first-party
`node scripts/link-plugin-dev-sdk.mjs` command to link the in-repository SDK into
workspace-excluded provider packages before building the existing SDK test
prerequisites. The link command creates development symlinks only; it does not
install packages or enable lifecycle scripts. It is the sole root postinstall
command, invoked by name rather than enabling root or dependency hooks. Its
source is bound to the verified source SHA, and its command, result and full log
are retained. The job then runs the thirteen selected delivery/provider/interaction
suites. It retains the complete test JSON and fails if any test is skipped,
pending or todo, if an expected suite is missing, or if any assertion fails.
Database/server focused typechecks and module boundaries still run after a test
failure, and the final status preserves every failed check. Commands,
exit codes and complete logs survive failure. PostgreSQL tests use disposable
runner-local databases, never an installed runtime database. These targeted
checks are not the full repository or native API/all-writer acceptance suite.

The author must inspect generation artifacts as data and integrate only reviewed
migration changes, including the separate custom guard fragment through the
migration path. This produces a new source SHA. Generation success is not
qualification: the new SHA still needs complete exact-source typecheck, tests,
build, migration synchronization and native API/PostgreSQL/all-writer/race/
denial acceptance, plus all ordinary PR and independent review gates. No such
final exact-source verification has been established by adding this workflow.
