# Code-delivery persistence

This subsystem is under implementation. The current persistence and authenticated
GitHub observation layers do **not** enforce terminal task readiness. Do not use
this intermediate implementation as a completion gate or install it as a finished
feature. No public registration, adjudication, disposition, transfer, or receipt
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
| `issues.code_delivery_revision` | Server-owned monotonic invalidation version. Every task update and supported delivery-association mutation advances it, including A-to-B-to-A policy changes. It grants no authority. |

The database enforces company/task/project/workspace foreign keys and canonical
PR uniqueness. Registration starts without an accepted head. An observation is
not evidence that an independent reviewer accepted that head. The authorized
registration and discovery reconciliation services are still required before a
public mutation surface can use these tables. Independent acceptance is available
only as an internal service at this checkpoint.

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
products. Independent reconciliation remains to be implemented; deleting a link
is not a substitute for it. The internal transfer service retains the original
obligation and adds history rather than moving or deleting display data.

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
Common terminal enforcement and its receipts are still required. Registration,
discovery reconciliation, superseded-delivery proof, public API authorization,
company portability/deletion and complete terminal-surface acceptance remain
unfinished. Do not interpret these internal services as a finished prevention gate.

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

Run the focused persistence check from the repository root:

```sh
pnpm exec vitest run --project @paperclipai/db src/code-delivery-migration.test.ts
pnpm --filter @paperclipai/db typecheck
```

No migration has been applied to a running instance by this work. For an
operational rollback, retain a pre-upgrade database backup and its matching
application version. Dropping these tables would discard obligations and
ownership history and is not a safe operational downgrade. The tests reconstruct
the old schema only inside their disposable, isolated PostgreSQL database.
