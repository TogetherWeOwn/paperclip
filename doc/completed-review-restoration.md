# Completed typed-review restoration

## Release gate

This repair remains draft until its exact source head passes CI and independent
code and security review. Source merge, installed runtime parity and executed
reconciliation are separate facts. This document is not permission to install,
restart or execute restoration against a live issue.

The operational invocation and a verified eligible existing issue-scoped actor
must be registered after review. There is no verified historical executor yet.
Do not use new credentials, grants, board impersonation or direct database edits
to supply one.

## Scope

The repair protects completed typed execution-stage reviews from a stale deferred
comment batch. Native confirmation interactions and runtime status-decision
records are not interchangeable with typed stage approvals.

The restoration request contains only `completionActivityId` and
`wakeupRequestId`. Both must be UUIDs. Extra fields fail validation. The server
derives the company, issue and authenticated actor. Clients cannot supply state,
actor identity, an assignment or replacement approvals.

The service restores only the original completed projection and return owner.
It does not delete policy, approve a new stage, select a different reviewer,
release a hold, adopt a checkout lock or update a parent issue.

## Existing actor requirements

- The actor must have ordinary current company and issue write access.
- The server checks access before entry and again against the locked issue in
  the restoration transaction. It preserves the responsible-user ceiling and
  ordinary low-trust decisions.
- Skill-test and task-bridge keys are not restoration capabilities.
- An agent must be the current assignee with a persisted running heartbeat bound
  to the same company, agent and exact issue. An unrelated or stopped run is not
  sufficient. An original same-run replay is allowed only with matching persisted
  restoration evidence and unchanged restored state.
- A conflicting checkout or execution run refuses restoration. The action does
  not adopt or force-release that run.
- A user must have authenticated current company write access. A user's audit
  run header does not exempt any active agent run from conflict detection.
- Current review policy remains enforced. A changed return assignment also
  requires ordinary `tasks:assign` authorization for the original target. The
  normal company-scoped issue updater validates target eligibility.

These are necessary conditions, not a grant of restoration authority. Evidence
or hold checks can still refuse an authorized actor.

## Evidence and refusal conditions

A server-generated version-1 completion receipt binds the original company,
issue, policy fingerprint, delivery fingerprint and decision IDs. The final
approval comment is bound by its persisted ID and original actor/run. Raw work
product and document contents are not stored in the receipt.

Restoration requires all of the following:

- Original approvals remain authentic, ordered and unchanged.
- Current relevant policy and delivery fingerprints match the receipt.
- The final approval comment and its single matching activity remain unchanged.
- The queued comment batch and promoted run batch match and predate completion.
- The only later state mutations are the covered deferred reopening and its
  expected promoted-run stage reset.
- No intentional resume, independent interaction, changes request, rejection,
  newer comment/edit, newer wake, active sibling run, changed governance,
  unresolved blocker, recovery hold, tree hold or active monitor exists.

Missing receipt, missing comment binding, missing wake lineage, ambiguous timing,
conflicting restoration audit or later work fails closed. Legacy completions
without the receipt are ineligible. Do not create a receipt retroactively from a
client snapshot or fabricate fresh approvals to bypass that refusal.

## Transaction and replay

The service locks the company-scoped issue and linked wake/run rows. Evidence and
authorization reads participate in a serializable transaction. Lock and statement
timeouts are bounded. Serialization failure, deadlock, lock unavailability or
statement cancellation returns a conflict. The service does not retry the
transaction automatically.

The ordinary issue update and `issue.completed_review_restored` activity commit
together. The activity names the original completion, decisions, wake, promoted
run and covered comments. Publications and issue post-commit actions occur only
after commit. The action never inserts or changes an execution decision.

Same-evidence replay returns `already_restored` without a second update or audit
only when the completed projection and original assignment remain unchanged.
Different evidence, assignment drift or later activity refuses replay.

## Rollback and separate execution

Use the normal reviewed source-revert process to withdraw the repair. Installation
coordination belongs to the runtime owner. A source revert does not undo a
persisted reconciliation. Do not use raw SQL, delete approvals or rewrite audit
history as rollback. Any issue change after reconciliation must use a separately
authorized normal issue action and retain the original audit.

## Verification status

The focused service fixtures use mocked transactions and the real evidence
planner. The HTTP fixtures use a mocked restoration service and real route
callbacks. They verify scoped authorization, strict request validation, original
target assignment gates and transaction/publication ordering. They do not prove
PostgreSQL rollback or concurrent-writer durability.

Remaining release work includes disposable PostgreSQL rollback/concurrency
proof, receipt coverage for approval-comment and recovery-completion paths, full
required checks, exact-head CI and independent review. Until those gates pass,
keep the repair draft and do not use it for historical reconciliation.
