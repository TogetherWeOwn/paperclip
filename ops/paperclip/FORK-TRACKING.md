# Fork tracking — TogetherWeOwn/paperclip

Ledger of upstream refs vs fork state for the 1001 release line.
"Gone when" = condition under which the row can be dropped
(upstream merged the equivalent, or the fork rebased past it).

## 1001 gateway-token TTL port (fork PR #12 follow-up)

- Base: `release/v2026.1001.0` @ `14f66a7cf`
- Work branch: `fix/run-gateway-token-ttl-1001`
- PR: TogetherWeOwn/paperclip#12 (`fix(tool-gateway): run-scoped token TTL covers run lifetime`) ported onto 1001; fork PR TogetherWeOwn/paperclip#32.
- Fix: both run-scoped gateway token mint sites in `server/src/services/heartbeat.ts`
  share one helper, `heartbeatRunGatewayTokenTtlMs()`: env `PAPERCLIP_RUN_GATEWAY_TOKEN_TTL_MS`,
  default 24 h. The gateway still rejects tokens whose run is no longer active
  (`ACTIVE_GATEWAY_RUN_STATUSES` / `gateway_token_run_inactive` in
  `server/src/services/tool-gateway.ts`, untouched). Tests: TTL default/override
  unit test plus updated runtime-MCP expiry bounds (23–25 h).
- Operator note: the interim DB trigger `two_run_gateway_token_ttl_ins` stays in
  place until this change rides a drained release and is verified live. Do not
  deploy from this branch.

## codex_local managed MCP block scrub

- Base: `release/v2026.1001.0`; work branch `fix/codex-local-scrub-mcp-bearer-on-run-end`; ported to `master` as a clean cherry-pick.
- Fix: `writeManagedCodexMcpConfig` (`packages/adapters/codex-local/src/server/codex-home.ts`) now returns a `release()`.
  `execute.ts` calls it in the outer `finally`, after the provider-config restore, so the run JWT and gateway
  bearers in the `# BEGIN PAPERCLIP MANAGED MCP` block no longer outlive the run on disk. An in-process
  holder set per home makes the last run to leave a shared home do the scrub. Managed homes only
  (`isManagedCodexHomePath`); a user-supplied `CODEX_HOME` is left alone.
- Also: the codex-local and server vitest setups point `PAPERCLIP_HOME` at a throwaway directory, so suites stop
  writing `companies/<id>/codex-home` and `codex-auth-cache` into the live instance root.
- Not in this slice: rejecting the run's agent JWT (48 h TTL) on `/api/mcp/project-tools` once the run has finished.
- Gone when: upstream removes the managed block from `config.toml` at run end, or moves the bearers out of the file.

## Upstream refs

| Upstream | Taken? | Notes | Gone when |
|---|---|---|---|
| paperclipai/paperclip#13113 | Partial | Reference for gateway route shaping; not in this slice. | Upstream merges an equivalent fix |
