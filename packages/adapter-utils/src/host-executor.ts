import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createPublicKey, randomUUID, verify as cryptoVerify } from "node:crypto";

export const NATIVE_SSH_SIGNER_REQUEST_VERSION = "1" as const;
export const NATIVE_SSH_ENVELOPE_AUDIENCE = "paperclip-native-ssh" as const;
export const NATIVE_SSH_MAX_AUTHORITY_LIFETIME_MS = 60_000;
export const NATIVE_SSH_SIGNER_TIMEOUT_MS = 10_000;
/** Server environment switch. Unset, empty or `off`: SSH launches need an authority only when an executor is bound. */
export const NATIVE_SSH_AUTHORITY_ENV = "PAPERCLIP_NATIVE_SSH_AUTHORITY";

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SIGNER_REQUEST_KEYS = new Set(["version", "opaqueRequestId"]);

export type NativeSshAuthorityErrorCode =
  | "native_ssh_authority_invalid"
  | "native_ssh_authority_required"
  | "native_ssh_authority_mismatch"
  | "native_ssh_authority_expired"
  | "native_ssh_authority_replayed"
  | "native_ssh_signer_request_invalid"
  | "native_ssh_signer_unavailable"
  | "native_ssh_ledger_unavailable"
  | "native_ssh_signer_envelope_invalid"
  | "native_ssh_signature_invalid";

export class NativeSshAuthorityError extends Error {
  readonly code: NativeSshAuthorityErrorCode;

  constructor(code: NativeSshAuthorityErrorCode, message: string) {
    super(message);
    this.name = "NativeSshAuthorityError";
    this.code = code;
  }
}

export interface NativeSshSignerRequest {
  readonly version: typeof NATIVE_SSH_SIGNER_REQUEST_VERSION;
  readonly opaqueRequestId: string;
}

export interface NativeSshSignerTransport {
  requestEnvelope(request: NativeSshSignerRequest): Promise<unknown>;
}

export interface NativeSshRemoteTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly remoteCwd: string;
}

export interface NativeSshLaunchAuthority {
  readonly version: typeof NATIVE_SSH_SIGNER_REQUEST_VERSION;
  readonly opaqueRequestId: string;
  readonly runId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly issueId: string;
  readonly adapterType: string;
  readonly assignedModel: {
    readonly version: "1";
    readonly model: string;
    readonly sha256: string;
  };
  readonly command: string;
  readonly args: readonly string[];
  readonly remote: NativeSshRemoteTarget;
  readonly argvSha256: string;
  /** Sorted names of the launch environment, so a signer can judge what is set. */
  readonly envKeys: readonly string[];
  /** Digest of the exact launch environment; the values themselves never leave the server. */
  readonly envSha256: string;
  readonly launchSpecSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface NativeSshSignedEnvelope {
  readonly version: typeof NATIVE_SSH_SIGNER_REQUEST_VERSION;
  readonly audience: typeof NATIVE_SSH_ENVELOPE_AUDIENCE;
  readonly authority: NativeSshLaunchAuthority;
  readonly signature: string;
}

export interface NativeSshLaunchInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly remote: NativeSshRemoteTarget;
  /** The environment the remote command starts with. PATH or NODE_OPTIONS can change what runs. */
  readonly env: Readonly<Record<string, string>>;
}

/** Decides whether the signer's signature over the envelope is genuine. Never trusts the transport. */
export type NativeSshEnvelopeVerifier = (envelope: NativeSshSignedEnvelope) => boolean | Promise<boolean>;

export interface NativeSshHostExecutorTarget {
  readonly kind: "native_ssh";
  /** Issues one single-use, signer-verified authorization for exactly this launch. */
  authorizeLaunch(input: NativeSshLaunchInput): Promise<NativeSshSignedEnvelope>;
}

export interface CreateNativeSshHostExecutorTargetInput {
  readonly runId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly issueId: string;
  readonly adapterType: string;
  readonly assignedModel: {
    readonly version: "1";
    readonly model: string;
    readonly sha256: string;
  };
  readonly signer: NativeSshSignerTransport | null | undefined;
  readonly verifyEnvelope: NativeSshEnvelopeVerifier | null | undefined;
  readonly persistAuthority: (authority: NativeSshLaunchAuthority) => Promise<void>;
  readonly persistEnvelope?: (input: {
    authority: NativeSshLaunchAuthority;
    envelopeSha256: string;
  }) => Promise<void>;
  /** Server-created opaque id per launch. Defaults to a random UUID. */
  readonly nextOpaqueRequestId?: () => string;
  readonly now?: () => Date;
  readonly maxLifetimeMs?: number;
  /** How long to wait for the signer before refusing the launch. */
  readonly signerTimeoutMs?: number;
}

/**
 * True unless the server environment leaves native SSH authority off. An
 * unrecognized value enforces, so a typo cannot silently disable the check.
 */
export function isNativeSshAuthorityRequired(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[NATIVE_SSH_AUTHORITY_ENV]?.trim().toLowerCase() ?? "";
  return value !== "" && value !== "off";
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** The exact bytes the signer signs: everything in the envelope except the signature. */
export function nativeSshEnvelopeSigningPayload(
  envelope: Pick<NativeSshSignedEnvelope, "version" | "audience" | "authority">,
): string {
  return stableJson({
    version: envelope.version,
    audience: envelope.audience,
    authority: envelope.authority,
  });
}

/** Verifier for a root-owned signer that signs the payload with an Ed25519 key (base64 signature). */
export function createEd25519NativeSshEnvelopeVerifier(publicKeyPem: string): NativeSshEnvelopeVerifier {
  const publicKey = createPublicKey(publicKeyPem);
  return (envelope) => {
    try {
      return cryptoVerify(
        null,
        Buffer.from(nativeSshEnvelopeSigningPayload(envelope)),
        publicKey,
        Buffer.from(envelope.signature, "base64"),
      );
    } catch {
      return false;
    }
  };
}

function assertLaunchInput(input: NativeSshLaunchInput): void {
  if (
    !readNonEmptyString(input?.command) ||
    !Array.isArray(input.args) ||
    input.args.some((arg) => typeof arg !== "string") ||
    !readNonEmptyString(input.remote?.host) ||
    !Number.isInteger(input.remote.port) ||
    input.remote.port < 1 ||
    input.remote.port > 65_535 ||
    !readNonEmptyString(input.remote.username) ||
    !readNonEmptyString(input.remote.remoteCwd) ||
    !readRecord(input.env) ||
    Object.values(input.env).some((value) => typeof value !== "string")
  ) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH launch requires a complete server-derived command and remote target",
    );
  }
}

function assertOpaqueRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new NativeSshAuthorityError(
      "native_ssh_signer_request_invalid",
      "Native SSH signer request requires a server-created opaque UUID",
    );
  }
}

function assertAuthoritySeed(seed: CreateNativeSshHostExecutorTargetInput): void {
  for (const [field, value] of [
    ["runId", seed.runId],
    ["companyId", seed.companyId],
    ["agentId", seed.agentId],
    ["issueId", seed.issueId],
  ] as const) {
    if (typeof value !== "string" || !UUID_RE.test(value)) {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_invalid",
        `Native SSH authority requires server-derived ${field}`,
      );
    }
  }
  if (!readNonEmptyString(seed.adapterType) || !readNonEmptyString(seed.assignedModel?.model)) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH authority requires a server-derived adapter type and assigned model",
    );
  }
  if (seed.assignedModel.version !== "1" || !SHA256_RE.test(seed.assignedModel.sha256)) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH authority requires valid assigned-model metadata",
    );
  }
}

function parseSignerRequest(value: unknown): NativeSshSignerRequest {
  const record = readRecord(value);
  if (!record) {
    throw new NativeSshAuthorityError(
      "native_ssh_signer_request_invalid",
      "Native SSH signer request must be an object",
    );
  }
  const keys = Object.keys(record);
  if (keys.length !== SIGNER_REQUEST_KEYS.size || keys.some((key) => !SIGNER_REQUEST_KEYS.has(key))) {
    throw new NativeSshAuthorityError(
      "native_ssh_signer_request_invalid",
      "Native SSH signer accepts only version and opaqueRequestId",
    );
  }
  if (record.version !== NATIVE_SSH_SIGNER_REQUEST_VERSION) {
    throw new NativeSshAuthorityError(
      "native_ssh_signer_request_invalid",
      "Unsupported Native SSH signer request version",
    );
  }
  assertOpaqueRequestId(record.opaqueRequestId);
  return { version: NATIVE_SSH_SIGNER_REQUEST_VERSION, opaqueRequestId: record.opaqueRequestId };
}

/** Signer client: the only thing a caller may say is "sign the authority you already hold for this id". */
export async function requestNativeSshSignerEnvelope(
  signer: NativeSshSignerTransport | null | undefined,
  request: unknown,
): Promise<unknown> {
  if (!signer || typeof signer.requestEnvelope !== "function") {
    throw new NativeSshAuthorityError(
      "native_ssh_signer_unavailable",
      "Native SSH signer transport is unavailable",
    );
  }
  return signer.requestEnvelope(parseSignerRequest(request));
}

function parseAuthority(value: unknown): NativeSshLaunchAuthority | null {
  const authority = readRecord(value);
  const assignedModel = readRecord(authority?.assignedModel);
  const remote = readRecord(authority?.remote);
  if (
    authority?.version !== NATIVE_SSH_SIGNER_REQUEST_VERSION ||
    typeof authority.opaqueRequestId !== "string" ||
    typeof authority.runId !== "string" ||
    typeof authority.companyId !== "string" ||
    typeof authority.agentId !== "string" ||
    typeof authority.issueId !== "string" ||
    typeof authority.adapterType !== "string" ||
    assignedModel?.version !== "1" ||
    typeof assignedModel.model !== "string" ||
    typeof assignedModel.sha256 !== "string" ||
    typeof authority.command !== "string" ||
    !Array.isArray(authority.args) ||
    authority.args.some((arg) => typeof arg !== "string") ||
    typeof remote?.host !== "string" ||
    typeof remote.port !== "number" ||
    !Number.isInteger(remote.port) ||
    typeof remote.username !== "string" ||
    typeof remote.remoteCwd !== "string" ||
    typeof authority.argvSha256 !== "string" ||
    !Array.isArray(authority.envKeys) ||
    authority.envKeys.some((key) => typeof key !== "string") ||
    typeof authority.envSha256 !== "string" ||
    typeof authority.launchSpecSha256 !== "string" ||
    typeof authority.issuedAt !== "string" ||
    typeof authority.expiresAt !== "string"
  ) {
    return null;
  }
  return authority as unknown as NativeSshLaunchAuthority;
}

function parseEnvelope(value: unknown): NativeSshSignedEnvelope {
  const envelope = readRecord(value);
  const authority = parseAuthority(envelope?.authority);
  if (
    envelope?.version !== NATIVE_SSH_SIGNER_REQUEST_VERSION ||
    envelope.audience !== NATIVE_SSH_ENVELOPE_AUDIENCE ||
    !authority ||
    !readNonEmptyString(envelope.signature)
  ) {
    throw new NativeSshAuthorityError(
      "native_ssh_signer_envelope_invalid",
      "Native SSH signer returned an invalid envelope",
    );
  }
  return {
    version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
    audience: NATIVE_SSH_ENVELOPE_AUDIENCE,
    authority,
    signature: envelope.signature as string,
  };
}

function buildAuthority(
  seed: CreateNativeSshHostExecutorTargetInput,
  opaqueRequestId: string,
  input: NativeSshLaunchInput,
  issuedAt: Date,
  expiresAt: Date,
): NativeSshLaunchAuthority {
  const withoutLaunchDigest = {
    version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
    opaqueRequestId,
    runId: seed.runId,
    companyId: seed.companyId,
    agentId: seed.agentId,
    issueId: seed.issueId,
    adapterType: seed.adapterType,
    assignedModel: { ...seed.assignedModel },
    command: input.command,
    args: [...input.args],
    remote: {
      host: input.remote.host,
      port: input.remote.port,
      username: input.remote.username,
      remoteCwd: input.remote.remoteCwd,
    },
    argvSha256: sha256CanonicalJson({ command: input.command, args: [...input.args] }),
    envKeys: Object.keys(input.env).sort(),
    envSha256: sha256CanonicalJson(input.env),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  return { ...withoutLaunchDigest, launchSpecSha256: sha256CanonicalJson(withoutLaunchDigest) };
}

function deepFreezeEnvelope(envelope: NativeSshSignedEnvelope): NativeSshSignedEnvelope {
  const { authority } = envelope;
  Object.freeze(authority.args);
  Object.freeze(authority.envKeys);
  Object.freeze(authority.remote);
  Object.freeze(authority.assignedModel);
  Object.freeze(authority);
  return Object.freeze(envelope);
}

// Proofs are identity-checked: only an envelope this module minted after verifying
// signature, authority equality and lifetime is ever a member. A structurally valid
// object literal (or a JSON round trip) can never impersonate one.
const issuedProofs = new WeakSet<object>();
const consumedProofs = new WeakSet<object>();

function isExpired(authority: NativeSshLaunchAuthority, now: Date): boolean {
  const expiresAt = Date.parse(authority.expiresAt);
  return !Number.isFinite(expiresAt) || now.getTime() >= expiresAt;
}

/**
 * The last gate before any SSH argv, key material or child exists. Requires an
 * executor-issued, unexpired, unconsumed proof for exactly this launch. With
 * `consume`, the proof is spent so it can authorize one launch only.
 */
export function assertNativeSshLaunchAuthority(
  envelope: NativeSshSignedEnvelope | null | undefined,
  launch: NativeSshLaunchInput,
  options: { now?: () => Date; consume?: boolean } = {},
): void {
  if (!envelope || typeof envelope !== "object" || !issuedProofs.has(envelope)) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_required",
      "Native SSH launch requires an executor-issued signed authority",
    );
  }
  if (consumedProofs.has(envelope)) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_replayed",
      "Native SSH authority was already used for a launch",
    );
  }
  const { authority } = envelope;
  if (isExpired(authority, options.now?.() ?? new Date())) {
    throw new NativeSshAuthorityError("native_ssh_authority_expired", "Native SSH authority has expired");
  }
  if (
    authority.command !== launch.command ||
    stableJson(authority.args) !== stableJson(launch.args) ||
    authority.argvSha256 !== sha256CanonicalJson({ command: launch.command, args: [...launch.args] }) ||
    !readRecord(launch.env) ||
    stableJson(authority.envKeys) !== stableJson(Object.keys(launch.env).sort()) ||
    authority.envSha256 !== sha256CanonicalJson(launch.env) ||
    authority.remote.host !== launch.remote.host ||
    authority.remote.port !== launch.remote.port ||
    authority.remote.username !== launch.remote.username ||
    authority.remote.remoteCwd !== launch.remote.remoteCwd
  ) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_mismatch",
      "Native SSH launch does not match the signed authority",
    );
  }
  if (options.consume) consumedProofs.add(envelope);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A ledger write that fails refuses the launch with a code callers can tell apart from config errors. */
async function recordInLedger(what: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    throw new NativeSshAuthorityError(
      "native_ssh_ledger_unavailable",
      `Native SSH ${what} could not be recorded: ${errorMessage(error)}`,
    );
  }
}

/** Bounded signer round trip; a transport failure or silence is "signer unavailable". */
async function askSigner(
  signer: NativeSshSignerTransport | null | undefined,
  request: NativeSshSignerRequest,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new NativeSshAuthorityError(
            "native_ssh_signer_unavailable",
            `Native SSH signer did not answer within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([requestNativeSshSignerEnvelope(signer, request), timeout]);
  } catch (error) {
    if (error instanceof NativeSshAuthorityError) throw error;
    throw new NativeSshAuthorityError(
      "native_ssh_signer_unavailable",
      `Native SSH signer request failed: ${errorMessage(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function createNativeSshHostExecutorTarget(
  input: CreateNativeSshHostExecutorTargetInput,
): NativeSshHostExecutorTarget {
  assertAuthoritySeed(input);
  const maxLifetimeMs = input.maxLifetimeMs ?? NATIVE_SSH_MAX_AUTHORITY_LIFETIME_MS;
  if (
    !Number.isSafeInteger(maxLifetimeMs) ||
    maxLifetimeMs <= 0 ||
    maxLifetimeMs > NATIVE_SSH_MAX_AUTHORITY_LIFETIME_MS
  ) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      `Native SSH authority lifetime must be between 1 and ${NATIVE_SSH_MAX_AUTHORITY_LIFETIME_MS}ms`,
    );
  }
  if (input.signerTimeoutMs !== undefined && (!Number.isSafeInteger(input.signerTimeoutMs) || input.signerTimeoutMs <= 0)) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH signer timeout must be a positive number of milliseconds",
    );
  }
  const signerTimeoutMs = input.signerTimeoutMs ?? NATIVE_SSH_SIGNER_TIMEOUT_MS;
  const now = input.now ?? (() => new Date());
  const nextOpaqueRequestId = input.nextOpaqueRequestId ?? (() => randomUUID());
  const usedRequestIds = new Set<string>();
  // One authority slot per run ledger: concurrent launches must not interleave
  // persist -> sign -> digest, or the second persist overwrites the first before
  // the signer reads it. A failure never blocks later launches.
  let authorizeTail: Promise<unknown> = Promise.resolve();

  async function authorizeLaunchInner(launchInput: NativeSshLaunchInput): Promise<NativeSshSignedEnvelope> {
    assertLaunchInput(launchInput);
    // Fail before any ledger write or signer round trip when trust roots are missing.
    if (!input.signer || typeof input.signer.requestEnvelope !== "function") {
      throw new NativeSshAuthorityError(
        "native_ssh_signer_unavailable",
        "Native SSH signer transport is unavailable",
      );
    }
    if (typeof input.verifyEnvelope !== "function") {
      throw new NativeSshAuthorityError(
        "native_ssh_signer_unavailable",
        "Native SSH signer verification key is unavailable",
      );
    }
    const opaqueRequestId = nextOpaqueRequestId();
    assertOpaqueRequestId(opaqueRequestId);
    if (usedRequestIds.has(opaqueRequestId)) {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_replayed",
        "Native SSH opaque request id was already used",
      );
    }
    usedRequestIds.add(opaqueRequestId);

    const issuedAt = now();
    if (Number.isNaN(issuedAt.getTime())) {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_invalid",
        "Native SSH authority clock returned an invalid time",
      );
    }
    const authority = buildAuthority(
      input,
      opaqueRequestId,
      launchInput,
      issuedAt,
      new Date(issuedAt.getTime() + maxLifetimeMs),
    );
    await recordInLedger("authority", () => input.persistAuthority(authority));
    const envelope = parseEnvelope(
      await askSigner(input.signer, { version: NATIVE_SSH_SIGNER_REQUEST_VERSION, opaqueRequestId }, signerTimeoutMs),
    );
    if (!(await input.verifyEnvelope(envelope))) {
      throw new NativeSshAuthorityError(
        "native_ssh_signature_invalid",
        "Native SSH signer envelope signature is not valid",
      );
    }
    if (stableJson(envelope.authority) !== stableJson(authority)) {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_mismatch",
        "Native SSH signer envelope does not match server-derived launch authority",
      );
    }
    if (isExpired(envelope.authority, now())) {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_expired",
        "Native SSH authority expired before the launch",
      );
    }
    await recordInLedger("envelope digest", async () =>
      input.persistEnvelope?.({ authority, envelopeSha256: sha256CanonicalJson(envelope) }),
    );
    const proof = deepFreezeEnvelope(envelope);
    issuedProofs.add(proof);
    return proof;
  }

  return Object.freeze({
    kind: "native_ssh" as const,
    authorizeLaunch(launchInput: NativeSshLaunchInput) {
      const run = authorizeTail.then(() => authorizeLaunchInner(launchInput));
      authorizeTail = run.catch(() => {});
      return run;
    },
  });
}

const activeHostExecutor = new AsyncLocalStorage<NativeSshHostExecutorTarget>();

/** Binds the server-created executor to everything the run launches, without adapters forwarding it. */
export function runWithNativeSshHostExecutor<T>(
  target: NativeSshHostExecutorTarget,
  fn: () => T,
): T {
  return activeHostExecutor.run(target, fn);
}

export function getActiveNativeSshHostExecutor(): NativeSshHostExecutorTarget | null {
  return activeHostExecutor.getStore() ?? null;
}
