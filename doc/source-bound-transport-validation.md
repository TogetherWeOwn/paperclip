# Source-bound transport validation

A server-native operation that validates the intended transport for one
source issue and returns a receipt, without waking the source issue,
realizing a workspace, starting a runtime service, or executing any
product/staging work. It is the invokable wiring around the pure helpers
`validateSourceTransportOnly` (`server/src/services/source-transport-validation.ts`)
and `verifySourceImageAttestation` (`server/src/services/source-image-attestation.ts`);
the wiring lives in
`server/src/services/source-bound-transport-validation-operation.ts`.

## Supported invocation

```
POST /api/issues/{sourceIssueId}/transport-validation
Authorization: Bearer <agent key for the source issue's assignee>
Content-Type: application/json

{ "workspaceId": "<execution-workspace id>", "transport": "<transport name>" }
```

- The authenticated agent is the principal. Principal and company come
  from the actor, never from the request body; body fields claiming a
  principal are ignored. Board (non-agent) actors have no agent principal
  and are denied.
- `{sourceIssueId}` accepts the issue UUID or its human-readable
  identifier, like sibling issue routes; the receipt always carries the
  canonical issue UUID. `workspaceId` must be a UUID. Ids that match
  neither form deny as `unauthorized_principal` /
  `workspace_transport_mismatch` (or `400` for a malformed body), never a
  server error.
- Every compared fact is resolved server-side at invocation time, inside
  the principal's company: the source issue's current assignee, the
  current unresolved-blocker set (dependency readiness), low-trust status
  (trust-preset resolution over agent/project/issue policy), and the
  selected workspace's transport (its execution-workspace record, which
  must be bound to the source issue: the workspace's source issue, or the
  issue's selected execution workspace). A closed workspace (`closedAt`
  set, or status `archived` / `cleanup_failed`) denies as
  `workspace_transport_mismatch`.
- `requestedToolClass` (optional, nullable) is passed to the low-trust
  preflight. Under low trust the validation always denies.

Responses: `200` with an `ok: true` receipt; `403` for
`unauthorized_principal` / `low_trust_preflight_denied`; `409` for
`issue_dependencies_blocked` / `workspace_transport_mismatch`; `422` when
transport validation passed but deployed-image attestation did not.
Every response is the same receipt shape and records an
`issue.source_transport_validation` activity entry with the result
codes. The receipt is a validation record, not a capability: it grants
no execution authority and must be re-checked at any later use.

## Receipt

```json
{
  "ok": true,
  "operationVersion": "source-bound-transport-validation/v1",
  "boundary": "transport-only",
  "runtimeInvoked": false,
  "sourceIssueId": "…",
  "principalAgentId": "…",
  "transport": {
    "ok": true,
    "boundary": "transport-only",
    "runtimeInvoked": false,
    "validatedWorkspaceId": "…",
    "checkedDependencies": true,
    "preflight": "enforced"
  },
  "attestation": {
    "ok": true,
    "digest": "sha256:<64 lowercase hex>",
    "sourceRevision": "<40 or 64 lowercase hex>",
    "verifiedAtValidationTime": true
  },
  "validatedAt": "<ISO-8601 timestamp>"
}
```

Deny receipts keep `boundary: "transport-only"` and
`runtimeInvoked: false`; the failed section carries its `errorCode`.
When transport validation denies, `attestation` is
`{ "ok": false, "errorCode": "not_evaluated" }`.

## Deployed-image attestation (trusted deployment record)

An `ok: true` receipt additionally requires digest pinning for the exact
running build. The attestation inputs come only from server
configuration set at deploy time — never from the caller:

| Env var | Meaning |
| --- | --- |
| `PAPERCLIP_SOURCE_REVISION` | Source revision of the running build (40-char SHA-1 or 64-char SHA-256, lowercase hex). |
| `PAPERCLIP_DEPLOYED_IMAGE_REFERENCE` | Deployed image as `repository@sha256:<digest>`. Mutable tags (`repository:tag`, bare `repository`, `repository:tag@sha256:…`) are refused. |
| `PAPERCLIP_EXPECTED_IMAGE_DIGEST` | Expected digest, `sha256:<64 lowercase hex>`, from the trusted build/registry record for that revision. |

All three must be set; a partially configured record is treated as
unavailable (`image_attestation_unavailable`) and fails closed. This is
digest pinning at validation time, not registry, signature, or
provenance verification: it proves the deployment record's reference
carries the expected digest, nothing about what built the image. Any
registry is accepted when the digests match.

## Verification procedure

1. Unit/E2E: `pnpm exec vitest run --root server` with
   `src/__tests__/source-bound-transport-validation-operation.test.ts`,
   `src/__tests__/source-transport-validation-route.test.ts`,
   `src/__tests__/source-transport-only-validation.contract.test.ts` and
   `src/__tests__/source-image-attestation.contract.test.ts`. These cover
   authorization, cross-company denial, dependency recheck at
   invocation, low-trust enforcement, workspace binding and transport
   match, the no-effects boundary, mutable-tag refusal, digest mismatch,
   and fail-closed behaviour when the deployment record is unset.
2. Live check: invoke the endpoint above as the source assignee. Confirm
   the receipt is returned, no run was woken for the source issue (no new
   heartbeat run), the workspace was not realized, no runtime service
   started, and the `issue.source_transport_validation` activity entry
   was recorded. Repeat as a different agent and confirm
   `unauthorized_principal` (403).
3. Digest binding: confirm `PAPERCLIP_EXPECTED_IMAGE_DIGEST` and the
   digest in `PAPERCLIP_DEPLOYED_IMAGE_REFERENCE` both equal the digest
   of the actually deployed image for `PAPERCLIP_SOURCE_REVISION` (for
   example from the registry manifest or `docker inspect --format
   '{{index .RepoDigests 0}}'`). A mutable tag alone never counts.

## Rollback

Remove the route mount (`sourceTransportValidationRoutes` in
`server/src/app.ts`) or delete `server/src/routes/source-transport-validation.ts`
and `server/src/services/source-bound-transport-validation-operation.ts`.
The pure helpers, source issue statuses, blockers, workspaces, and any
previously issued receipts are unchanged.
