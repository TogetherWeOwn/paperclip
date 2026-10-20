# Gateway tool-result delivery

Agent gateway calls retain their full validated result for audit sizing, but text
results over 16 KiB are delivered as a bounded preview and a private spill-file
pointer. The default preview contains at most 12 KiB of text. The serialized MCP
result, including the footer and pointer metadata, stays within the configured
cap. JSON escaping and UTF-8 boundaries count toward that budget. Plugin result
envelopes retain their plugin identity and replace only the result body. A capped
response is a delivery wrapper, not an instance of the tool's original output
schema: its structured content contains the spill pointer rather than partial
provider data. Consumers that require the original typed result must read the
complete spill. Objects and arrays are saved as JSON; a top-level string is saved
as raw UTF-8 text. The footer reports the original serialized result byte count,
which can differ from the spill's file size because of JSON quoting or redaction.

This applies to ordinary run-bound gateway calls and direct plugin calls. It
includes GitHub action lists, commit lists, pull-request lists, file reads,
pull-request reads and Playwright text snapshots. Image/audio content is not
truncated. Tool discovery and non-run connection Test calls keep their protocol
responses. Approved actions that execute after their run has stopped do not have
a live spill writer and retain their existing response behavior.

Connected MCP error results use the same validation, redaction and delivery path
before the gateway throws an error. Both ordinary and approved calls keep HTTP
502 and `tool_error`; the message contains the bounded preview and spill pointer.
Small errors and tools with caps disabled retain their full sanitized message.
Failed invocations and `call_failed` events retain the full sanitized size and
hash, plus delivery metadata. Provider actions are not retried.

## Exempt reviewer reads

Canonical `read_pull_request` is always exempt. The `paperclip_github_chat`
reviewer protocol's `read_file` is also exempt. Exemptions use canonical upstream
tool identity, not a display title. Caps never remove the reviewer's full diff.
Normal secret redaction and prompt-injection validation still apply.

## Profile and instance configuration

A matching include entry in an effective tool profile can set
`conditions.resultMaxBytes` to an integer cap. Existing selector, actor, argument
and context conditions must match. An excluded profile does not supply a cap.
When several valid entries match, the smallest positive cap wins; zero means
unlimited only when no positive cap matches. Profile caps override instance
settings but never the mandatory reviewer exemptions. This is delivery
configuration, not an authorization grant. If profile lookup fails after provider
execution, instance settings apply and `metadata.resultCapConfigUnavailable=true`
makes that degradation visible without replaying the action.

The server also reads these optional environment settings:

- `PAPERCLIP_TOOL_RESULT_MAX_BYTES`: default cap, initially `16384`.
- `PAPERCLIP_TOOL_RESULT_CAPS`: a JSON object of per-tool overrides.

Use canonical upstream tool names with hyphens normalized to underscores. Keys
are checked in this order: `<connection-id>/<tool>`, `<application-key>/<tool>`,
then `<tool>`. For example:

```json
{"github/get_file_contents":32768,"browser_snapshot":8192}
```

Caps are integer bytes from 1024 through 1048576. Zero explicitly disables a cap.
Invalid configuration retains the default or a less-specific valid override.
Reviewer exemptions take precedence over configuration. These settings do not
change transport response-size limits, tool permissions, or approval policy.

Canonical `get_job_logs` calls default `failed_only` to `true` before policy,
hashing and approval signing. An explicit `false` is preserved. Their previews
retain the log tail instead of the beginning. The spill retains the complete
returned log, which can already be filtered by the provider.

## Spill security and lifetime

The heartbeat controller registers one writer for the exact company, agent and
run. It uses the already-realized execution target, not a destination from tool
arguments. Local files live in the existing run scratch directory. Remote files
live under `.paperclip-runtime/tool-results/<run-id>/` in that run's workspace.
Local scratch follows terminal-run cleanup; remote files disappear with the
workspace and are excluded from workspace synchronization.

Secret redaction and reviewer blinding happen before the spill and preview. A
fixed controller program receives the sanitized payload on stdin. It creates
owner-private directories and exclusive `0600` files as the target execution
user. It refuses symlinked spill directories, foreign ownership and non-private
spill directories. Payloads and transport diagnostics do not enter run logs.
Existing SSH launch-authority checks are not bypassed.

A missing writer, disk error or invalid spill receipt does not replay or fail an
already-executed provider action. The full sanitized result is returned instead.
The completion event records `metadata.truncated=false` and
`metadata.resultCapSkipped` with a fixed reason. An operator must investigate
these events rather than treat them as successful context reduction.

Spills are recovery aids for the current run, not durable deliverables. Read the
footer's path with ranged file reads or grep. Upload a real deliverable through
the normal artifact workflow before the run ends.

## Audit and deployment measurement

`tool_call_events.result_size_bytes` retains the full validated, redacted result's
pre-truncation size. Its meaning does not change. Completion metadata adds
`truncated` and `deliveredSizeBytes`. Do not expect the original size column to
drop after deployment; use delivered bytes to measure context savings.

Run the following read-only query against the authorized measurement database,
with an explicit company, non-exempt tool-name list, and 24-hour window. Compare
matched before/after windows and retain counts and failure rates as well as bytes:

```sql
SELECT tool_name,
       count(*) FILTER (WHERE event_type = 'call_completed') AS completed,
       count(*) FILTER (WHERE event_type = 'call_failed') AS failed,
       sum(greatest(coalesce(result_size_bytes, 0) - 16384, 0))
         FILTER (WHERE event_type = 'call_completed') AS original_excess_bytes,
       sum(greatest(coalesce((metadata->>'deliveredSizeBytes')::bigint,
                             result_size_bytes, 0) - 16384, 0))
         FILTER (WHERE event_type = 'call_completed') AS delivered_excess_bytes,
       count(*) FILTER (WHERE metadata ? 'resultCapSkipped') AS degraded
FROM tool_call_events
WHERE company_id = :company_id
  AND created_at >= :window_start
  AND created_at < :window_end
  AND tool_name = ANY(:non_exempt_tool_names)
  AND event_type IN ('call_completed', 'call_failed')
GROUP BY tool_name;
```

Release requires exact-head CI and independent review, a staging smoke that
confirms the footer path is readable on the actual target, and the normal
approved deploy-line health/rollback contract. The post-deployment target is at
least 80% less excess delivered output for non-exempt tools, without a higher
failure rate. Unit tests and local smoke evidence do not prove that 24-hour
production outcome.
