# Bounded read-only observation scope (held cap-zero flow)

Implementation card: [TOG-21648](/TOG/issues/TOG-21648). Mandatory security
specification: CISO verdict `ciso-read-only-boundary` revision
`a983eaa4-7311-4d05-b812-f532352858ad`. Admission: COO
`admission-decision` revision `b7c8b124-7db1-4fac-b960-e9fc520215f4`.
Independent acceptance is a separate downstream gate ([TOG-21649](/TOG/issues/TOG-21649));
merge is NOT deployment or security acceptance.

## What it is

One native, immutable, deny-by-default observer credential shape for the held
zero-removal observation in [TOG-20698](/TOG/issues/TOG-20698):

- one company `ef993a7e-5ea7-445f-ba88-27a6a2690c3a`, one purpose
  `held-cap-zero-observation`, non-sliding validity of at most 35 minutes;
- ONLY `GET /api/companies/{companyId}/issues`,
  `GET /api/companies/{companyId}/heartbeat-runs`,
  `GET /api/companies/{companyId}/live-runs`, with bounded query allowlists
  (status/pagination/limits) that preserve complete pagination;
- every other verb (including HEAD/OPTIONS), path, company, key-management,
  secret, log, runtime, workspace and single-issue read is denied before
  generic actor permissions, on direct access too. Headers and later role
  elevation cannot widen it,

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
  `issueId` reference and, for live runs, the sanitized `execution`
  diagnostic join. No result summaries, usage, log/session fields, outputs or
  environment values. The live SQL never selects those columns.

## Permitted bookkeeping (explicit)

Per-request `agent_api_keys.lastUsedAt` touch and auth-failure audit rows.
Permitted observer reads perform zero recovery, scheduling or business-state
writes. Revocation (`revokedAt`) and expiry are validated on every request
with no authority-preserving cache.

## Compatibility

Against the pinned cap-zero consumer (`3e8b35ebaea8dafbafcd7459cf3c9f0be43cf1d9`;
CISO-verified 2/2 blob match — not re-read here): the allowlists accept the
cited call shapes (`issues?status&limit&offset` across all seven statuses,
`heartbeat-runs?limit=200`, default `live-runs`) and return the cited field
families (issue identity/status, run status/time/retry, sanitized
path/issue/workspace references, live/queued/retrying joins). Rejected source
packet `a3c651be-8a79-4dc5-ac9e-9963d8276cb5` was not replayed.

## Verify

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/observer-scope.test.ts src/__tests__/agent-cross-tenant-authz-routes.test.ts
```

35 isolated observer controls (positive reads on all three paths,
consumer-field/pagination compatibility; negative write/unused-read/
cross-company/invalid-scope/expiry/role-elevation; deny-before-mutation
spies; zero-write assertions) plus the neighboring auth suites.
