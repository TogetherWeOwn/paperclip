# Source-bound workspace allocation (Board-authorized, no-wake)

Allocates a durable but **unrealized** execution-workspace record bound to
one source issue, without waking the issue, checking out code, creating a
branch or worktree, or starting any runtime. It is the supported way to
pre-bind the workspace identity that a later heartbeat run realizes into,
so transport validation (see
[`source-bound-transport-validation.md`](./source-bound-transport-validation.md))
can be reasoned about against a stable record — while still denying that
record until realization actually happens.

Implementation: `server/src/services/source-bound-workspace-allocation.ts`
(operation version `source-bound-workspace-allocation/v1`), routes in
`server/src/routes/execution-workspaces.ts`.

## Supported invocation

```
POST /api/issues/{sourceIssueId}/source-bound-workspace-allocation
Authorization: <Board session/key for a user with runtime:manage>
Content-Type: application/json

{ }
```

- **Authorization.** Board principal + `runtime:manage` on the issue's
  company, resolved server-side (`assertBoard` + `access.decide`).
  Agent keys are denied before anything resolves. A board actor without
  the capability, a missing issue, and a cross-company issue all deny as
  `unauthorized_principal` (403) without revealing which.
- **No caller-supplied fields.** The body may carry an optional
  `requested` object, which is ignored. Every persisted field is derived
  server-side from the issue's stored selection
  (`executionWorkspacePreference` / `executionWorkspaceSettings` +
  `projectWorkspaceId`). Only `isolated_workspace` + `git_worktree`
  allocates: an absent selection denies `selection_missing` (422); any
  other mode/strategy, or a preference/settings disagreement, denies
  `selection_not_isolated` (422).
- **The record.** Status `unrealized`; `sourceIssueId` = the issue;
  `cwd`, `providerRef`, `branchName`, `openedAt`, and `closedAt` are all
  null; `providerType`/`baseRef` come from the stored selection. The
  insert, the `issue.executionWorkspaceId` bind, and the
  `issue.source_bound_workspace_allocated` activity-log audit entry
  (actor, company, source issue, workspace id, selected project
  workspace, strategy/base-ref/branch-template inputs, prior binding,
  disposition, timestamp) commit in **one transaction**. Issue status,
  assignee, blockers, execution policy, and monitor fields are not
  reachable from the operation and never change.
- **Idempotency.** A repeat call returns `200` with
  `disposition: "existing"` and the same record (audited) only when
  company, source issue, and selected project workspace all still
  match. Conflicting, archived-bound, ambiguous, or malformed bindings
  deny `binding_conflict` (409) — never a silent rebind. First creation
  returns `201` with `disposition: "created"`. Pre-existing workspace
  records are never mutated by allocation.
- **Allocation is not validation.** Transport validation denies an
  unrealized record as `workspace_not_realized` (409) before attestation
  is evaluated. The denial is row-level, not status-label-only: besides
  `status !== "unrealized"` the validator requires a non-null `openedAt`
  and non-null references — both `providerRef` and `cwd` for an isolated
  git_worktree workspace, one of the two for other modes — so a generic
  PATCH that flips the status while the row facts stay null still denies.
  Only heartbeat realization — which adopts the allocated record (same
  id, no second insert) and flips it to `active` with
  cwd/providerRef/branch/openedAt set — makes the record eligible. The
  terminal-workspace reaper never sweeps an unrealized record, and
  closing one plans no worktree/branch deletion (none exists).
- **PATCH cannot realize or archive.** `PATCH /api/execution-workspaces/:id`
  refuses (409) any status change on a record whose current status is
  `unrealized`, including archiving: the PATCH archive path does not
  restore the isolated issue binding, which would strand the issue on a
  closed record the rollback can no longer repair. Realization happens
  only through heartbeat adoption (`markAllocatedWorkspaceRealized`);
  archiving an allocation happens only through the rollback route below.
- **Adoption is atomic.** Heartbeat persistence flips the allocated
  record inside the allocation transaction (issue `FOR UPDATE` lock with
  status and binding re-checked, plus a conditional write matching only
  `status = 'unrealized'` and `closed_at IS NULL`). A Board rollback that
  commits first makes the write match zero rows, so adoption denies with
  `workspace_not_unrealized`/`binding_conflict`, and the run falls
  through to a fresh insert instead of resurrecting the archived row.
  When the allocation is still open and bound but the run cannot realize
  into it (`realization_incomplete`, e.g. it resolved to `project_primary`
  with no worktree path), the run fails instead of inserting a second
  source-bound row that would orphan the allocation.

## Rollback

```
POST /api/issues/{sourceIssueId}/source-bound-workspace-allocation/rollback
Authorization: <Board session/key for a user with runtime:manage>
Content-Type: application/json

{ "workspaceId": "<allocated workspace id>" }
```

Archives only the allocated **unrealized** record, in one transaction,
audited as `issue.source_bound_workspace_allocation_rolled_back`. When
the issue is still bound to the record, it restores
`issue.executionWorkspaceId` to the exact prior value recorded in the
record's allocation metadata. When the binding was cleared — or moved
to another open record of the same issue — it archives the unbound
orphan with a conditional write (`status = 'unrealized'` and
`closed_at IS NULL`) and leaves the issue binding untouched, so the
orphan never blocks a later allocation; this is also the cleanup path
the PATCH 409 points at. If the issue was rebound to a record that is
not an open allocation of the same issue (another issue's or a shared
workspace), clear the issue's `executionWorkspaceId` and call rollback
again. Any other binding change keeps the
`binding_conflict` deny (409), as do records that are not this issue's
open allocation. Realized workspaces refuse with
`workspace_not_unrealized` (409) and close through the normal workspace
lifecycle. No workspace, branch, or history is deleted.

## Verification procedure

1. Unit/E2E:
   `pnpm exec vitest run --root server src/__tests__/source-bound-workspace-allocation.contract.test.ts src/__tests__/source-bound-workspace-allocation-db.test.ts src/__tests__/source-transport-validation-unrealized.contract.test.ts`
   These cover board-only authorization, server-derived selection,
   atomicity (zero residue on failure/denial), idempotent replay,
   binding-conflict fail-closed cases, realization adoption of the same
   row, rollback, reaper exemption, and the validator's
   `workspace_not_realized` denial before attestation.
2. Live check: allocate for an issue with an isolated git-worktree
   selection as a board user with `runtime:manage`. Confirm the record
   exists with status `unrealized` and null cwd/openedAt, the issue's
   `executionWorkspaceId` points at it, one
   `issue.source_bound_workspace_allocated` activity entry exists, and
   **no** heartbeat run, runtime service, branch, or worktree was
   created (issue status/assignee/monitor unchanged). Repeat the call
   and confirm `disposition: "existing"` with the same id. Run transport
   validation as the assignee and confirm
   `workspace_not_realized` (409). Roll back and confirm the record is
   `archived` and the prior binding restored.
3. Agent denial: repeat the allocation call with an agent key and
   confirm 403 with no record created.

## Code rollback

Remove the two routes from `server/src/routes/execution-workspaces.ts`
and delete `server/src/services/source-bound-workspace-allocation.ts`.
Allocated records remain readable as ordinary workspace rows (status
`unrealized`); archive them and clear the issue selection via the
rollback semantics above before removing the code if a clean state is
required. The `opened_at` nullability migration is backward compatible
and can stay.
