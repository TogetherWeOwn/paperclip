# Native SSH launch authority

Paperclip can require a signed launch authority before it starts a process on an SSH execution target. The authority binds one launch to these:

- one run, one agent and one assigned model;
- one exact command and argument list;
- one environment: its sorted key names and a digest of its values;
- one remote target.

The authority design requires approval by a signer outside the Paperclip server. The code below supplies a **dormant transport and reference implementation**, not a production authority boundary. No production signer is constructed here, and the original cancellation, signer-integration, and authenticated-host-verification activation prerequisites remain open (see Production blockers).

## Enforcement switch

The server environment variable `PAPERCLIP_NATIVE_SSH_AUTHORITY` controls enforcement. Agents cannot change it.

- Unset, empty or `off`: SSH launches work as before. If a caller binds an executor anyway, that executor is enforced in full.
- `required` (or any other value): every SSH launch through `runChildProcess` needs an executor-issued authority. Without one, the launch is refused before `ssh` is resolved or a key file is written. Any value other than unset, empty or `off` enforces, so a typo cannot disable the check.

Do not set `required` until every production blocker below has independently accepted evidence and the separate activation gate passes. A reachable socket alone is insufficient. If no signer is configured, every SSH-target run is refused.

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
3. The signer receives only `{ "version": "1", "opaqueRequestId": "<uuid>" }`. It must sign the authority recorded for that id and nothing else. The executor waits at most 10 seconds; endpoint config carries the request over the framed unix-socket transport (see Configuration).
4. The executor accepts the envelope only when all of these hold:
   - the configured verifier accepts the signature (the Ed25519 verifier checks the canonical envelope without the signature);
   - the signed authority equals the recorded authority;
   - the authority has not expired. The lifetime is at most 60 seconds.

   The executor then records the envelope SHA-256 (`nativeSshEnvelopeSha256`). Each new launch replaces the recorded authority and clears the digest. Concurrent launches in one run are authorized one at a time, so a second launch cannot overwrite the recorded authority before the signer reads the first.
5. The proof is single-use. These are refused: a replayed request id, a reused proof, a proof for a different command, arguments, environment or target, and a JSON copy of a proof.

Signer transport failures, signer silence and ledger write failures refuse the launch. Their codes are `native_ssh_signer_unavailable` and `native_ssh_ledger_unavailable`.

## Configuration

The heartbeat service takes the signer pair two ways. Explicit `nativeSshSigner` (the transport to the signer) and `nativeSshEnvelopeVerifier` (for example `createEd25519NativeSshEnvelopeVerifier(publicKeyPem)`) pass straight through, for tests and embeds. Or set endpoint config — `nativeSshSignerEndpoint` (the AF_UNIX socket path of the out-of-process signer) plus `nativeSshSignerPublicKeyPem` (its Ed25519 public key, SPKI PEM) — and the heartbeat builds the pair itself. Both null (the default) leaves the seam dormant. The run builder applies SSH-target and enforcement gating before resolving these options: setting exactly one, mixing endpoint config with an explicit pair, or passing an unusable key refuses a required-authority SSH run before any launch. While enforcement is off, these options are not resolved. The socket path and key are explicit arguments only; nothing reads them from the environment. Local and sandbox targets are not affected.

The built-in transport (`packages/adapter-utils/src/native-ssh-signer-transport.ts`) speaks framed protocol v1 over the socket: a 4-byte big-endian length prefix plus UTF-8 JSON, a 64 KiB cap each way, and 2-second connect plus 8-second read budgets inside the executor's 10-second signer wait. Every transport failure refuses the launch with `native_ssh_signer_unavailable`.

The reference signer (`server/src/services/native-ssh-signer-daemon.ts`) is a starting point for the out-of-process daemon and is never auto-started: it checks the injected peer identity (uid/gid/executable/cgroup), re-validates the recorded authority for the opaque id, and issues each id once in its configured ledger. A real peer-credential resolver, production run-ledger loader, durable atomic issue ledger, and explicit deployment policy are not supplied here. The reference policy hook defaults to permit after the other checks; that is not a production policy.

Its socket path must be absolute and normalized. The parent must already exist, be canonical (no symlink aliases), owned by the daemon's effective uid, and not group/other writable. The daemon uid and directory ancestors must be trusted; this is not protection against that uid or an administrator changing the filesystem concurrently. The daemon never creates those directories or removes an occupied configured pathname, including a stale socket. It binds inside a private temporary directory under that parent, sets socket permissions there, and publishes an exclusive hard link; unsupported filesystems refuse rather than fall back to replacing a path. On close, Node removes only the private bind path. Public cleanup checks the parent and socket device/inode/uid identities before removing its own socket, preserving unrelated replacements. An occupied or crash-left path needs separately authorized operator inspection/cleanup, not automatic deletion.

The environment that is bound is the one the remote command actually gets, after the SSH size budget drops oversized values. The authority holds its sorted key names and a digest. The values are not stored in it.

No database migration is needed. The authority and the envelope digest use the existing run context snapshot.

## Threat model limits

- The signer's approval binds what the server asks to launch. It does not protect against code running inside the Paperclip server process. That code holds the SSH key and can construct its own executor.
- The embedded POSIX host verifier (`packages/adapter-utils/src/native-ssh-host-verifier.ts`) checks **unsigned consistency**, not independent authorization: user, absolute directory, expiry, and per-record argv/env digests derived from the same script inputs. A mismatch refuses with exit 125, but replacing the whole script also replaces its expected digests. Those digests are not the signed canonical envelope digests. No signer envelope/signature or trusted host-side replay ledger is checked on the host; host/port are not rechecked and relative directories skip the directory check. Server-side signature verification does not resolve that boundary.
- With a caller-supplied signal, `runChildProcess` threads an optional `AbortSignal` through authorization to the signer wait; cancellation refuses with `launch_cancelled` before spawn and cleans staged keys. The production run-stop controller reaches `adapter.execute`, but the adapter/execution-target launch path does not forward it to `runChildProcess`. Thus these hooks do not yet make production run-stop prevent a launch during signer wait.

## Production blockers

These are unresolved activation prerequisites, not completed features or provisioning permission:

1. **Cancellation forwarding:** carry the heartbeat run-stop signal through adapter execution and execution-target dispatch to every authorized SSH launch, with independent stop-during-sign and stop-during-staging no-spawn proofs on the actual route.
2. **Production signer integration:** supply authenticated native peer credentials, a production recorded-authority loader, durable atomic issuance/replay protection, and explicit fail-closed deployment policy. The injectable reference core and memory ledger alone do not establish an independent production signer.
3. **Authenticated host enforcement:** deliver fail-closed envelope/signature, target/command/environment, expiry and replay verification against an independent host trust root. The current embedded consistency checks are insufficient. Code can be tested offline with synthetic identities; any host trust-root provisioning or live test still needs its own accepted gate.

Merging this dormant code does not clear these blockers. Keep the authority switch UNSET, with no daemon start, host mutation, key/identity/env/secret provisioning, live canary, or enforcement flip as part of this delivery.
