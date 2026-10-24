# Run-local model resolution

`run.model.resolve` is an optional plugin capability for choosing a model immediately before an issue-backed run starts provider work. It changes only that run's effective adapter configuration; it does not update the agent, issue, credentials, or connection inventory.

## Why a separate hook?

Changing an agent's persistent default is not an atomic per-run decision: overlapping runs can observe another run's choice, and an unavailable routing policy cannot veto a start. A run-local hook supports provider-neutral policy without giving a plugin permission to mutate agents. It complements native AI connection routers rather than replacing them: explicit saved-connection bindings and native router selections retain authority and bypass this hook.

This is an opt-in extension. Instances without an eligible resolver preserve their existing routing behavior. No deployment, provider integration, credentials, quota feed, or background host pacer is required by this feature.

## Manifest and worker

Declare the capability and, only if needed, a bounded allowlist of plain-string environment overrides:

```ts
capabilities: ["run.model.resolve"],
modelRouting: { envKeys: ["MODEL_CONTEXT_LIMIT"] },
```

`modelRouting` requires the capability. Its `envKeys` list is limited to 32 uppercase environment-variable names. The hook cannot replace an effective `secret_ref` binding, including one introduced by the final workspace/issue merge. The host never sends resolved environment values or secret material to the hook.

Implement `onResolveRunModel` on `definePlugin`. The SDK advertises the optional `resolveRunModel` host-to-worker RPC only when that handler exists. Older plugins need not implement it.

```ts
async onResolveRunModel(request) {
  if (request.previous?.model === "example-model") return { kind: "keep" };
  return {
    kind: "decide",
    decisionId: `decision:${request.runId}`,
    model: "example-model",
    source: "example-policy",
    env: { MODEL_CONTEXT_LIMIT: "32000" },
  };
}
```

The request contains `runId`, `companyId`, `agentId`, nullable `issueId`, `adapterType`, `invocationSource`, nullable `wakeReason`, nullable `agentDefaultModel`, nullable `issueOverrideModel`, `deadlineMs`, and nullable `previous: { runId, model, decisionId }`. Previous decisions are constrained to the same company, agent, and issue; another company's history is not exposed.

The response is one of:

- `{ kind: "keep" }`: retain the host's existing effective configuration.
- `{ kind: "decide", decisionId, model, source, effort?, env?, tier?, fallback?, reason? }`: propose a run-local selection. Model and decision ID must be nonempty strings of at most 200 characters. Environment keys must be declared and values must be strings. The adapter's normal configuration/provider validation still applies; optional `effort` uses the adapter's `effort` field, not a provider-specific translation layer.
- `{ kind: "defer", retryAfterMs, reason }`: do not start provider work. The host clamps valid delays to 1–60 seconds and uses 5 seconds for invalid delays.

The host sets `deadlineMs` to 1,500 and uses the same RPC timeout. A qualifying installed resolver that is not ready/running, RPC failure/timeout, invalid answer, or conflicting eligible resolvers fails closed into a bounded retry. This does not silently select an arbitrary resolver or fall back to the agent default. The existing scheduler limits model-decision retries to 12 attempts; exhaustion releases the issue execution slot instead of starting unapproved provider work.

## Eligibility, precedence, and accounting

Only issue-backed runs are eligible. Human-assigned issues, explicit issue model pins, and explicit native AI connection bindings/router pools bypass the hook. Disabled/uninstalled plugins and a company's explicit plugin opt-out are excluded. Exactly one remaining capability holder is required when resolution is enabled.

A decision is applied after the normal workspace/issue configuration merge and before secret/environment resolution. Native runner provider inputs also receive the run-local selection. Existing session freshness rules see the effective chosen model; the feature adds no separate session store or automatic session reset policy. Session continuity across model changes must be rehearsed for the particular adapter/provider before production adoption.

The run's `contextSnapshot.modelDecision` and `agent.run.*` lifecycle payloads carry a minimal record (`outcome`, `pluginKey`, `decisionId`, `model`, and an optional skip/defer reason), not the environment map or full adapter configuration. A skipped run without any resolver does not add a decision record. No database migration or new mutable agent field is introduced.

## Verification

Focused contracts and regression tests:

```sh
pnpm exec vitest run \
  server/src/__tests__/run-model-resolver.test.ts \
  server/src/__tests__/run-model-resolver.integration.test.ts \
  packages/plugins/sdk/tests/run-model-resolve.test.ts \
  packages/plugins/sdk/tests/worker-rpc-host.test.ts \
  packages/shared/src/validators/plugin.test.ts \
  server/src/__tests__/plugin-worker-manager.test.ts \
  server/src/modules/run-dispatch/adapters/postgres.test.ts
pnpm --filter @paperclipai/server... build
```

The integration fixture uses a disposable embedded database and synthetic data to cover company opt-outs and previous-decision isolation. The SDK fixture uses the real RPC dispatcher for `keep`, `decide`, `defer`, and optional-method discovery. Unit tests cover unavailable/conflicting holders, malformed responses, allowlists, pins, and secret-reference protection. Native run-status projection tests ensure the minimal decision record survives terminal event publication without the full wake context.

These focused checks do not replace the repository-wide typecheck, tests, build, adapter session-continuity checks, or any deployment-specific security and final-image rehearsal gates.
