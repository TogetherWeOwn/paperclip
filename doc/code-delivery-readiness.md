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

## Explicitly incomplete integration

**REST terminal updates currently return `409 code_delivery_not_ready` with
reason `terminal_effects_preparation_required`, including genuinely merged
cases.** A pure effective-status preflight runs before private-project creation,
interrupt handling or run/goal stops. It permits an earlier review approval that
still advances to `in_review`. This is a temporary fail-closed boundary, not a
finished positive completion path or an exemption for agent-owned tasks.

The REST path must next accept a durable, transactionally fenced stop/effect
intent, then dispatch physical effects only after accepted outer commit. Merely
moving the provider read before the existing physical stop is insufficient: a
later revision conflict must leave the run and goal untouched.

Native finalization and other common-service callers without preparation also
fail closed. A completed-run/system preparation authority has not been
implemented; it must revalidate server-derived source/run and current project
consent without borrowing ambient human credentials. Direct SQL writers, terminal
creation/import, lifecycle deletion/export, supersession and all-writer/race
acceptance remain incomplete.

Receipt/consumption schema sources and SQL guard fragments are **not included in
a generated executable migration yet**. Existing migrations therefore do not
activate the database terminal backstop. Do not install this candidate or claim
universal terminal prevention from common-service integration alone. Generate
snapshots through the supported database generator; never hand-edit snapshots.

## Verification limits

New common-boundary unit and PostgreSQL regression sources cover missing/forged
preparation, principal mismatch, timestamp writes, review-state preservation,
post-commit buffer rollback, stale transition preparation and lock conflicts.
These sources have not yet been executed. They do not establish positive native
API completion, full generated-schema acceptance or live provider behavior.

Required verification, including full typecheck/test/build and exact-head check
links, belongs on GitHub Actions. Local diagnostic execution is limited to an
authorized focused failing-test reproduction. Until a permitted verification and
migration-generation route exists, this candidate is not ready for review or
publication.
