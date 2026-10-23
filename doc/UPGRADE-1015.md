# Upgrade configuration pack: v2026.1005.0 (+fork) → v2026.1015.0 candidate

**Corrective pack only. Not an executable migration, security approval, staging
qualification, permission grant or production cutover authorization.** Publication
contract: new pushed branch and immutable commit, **no PR or cutover on this card**.
The prior security verdict is **CHANGES REQUIRED**, not approval; completing its
review or this correction does not clear security or staging.

## Pinned inputs and authority

| Input | Immutable revision |
| --- | --- |
| Integration source (I) | `321499c232ea4e1966367b85763ad0c53969ffac` |
| Original separate config pack (C) | `317d84471eaff5e32ffea594977983d3db07f506` |
| Upstream beta | `1b4c803816e82b0265c8422e1a804327a7ed8c54` |
| Old fork behavior (O) | `67dfe6748c11fe65ecc6d8ef8555552eae776e39` |

Citations below refer to **I**, unless labeled O. These are not citations to a
moving branch or a claim that C contains the integration runtime. Record the
corrected config commit separately in the handoff; pin every replacement input
explicitly and repeat affected qualification/security review. A release tag name
or successful build of another source is insufficient.

Instance settings, review configurations, budgets and grants live in the database.
The three `ops/upgrade-1015/*.sql` files are **read-only inventory templates**, not
apply scripts. No live DB/provider reads or writes, production tests/migrations,
deployments, secret/identity-material access, permission changes, rotation, gate
bypass or new spend are allowed on this corrective card. API examples below are
future executor contracts, **not calls to run now**. Do not execute SQL to validate
this pack against a live database. Keep evidence on the corrective child.

ACT: correct unsafe configuration instructions/inventories. WHY: preserve old
author denials, exact budget policy identity and security boundaries. UNDO:
supersede or revert reviewed history on a new commit; never force-push, execute
SQL, or overwrite the original config/integration branches to undo this work.

## 0. Evidence collection plan — not collected here

The existing authorized executor must collect only permitted metadata, in trusted
custody, before any later execution. This checklist conveys no new access:

- Record snapshot time, environment/company opaque alias, exporter/source SHA,
  corrected config SHA, reviewed manifest digest and exact artifact identity.
- Inventory **all existing** budget policies with stable ID, full key and state;
  distinguish old-schema inventory from post-schema `unpricedUsagePolicy` reads.
- Snapshot each review endpoint's revision, people/flags, defaults, **every** repo
  override and enabled repository set. Validate ID-to-current-login correspondence;
  do not widen filters to compensate for unresolved/renamed identities.
- Count **all active human raw-role categories and normalized roles**, grant/scope
  categories and predicted missing defaults (§3). Never dump raw restricted scopes.
- Collect sanitized stored-tool metadata (§4) and persistent-identity recipient,
  wrapping-key custody, backup and recovery evidence (§3). No env, tokens, key
  material, provider payloads or sensitive raw JSON in reports.
- Record missing evidence and unresolved prior authority references as STOPs.
  Inventory execution, counts, effective access, custody and recovery have **not**
  been established by this pack. Do not mark these checklist items complete merely
  because the templates exist.

## 1. Budgets: existing policy identity, explicit window, preserved stops

`unpriced_usage_policy` defaults to `block`; migration
`packages/db/src/migrations/0312_easy_eternity.sql:109` backfills existing policies.
Never assume the old schema accepts this field. Keep execution quiesced through
schema/configuration changes. An `allow` exception does not price unknown usage,
cap hidden charges, authorize spend or waive priced-spend, unresolved pending
accounting, reservations, manual/security pauses or other scope stops
(`server/src/services/budgets.ts:178-230`).

### Required mapping manifest

Enumerate **existing** policies before selecting a reviewed CLIProxy-only subset.
Each target is one row identified by:

`companyId + scopeType + scopeId + metric + windowKind + stable policyId`.

Record expected `updatedAt`, prior `unpricedUsagePolicy`, `amount`,
`reservationCents`, `warnPercent`, `hardStopEnabled`, `notifyEnabled`, `isActive`,
enforcement/delivery versions, actual usage window and snapshot time/counts.
Also record the reason, CLIProxy-only justification, existing authorization
reference, reviewer, `reviewAt`, `expiresAt`, target/affected counts, before/after
states and same-policy rollback value. Review/expiry are **executor obligations**;
the API has no automatic exception expiry field. Do not put those manifest-only
fields in its request.

Only select existing positive-amount, active, hard-stop policies requiring this
exception; inventory but leave zero/inactive/non-hard-stop/unsupported policies
unchanged. The upsert normalizes a zero-amount policy to inactive; therefore it
cannot be treated as a flags-preserving operation for arbitrary historical rows
(`budgets.ts:738-755`). Do not create a policy, invent a limit, reactivate a scope
or add an unrelated scope to make an exception succeed.

Usage must join each event independently to its company and matching agent/project
policies, not choose one via `COALESCE`. Monthly uses UTC `[monthStart,monthEnd)`;
**lifetime applies no timestamp predicate** (its displayed bounds are 1970..9999).
This includes historical, even anomalous future-dated, lifetime events. Only
`billed_cents` is supported by this usage calculation. Exclude
`billing_type = 'subscription_included'` from the **unpriced event count**, not
indiscriminately from all cost sums. The `01` template implements this inventory;
it is not a full pending-accounting/enforcement summary
(`budgets.ts:58-74,178-217,450-494`).

### Future audited API procedure, not executed here

`GET /api/companies/:companyId/budgets/overview` supplies policy summaries.
`POST /api/companies/:companyId/budgets/policies` is board/company checked and
logs `budget.policy_upserted` (`server/src/routes/costs.ts:346-364`;
`server/src/services/budgets.ts:708-840`). Example for an **already existing**
lifetime project policy:

```json
{
  "scopeType": "project",
  "scopeId": "<existing-project-uuid>",
  "metric": "billed_cents",
  "windowKind": "lifetime",
  "unpricedUsagePolicy": "allow"
}
```

For a monthly row explicitly send `windowKind: "calendar_month_utc"`. The validator
defaults omitted metric/window; **never rely on those defaults**. The five-column
lookup is at `budgets.ts:719-735`; the HTTP validator supplies monthly even though
the service's internal project fallback is lifetime
(`packages/shared/src/validators/budget.ts:10-22`).

1. Establish exclusive authorized configuration ownership; quiesce **every other**
   budget writer and ordinary work admission. This endpoint has **no client CAS or
   expectedRevision**. A preflight read alone is not concurrency protection. If
   exclusive ownership cannot be guaranteed, STOP; do not claim atomic guarding.
2. Immediately before each request, re-read the reviewed policy. Assert exactly
   **one** row with the manifest ID **and** full key and all expected prior state.
   A missing/duplicate row, changed state, wrong company/scope/metric/window or
   unsupported state means **STOP with zero write requests**. Do not send an amount
   to bypass a missing-policy validation error. `policyId` and expected state are
   manifest/readback guards, not supported upsert body fields.
3. Send only the explicit key and `unpricedUsagePolicy`. Read back the same ID/key;
   assert the new value and unchanged amount, reservation, warning/notification,
   active and hard-stop flags. Account for actor/time and enforcement-version
   changes separately. The API also reconciles incidents and legacy monthly
   amounts; preserve maintenance quiescence even if a budget pause becomes clear.
4. Reconcile `target=N`, `affected=N`, `created=0`, `untargeted changes=0`, exact
   before/after records and audit receipts. Ambiguous response or unexpected
   effects: keep execution stopped, inspect state/audit, never blindly replay.
5. Roll back a policy exception via the **same ID and full key** with the captured
   prior value, expected post-state, exclusive ownership and the same audited API.
   Drift means STOP/reconcile, not overwrite. Prove this in staging before release.

The broad SQL UPDATE fallback is **removed**, not repaired by an unverified guard.
No SQL write fallback is supplied. If a later separately authorized fallback is
needed, it requires identical row identity, expected-state checks, transaction,
compensating audit and affected-row assertions; that is a newly reviewed artifact,
not permission to improvise this pack. Do not fabricate prices or subscription
attribution as an alternate workaround.

## 2. Review bots: preserve includes, migrate every old per-person denial

Normal automatic scheduling no longer applies per-person `automaticReviews`
(I `server/src/services/chat-github-review-policy.ts:154-178`). **Includes remain
identical at defaults and every override**: never union opted-in people into them.
Empty includes remain empty; nonempty allowlists must not expand.

The actual old predicate is `person && !person.automaticReviews`
(O `server/src/services/chat-github-review-policy.ts:154-158`), not strict-false
only. Valid old saves required a boolean, but raw historical JSON needs inspection:

| Stored flag on an existing person | Old predicate | Conversion disposition |
| --- | --- | --- |
| `true` | Not denied by this predicate | Retain row/flag; never add to includes |
| `false` | Denied | Add verified login to effective excludes everywhere |
| Missing | Denied | STOP pending a separately reviewed endpoint mapping; then add verified login to excludes and retain missing field |
| `null`, `0`, empty string | Denied, malformed old input | STOP; inventory required denial, do not coerce/save |
| Nonempty string (including `"false"`), nonzero number, object, array | Truthy but malformed | STOP; no guess/cleanup/new opt-in |
| No matching person | No per-person denial | Leave membership/authorization rules unchanged |

Present nonboolean flags, malformed roots/arrays/filters, invalid login/ID,
duplicate IDs or uncertain renamed logins STOP that endpoint's conversion. Resolve
through a separately reviewed correction, not by inventing a flag or dropping a
person. The new validator accepts missing flags, not present nonbooleans
(`packages/shared/src/validators/chat-github.ts:63-79`). Acceptance by that validator
is not a reviewed decision for a missing historical flag. Record the exact endpoint,
revision, verified identity, old denial and proposed effective-excludes mapping for
independent review before conversion; absent that decision, STOP remains in force.
This pack supplies no endpoint decision. Any old-denied malformed row likewise
remains denied operationally by the STOP until its reviewed mapping exists.

For each valid endpoint snapshot:

1. Copy the complete configuration, retaining `people[]` and every flag verbatim.
   Build denial logins from the old predicate using verified current GitHub IDs/
   logins. Do not treat glob patterns as identity aliases or rewrite existing lists.
2. Preserve each existing `defaults.excludeAuthors` entry/order; append missing
   denial logins. Leave `defaults.includeAuthors` **identical**.
3. Visit **every repository override**. If it owns `excludeAuthors`, append all
   denials to that array, **including when it is explicitly `[]`**. If absent, keep
   it absent: it inherits corrected defaults. Preserve override includes verbatim,
   including `[]`; do not materialize inherited includes or replace other fields.
   Overrides replace whole fields (`review-policy.ts:15-23`).
4. Assert old-denied authors stay denied in every effective enabled repo, including
   defaults-only repos, custom include/exclude overrides and explicit-empty arrays.
   Preserve pre-existing exclusions and test opted-in authors outside a nonempty
   include list remain denied. Readback must compare the entire preserved snapshot.
5. Apply only via authorized `GET`/`PUT
   /api/chat-endpoints/:endpointId/github/configuration`, body
   `{ "expectedRevision": <read revision>, "configuration": <complete snapshot> }`.
   The revision is checked under lock; conflict/validation failure means STOP,
   refresh/re-review, not SQL bypass. Read back the expected next revision and
   effective overrides (`routes/chat-channels.ts:228-235`;
   `chat-github-management.ts:152-168`; validator `chat-github.ts:142-147`).
   Rollback uses the complete prior snapshot with the **current** expected revision;
   history is not reset. Recheck denials before any old/new admission resumes.

The `02` template inventories structure, flags and effective override filters; the
unsafe defaults-only SQL write template is **removed**. API validation is not a
substitute for the non-widening assertions.

Keep `memberAccess`, sponsor/responsible-user checks, invocation, event selection
(including issue settings), draft/bot/branch/label/path restrictions, trusted bot
IDs, tools, shadow/shadowRoutes and publication limits unchanged. Authorized manual
mentions are a separate existing path; do not broaden it. **Workflow-trigger sender
admission still requires `automaticReviews === true`**, sponsored guest and active
non-viewer sponsor (`review-policy.ts:333-362`); do not remove people/flags as a
deprecation cleanup. Preserve shadow no-publication behavior.

`enableGitHubReviewBots` governs management visibility, not runtime authority for
existing bots or new tools. This pack does **not** enable it. Any already-authorized
management setting change is separate (`PATCH /api/instance/settings/experimental`,
`routes/instance-settings.ts:263-298`).

## 3. Human roles, effective grants and persistent identity custody

### Inventory and projected bootstrap

These are **human membership roles**, not permissions of an agent named Operator.
All active humans must appear in the `03` inventory, including zero-grant members:
raw `owner/admin/operator/viewer/member`, null and unknown categories. Normalization
is exact/case-sensitive; `member`, null, unknown and empty normalize to `operator`,
not viewer (`server/src/services/company-member-roles.ts:4-19`). Preserve opaque
principal/membership IDs; suppress arbitrary unknown raw strings in shared reports.

The new operator defaults are 14 null-scope keys (`company-member-roles.ts:57-75`):
`agents:create`, `agents:configure`, `skills:create`, `environments:manage`,
`users:invite`, `tasks:assign`, `pipelines:write`, `tools:manage_connections`,
`tools:manage_profiles`, `tools:manage_runtime`, `tools:use`, `tools:admin`,
`tools:view_audit`, `audit:view_agent_actions`. O had only `tasks:assign` in that
role (`company-member-roles.ts:57-58`). Owner/admin/viewer lists are unchanged,
but startup still repairs their missing defaults. The `03` per-key projection uses
the complete owner (12), admin (11), operator (14) and viewer (0) sets from I
`server/src/services/company-member-roles.ts:28-75`. Those are set sizes, not insert
counts: existing keys, including scoped/custom grants, reduce the missing count.
Viewers have a separate zero-default summary, not fabricated permission-key rows;
zero defaults does not imply zero effective access or revoke their stored grants.

Every boot backfills missing normalized role defaults for active human memberships
(`server/src/index.ts:711-716`;
`principal-access-compatibility.ts:17-74,113-135`). **13 added keys is not 13 inserts
per principal**. Existing custom/scoped rows collide on company/principal/type/key,
not scope, and are retained by `onConflictDoNothing`. A principal may already have
some keys or be missing even `tasks:assign`. Capture projected per-key inserts,
unchanged scoped rows, all-role prior-default repairs, and reconcile with staging
new grant IDs and startup totals. Null grantor plus a recent timestamp is only
bootstrap-compatible attribution, not sufficient proof without the before-ID diff.
No principal expansion is approved by these counts or this correction.

### Separately authorized narrowing — never execute on this card

A role-only PATCH **does not revoke existing grants** (`routes/access.ts:4508-4539`;
`services/access.ts:1052-1125`). Deleting a role-default grant while retaining its
role is not durable: restart restores missing defaults. Do not prescribe raw SQL
revocation or claim scoped narrowing is impossible.

The existing audited atomic API is:

`PATCH /api/companies/:companyId/members/:memberId/role-and-grants`

with **explicit** `membershipRole`, `status`, and a complete `grants` replacement
list of `{permissionKey, scope}`. Omitted `grants` means `[]`, not preservation
(`packages/shared/src/validators/access.ts:96-124`). The service transaction locks
owners/target, updates membership and replaces that principal's company grants;
it preserves the last-active-owner guard (`services/access.ts:483-579`). The route
logs `company_member.access_updated` **after** that transaction, not within it
(`routes/access.ts:4543-4586`); require audit reconciliation too.

Separate existing authorization must pass company access, board actor,
`users:manage_permissions`, target-rank, self and instance-admin protections
(`routes/access.ts:1271-1338,3017-3042`). This pack grants none. Choose a target
role whose defaults fit the intended authority; even a custom narrow replacement
can be broadened by restart if its retained role requires missing defaults.
`GET /api/companies/:companyId/members` returns stored grants, **not a complete
effective-permission oracle** (`routes/access.ts:1217-1266,4488-4499`). Verify
allowed and denied contexts, scope interpretation, active membership and privileged
fallbacks independently, then restart and verify again in disposable staging.
Do not use owner/admin/local-implicit access to falsely demonstrate denial.
Unexpected expansion STOPs affected execution for the existing security decision
path; do not introduce an owner approval hop or self-elevate.

### Persistent-identity metadata/custody checklist — outstanding

- Enumerate eligible agents, provider/runtime classes and execution targets by
  opaque IDs only. Agent creation/first eligible managed launch provisions an
  encrypted identity once; independent HTTP/gateway and API-hosted runner targets
  are excluded (`agent-identity.ts:28-87`).
- Identify the existing trusted host/recipient set, operator/custodian and every
  changed persistent-key recipient boundary. Managed remote providers can receive
  and retain this key. Prior remote execution or short-lived JWT authority is
  **not** proof of authority to retain a persistent identity. New boundaries STOP
  for the existing governed security decision; do not launch to gather proof.
- Record wrapping-key file/backup custody metadata and permissions, **never the
  key value**. Hold the matching wrapping key separately from encrypted DB backups.
  Prove isolated staging restore continuity via **public key IDs only**; no
  identity-row cloning into active development agents.
- Define incident owner and external verifier revocation/expiry before relying on
  signatures. Restoring a DB or expiring a run JWT cannot recall distributed keys.
  No rotation UI or end-to-end no-downtime rotation is established or authorized.
- Redaction is accidental-disclosure defense, not confinement of a runtime that
  possesses the key. Do not claim every adapter/provider/encoding/log path tested.
  No host custody, backup or recovery result is certified here.

Sources: `doc/AGENT-IDENTITY.md:50-71,86-96`; `agent-identity.ts:28-87`;
`packages/db/src/schema/agent_identity_keys.ts:5-21`;
`server/src/secrets/local-encrypted-provider.ts:48-99,203-231`;
`packages/adapter-utils/src/server-utils.ts:3237-3264`;
`heartbeat/runtime-execution.ts:640-648`; Cursor Cloud `server/execute.ts:109-121,292-307`.

## 4. Stored-tool restrictions and unresolved authority provenance

The actual upstream fix is **`483dbc88904672362563419e485a1c4b366db96b` (#14915)**,
an ancestor of I and `v2026.1012.0`. The separate local prior-decision reference
**`b6467405` remains unresolved**. Code provenance is not approval provenance;
the upstream fix does not identify or replace that local approval. Its issuer must
resolve it or the security authority explicitly track the gap. Do not substitute
an audit for an unidentified approval or silently treat it as satisfied.

`server/src/services/tool-access-policy.ts:731-760` requires a matching explicit
allow AND every understood selector; malformed/unknown restrictions deny. Null
and `{}` remain unrestricted. Never clear a denied scope to null/`{}` or strip
unknown selectors to make it work. The raw nonempty-scope dump is removed from `03`.

Required sanitized audit, by the existing authorized metadata executor (not run):

1. Pin exporter/evaluator SHA, snapshot/company alias; enumerate **all `tools:use`
   rows**, including unrestricted rows that could mask restricted denies. Related
   profiles/bindings/policies and active principals use opaque IDs/counts only.
2. Classify in trusted memory; emit grant ID/principal alias, scope-root category,
   allowlisted selector-key names, **unknown-key count only**, kind/count validity
   flags, allow-prefix counts and reason enum (`unrestricted`, `valid-restricted`,
   `invalid-root`, `invalid-allow`, `unknown-selector`, `invalid-selector`,
   `unresolved-target`, `combined-mismatch`). No raw scope, unknown key strings,
   allow values, URLs, headers, args, credential refs or logs.
3. Reconcile examined = unrestricted + valid-restricted + denied/invalid, by
   principal/connection alias. Account for stale IDs, alias matching, exact literal
   selectors, singular/plural conjunction and combined mismatches.
4. Qualify a finite gateway discovery/call/revocation matrix against deterministic
   **fake providers in disposable staging**: intended matching read allowed;
   wrong tool/connection/project/company/run, malformed/unknown/revoked grants
   denied with **zero provider calls**. No production mutating probes/provider calls.
   Existing integration regression: `server/src/__tests__/tool-grant-scope.test.ts:22-88`;
   its presence is not evidence it ran on the release source.
5. Any scoped correction requires an independently authorized exact replacement,
   metadata fingerprint and audit/readback. Repeat the sanitized matrix after the
   upgrade. Counts, affected principals/tools and availability impact remain
   **unverified** until actual exporter/staging evidence exists.

Lock carryover still requires full stop of old/new writers for upgrade **and**
rollback (`doc/workspace-restore-locks.md:39-51`). Do not delete/replace a live
`.lock.sqlite` or move legacy lock directories while any writer can run.

## 5. Out of scope

No new permission, recipient, provider, feature enablement, key rotation, spend or
production testing. Upstream runner-default change `8193abb936` (#15997) is outside
the pinned beta; it is not smuggled into this config correction. No integration,
schema, migration, runtime implementation or Test Author acceptance-file edits.

## 6. Required order — actual staging BEFORE production

### A. Freeze and security prerequisites

1. Publish corrected config branch/SHA, full-verdict correction map and offline
   evidence. These are review inputs, not favorable security findings.
2. Obtain the actual **favorable exact-revision security verdict** for source,
   config and applicable metadata/custody evidence. Resolve or explicitly track
   `b6467405` with that authority. Unknown principal expansion or recipient boundary
   retains its STOP and existing decision path.
3. Require exact-source CI/review gates and immutable built-artifact digest,
   source SHA and migration identity. Do not infer green from another head or a
   completed adverse-review card. Pin replacement inputs and re-review as needed.

### B. Isolated staging qualification and rollback rehearsal

**Finish every item here before production cutover is eligible.** This section is
a future separately authorized host execution contract, not work performed here.

1. Under that contract, back up isolated staging state and record matching
   wrapping-key custody separately; quiesce admission and drain/stop **all** old
   server/worker writers across hosts/containers. No old/new concurrent writers.
2. Migrate and boot the **exact pinned artifact** in maintenance/quiesced staging;
   verify the actual integration migration journal (not an assumed numeric suffix)
   and projected versus observed bootstrap grants. No ordinary jobs yet.
3. Apply reviewed budget and review-config mappings via their audited APIs with
   the guards/readbacks above, keeping all unrelated writers/admission quiesced.
4. Actually run plugin smoke, adapter-family checks on authorized synthetic
   fixtures, review-bot **shadow soak without GitHub publication**, author matrices,
   budget exact-window/expected-state matrices, principal effective-grant/restart
   verification and stored-tool allow/deny/revocation matrices. Capture commands,
   environment, times, source/config SHAs, artifact digest, counts and failures.
5. **Rehearse rollback now**: full drain/stop, restore pre-upgrade isolated DB with
   matching separately held wrapping key and old artifact, prove health and prior
   budget/review/grant behavior. Compare public identity IDs for continuity only;
   never expose material or clone identities to active development agents.
6. Preserve restore logs/health outcomes and return to the reviewed staging state
   only under the same contract; capture final soak evidence. Failure or drift
   retains the STOP. No waiver by marking a card complete.

### C. Production cutover, only after A and B are complete

The authorized executor must verify favorable exact-revision security, exact-source
CI/review and artifact identity, actual successful staging/rollback evidence,
reviewed manifests and existing authorization. This pack performs none of this.

Take an authorized pre-cutover backup; drain/quiesce and stop all old writers;
migrate/boot the qualified artifact in maintenance with ordinary admission held;
apply exact reviewed mappings and reconcile inventories/audit counts. Check only
the authorized machine-contract health/readiness signals and rollback criteria.
**No production tests, provider probes or exploratory migrations.** Release
admission only after that existing contract passes. Do not add a routine CEO/CISO/
owner approval hop; missing security evidence is not permission to bypass a gate.

## 7. Rollback contract and its limits

Full stop applies again to **all old/new writers**. An image-only rollback does
not undo migrated DB state: restore the matched pre-cutover DB, prior artifact and
compatible wrapping-key custody under the existing executor contract; validate
health and prior configuration. Rehearse this in **staging before production**.
Do not delete data/history, improvise down-migrations or force a downgrade.

For a single configuration rollback, use the guarded same-policy budget API or
revision-checked complete prior review snapshot (§1/§2), not raw SQL. An unexpected
state requires reconciliation. Neither restore nor JWT expiry revokes persistent
keys already distributed to runtimes. Do not assert rollback recalls identity.

## 8. Security-verdict correction map and evidence boundaries

| Full-verdict item | Correction in this pack | Still required, not claimed |
| --- | --- | --- |
| 1: include-list widening, repo overrides, malformed flags, sender flags | §2 and `02`: identical includes; preserved excludes plus old denials at defaults/owned overrides including `[]`; invalid-input STOP; people retained | Unchanged independent acceptance artifact results and later actual config readback/shadow proof |
| 2: metric/window ambiguity, usage audit, unaudited broad fallback | §1 and `01`: existing ID/full key/expected state, actual-window join, subscription unpriced exclusion, explicit API/exclusivity/counts/rollback; SQL writes removed | Reviewed real policy manifest, actual prior/after rows and audit; exact-source enforcement tests/staging |
| 3: incomplete raw roles, fixed insert count, role-only narrowing | §3 and `03`: all active categories + normalized roles; per-key projection and scoped conflict preservation; atomic API/auth/last-owner/restart guidance | Actual sanitized principal diff, authorized expansion/narrowing decision, effective/restart proof |
| 4: stored-tool metadata/provenance gaps | §4 and `03`: no raw-scope dump, all-root audit plan, finite fake-provider matrix; upstream SHA separate from unresolved local reference | Sanitized exporter results, counts and authority-reference resolution; no clearance claimed |
| 5: identity custody/recovery gaps | §3 checklist and §7 rollback limits | Authorized recipient/custody inventory, matching-key isolated restore proof, incident/verifier procedure |
| Required ordering/release conditions | §6: favorable exact-revision verdict, source CI/review/artifact identity, actual staging and rollback **before** production | All live execution and release decisions remain outside this card |

Offline synthetic assertions can prove mapping properties, not live database state,
provider behavior, host permissions, custody, CI, migrations, qualification or
security approval. Full Vitest/typecheck/build and live integration suites are not
certified by a four-file documentation/template handoff. Attach concrete commands,
results, immutable SHA and limitations in the correction report; return artifacts
for security re-review without declaring this adverse verdict cleared.
