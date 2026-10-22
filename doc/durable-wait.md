# Event-backed wait foundation

This foundation stores controller observations and evaluates a pure wait predicate.
It does not change monitor dispatch, repair, mutation validation, or event delivery.
There are no admission callers yet. Setting `eventBackedWaitMode` to `shadow` or
`enforce` does not activate suppression in this slice.

## Registration

`POST /api/companies/:companyId/issues/:issueId/wait-coverage` uses existing board
session or board-key authentication. It denies agent keys, anonymous callers,
viewers, inactive members, and callers outside the path company. A controller must
use an authorized board identity; this endpoint introduces no system credential or
agent self-registration route. Local-trusted deployments retain their existing
implicit board trust boundary.

The shared `registerIssueWaitCoverageSchema` defines the strict request body:

```json
{
  "serviceName": "github-pr-controller",
  "externalRef": "https://github.com/example/project/pull/42",
  "sourceKind": "github_pr",
  "eventRevision": "head-sha:observed-state-digest",
  "armedRevision": "head-sha:observed-state-digest",
  "observationStatus": "ok",
  "observedAt": "2026-10-22T12:00:00.000Z",
  "armedAssigneeAgentId": "30000000-0000-4000-8000-000000000001",
  "armedStatus": "in_review",
  "fallbackAt": "2026-10-22T13:00:00.000Z"
}
```

Times on the wire are ISO UTC strings. `fallbackAt` can be null. Failed provider
reads must register `observationStatus: "error"`, not an unchanged success. Only
`github_pr` is currently a recognized source. A reference or service name alone
never proves coverage.

The server derives company, issue, actor, registration time and expiry. Expiry is
`min(registration time + 12h, monitor timeout)`; an explicit null/missing timeout
uses only the 12-hour cap. Invalid stored policy is rejected, not treated as an
unbounded timeout. The armed assignee/status must match the locked current issue.
Observations from the future are rejected; stale timestamps are never refreshed
implicitly. An observation older than the stored observation returns 409.

Success returns 200 with the serialized registry row (`issueWaitCoverageSchema`).
The database enforces the natural key `(issue_id, service_name, external_ref)` and
company-consistent issue/agent foreign keys. Registration serializes on the issue,
upserts the observation, and commits `issue.wait_coverage_registered` activity in
the same transaction. It publishes activity only after commit. It does not update
the issue, claim a monitor, create a run, or enqueue a wake in any flag mode.

New rows have a null `unresolvedActionableEventAt`. Registration cannot set or clear
that field. Existing unresolved events survive re-registration. Authenticated event
delivery and acknowledgement wiring belongs to a later slice, not this endpoint.
The controller must not use this foundation as an event-delivery receipt.

## Pure predicate

`evaluateDurableWait(facts, now)` accepts a trusted server snapshot and one finite
epoch-millisecond clock value. It returns `{ valid, reason, suppressibleFallback }`.
It reads no clock or database, performs no network calls, and mutates nothing.
Unknown required facts fail open to existing behavior: both booleans are false.

Common requirements:

- Mode is `shadow` or `enforce`; default and malformed stored values normalize to `off`.
- Authenticated coverage belongs to the same company/issue and a recognized source.
- Agent, status and event revision match the armed snapshot; there is no user assignee.
- Coverage is unexpired and successful. Observation age is `[0, freshnessMs)`;
  freshness defaults to two hours. Equality at expiry or freshness is invalid.
- No unresolved event, pending agent answer, active/queued run, queued wake, or retry.
- Explicit finite budget proof, including for coverage-only waits: nonnegative
  integer attempts below a positive integer maximum; timeout is explicitly null
  or strictly future. Provider-quota monitors are excluded.

Let `H = min(coverage expiry, non-null timeout)`:

| Snapshot | valid | suppressibleFallback |
| --- | --- | --- |
| Matching monitor with `now < nextCheckAt <= H` | true | false |
| Matching due/overdue monitor with a proven successor | true | true |
| No monitor and `now < fallbackAt <= H` | true | false |
| Other, unknown, expired, exhausted or mismatched facts | false | false |

For a due monitor the scheduler must supply a finite positive `backoffMs`.
`N = min(now + backoffMs, H)` must be finite and strictly future, and the addition
must itself remain finite. There is no implicit backoff. A malformed present monitor
cannot fall through to coverage-only. Future fallbacks beyond H are rejected,
not clamped. A due monitor is not an expired wait if its bounded successor is proven.

Eligibility is not proof of re-arming a monitor. Later admission integration must
re-read and re-evaluate under an atomic claim, consume one attempt, and persist N
before suppression. Shadow/enforce currently compute the same pure result only.

## Setting and verification

`eventBackedWaitMode: "off" | "shadow" | "enforce"` is an instance experimental
setting, not a boolean managed-feature switch. Existing instance-admin settings
permissions apply. No UI control or controller integration is added. The reversible
setting value is `off`; this foundation does not enable a live flag.

Run the three pure/schema/settings suites with:

```sh
pnpm --dir server exec vitest run \
  src/__tests__/durable-wait.acceptance.test.ts \
  src/__tests__/durable-wait-settings.acceptance.test.ts \
  src/__tests__/durable-wait-schema.acceptance.test.ts
```

The HTTP suite requires `PAPERCLIP_DURABLE_WAIT_TEST_DATABASE_URL` to name an empty,
exclusively owned `paperclip_durable_wait_test_*` database on a test-only host
accepted by its safety guard. It refuses other hosts/names and nonempty databases.
It does not use `DATABASE_URL` or embedded storage. Provision a fresh database for
each run, then run `src/__tests__/issue-wait-coverage.acceptance.test.ts` with the
same Vitest command. Never point it at a serving application database.
