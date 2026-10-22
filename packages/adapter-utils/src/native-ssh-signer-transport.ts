import { connect, type Socket } from "node:net";

import {
  NATIVE_SSH_SIGNER_REQUEST_VERSION,
  NativeSshAuthorityError,
  type NativeSshSignerRequest,
  type NativeSshSignerTransport,
} from "./host-executor.js";

/**
 * Framed client for the reference native SSH signer daemon
 * (`server/src/services/native-ssh-signer-daemon.ts`).
 *
 * Wire protocol v1: one request per AF_UNIX connection, each message a u32be
 * length prefix followed by UTF-8 JSON. The client sends exactly
 * `{ "version": "1", "opaqueRequestId": "<uuid>" }` and reads one response
 * frame: `{ "ok": true, "envelope": <unknown> }` or
 * `{ "ok": false, "reason": "<code>", "requestDigest": "<sha256>" }`.
 *
 * Every transport failure (connect refused or timed out, write failure, read
 * timeout, oversize frame, invalid JSON, daemon refusal) is
 * `native_ssh_signer_unavailable`, so the executor refuses the launch. The
 * returned envelope is passed through as `unknown`: the executor's own
 * `parseEnvelope` still classifies a malformed envelope as
 * `native_ssh_signer_envelope_invalid`, and the configured verifier still
 * checks the signature. The transport never trusts the daemon.
 *
 * Concurrency: each `requestEnvelope` call opens its own connection, so
 * concurrent launches from different runs cannot interleave frames. There is
 * no shared connection and no cross-request mutex; the executor already
 * serializes launches within one run.
 *
 * Configuration is explicit arguments only. This module reads no environment
 * variable: a deployment cannot be re-pointed at a rogue socket by ambient
 * name (see the self-disable pins in the test file).
 */

/** Largest single frame accepted in either direction (requests are ~100 bytes; envelopes a few KiB). */
export const NATIVE_SSH_SIGNER_TRANSPORT_MAX_FRAME_BYTES = 64 * 1024;
/** Default budget to establish the daemon connection. Well under the executor's 10s signer wait. */
export const NATIVE_SSH_SIGNER_TRANSPORT_DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
/** Default budget to read the daemon's response frame once connected. */
export const NATIVE_SSH_SIGNER_TRANSPORT_DEFAULT_READ_TIMEOUT_MS = 8_000;

const FRAME_HEADER_BYTES = 4;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SIGNER_REQUEST_KEYS = new Set(["version", "opaqueRequestId"]);
const MAX_REASON_CHARS = 128;

export interface UnixSocketNativeSshSignerTransportOptions {
  /** Budget to establish the daemon connection. Defaults to 2000ms. */
  readonly connectTimeoutMs?: number;
  /** Budget to read the daemon's response frame once connected. Defaults to 8000ms. */
  readonly readTimeoutMs?: number;
}

function unavailable(message: string): NativeSshAuthorityError {
  return new NativeSshAuthorityError("native_ssh_signer_unavailable", message);
}

/**
 * Strict client-side request check. The executor already validates before it
 * calls a transport, but the transport is a public seam: anyone holding one
 * may speak only the closed request grammar. Mirrors the seam's
 * `parseSignerRequest` code so both layers classify identically.
 */
function assertSignerRequest(request: unknown): NativeSshSignerRequest {
  const record =
    request !== null && typeof request === "object" && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : null;
  const keys = record ? Object.keys(record) : [];
  if (!record || keys.length !== SIGNER_REQUEST_KEYS.size || keys.some((key) => !SIGNER_REQUEST_KEYS.has(key))) {
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
  if (typeof record.opaqueRequestId !== "string" || !UUID_RE.test(record.opaqueRequestId)) {
    throw new NativeSshAuthorityError(
      "native_ssh_signer_request_invalid",
      "Native SSH signer request requires a server-created opaque UUID",
    );
  }
  return { version: NATIVE_SSH_SIGNER_REQUEST_VERSION, opaqueRequestId: record.opaqueRequestId };
}

/** Encodes one length-prefixed frame. Shared with the daemon so both sides agree byte for byte. */
export function encodeNativeSshSignerFrame(payload: Buffer): Buffer {
  if (payload.length === 0 || payload.length > NATIVE_SSH_SIGNER_TRANSPORT_MAX_FRAME_BYTES) {
    throw unavailable(
      `Native SSH signer frame must be between 1 and ${NATIVE_SSH_SIGNER_TRANSPORT_MAX_FRAME_BYTES} bytes`,
    );
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Reads one length-prefixed frame. Shared with the daemon. A single data
 * listener accumulates header and body together, because both usually arrive
 * in one chunk; splitting the read would discard already-received body bytes.
 * A declared length of zero or above the cap refuses the round trip without
 * waiting for the body. The timeout budgets the whole frame.
 */
export function readNativeSshSignerFrame(
  socket: Socket,
  options: { timeoutMs: number; what?: string },
): Promise<Buffer> {
  const what = options.what ?? "a response frame";
  return new Promise<Buffer>((resolve, reject) => {
    let received = Buffer.alloc(0);
    let frameLength = -1;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(unavailable(`Native SSH signer did not send ${what} within ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (frameLength < 0 && received.length >= FRAME_HEADER_BYTES) {
        frameLength = received.readUInt32BE(0);
        if (frameLength === 0 || frameLength > NATIVE_SSH_SIGNER_TRANSPORT_MAX_FRAME_BYTES) {
          fail(
            unavailable(
              `Native SSH signer sent an invalid frame length for ${what} (must be between 1 and ${NATIVE_SSH_SIGNER_TRANSPORT_MAX_FRAME_BYTES} bytes)`,
            ),
          );
          return;
        }
      }
      if (frameLength > 0 && received.length >= FRAME_HEADER_BYTES + frameLength) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(received.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + frameLength));
      }
    };
    const onError = (error: Error) => fail(unavailable(`Native SSH signer connection failed: ${error.message}`));
    const onClose = () =>
      fail(unavailable(`Native SSH signer closed the connection before sending ${what}`));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const socket = connect(socketPath);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(unavailable(`Native SSH signer did not accept a connection within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(unavailable(`Native SSH signer connection failed: ${error.message}`));
    });
  });
}

function writeFrame(socket: Socket, frame: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(frame, (error) => {
      if (error) reject(unavailable(`Native SSH signer write failed: ${error.message}`));
      else resolve();
    });
  });
}

function parseDaemonResponse(body: Buffer): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw unavailable("Native SSH signer response is not valid JSON");
  }
  const record =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (!record || typeof record.ok !== "boolean") {
    throw unavailable("Native SSH signer response has no boolean ok verdict");
  }
  if (record.ok) {
    if (!("envelope" in record)) {
      throw unavailable("Native SSH signer response is missing its envelope");
    }
    return record.envelope;
  }
  if (typeof record.reason !== "string" || record.reason.length === 0) {
    throw unavailable("Native SSH signer refused the request without a reason");
  }
  const reason =
    record.reason.length > MAX_REASON_CHARS ? `${record.reason.slice(0, MAX_REASON_CHARS)}…` : record.reason;
  throw unavailable(`Native SSH signer refused the request (${reason})`);
}

/**
 * Creates the executor's signer client over an AF_UNIX socket. The socket
 * path and timeouts are explicit arguments; nothing is read from the
 * environment, and a null transport (no signer configured) keeps the current
 * fail-closed behavior untouched.
 */
export function createUnixSocketNativeSshSignerTransport(
  socketPath: string,
  options: UnixSocketNativeSshSignerTransportOptions = {},
): NativeSshSignerTransport {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH signer transport requires an explicit socket path",
    );
  }
  const connectTimeoutMs =
    options.connectTimeoutMs ?? NATIVE_SSH_SIGNER_TRANSPORT_DEFAULT_CONNECT_TIMEOUT_MS;
  const readTimeoutMs = options.readTimeoutMs ?? NATIVE_SSH_SIGNER_TRANSPORT_DEFAULT_READ_TIMEOUT_MS;
  for (const [name, value] of [
    ["connectTimeoutMs", connectTimeoutMs],
    ["readTimeoutMs", readTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_invalid",
        `Native SSH signer transport ${name} must be a positive number of milliseconds`,
      );
    }
  }
  return {
    async requestEnvelope(request: NativeSshSignerRequest): Promise<unknown> {
      const validated = assertSignerRequest(request);
      const payload = Buffer.from(
        JSON.stringify({ version: validated.version, opaqueRequestId: validated.opaqueRequestId }),
        "utf8",
      );
      const socket = await connectSocket(socketPath, connectTimeoutMs);
      try {
        await writeFrame(socket, encodeNativeSshSignerFrame(payload));
        const body = await readNativeSshSignerFrame(socket, { timeoutMs: readTimeoutMs });
        return parseDaemonResponse(body);
      } finally {
        socket.destroy();
      }
    },
  };
}
