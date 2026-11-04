# Atomic plugin state creation

`PluginStateClient` adds an optional method within plugin API v1:

```ts
create?(input: ScopeKey, value: unknown): Promise<boolean>;
```

The plugin calls `ctx.state.create(input, value)` only after checking availability.
Plugin identity comes from the host's installed plugin record, never from the
caller. The same `ScopeKey` is used by `get`, `set`, and `delete`.

## Availability and compatibility

During `initialize`, a supporting host sends `supportedHostMethods: string[]`.
It advertises actual function-valued host handlers, not merely the methods known
to the SDK. `HostServices.state.create` and the factory's `state.create` handler
are optional; an older adapter without the primitive does not advertise it.
The worker exposes `ctx.state.create` only when the list includes exactly
`"state.create"` and the manifest declares `plugin.state.write`. Host handlers
still enforce the write permission and the invocation company scope on each call.

Check availability without mutating anything:

```ts
if (typeof ctx.state.create !== "function") {
  throw new Error("Atomic state creation is unavailable");
}
```

A missing list (old host), unknown method, malformed list, missing write capability,
or absent adapter means unavailable. There is no `get`/`set` fallback. An older
SDK/worker ignores the additive initialization field and continues using its
existing methods. An unknown/unsupported RPC method throws even if a host
incorrectly advertised it. A local wrapper, package version, merged source, or
migration ledger alone is not proof that the running host supports the method.
No API version bump, new permission, runtime upgrade, or package publication is
part of this source addition. The source package versions remain SDK `1.0.0` and
server `0.3.1`; availability is negotiated, not inferred from those versions.

## Storage and wire contract

`state.create` takes `ScopeKey & { value: unknown }` and returns a **strict boolean**:

- `true`: this invocation inserted the entire value and its transaction committed.
- `false`: the exact composite key already existed. Its value, timestamp, and
  lifetime remain unchanged, whether the proposed value is the same or different.
  A stored JSON `null` counts as existing, not as absence.
- Storage, commit, transport, permission, invalid-scope, and unsupported-method
  errors throw. A timeout or lost response may hide a committed insert. It cannot
  authorize fresh work; do not coerce a response to truthiness or retry dispatch.

The host validates the existing state-key schema and checks plugin existence.
Omitted/null `scopeId` maps to SQL NULL; omitted/null namespace maps to `default`.
An empty scope ID, namespace, or key is invalid. Company scope requires a nonempty
scope ID matching the authorized invocation company. Extra `pluginId` or
`companyId` fields cannot replace the host-bound plugin or the key's company.

The implementation performs one `INSERT ... ON CONFLICT
(plugin_id, scope_kind, scope_id, namespace, state_key) DO NOTHING RETURNING id`
inside an explicit transaction, awaiting commit before returning. The explicit
transaction also avoids the root database client's transient write retry path:
an interrupted transaction aborts rather than replaying an ambiguous insert.
There is no read-then-write algorithm or worker-local mutex.

The existing `plugin_state_unique_entry_idx` is `UNIQUE NULLS NOT DISTINCT` in
both the Drizzle schema and migration `0029_plugin_tables.sql`. PostgreSQL 15+
is required (the supported embedded PostgreSQL and local PostgreSQL 17 paths
satisfy it). No new migration is needed. Do not substitute ordinary NULL-distinct
uniqueness: that would permit duplicate instance-scope keys.

## Admission consumer invariant

Atomic creation is a primitive, not a complete authorization or dispatch protocol.
An admission consumer must use:

- One fixed, versioned admission-consumption namespace.
- `scopeKind: "company"` and nonempty `scopeId` equal to the authorized company UUID.
- A `stateKey` derived **only** from the authenticated run UUID. Never partition
  by grant, command, agent, or workspace. A replacement grant must reach the same
  company+run slot.
- An immutable value pinning company/run, command UUID, canonical execution
  digest, and required audit fields.

A successful create is necessary but not sufficient for dispatch: every existing
authorization and policy check still applies. `false` permits only already-journaled
same-ID/same-digest receipt handling under existing authorization, or denial;
it never authorizes fresh dispatch. Missing capability denies both new real
admission and admission dry-run. A dry-run checks availability and reads only;
it never calls create or reserves a slot.

The consumption tombstone must live outside command-journal retention, expiry,
cancellation, and config/grant replacement. Never `set`, `delete`, TTL-clean, or
compensating-delete entries in this namespace. A consume committed before journal
failure or a crash permanently spends the slot: fail closed, with no automatic
re-dispatch. Preserve supported legacy receipt/read/heartbeat/cancel/reconciliation
operations rather than globally restricting those routes.

Generic plugin state is **not append-only**. Uninstall with data removal,
`deleteAll`, plugin identity replacement, database reset, and database restore
can erase or rewind tombstones. These are reset hazards, not authorized replay-reset
mechanisms and not evidence of running-host readiness. Consumers needing stronger
lifecycle guarantees must govern those hazards separately.

## Isolated verification

Run from the repository root after building workspace dependencies:

```sh
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
pnpm --filter @paperclipai/db build
pnpm exec vitest run packages/plugins/sdk/tests/state-create-host.test.ts packages/plugins/sdk/tests/state-create-bridge.test.ts server/src/__tests__/plugin-state-create.test.ts server/src/__tests__/plugin-state-create-negotiation.test.ts
```

The database suite creates and removes its own migrated PostgreSQL cluster. It
uses independent one-connection pools and host instances, checks the migrated
NULLS NOT DISTINCT index, races same/different values, reconnects, and verifies
unchanged conflict rows and stored JSON null. It exercises scope/plugin isolation,
permission denial, insertion and deferred commit failures, and the real SDK/JSON-RPC/
host/database round-trip including a lost committed response. The wire and worker
manager suites cover strict booleans, read-only availability, legacy initialization,
unsupported negotiation and absence of fallback. The legacy-worker fixture checks
the pre-negotiation wire shape; it does not install a historical published SDK.
If the disposable PostgreSQL suite cannot run, report that missing evidence and
do not claim database-atomic readiness from the in-memory wire fixtures alone.
No live database or running plugin needs to be changed for these tests.
