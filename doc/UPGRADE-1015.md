# Upgrade runbook: v2026.1005.0 (+tog) → v2026.1015.0

Target: `sync/v2026.1015.0` @ `1b4c8038` = upstream tag
`beta/v2026.1012.1-beta.0`. When upstream tags `v2026.1015.0`, verify it is
the beta plus release-notes only before executing (parent
[TOG-35829](/TOG/issues/TOG-35829) step 1).

Every option name below was verified against the beta tag source with
`git show beta/v2026.1012.1-beta.0:<path>`; the citation index in §8 gives
file:line for each. Host research prose paraphrases were corrected where the
source disagrees.

Instance config (experimental flags, review-bot configs, budget policies,
grants) lives in the production database, not in this repo, so the
"config patch" on this branch is the SQL/API cutover pack in
`ops/upgrade-1015/` plus the value-mapping rules in this runbook. The host
fills in scope IDs and logins from the pre-cutover reads, then executes.
No PR: the host executes the cutover directly.

## 0. Pre-cutover (host, on the old version)

1. Take a full database backup. Rollback requires a restore (§7).
2. Snapshot current state (read-only queries in `ops/upgrade-1015/`):
   - `01`: budget policies per scope + unpriced cost-event counts.
   - `02`: each `chat_github_configurations` row's `people[]`
     (`login`, `automaticReviews`) and `defaults` author filters.
   - `03`: active human memberships with role `operator` + their stored
     grant rows; stored tool grants with `scope.allow`/selectors.
3. Record the CLIProxy fleet's budget scopes (company/agent/project IDs).
   Any scope whose policy has `amount > 0`, `is_active`, and
   `hard_stop_enabled` will block on unpriced events after cutover unless
   handled in §1.

## 1. Budgets: `unpricedUsagePolicy` defaults to `block` (1015.0-new)

Upstream change: #14997 (`799e4d556f`, "make accounting durable and
synchronize cost reporting"). Verified absent from `v2026.1012.0`.

- Schema: `packages/db/src/schema/budget_policies.ts:18`
  (`unpriced_usage_policy`, `notNull`, default `"block"`).
- Types: `packages/shared/src/types/budget.ts:22,49,99`
  (`"block" | "allow"`).
- API input: `packages/shared/src/validators/budget.ts:19`
  (`upsertBudgetPolicySchema` accepts `unpricedUsagePolicy?`).
- Migration: `packages/db/src/migrations/0312_easy_eternity.sql:109`
  (`ADD COLUMN ... DEFAULT 'block' NOT NULL`) — **existing policies
  backfill to `block`**.
- Enforcement (`server/src/services/budgets.ts`):
  - `:226` `observedBlocks` — blocks only when the policy is active,
    `hardStopEnabled`, `amount > 0`, and the window has unpriced events
    (or over-spend / pending runs).
  - `:575` start-work denial: "cannot start work because recorded usage
    has no reliable price".
  - `:874` resume guard: `raise_budget_and_resume` refuses while unpriced
    events exist unless the policy is `allow`.
- "Unpriced" = `cost_events.cost_status = 'unpriced'` with
  `billing_type <> 'subscription_included'` (`budgets.ts:203`;
  `COST_STATUSES` in `packages/shared/src/constants.ts:836`).

Cutover action — one per CLIProxy fleet scope, before or immediately after
boot (a blocked fleet needs the resume path, so prefer before):

- Recommended: `POST /api/companies/:companyId/budgets/policies`
  (`server/src/routes/costs.ts:354-362`, Board-authenticated) with
  `{ "scopeType": "<company|agent|project>", "scopeId": "<uuid>",
  "unpricedUsagePolicy": "allow" }`. Existing rows keep their values;
  unspecified fields are preserved (`budgets.ts:661`).
- Alternatives: price the usage via charge correction (sets `costStatus`
  to `estimated`/`reported`, `billing-reconciliation.ts:147`), or
  attribute subscription billing so events are excluded from the unpriced
  count. Both are heavier than the one-field policy change; do them
  post-cutover if desired.
- `ops/upgrade-1015/01-budgets-unpriced-allow.sql` has the verification
  reads plus a parameterized SQL fallback. Prefer the API (validated and
  activity-logged).

## 2. Review bots: `enableGitHubReviewBots` + author filters (1015.0-new)

Verified absent from `v2026.1012.0`.

- Flag default off: `packages/shared/src/validators/instance.ts:57`,
  `packages/shared/src/types/instance.ts:75`,
  `packages/shared/src/feature-catalog.ts:123` (managed tier; "Existing
  bots keep running when hidden; GitHub tool connections are unaffected").
- Gating: `server/src/routes/chat-channels.ts:106-117` (identity-link
  access + per-provider check) and
  `server/src/services/connection-intents.ts:414` (GitHub channel
  discovery). Independent of chat connectors
  (`doc/connections/GITHUB.md:14`).
- `people[].automaticReviews` ignored:
  `packages/shared/src/types/chat-github.ts:42` (`@deprecated`),
  `packages/shared/src/validators/chat-github.ts:59` (accepted for
  compatibility), `server/src/services/chat-github-review-policy.ts:143`
  ("no longer gate work"), `doc/connections/GITHUB-REVIEW-BOT.md:135`,
  `doc/connections/GITHUB.md:39`.
- Author-filter shape that replaces it
  (`packages/shared/src/types/chat-github.ts:13,20-21`;
  defaults `:180,186-187`):
  `invocation` (`mentions_only` | `linked_authors` | `allowed_authors`,
  default `linked_authors`), `includeAuthors[]` (empty = all authorized),
  `excludeAuthors[]`, glob syntax `*`/`**`/`?` via
  `matchesGitHubReviewPattern`
  (`server/src/services/chat-github-review-policy.ts:25-40`).
  Guests additionally need `invocation: "allowed_authors"` for automatic
  runs. Authorized mentions bypass automatic filters (manual path).

Cutover actions:

1. Expose setup/management: `PATCH /api/instance/settings/experimental`
   (`server/src/routes/instance-settings.ts:263-298`) with
   `{ "enableGitHubReviewBots": true }`. Execution of existing bots does
   not depend on this flag.
2. Convert each GitHub bot configuration (old fork behavior:
   `person.automaticReviews === false` blocks that person's automatic
   reviews):
   - every `people[]` login with `automaticReviews: false` →
     `defaults.excludeAuthors`, plus any per-repository override that sets
     its own author-filter fields (overrides replace those fields
     wholesale, `review-policy.ts:14-22`);
   - if `defaults.includeAuthors` is non-empty, add the
     `automaticReviews: true` logins to it; if empty, leave it (all
     authorized authors stay eligible);
   - leave `people[]` rows in place (accepted, ignored);
   - keep `memberAccess`, `invocation`, and event selection as-is unless
     the pre-cutover snapshot shows a reason to change.
   Apply via Board UI (Settings → author filters) or the config update API
   (`updateGitHubChatConfigurationSchema` with `expectedRevision`,
   `packages/shared/src/validators/chat-github.ts`).
   `ops/upgrade-1015/02-review-bots-author-filters.sql` has the preview
   read and a parameterized template. Fork shadow-review behavior is
   preserved by the Lane B rebase, not by this conversion.

## 3. Operator grants (14) and `PAPERCLIP_AGENT_PRIVATE_KEY` (1015.0-new)

Verified absent from `v2026.1012.0` (operator had 1 grant there).

- Operator role list, 14 keys, all `scope: null`
  (`server/src/services/company-member-roles.ts:57-72`):
  `agents:create`, `agents:configure`, `skills:create`,
  `environments:manage`, `users:invite`, `tasks:assign`,
  `pipelines:write`, `tools:manage_connections`, `tools:manage_profiles`,
  `tools:manage_runtime`, `tools:use`, `tools:admin`,
  `tools:view_audit`, `audit:view_agent_actions`.
  Owner/admin lists are unchanged since 1005.0.
- Delivery: every server boot runs
  `backfillPrincipalAccessCompatibility` (`server/src/index.ts:709`),
  which inserts each active human membership's **missing** role-default
  rows (`server/src/services/principal-access-compatibility.ts:76,57,17`;
  `onConflictDoNothing`). The first 1015.0 boot therefore grants every
  existing human Operator the 13 new keys (rows carry
  `granted_by_user_id NULL`). New invites get the same 14 at join time.
- Durable narrowing: revoking a role-default key from a human does **not**
  stick — the next boot re-inserts it as missing. To narrow a person,
  change their membership role (e.g. `viewer` maps to `[]`). No CISO
  pre-action is required unless the 14-key set is unacceptable, in which
  case re-role before boot.
- New-agent defaults are separate and do not backfill:
  `NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS`
  (`server/src/lib/agent-permissions.ts:4-18`, 14 keys) applies to new
  hires/activations only (`doc/agent-permission-defaults.md`). Existing
  agents are unaffected.
- Audit: `ops/upgrade-1015/03-operator-grants-audit.sql` snapshots
  pre-cutover operator grants and verifies post-boot inserts.
- Agent identity (`doc/AGENT-IDENTITY.md`, #15352): each agent gets a
  persistent Ed25519 keypair. Managed runs receive server-owned
  `PAPERCLIP_AGENT_KEY_ID` / `PAPERCLIP_AGENT_PUBLIC_KEY` /
  `PAPERCLIP_AGENT_PRIVATE_KEY` env (`packages/adapter-utils/src/server-utils.ts:3205-3212`);
  configured values cannot override them. Private material is encrypted at
  rest with the stack's `PAPERCLIP_SECRETS_MASTER_KEY` or the local
  0600 master-key file (`AGENT-IDENTITY.md:20-21`). Existing agents are
  provisioned on their next managed run; there is no backfill command
  (`:6`). Managed remote providers, including Cursor Cloud, receive the
  same private key — moving an agent trusts that runtime host with its
  identity (`:51`). There is no rotation UI. Cutover actions: confirm the
  secrets master key is configured; never print key material (audit by row
  counts and `key_id` only, never `private_key_material`).

## 4. 1012.0 carryover (already in `v2026.1012.0`, new to us)

- SQLite restore locks (`doc/workspace-restore-locks.md`): old and new
  lock protocols must never run concurrently against the same instance
  root (`:39`). Upgrade requires draining and stopping **all** old server
  and worker writers, on every host/container (`:42`), and the same drain
  applies to rollback (`:51`). Never delete/replace a `.lock.sqlite`
  file while the instance can write; move leftover legacy `.lock/`
  directories to scratch only after all writers are stopped.
- Stored tool grants enforced as written (`483dbc8890`, #14915, confirmed
  in `v2026.1012.0`): an explicit `scope.allow` must contain a matching
  `tool:`/`connection:`/`application:` entry; unknown selectors,
  malformed values, and empty restrictions deny access; discovery and
  execution enforce the same limits
  (`doc/MCP-ACCESS-GOVERNANCE.md:256-275`). Fail-closed: audit stored
  grants with `scope.allow`/selectors pre-cutover (queries in `03`);
  over-broad or malformed scopes will start denying.
- CISO input ref `b6467405` from the parent card could **not** be resolved
  to any commit in this repo or its remotes (fetch attempted 2026-10-21).
  Host: confirm what this identifier points to before the CISO gate, or
  treat the stored-grant audit above as the gate input.

## 5. Explicitly out of scope: upstream #15997

`8193abb936` ("feat(claude): default qualified macOS and Linux targets to
Paperclip Runner (#15997)") is **not** in the beta tag (verified:
`merge-base --is-ancestor` negative), **is** in `upstream/master`, and is
not in our `origin/master`. It collides with our #147 (`5c65d9644c`,
"refuse Paperclip Runner launches over SSH transports", touching
`native-session-executor.ts` and `environment-support.ts`). No action on
this branch; the collision belongs to the master-sync follow-up, not the
1015.0 cutover.

## 6. Cutover sequence (drain-restart with full stop)

1. Pre: DB backup (§0); config-pack values staged (scope IDs, logins,
   experimental flag); CISO sign-off on §3 deltas (§4 gate input ready).
2. Drain: quiesce schedulers and runners; confirm no running heartbeats;
   stop **all** server/worker writers on every host/container (§4 locks).
3. Migrate + boot the 1015.0 image. Confirm migrations through 0312+
   applied; watch the startup log for "Backfilled principal access
   compatibility records" (`server/src/index.ts:709-712`).
4. Apply §1 (budget policies), §2 (flag + author filters); run the `03`
   post-boot grant verification.
5. Smoke: `/api/health`; one queued run per adapter family (claude_local,
   Codex, Operator-SSH); review bot in shadow; budget overview shows
   expected states; no unexpected `hard_stop` incidents.
6. Staging soak per parent plan before production cutover.

## 7. Rollback (old compose + DB restore)

1. Full stop again — the drain requirement applies to rollback
   (`doc/workspace-restore-locks.md:51`).
2. Restore the pre-cutover database backup. Migrations are **not**
   image-reversible (e.g. 0312 adds `NOT NULL` columns; a source ahead of
   the checkout is rejected as a downgrade).
3. Boot the previous compose/image (`deploy/tog6` line). Existing
   `.lock.sqlite` files can remain (old versions ignore them); handle
   legacy `.lock/` leftovers per §4 only after all writers are stopped.
4. Verify `/api/health`, one queued run, and pre-cutover behavior of
   budgets/review bots/grants.

## 8. Citation index (all paths on `beta/v2026.1012.1-beta.0`)

| Item | Path:line |
| --- | --- |
| `unpriced_usage_policy` column + default | `packages/db/src/schema/budget_policies.ts:18` |
| `unpricedUsagePolicy` type (policy/summary/upsert) | `packages/shared/src/types/budget.ts:22,49,99` |
| Upsert accepts `block`\|`allow` | `packages/shared/src/validators/budget.ts:19` |
| Backfill-to-`block` migration | `packages/db/src/migrations/0312_easy_eternity.sql:109` |
| Block evaluation / denial / resume guard | `server/src/services/budgets.ts:226,575,874` |
| Upsert preserves unspecified fields | `server/src/services/budgets.ts:661` |
| Unpriced-event definition | `server/src/services/budgets.ts:203` |
| `COST_STATUSES` | `packages/shared/src/constants.ts:836` |
| Budget upsert route | `server/src/routes/costs.ts:354-362` |
| Charge-correction repricing | `server/src/services/billing-reconciliation.ts:147` |
| `enableGitHubReviewBots` default/schema/catalog | `packages/shared/src/validators/instance.ts:57`, `packages/shared/src/types/instance.ts:75`, `packages/shared/src/feature-catalog.ts:123` |
| Flag gating (routes/discovery) | `server/src/routes/chat-channels.ts:106-117`, `server/src/services/connection-intents.ts:414` |
| Experimental-settings PATCH route | `server/src/routes/instance-settings.ts:263-298` |
| `automaticReviews` deprecated/ignored | `packages/shared/src/types/chat-github.ts:42`, `packages/shared/src/validators/chat-github.ts:59`, `server/src/services/chat-github-review-policy.ts:143`, `doc/connections/GITHUB-REVIEW-BOT.md:135`, `doc/connections/GITHUB.md:39` |
| Author-filter shape + defaults | `packages/shared/src/types/chat-github.ts:13,20-21,180,186-187` |
| Author glob syntax | `server/src/services/chat-github-review-policy.ts:25-40` |
| Repo-override merge (wholesale) | `server/src/services/chat-github-review-policy.ts:14-22` |
| Old per-person gate (fork `deploy/tog6`) | `server/src/services/chat-github-review-policy.ts:155` |
| Operator 14-grant list | `server/src/services/company-member-roles.ts:57-72` |
| Startup grant backfill | `server/src/index.ts:709`, `server/src/services/principal-access-compatibility.ts:76,57,17` |
| New-agent 14-grant defaults (no backfill) | `server/src/lib/agent-permissions.ts:4-18`, `doc/agent-permission-defaults.md` |
| Identity env injection | `packages/adapter-utils/src/server-utils.ts:3205-3212` |
| Master key / no backfill / remote trust | `doc/AGENT-IDENTITY.md:20-21,6,51` |
| Restore-lock full stop (upgrade + rollback) | `doc/workspace-restore-locks.md:39,42,51` |
| Stored grants enforced as written | commit `483dbc8890` (#14915, in `v2026.1012.0`), `doc/MCP-ACCESS-GOVERNANCE.md:256-275` |
| #15997 not in beta; in upstream/master | commit `8193abb936` (merge-base negative on beta) |
| Our colliding #147 | commit `5c65d9644c` |
