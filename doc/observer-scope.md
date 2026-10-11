# Bounded read-only observation scope (held cap-zero flow)

This document describes the native observer credential shape: one immutable,
deny-by-default read-only scope for a single held zero-removal observation.
Independent security acceptance is a separate downstream gate; merge is NOT
deployment or security acceptance.

## What it is

- One company, one purpose (`held-cap-zero-observation`), non-sliding
  validity of at most 35 minutes.
- ONLY `GET /api/companies/{companyId}/issues`,
  `GET /api/companies/{companyId}/heartbeat-runs` and
  `GET /api/companies/{companyId}/live-runs`, with bounded query allowlists
  (status/pagination/limits) that preserve complete pagination.
- Every other verb (including HEAD/OPTIONS), path, company, key-management,
  secret, log, runtime, workspace and single-issue read is denied before
  generic actor permissions, on direct access too. The live-events WebSocket
  upgrade denies observer credentials as well. Headers and later role
  elevation cannot widen the scope.

## How it is enforced

- Shape: `observerAgentKeyScopeSchema`
  (`packages/shared/src/validators/agent.ts`). Unknown/malformed scopes throw
  in `normalizeAgentApiKeyScope` instead of falling back to `standard`; auth
  paths deny, key listings keep a display-only fallback.
- HTTP ceiling: `server/src/middleware/observer-ceiling.ts`, mounted after
  actor resolution and before every route. Observer actors that miss the
  ceiling end with 403 and never reach permissions or mutation handlers.
- The authorization service denies observer credentials every generic action;
  their only authority is the ceiling plus the three pure projections.
- Route handlers (`server/src/routes/observer.ts`, wired first in
  `issues.ts`/`agents.ts`) re-validate scope, company and the bounded query,
  call only pure read services, and return allowlisted projections — never the
  recovery-revalidating issue GET handler.
- Minting an observer key via `POST /api/agents/:id/keys` is denied
  (`OBSERVER_ISSUANCE_DENIED`). Run-JWT minting only ever issues
  `standard`/`skill_test`. Observer scopes exist only as synthetic test
  fixtures until a later authorized issuance act.

## Pure projections (what the reader gets)

- Issues: identity/status (`id`, `identifier`, `title`, `status`, `priority`,
  `projectId`, `parentId`, assignees, timestamps) plus the live safety joins:
  `activeRecoveryAction` (no evidence/fingerprint/policies) and
  `successfulRunHandoff` (no free-text summary). No context snapshots.
- Runs (heartbeat and live): status/time/retry metadata plus the sanitized
  `issueId` reference (resolved from the summarized snapshot on heartbeat
  rows, from the flat column on live rows) and, for live runs, the sanitized
  `execution` diagnostic join (phase/label/retry/attempt signals only — no
  free-text `cause`/`nextAction`, which can echo unredacted output). No
  result summaries, usage, log/session fields, outputs or environment values.
  The live SQL never selects those columns.

## Permitted bookkeeping (explicit)

Per-request `agent_api_keys.lastUsedAt` touch and auth-failure audit rows.
Permitted observer reads perform zero recovery, scheduling or business-state
writes. Revocation (`revokedAt`) and expiry are validated on every request
with no authority-preserving cache.

## Compatibility

The allowlists accept the documented consumer call shapes
(`issues?status&limit&offset` across all seven statuses,
`heartbeat-runs?limit=200`, default `live-runs`) and return the documented
field families (issue identity/status, run status/time/retry, sanitized
path/issue/workspace references, live/queued/retrying joins).

## Verify

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/observer-scope.test.ts src/__tests__/agent-cross-tenant-authz-routes.test.ts src/__tests__/live-events-ws.test.ts
```

Isolated observer controls (positive reads on all three paths,
consumer-field/pagination compatibility; negative write/unused-read/
cross-company/invalid-scope/expiry/role-elevation/websocket-upgrade;
deny-before-mutation spies; zero-write assertions) plus the neighboring auth
suites.
