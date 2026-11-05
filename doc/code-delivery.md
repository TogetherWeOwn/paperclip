# Code-delivery persistence

This subsystem is under implementation. Common-service rejection and an
executable fail-closed SQL backstop are present, but usable terminal writer and
durable-effect integration remain incomplete. Do not install this intermediate
implementation as a finished feature. No public registration, adjudication, disposition, transfer, or receipt
API is implemented yet.

## Ownership of evidence

The code-delivery subsystem owns durable delivery intent, discovered code links,
canonical PR obligations, and ownership history. Task execution policy continues
to own review stages, participants, decisions, assignment, and rounds. Project Git
authorization continues to own credentials and consent. Work products remain
presentation and discovery data, never proof of delivery.

| Record | Meaning |
| --- | --- |
| `issue_code_delivery_intents` | Explicit `code` or `non_code` intent, or unresolved `ambiguous` classification. Explicit classifications are immutable. |
| `code_delivery_discoveries` | Append-only snapshots of code-bearing work products. A discovery is not a validated PR identity, a disposition, or a readiness receipt. |
| `code_delivery_obligations` | A canonical GitHub repository-ID/PR-number identity with one same-company owner, retained source task/project/workspace, proposed head, separate accepted head, revision, and provenance. |
| `code_delivery_ownership_events` | Append-only ownership provenance. Initial registration and independently adjudicated transfers retain every owner. |
| `code_delivery_decisions` | Immutable independent classification, head acceptance, no-PR, closed-unmerged, withdrawal, and transfer decisions. These are not terminal readiness receipts. |
| `code_delivery_authorities` | Explicit company-scoped technical agent for no-stage decisions, configured by an authorized human administrator. No agent name or job title grants this authority. |
| `code_delivery_readiness_receipts` | Server-prepared terminal evidence bound to one company, task revision, effective terminal status, snapshot hash, transaction and expiry. Defined in executable migration `0434`; not installed in a running instance. |
| `code_delivery_receipt_consumptions` | Immutable one-to-one consumption of a receipt by the exact next task revision and terminal status in the same transaction. Only the terminal-update trigger creates consumption. Not installed yet. |
| `issues.code_delivery_revision` | Server-owned monotonic invalidation version. Every task update and supported delivery-association mutation advances it, including A-to-B-to-A policy changes. It grants no authority. |

The database enforces company/task/project/workspace foreign keys and canonical
PR uniqueness. Registration starts without an accepted head. An observation is
not evidence that an independent reviewer accepted that head. Registration,
reconciliation and independent acceptance are internal services only at this
checkpoint; none is a public mutation endpoint or terminal completion gate.

## Canonical registration and discovery reconciliation

`code-delivery-registration.ts` validates the task's explicit repository workspace
and project, then uses the authenticated GitHub reader before taking task locks.
Caller-supplied repository ID, PR number, base and proposed head must all match
that server observation. Inside the transaction it rechecks the acting run,
authorization, task revision and source binding. Registration records observation
provenance, initial ownership and audit together. It never accepts the head or
records a native review decision. The registrant cannot independently adjudicate
that delivery later, even after an assignment change.

Canonical repository-ID/PR-number identity is company-scoped. Identical retries
return the retained obligation without duplicate audit; a different owner,
source workspace, base or proposed head cannot reuse registration to overwrite
it. A new registration on a terminal or explicit non-code task is refused.
An ambiguous task can register code evidence, but remains unclassified until an
independent classification decision. Source selection never defaults to the
project's primary repository.

`code-delivery-discovery.ts` matches retained GitHub PR links to validated
obligations; URL parsing alone does not validate provider identity or delivery.
Branch and commit snapshots remain unresolved until an independent head-acceptance
decision explicitly binds their discovery IDs and retained source revisions.
An independent no-PR decision must name every retained discovery and cannot waive
a PR association. New snapshots are not covered by an earlier decision. No
work-product deletion, conversion, display label or project move removes retained
evidence. The read service returns unresolved associations explicitly; it does
not repair them from a label or a caller-provided receipt.

## Discovery retention

Work products of type `pull_request`, `branch`, or `commit`, and GitHub PR links
under other types, produce durable discovery snapshots. Conversion, deletion,
URL changes, and display moves cannot remove earlier snapshots. Moving a work
product does not transfer its obligation. Moving a task between projects does
not replace an obligation's original authorization source.

New code associations on terminal tasks are refused; display-only updates to
already-discovered legacy associations remain possible. Explicit non-code tasks
cannot acquire new code associations. An existing ambiguous task with code
associations cannot become non-code just because someone deletes its work
products. The internal reconciliation service retains independent decisions;
deleting a link is not a substitute for one. The internal transfer service retains
the original obligation and adds history rather than moving or deleting display
data.

Ordinary task deletion remains possible without retained code associations.
Tasks referenced by discoveries or obligations cannot be physically deleted.
Company hard-deletion/export/import integration must account for the new durable
records before the complete candidate is ready.

## Independent decisions and transfers

`code-delivery-decisions.ts` owns internal decision transactions. The authority
helper reuses task visibility, mutation and run-write authorization. A pending
final-stage participant may adjudicate; an earlier stage may not. A no-stage task
requires its configured independent technical agent. Task creators, executors,
review requesters and retained output authors cannot self-adjudicate. Transfers
carry those exclusions forward so moving work cannot erase authorship.

Caller payloads contain typed intent, expected revisions, reason and an idempotency
key. Unknown fields, including actor, authority, provider observation and receipt
JSON, are rejected. The server records authority and observation evidence. A
replayed identical request returns one decision; reusing its key with different
intent or a different principal conflicts. These decisions never record a native
review verdict or change review rounds, assignment, monitors or terminal state.

Head acceptance and closed-unmerged/withdrawal decisions require the existing
bounded authenticated reader. Remote reads occur before the transaction. The
transaction locks current tasks, checks the acting run and rechecks issue,
obligation and authority versions. A policy A-to-B-to-A edit invalidates prepared
evidence. Closed dispositions require a live closed-unmerged PR and exact head;
a closed label or a merged PR is not a withdrawal. A withdrawal record does not
authorize a provider-side action or waive an external approval gate.

Transfers lock both owners in ID order. The destination must be same-company,
nonterminal, assigned to an invokable agent and have a current queued/running run
or an eligible bounded monitor. Self, missing, cross-company, stale and cyclic
transfers fail. The immutable decision, owner update, revision increments,
ownership event and audit entries for both tasks commit together. Head acceptance
is cleared so the new owner cannot silently inherit a different adjudicator's
acceptance. Database triggers refuse direct ownership moves and head certification
without the corresponding current decision.

The internal service alone cannot prevent the destination from later closing.
Common terminal enforcement and its receipts are still required. Superseded-delivery
proof, public API authorization, company portability/deletion and complete
terminal-surface acceptance remain unfinished. The registration/reconciliation
increment has not yet been exercised by CI. Do not interpret these internal services as a finished prevention gate.

## Prepared readiness candidate (not activated)

`code-delivery-readiness-policy.ts` plans all owned obligations, retained discovery
reconciliations and outbound transfers. Genuine non-code tasks produce no provider
requests. Code without an owned or transferred PR needs an independent typed
no-PR decision. Each owned PR must have an independently accepted exact live head
and authenticated merged evidence, or an exact independent closed-unmerged or
withdrawal decision plus a fresh live closed observation. Work-product labels do
not participate in the delivery predicate. Unknown intent, partial observations,
head/identity mismatches, oversized attempts and stale evidence fail closed.
Superseded delivery is not implemented in this candidate.

`code-delivery-readiness.ts` separates preparation from transactional validation.
Preparation performs bounded authenticated provider reads without task row locks.
It returns an opaque in-process token, not serializable receipt JSON or caller
claims. The token binds actor context, effective terminal status and a hash of
issue, policy/state, retained associations, decisions, ownership and source
bindings. Nonterminal effective results, including earlier review approvals,
return no token and perform no provider or delivery database work.

The candidate `apply` method synchronously claims a matching preparation token,
then opens a savepoint on the caller's transaction. It re-locks the task and
related owners, checks current run authority, compares the complete snapshot and
rechecks independent adjudication. Outbound transfers recheck the destination's
current wake path under its lock. There is no receipt-only commit method.
The mutation callback must use the supplied savepoint for the terminal task write,
native decision and every transactional effect. It must not perform remote reads,
stop a process, publish notifications, or perform other irreversible effects.
Those operations belong after a confirmed outer commit or in a transactionally
accepted durable delivery path.

After the callback, `apply` requires the database-created consumption record and
exact terminal task revision/status before recording the audit. A callback that
does nothing, writes a different status/revision, or fails cannot return a receipt.
The savepoint rolls back local writes even if the enclosing caller catches the
error. The token cannot be retried or replayed, including after rollback; a new
attempt must prepare again. Receipt data retains exact head, repository identity,
merge timestamp, merge SHA, observation time, obligation revision and selected
decision IDs. Preparation and every observation expire within 30 seconds.
Validation never refreshes evidence or calls GitHub while holding locks.

Migration `0434_brainy_franklin_richards.sql` contains the Actions-generated
receipt/consumption tables and custom immutable history, transaction/revision/
deadline validation, unprepared terminal-write and terminal-insert rejection,
automatic exact-revision consumption, and deferred settlement checks. The former
uninstalled fragment is now part of this executable journal entry, not a separate
source of truth. Settlement rejects an unused receipt or an outer-transaction
change after consumption. A later transaction may update terminal bookkeeping,
but cannot rewrite a terminal timestamp without a new receipt. Only the trigger
may insert consumption; its row is not caller-supplied evidence.

**This is not an installed or usable end-to-end completion guard.** SQL source
integration does not complete native writer preparation, durable effects,
superseded outcomes or lifecycle integration. Do not install this checkpoint.
Current transfer validation conservatively refuses an already-terminal destination;
verified completed replacement/owner evidence still needs lifecycle integration.

The SQL regression now uses the complete migrated PostgreSQL schema rather than
a minimal trigger fixture. Persistence tests also replay the receipt upgrade over
retained legacy terminal/review rows. Test fixture receipts are explicitly
synthetic, not live-provider evidence. These authored sources need exact-source
Actions execution; neither SQL coverage nor mocked service boundaries establish
native review decisions, full API rollback or terminal-side-effect preservation.
Full database/API/concurrency acceptance is still required.
In particular, route-level pre-terminal run cancellation must be moved behind the
accepted transactional boundary; a denied attempt must not have stopped a run
before its stale-state conflict is detected. Native and other transaction-owning
callers must prepare before taking their enclosing locks.

## Migration and verification

Migration `0432` adds the tables, revision, composite workspace key, and integrity
triggers. All existing tasks are explicitly unclassified. Existing code-bearing
work products are retained as discoveries, including associations on terminal
tasks. Labels such as `merged` are copied as display data, not certified as live
merged state. The migration neither invents canonical obligations from URLs nor
resets task status, timestamps, execution policy, participants, or rounds.

The PostgreSQL migration regression executes both a fresh migration and an
upgrade with existing terminal/review state and work products. It covers tenant
constraints, canonical deduplication, immutable history, revision invalidation,
late registration, display moves, deletion, and a concurrent close/association
attempt. It is not full terminal-writer or live-provider acceptance.

The fork-only Actions route generated the receipt schema, snapshot, journal and
pruning deletion. The integrated tree retains the five newest snapshots and all
historical SQL and journal entries. It now requires zero generation drift before
selected subsystem tests, database/server typechecks and module-boundary checks.
The relevant sources include `packages/db/src/code-delivery-migration.test.ts`,
`packages/db/src/code-delivery-terminal-guards.test.ts`, and the server delivery
policy, preparation, registration, authority and common-mutation tests.
Exact-candidate full required checks remain necessary; authored regression
sources and a successful generator are not acceptance results.

No migration has been applied to a running instance by this work. For an
operational rollback, retain a pre-upgrade database backup and its matching
application version. Dropping these tables would discard obligations and
ownership history and is not a safe operational downgrade. The tests reconstruct
the old schema only inside their disposable, isolated PostgreSQL database.
