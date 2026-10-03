# Fork tracking — TogetherWeOwn/paperclip

Ledger of upstream refs vs fork state for the 1001 release line.
"Gone when" = condition under which the row can be dropped
(upstream merged the equivalent, or the fork rebased past it).

## 1001 gateway-token TTL port (fork PR #12 follow-up)

- Base: `release/v2026.1001.0` @ `14f66a7cf`
- Work branch: `fix/run-gateway-token-ttl-1001`
- PR: TogetherWeOwn/paperclip#12 (`fix(tool-gateway): run-scoped token TTL covers run lifetime`) ported onto 1001; new fork PR number recorded after opening.
- Fix: both run-scoped gateway token mint sites in `server/src/services/heartbeat.ts`
  share one helper, `heartbeatRunGatewayTokenTtlMs()`: env `PAPERCLIP_RUN_GATEWAY_TOKEN_TTL_MS`,
  default 24 h. The gateway still rejects tokens whose run is no longer active
  (`ACTIVE_GATEWAY_RUN_STATUSES` / `gateway_token_run_inactive` in
  `server/src/services/tool-gateway.ts`, untouched). Tests: TTL default/override
  unit test plus updated runtime-MCP expiry bounds (23–25 h).
- Operator note: the interim DB trigger `two_run_gateway_token_ttl_ins` stays in
  place until this change rides a drained release and is verified live. Do not
  deploy from this branch.

## Upstream refs

| Upstream | Taken? | Notes | Gone when |
|---|---|---|---|
| paperclipai/paperclip#13113 | Partial | Reference for gateway route shaping; not in this slice. | Upstream merges an equivalent fix |
