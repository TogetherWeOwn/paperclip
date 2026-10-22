import { createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  NATIVE_SSH_ENVELOPE_AUDIENCE,
  NATIVE_SSH_MAX_AUTHORITY_LIFETIME_MS,
  NATIVE_SSH_SIGNER_REQUEST_VERSION,
  nativeSshEnvelopeSigningPayload,
  sha256CanonicalJson,
  type NativeSshLaunchAuthority,
  type NativeSshSignedEnvelope,
} from "@paperclipai/adapter-utils/host-executor";
import {
  encodeNativeSshSignerFrame,
  readNativeSshSignerFrame,
} from "@paperclipai/adapter-utils/native-ssh-signer-transport";

/**
 * Reference signer daemon for native SSH launch authorities. A faithful port
 * of the approved `native_ssh_authority` package's `issue_envelope` semantics
 * (`2f232abd`, content-identical to approved `5705e768`), adapted to the live
 * v1 authority line:
 *
 * - the daemon signs only the authority the server already recorded for the
 *   opaque id, loaded through the injected `loadRecordedAuthority` port;
 * - the asking peer must equal the configured expected peer
 *   (uid/gid/executable/executable-sha/cgroup);
 * - the recorded authority's grammar is re-validated and every recomputable
 *   digest (argv, launch spec, assigned-model sha) must match;
 * - lifetime is capped by policy and by the absolute 60s maximum, and the
 *   issue time must fall inside the authority's window;
 * - each opaque id is issued once;
 * - the envelope is Ed25519-signed over the exact payload the seam verifier
 *   checks (`nativeSshEnvelopeSigningPayload`, imported so both sides agree
 *   byte for byte).
 *
 * This daemon is NEVER auto-started: nothing in the server listens on its
 * socket unless an operator deploys and starts it explicitly. It is the
 * reference the deployment gates review, not a running service.
 *
 * Production residuals (each needs its own gate, NOT this card):
 * - peer identity needs a native SO_PEERCRED binding; Node exposes none, so
 *   the resolver is injected and a missing peer fails closed;
 * - `loadRecordedAuthority` must read the run ledger
 *   (`heartbeat_runs.context_snapshot.nativeSshAuthority`); tests use memory;
 * - the memory issue ledger must become a durable atomic ledger;
 * - deployment policy (which commands/adapters may be signed) belongs in the
 *   `permitAuthority` hook; the reference permits everything the checks pass;
 * - the daemon cannot recompute `envSha256`: environment values never leave
 *   the server, so the digest's format is checked but its value is
 *   server-asserted. The executor still binds the exact launch environment
 *   before spawn.
 */

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SIGNER_REQUEST_KEYS = new Set(["version", "opaqueRequestId"]);
const AUTHORITY_KEYS = new Set([
  "version",
  "opaqueRequestId",
  "runId",
  "companyId",
  "agentId",
  "issueId",
  "adapterType",
  "assignedModel",
  "command",
  "args",
  "remote",
  "argvSha256",
  "envKeys",
  "envSha256",
  "launchSpecSha256",
  "issuedAt",
  "expiresAt",
]);
const DEFAULT_SOCKET_MODE = 0o660;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_BACKLOG = 16;

/** Closed refusal vocabulary spoken on the wire. Never carries key material or stack traces. */
export type NativeSshSignerRefusalReason =
  | "request_frame_invalid"
  | "request_json_invalid"
  | "request_not_object"
  | "request_fields_invalid"
  | "request_version_unsupported"
  | "opaque_request_invalid"
  | "peer_identity_unavailable"
  | "peer_unauthorized"
  | "peer_cgroup_mismatch"
  | "peer_executable_mismatch"
  | "peer_executable_unreadable"
  | "peer_generation_mismatch"
  | "opaque_request_not_found"
  | "opaque_request_mismatch"
  | "authority_load_unavailable"
  | "authority_not_object"
  | "authority_fields_invalid"
  | "authority_version_unsupported"
  | "authority_run_binding_invalid"
  | "authority_adapter_invalid"
  | "authority_model_invalid"
  | "authority_model_digest_mismatch"
  | "authority_command_invalid"
  | "authority_remote_invalid"
  | "authority_argv_digest_mismatch"
  | "authority_env_keys_invalid"
  | "authority_env_digest_invalid"
  | "authority_launch_spec_digest_mismatch"
  | "authority_time_invalid"
  | "lifetime_exceeds_policy"
  | "lifetime_exceeds_maximum"
  | "time_window_invalid"
  | "authority_policy_refused"
  | "envelope_signing_failed"
  | "opaque_request_replayed"
  | "ledger_unavailable";

export class NativeSshSignerRefusal extends Error {
  readonly reason: NativeSshSignerRefusalReason;

  constructor(reason: NativeSshSignerRefusalReason, detail?: string) {
    super(detail ? `Native SSH signer refused the request (${reason}): ${detail}` : `Native SSH signer refused the request (${reason})`);
    this.name = "NativeSshSignerRefusal";
    this.reason = reason;
  }
}

function refuse(reason: NativeSshSignerRefusalReason, detail?: string): never {
  throw new NativeSshSignerRefusal(reason, detail);
}

/** Peer identity: uid/gid/exe/cgroup of the asking process, as SO_PEERCRED would report it. */
export interface NativeSshSignerPeerIdentity {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  readonly executable: string;
  readonly cgroup: string;
}

/** The one peer allowed to ask: the server process the deployment pinned. */
export interface NativeSshSignerExpectedPeer {
  readonly uid: number;
  readonly gid: number;
  readonly executable: string;
  readonly executableSha256: string;
  readonly cgroup: string;
}

/**
 * Resolves the asking peer for a connection. Node has no SO_PEERCRED API, so
 * production must back this with a native binding; a null result or a throw
 * refuses the request (`peer_identity_unavailable`). Never optional.
 */
export type NativeSshSignerPeerResolver = (
  socket: Socket,
) => NativeSshSignerPeerIdentity | null | Promise<NativeSshSignerPeerIdentity | null>;

/** Deployment policy. The audience is the fixed envelope audience, asserted at daemon creation. */
export interface NativeSshSignerDaemonPolicy {
  readonly audience: typeof NATIVE_SSH_ENVELOPE_AUDIENCE;
  /** Maximum authority lifetime in seconds: an integer from 1 to 60. */
  readonly maxLifetimeSeconds: number;
}

/**
 * Loads the exact authority the server recorded for an opaque id. Production
 * plugs the run ledger here; the daemon re-validates whatever comes back and
 * never trusts its shape. Null (or undefined) means "no such request".
 */
export type NativeSshRecordedAuthorityLoader = (
  opaqueRequestId: string,
) => unknown | null | undefined | Promise<unknown | null | undefined>;

/** Single-issue ledger: each opaque id is signed at most once. `recordIssue` throws a refusal on replay. */
export interface NativeSshIssueLedger {
  recordIssue(opaqueRequestId: string, envelopeSha256: string): void | Promise<void>;
}

export function createMemoryNativeSshIssueLedger(): NativeSshIssueLedger {
  const issued = new Map<string, string>();
  return {
    recordIssue(opaqueRequestId: string, envelopeSha256: string): void {
      if (issued.has(opaqueRequestId)) throw new NativeSshSignerRefusal("opaque_request_replayed");
      issued.set(opaqueRequestId, envelopeSha256);
    },
  };
}

export type NativeSshExecutableHasher = (executablePath: string) => Promise<string | null>;

async function hashExecutableFile(executablePath: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(executablePath)) {
      hash.update(chunk);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateSignerRequest(request: unknown): { opaqueRequestId: string } {
  const record = readRecord(request);
  if (!record) refuse("request_not_object");
  const keys = Object.keys(record);
  if (keys.length !== SIGNER_REQUEST_KEYS.size || keys.some((key) => !SIGNER_REQUEST_KEYS.has(key))) {
    refuse("request_fields_invalid");
  }
  if (record.version !== NATIVE_SSH_SIGNER_REQUEST_VERSION) refuse("request_version_unsupported");
  if (typeof record.opaqueRequestId !== "string" || !UUID_RE.test(record.opaqueRequestId)) {
    refuse("opaque_request_invalid");
  }
  return { opaqueRequestId: record.opaqueRequestId };
}

/** Re-validates the recorded authority's full grammar; the loader's output shape is never trusted. */
function parseRecordedAuthority(value: unknown): NativeSshLaunchAuthority {
  const authority = readRecord(value);
  if (!authority) refuse("authority_not_object");
  const keys = Object.keys(authority);
  if (keys.length !== AUTHORITY_KEYS.size || keys.some((key) => !AUTHORITY_KEYS.has(key))) {
    refuse("authority_fields_invalid");
  }
  if (authority.version !== NATIVE_SSH_SIGNER_REQUEST_VERSION) refuse("authority_version_unsupported");
  for (const field of ["opaqueRequestId", "runId", "companyId", "agentId", "issueId"] as const) {
    if (typeof authority[field] !== "string" || !UUID_RE.test(authority[field])) {
      refuse("authority_run_binding_invalid", field);
    }
  }
  if (!isNonEmptyString(authority.adapterType)) refuse("authority_adapter_invalid");
  const assignedModel = readRecord(authority.assignedModel);
  if (
    assignedModel?.version !== "1" ||
    !isNonEmptyString(assignedModel.model) ||
    typeof assignedModel.sha256 !== "string" ||
    !SHA256_RE.test(assignedModel.sha256)
  ) {
    refuse("authority_model_invalid");
  }
  if (createHash("sha256").update(assignedModel.model, "utf8").digest("hex") !== assignedModel.sha256) {
    refuse("authority_model_digest_mismatch");
  }
  if (!isNonEmptyString(authority.command)) refuse("authority_command_invalid");
  if (!Array.isArray(authority.args) || authority.args.some((arg) => typeof arg !== "string")) {
    refuse("authority_command_invalid", "args");
  }
  const remote = readRecord(authority.remote);
  if (
    !isNonEmptyString(remote?.host) ||
    typeof remote.port !== "number" ||
    !Number.isInteger(remote.port) ||
    remote.port < 1 ||
    remote.port > 65_535 ||
    !isNonEmptyString(remote.username) ||
    !isNonEmptyString(remote.remoteCwd)
  ) {
    refuse("authority_remote_invalid");
  }
  if (
    authority.argvSha256 !==
    sha256CanonicalJson({ command: authority.command, args: authority.args as string[] })
  ) {
    refuse("authority_argv_digest_mismatch");
  }
  if (
    !Array.isArray(authority.envKeys) ||
    authority.envKeys.some((key) => typeof key !== "string") ||
    (authority.envKeys as string[]).some((key, index) => key !== [...(authority.envKeys as string[])].sort()[index])
  ) {
    refuse("authority_env_keys_invalid");
  }
  // Values never leave the server, so only the digest format is checkable here (documented residual).
  if (typeof authority.envSha256 !== "string" || !SHA256_RE.test(authority.envSha256)) {
    refuse("authority_env_digest_invalid");
  }
  const { launchSpecSha256: _expected, ...withoutLaunchDigest } = authority;
  if (typeof _expected !== "string" || sha256CanonicalJson(withoutLaunchDigest) !== _expected) {
    refuse("authority_launch_spec_digest_mismatch");
  }
  if (typeof authority.issuedAt !== "string" || typeof authority.expiresAt !== "string") {
    refuse("authority_time_invalid");
  }
  return authority as unknown as NativeSshLaunchAuthority;
}

async function matchPeer(
  peer: NativeSshSignerPeerIdentity | null,
  expected: NativeSshSignerExpectedPeer,
  hashExecutable: NativeSshExecutableHasher,
): Promise<void> {
  if (!peer) refuse("peer_identity_unavailable");
  if (peer.uid !== expected.uid || peer.gid !== expected.gid) refuse("peer_unauthorized");
  if (peer.cgroup !== expected.cgroup) refuse("peer_cgroup_mismatch");
  if (peer.executable !== expected.executable) refuse("peer_executable_mismatch");
  const digest = await hashExecutable(peer.executable);
  if (digest === null) refuse("peer_executable_unreadable");
  if (digest !== expected.executableSha256) refuse("peer_generation_mismatch");
}

export interface IssueNativeSshEnvelopeInput {
  readonly request: unknown;
  readonly peer: NativeSshSignerPeerIdentity | null;
  readonly expectedPeer: NativeSshSignerExpectedPeer;
  readonly policy: NativeSshSignerDaemonPolicy;
  readonly loadRecordedAuthority: NativeSshRecordedAuthorityLoader;
  readonly ledger: NativeSshIssueLedger;
  readonly privateKey: KeyObject;
  readonly now: Date;
  readonly hashExecutable?: NativeSshExecutableHasher;
  /**
   * Deployment policy hook: commands/adapters the deployment allows to be
   * signed. A false answer or a throw refuses the request
   * (`authority_policy_refused`). Defaults to permit (reference behavior).
   */
  readonly permitAuthority?: (authority: NativeSshLaunchAuthority) => boolean | Promise<boolean>;
}

/**
 * Pure issue core: the port of `issue_envelope`. Validates the request,
 * binds the peer, loads and re-validates the recorded authority, enforces
 * lifetime policy and time window, signs once and records the issue. Any
 * violation is a `NativeSshSignerRefusal` with a closed-vocabulary reason.
 */
export async function issueNativeSshEnvelope(input: IssueNativeSshEnvelopeInput): Promise<NativeSshSignedEnvelope> {
  const { opaqueRequestId } = validateSignerRequest(input.request);
  await matchPeer(input.peer, input.expectedPeer, input.hashExecutable ?? hashExecutableFile);
  let recorded: unknown;
  try {
    recorded = await input.loadRecordedAuthority(opaqueRequestId);
  } catch (error) {
    refuse("authority_load_unavailable", error instanceof Error ? error.message : String(error));
  }
  if (recorded === null || recorded === undefined) refuse("opaque_request_not_found");
  const authority = parseRecordedAuthority(recorded);
  if (authority.opaqueRequestId !== opaqueRequestId) refuse("opaque_request_mismatch");
  const issuedAtMs = Date.parse(authority.issuedAt);
  const expiresAtMs = Date.parse(authority.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    refuse("authority_time_invalid");
  }
  if (expiresAtMs - issuedAtMs > input.policy.maxLifetimeSeconds * 1000) refuse("lifetime_exceeds_policy");
  if (expiresAtMs - issuedAtMs > NATIVE_SSH_MAX_AUTHORITY_LIFETIME_MS) refuse("lifetime_exceeds_maximum");
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs) || issuedAtMs > nowMs || expiresAtMs <= nowMs) refuse("time_window_invalid");
  if (input.permitAuthority) {
    let permitted = false;
    try {
      permitted = await input.permitAuthority(authority);
    } catch {
      permitted = false;
    }
    if (!permitted) refuse("authority_policy_refused");
  }
  const unsigned = {
    version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
    audience: NATIVE_SSH_ENVELOPE_AUDIENCE,
    authority,
  };
  // A wrong key type would mint an envelope the Ed25519 trust root can never
  // accept; fail closed here with a clear reason instead of signing anyway.
  if (input.privateKey?.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") {
    refuse("envelope_signing_failed", "signing key is not a private Ed25519 key");
  }
  let signature: string;
  try {
    signature = cryptoSign(null, Buffer.from(nativeSshEnvelopeSigningPayload(unsigned), "utf8"), input.privateKey).toString(
      "base64",
    );
  } catch (error) {
    refuse("envelope_signing_failed", error instanceof Error ? error.message : String(error));
  }
  const envelope: NativeSshSignedEnvelope = { ...unsigned, signature };
  try {
    await input.ledger.recordIssue(opaqueRequestId, sha256CanonicalJson(envelope));
  } catch (error) {
    if (error instanceof NativeSshSignerRefusal) throw error;
    refuse("ledger_unavailable", error instanceof Error ? error.message : String(error));
  }
  return envelope;
}

export interface NativeSshSignerDaemonConfig {
  readonly socketPath: string;
  readonly socketMode?: number;
  readonly expectedPeer: NativeSshSignerExpectedPeer;
  readonly policy: NativeSshSignerDaemonPolicy;
  readonly privateKey: string | KeyObject;
  readonly loadRecordedAuthority: NativeSshRecordedAuthorityLoader;
  readonly peerResolver: NativeSshSignerPeerResolver;
  readonly ledger?: NativeSshIssueLedger;
  readonly hashExecutable?: NativeSshExecutableHasher;
  readonly permitAuthority?: (authority: NativeSshLaunchAuthority) => boolean | Promise<boolean>;
  readonly now?: () => Date;
  readonly readTimeoutMs?: number;
  readonly backlog?: number;
  /** Observability hook for refusals; the wire still carries only the closed reason vocabulary. */
  readonly onRefusal?: (info: {
    reason: NativeSshSignerRefusalReason;
    detail: string;
    opaqueRequestId: string | null;
  }) => void;
}

export interface NativeSshSignerDaemon {
  readonly socketPath: string;
  listen(): Promise<string>;
  close(): Promise<void>;
}

function configError(message: string): Error {
  return new Error(`Native SSH signer daemon misconfigured: ${message}`);
}

function assertExpectedPeer(expected: NativeSshSignerExpectedPeer): void {
  if (
    !expected ||
    !Number.isInteger(expected.uid) ||
    expected.uid < 0 ||
    !Number.isInteger(expected.gid) ||
    expected.gid < 0
  ) {
    throw configError("expectedPeer requires non-negative integer uid and gid");
  }
  if (typeof expected.executable !== "string" || !expected.executable.startsWith("/")) {
    throw configError("expectedPeer requires an absolute executable path");
  }
  if (typeof expected.executableSha256 !== "string" || !SHA256_RE.test(expected.executableSha256)) {
    throw configError("expectedPeer requires a sha256 executable digest");
  }
  if (typeof expected.cgroup !== "string" || !expected.cgroup.startsWith("/") || expected.cgroup.includes("..")) {
    throw configError("expectedPeer requires an absolute cgroup path without ..");
  }
}

function assertPolicy(policy: NativeSshSignerDaemonPolicy): void {
  if (policy?.audience !== NATIVE_SSH_ENVELOPE_AUDIENCE) {
    throw configError("policy.audience must be the native SSH envelope audience");
  }
  if (
    !Number.isInteger(policy.maxLifetimeSeconds) ||
    policy.maxLifetimeSeconds < 1 ||
    policy.maxLifetimeSeconds * 1000 > NATIVE_SSH_MAX_AUTHORITY_LIFETIME_MS
  ) {
    throw configError(
      `policy.maxLifetimeSeconds must be an integer from 1 to ${NATIVE_SSH_MAX_AUTHORITY_LIFETIME_MS / 1000}`,
    );
  }
}

function normalizePrivateKey(privateKey: string | KeyObject): KeyObject {
  let key: KeyObject;
  try {
    key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  } catch (error) {
    throw configError(`privateKey is not a usable private key (${error instanceof Error ? error.message : String(error)})`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw configError("privateKey must be an Ed25519 key");
  return key;
}

/**
 * Creates the reference daemon. Validates all configuration eagerly and
 * throws a plain `Error` for operator config faults (fail fast, before
 * binding). Per-request violations are `NativeSshSignerRefusal`s that become
 * `{ ok: false }` responses; the daemon never crashes on peer input.
 */
export function createNativeSshSignerDaemon(config: NativeSshSignerDaemonConfig): NativeSshSignerDaemon {
  if (typeof config?.socketPath !== "string" || config.socketPath.length === 0) {
    throw configError("socketPath must be a non-empty path");
  }
  const socketMode = config.socketMode ?? DEFAULT_SOCKET_MODE;
  if (!Number.isInteger(socketMode) || socketMode < 0 || socketMode > 0o777) {
    throw configError("socketMode must be an integer between 0 and 0o777");
  }
  assertExpectedPeer(config.expectedPeer);
  assertPolicy(config.policy);
  const privateKey = normalizePrivateKey(config.privateKey);
  if (typeof config.loadRecordedAuthority !== "function") throw configError("loadRecordedAuthority is required");
  if (typeof config.peerResolver !== "function") throw configError("peerResolver is required");
  const readTimeoutMs = config.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs <= 0) {
    throw configError("readTimeoutMs must be a positive number of milliseconds");
  }
  const backlog = config.backlog ?? DEFAULT_BACKLOG;
  if (!Number.isSafeInteger(backlog) || backlog <= 0) throw configError("backlog must be a positive integer");

  const ledger = config.ledger ?? createMemoryNativeSshIssueLedger();
  const hashExecutable = config.hashExecutable ?? hashExecutableFile;
  const now = config.now ?? (() => new Date());
  const onRefusal = config.onRefusal;
  let server: Server | null = null;
  const connections = new Set<Socket>();

  function respond(socket: Socket, response: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve) => {
      socket.end(encodeNativeSshSignerFrame(Buffer.from(JSON.stringify(response), "utf8")), () => resolve());
      socket.once("error", () => resolve());
    });
  }

  async function handleConnection(socket: Socket): Promise<void> {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    let parsedRequest: unknown = null;
    try {
      const body = await readNativeSshSignerFrame(socket, { timeoutMs: readTimeoutMs, what: "a signer request" });
      try {
        parsedRequest = JSON.parse(body.toString("utf8"));
      } catch {
        throw new NativeSshSignerRefusal("request_json_invalid");
      }
      let peer: NativeSshSignerPeerIdentity | null;
      try {
        peer = await config.peerResolver(socket);
      } catch {
        peer = null;
      }
      const envelope = await issueNativeSshEnvelope({
        request: parsedRequest,
        peer,
        expectedPeer: config.expectedPeer,
        policy: config.policy,
        loadRecordedAuthority: config.loadRecordedAuthority,
        ledger,
        privateKey,
        now: now(),
        hashExecutable,
        permitAuthority: config.permitAuthority,
      });
      await respond(socket, { ok: true, envelope });
    } catch (error) {
      if (socket.destroyed) return;
      const refusal =
        error instanceof NativeSshSignerRefusal
          ? error
          : error instanceof Error && error.name === "NativeSshAuthorityError"
            ? new NativeSshSignerRefusal("request_frame_invalid", error.message)
            : new NativeSshSignerRefusal("request_frame_invalid", "unreadable request");
      const opaqueRequestId =
        typeof parsedRequest === "object" && parsedRequest !== null
          ? ((parsedRequest as Record<string, unknown>).opaqueRequestId as string | undefined) ?? null
          : null;
      onRefusal?.({ reason: refusal.reason, detail: refusal.message, opaqueRequestId });
      await respond(socket, {
        ok: false,
        reason: refusal.reason,
        requestDigest: sha256CanonicalJson(parsedRequest),
      });
    } finally {
      socket.destroy();
    }
  }

  return {
    socketPath: config.socketPath,
    async listen(): Promise<string> {
      if (server) return config.socketPath;
      await mkdir(dirname(config.socketPath), { recursive: true });
      try {
        await unlink(config.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
      const listener = createServer((socket) => {
        void handleConnection(socket).catch(() => socket.destroy());
      });
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(config.socketPath, backlog, () => {
          listener.off("error", reject);
          // Post-bind server errors are unexpected; per-connection failures
          // are all handled on their socket, so this only avoids a throw.
          listener.on("error", () => {});
          resolve();
        });
      });
      await chmod(config.socketPath, socketMode);
      server = listener;
      return config.socketPath;
    },
    async close(): Promise<void> {
      for (const socket of connections) socket.destroy();
      connections.clear();
      if (server) {
        const closing = server;
        server = null;
        await new Promise<void>((resolve) => closing.close(() => resolve()));
      }
      try {
        await unlink(config.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
    },
  };
}
