# Native SSH launch authority

Paperclip can require a signed launch authority before it starts a process on an SSH execution target. The authority binds one launch to these:

- one run, one agent and one assigned model;
- one exact command and argument list;
- one environment: its sorted key names and a digest of its values;
- one remote target.

A signer outside the Paperclip server approves it.

## Enforcement switch

The server environment variable `PAPERCLIP_NATIVE_SSH_AUTHORITY` controls enforcement. Agents cannot change it.

- Unset, empty or `off`: SSH launches work as before. If a caller binds an executor anyway, that executor is enforced in full.
- `required` (or any other value): every SSH launch through `runChildProcess` needs an executor-issued authority. Without one, the launch is refused before `ssh` is resolved or a key file is written. Any value other than unset, empty or `off` enforces, so a typo cannot disable the check.

Set `required` only after a signer is reachable. If no signer is configured, every SSH-target run is refused.

## What is gated

- `runChildProcess` with a remote execution spec. This covers adapter launches and server probes inside a run, such as the managed-AI project-auth check. The authority is issued in `resolveSpawnTarget`.
- `buildSshSpawnTarget` checks and spends the authority before it stages the private key. A refused launch writes no key file and starts no child.
- Probes outside a run (the adapter environment Test route and managed-AI connection adoption) have no run to bind an authority to. While enforcement is `required`, they return HTTP 422 with code `native_ssh_authority_required` on SSH targets.

These remain server-owned transport and are not gated: workspace sync, file streams and the command runner (`runSshCommand`). The call-site inventory test in `native-ssh-dispatch.test.ts` fails when a new function starts `ssh` or stages SSH key material without a classification.

Not gated yet: the Paperclip Runner (`paperclip_runner` adapter with the native runner enabled) on an SSH target starts runnerd through the command runner. While enforcement is `required`, such a run still needs a decided model, because the run's executor is built first. With a decided model, runnerd starts without an authority. Do not use that combination with enforcement until that path carries an authority or refuses SSH targets.

## Issue flow

1. For each SSH run, the heartbeat builds one host executor (`server/src/services/native-ssh-authority.ts`). The model comes only from an explicit `decide` answer of the single enforced model-decision holder. Paperclip never reads `adapterConfig.model` for this. The run is refused before any launch in these cases:
   - the holder is missing, disputed or unverifiable;
   - the answer is a keep, skip or deferral, or an advisory record;
   - the answer came from a different router;
   - the run has no issue.

   The run fails with the usual setup error code. Its error message says that the assigned model is missing, or names the missing run identity. The thrown error has the code `native_ssh_assigned_model_missing` or `native_ssh_authority_invalid`.
2. For each launch, the executor creates a server-side opaque request id and builds the authority. It records the exact authority on the run (`heartbeat_runs.context_snapshot.nativeSshAuthority`, which is also kept in the run's in-memory context).
3. The signer receives only `{ "version": "1", "opaqueRequestId": "<uuid>" }`. It must sign the authority recorded for that id and nothing else. The executor waits at most 10 seconds.
4. The executor accepts the envelope only when all of these hold:
   - the configured verifier accepts the signature (the Ed25519 verifier checks the canonical envelope without the signature);
   - the signed authority equals the recorded authority;
   - the authority has not expired. The lifetime is at most 60 seconds.

   The executor then records the envelope SHA-256 (`nativeSshEnvelopeSha256`). Each new launch replaces the recorded authority and clears the digest. Concurrent launches in one run are authorized one at a time, so a second launch cannot overwrite the recorded authority before the signer reads the first.
5. The proof is single-use. These are refused: a replayed request id, a reused proof, a proof for a different command, arguments, environment or target, and a JSON copy of a proof.

Signer transport failures, signer silence and ledger write failures refuse the launch. Their codes are `native_ssh_signer_unavailable` and `native_ssh_ledger_unavailable`.

## Configuration

The heartbeat service takes `nativeSshSigner` (the transport to the signer) and `nativeSshEnvelopeVerifier` (for example `createEd25519NativeSshEnvelopeVerifier(publicKeyPem)`). This release line has no built-in signer transport. Provide them in code before you set enforcement to `required`. Local and sandbox targets are not affected.

The environment that is bound is the one the remote command actually gets, after the SSH size budget drops oversized values. The authority holds its sorted key names and a digest. The values are not stored in it.

No database migration is needed. The authority and the envelope digest use the existing run context snapshot.

## Threat model limits

- The signer's approval binds what the server asks to launch. It does not protect against code running inside the Paperclip server process. That code holds the SSH key and can construct its own executor.
- The signed envelope is not sent to the SSH host, so the host does not verify it.
- `runChildProcess` has no cancellation hook before spawn. If a run is cancelled while the signer is answering (at most 10 seconds), the launch still starts when the signer answers in time. Resolve this before you turn enforcement on for production.
