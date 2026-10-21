# Comment-Wake Suppression

Stale bot chatter used to wake agents at full session price: host research
(2026-10-19..10-21, `heartbeat_runs`) found 48% of Meta runs change nothing,
with comment wakes the top wake source (3,927 runs in 3 days). Many wakes come
from automation comments that need no action: PR-controller notes, age alerts,
receipts.

`enqueueWakeup` therefore applies three pre-execution skip rules to comment
wakes, right after wake-queue admission (a live run still absorbs the wake via
coalesce first) and before the PAP-13775 event-free rewake throttle. Pure
decision logic lives in `server/src/services/comment-wake-suppression.ts`;
the gate wiring is in `server/src/services/heartbeat.ts`.

## Rules

1. `automation_comment_no_marker` — skip wakes for automation-authored
   (`agent`/`system`) comments that carry no actionable marker. The explicit
   allowlist of markers that SHOULD wake:
   - `finding` — review findings (`finding`, `findings`)
   - `ci_red` — CI red/failure signals (`CI … red/failed/broken`,
     `checks failed`, `ACTION_REQUIRED`)
   - `conflict` — merge conflicts (`conflict`, `rebase`)
   - `mention` — any `@mention` (a directed ping always wakes; owner/CEO
     identity is not resolvable at this layer, so every mention wakes)
2. `comment_wake_debounced` — rate-limit even marker-bearing automation
   chatter to one wake per N minutes per issue. The window anchors to the
   last finished run; any human-authored comment since resets it.
3. `recent_run_no_changes` — skip when the last run on the issue ended within
   M minutes and nothing changed since: no human comment and no non-comment
   new-input activity (docs, work products, interactions, approvals, …).

Safety properties (pinned by unit + embedded-Postgres integration tests):

- Human-authored comments always wake. Owner/CEO board comments arrive as
  `user` actors, so no human or owner wake is ever suppressed.
- Reopens, explicit resumes, review-path recovery, interrupted-run recovery,
  force-fresh sessions, liveness continuations (e.g. quarantined low-trust
  handoffs), child stop-relay notifications (keyed on first-party
  provenance, `requestedByActorId: issue_stop_relay` /
  `contextSnapshot.source: issue.stop_relay`, since the relay body matches
  no marker), interaction continuations, and `allowRunCoalescing: false`
  wakes bypass.
- A missing/deleted triggering comment fails open (wake).
- A last run that did not succeed fails open (its follow-up is recovery).

## Configuration

Defaults are ON. All knobs are environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMMENT_WAKE_SUPPRESSION_ENABLED` | on (`"false"` disables) | Master switch for all three rules |
| `COMMENT_WAKE_DEBOUNCE_MINUTES` | `5` | N for rule 2 (clamped 1..1440) |
| `WAKE_RECENT_RUN_GUARD_MINUTES` | `10` | M for rule 3 (clamped 1..1440) |

In code, `heartbeatService(db, { runtimeEnv })` selects the env source; tests
pass `runtimeEnv` to toggle the gate per instance.

## Observability

Every suppression writes a machine-readable receipt: an
`agent_wakeup_requests` row with `status = 'skipped'`,
`reason = 'comment_wake_suppressed'`, and a `payload.wakeSuppression` object
(`reason`, `requestedReason`, `wakeCommentId`, `authorType`, `markers`,
`nextAllowedAt` where applicable, `suppressedAt`).

The aggregate metric `wakes_suppressed_total{reason}` is stored in the
existing `tool_runtime_metric_counters` sink (company-scoped, per-minute
buckets) under `wake_suppressed:<reason>` metric names — this repo has no
Prometheus client, so the DB counter table is the established metrics path:

```sql
SELECT metric, date_trunc('hour', bucket_start_at) AS hour, sum(count)
FROM tool_runtime_metric_counters
WHERE metric LIKE 'wake_suppressed:%'
GROUP BY 1, 2 ORDER BY 2, 1;
```

Counter writes are fire-and-forget: a metrics failure never breaks a wake.

## Replay

`scripts/replay-wake-suppression.ts` replays the same pure evaluators over
real wake history. Run it against a staging or snapshot database (never
production directly):

```sh
DATABASE_URL=postgres://... tsx scripts/replay-wake-suppression.ts \
  --company <company-id> --hours 24
```

It reports the projected run reduction (acceptance target: >= 30% fewer
runs on 24h of real wakes) and exits 1 if any human/owner wake would have
been suppressed. See `--help`-style flags in the script header (`--limit`,
`--debounce-minutes`, `--guard-minutes`, `--json`, repeatable `--company`).

Accounting notes: the `classified` denominator counts only wakes that
started (or will start) a run — already-`skipped` rows and non-run-starting
rows (`coalesced`, `deferred_issue_execution`, `failed`, `cancelled`,
`expired`) are excluded and reported separately, so the figure reads as
"runs prevented / runs that ran". The suppressed-wake sample carries ids
and reason only, never comment bodies. `allowRunCoalescing`,
`forceFreshSession`, explicit resumes, and liveness continuations ride the
live wake options/snapshot rather than the persisted row, so the replay
treats every row as coalescible/non-fresh/non-resume/non-liveness; that can
only over-count suppression for those rare rows, never hide a human wake.
