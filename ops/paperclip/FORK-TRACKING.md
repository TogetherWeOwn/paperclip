# Fork tracking — TogetherWeOwn/paperclip

Ledger of upstream refs vs fork state for the tog release line.
"Gone when" = condition under which the row can be dropped
(upstream merged the equivalent, or the fork rebased past it).

## tog.3 ([TOG-8853](/TOG/issues/TOG-8853), parent [TOG-8760](/TOG/issues/TOG-8760))

- Base: `tog/v2026.916.1-e2big-14092` @ `6aefa649f` (tog.2 release tip)
- Work branch: `fix/run-gateway-token-ttl`
- PR: TogetherWeOwn/paperclip#7 (`fix(tool-gateway): run-scoped token TTL covers run lifetime`)
- Fix: both run-scoped gateway token mint sites in `server/src/services/heartbeat.ts`
  (native run gateway token and managed gateways token) share one helper,
  `heartbeatRunGatewayTokenTtlMs()`: env `PAPERCLIP_RUN_GATEWAY_TOKEN_TTL_MS`,
  default 24 h. The gateway still rejects tokens whose run is no longer active
  (`ACTIVE_GATEWAY_RUN_STATUSES` / `gateway_token_run_inactive` in
  `server/src/services/tool-gateway.ts`, untouched). Tests: TTL default/override
  unit test, updated runtime-MCP expiry bounds, and a 61-minute-old token that
  authenticates while its run is active and is rejected after the run finishes.
- Operator step after deploy: remove the interim DB trigger
  `two_run_gateway_token_ttl_ins` (it extended `heartbeat_run` tokens to 24 h
  and is redundant once this fix is live).

## tog.2 ([TOG-7727](/TOG/issues/TOG-7727), parent [TOG-7607](/TOG/issues/TOG-7607))

- Base: `tog/v2026.916.1-e2big-14092` @ `3c2da437`
- Work branch: `tog/v2026.916.1-tog7607-gateway`
- PR: TogetherWeOwn/paperclip#6 (`fix(tool-gateway): omit null structuredContent and propagate replay isError`)
- Fix: `toMcpCallResult` route shaping — omit non-object `structuredContent`
  (never `null`), unwrap the plugin-dispatcher and connected-MCP envelopes,
  propagate replay `isError` from stored status. Regression tests validated
  with the MCP SDK `CallToolResultSchema`.

## Upstream refs

| Upstream | Taken? | Notes | Gone when |
|---|---|---|---|
| paperclipai/paperclip#13113 | Partial | Route helpers + unwrap + tests adapted. Did NOT take `isConnectedMcpToolResultData` structural shape-sniffing (Greptile-flagged: misclassifies valid plugin/built-in data as an envelope). Unwrap at the plugin dispatch site by `providerType === "paperclip_plugin"`; connected-MCP `data` envelope only when `data` carries a `content` array. | Upstream merges #13113 without the shape-sniffing, or the fork rebases past an equivalent fix |
| paperclipai/paperclip#10317 | Partial (open, Greptile 5/5) | Unwrap-location reference; `.then(execution => execution.result)` approach. | PR merges upstream or is closed |
| paperclipai/paperclip#11199 | Yes — fixed by us | Neither upstream PR fixes the replay path. Fork: `storedInvocationResult` parses the summary, stamps `isError` from stored status/`errorMessage`; all 3 replay return sites shaped via `toMcpCallResult`. | Upstream merges an equivalent replay fix |
| #12611, #11910 | No | Same-path candidates, not in the tog.2 slice. | Revisited on a follow-up card if still applicable |
| #12835, #13024, #13069, #13663, #12775 | No | Same-path candidates, not in the tog.2 slice. | Revisited on a follow-up card if still applicable |
| #9743, #13115, #12872, #14017, #13167, #13297, #11812, #13025, #14012, #10510, #11433 | Skipped | Explicitly out of scope per [TOG-7727](/TOG/issues/TOG-7727). | — |

## Fork watcher

No watcher scaffolding exists in this repo (verified 2026-09-28: no `ops/`
dir, no `fork-watcher`/`fork-tracking` references outside this file).
Extending the watcher to the new PRs is an open follow-up, not done in tog.2.
