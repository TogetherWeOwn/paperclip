# Native SSH launch authority

Paperclip starts an agent process on an SSH execution target only with a signed launch authority. The authority binds one launch to one run, one agent, one assigned model, one exact command and argument list, and one remote target. A process outside the Paperclip server signs it.

## What is gated

- `runChildProcess` with a remote execution spec (adapter launches and server probes such as the managed-AI project-auth check). The authority is issued in `resolveSpawnTarget` before `ssh` is resolved or any argument, environment value or key file exists.
- `buildSshSpawnTarget` checks and spends the authority before it stages the private key. A refused launch writes no key file and starts no child.

These remain server-owned transport and are not gated: workspace sync, file streams and the command runner (`runSshCommand`). The `native-ssh-dispatch.test.ts` call-site inventory test fails when a new function starts `ssh` or stages SSH key material without a classification.

Not gated yet: the Paperclip Runner (`paperclip_runner` adapter with the native runner enabled) on an SSH target starts runnerd through the command runner. Do not enable that combination until that path carries an authority or refuses SSH targets.

## Issue flow

1. The heartbeat builds one host executor per SSH run (`server/src/services/native-ssh-authority.ts`). The model comes only from an explicit `decide` answer of the single enforced model-decision holder. A missing, disputed or unverifiable holder, a keep, skip, deferral or advisory record, or a foreign router refuses the run with `native_ssh_assigned_model_missing`. Paperclip never reads `adapterConfig.model` for this.
2. For each launch the executor creates a server-side opaque request id and builds the authority. It records the exact authority on the run (`heartbeat_runs.context_snapshot.nativeSshAuthority`).
3. The signer receives only `{ "version": "1", "opaqueRequestId": "<uuid>" }`. It must sign the authority recorded for that id and nothing else.
4. The executor accepts the envelope only when the configured verifier accepts the signature, the signed authority equals the recorded authority, and the authority has not expired. The Ed25519 verifier checks the canonical envelope without the signature. The lifetime is at most 60 seconds. The executor then records the envelope SHA-256 (`nativeSshEnvelopeSha256`). Each new launch replaces the recorded authority and clears the digest.
5. The proof is single-use. A replayed request id, a reused proof, a proof for different arguments or target, or a JSON copy of a proof is refused.

## Configuration

The heartbeat service takes `nativeSshSigner` (the transport to the signer) and `nativeSshEnvelopeVerifier` (for example `createEd25519NativeSshEnvelopeVerifier(publicKeyPem)`). Without both, every SSH-target launch is refused with `native_ssh_signer_unavailable`. Local and sandbox targets are not affected.

No database migration is needed. The authority and the envelope digest use the existing run context snapshot.
