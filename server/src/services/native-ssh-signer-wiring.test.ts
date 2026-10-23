import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_SSH_ENVELOPE_AUDIENCE,
  nativeSshEnvelopeSigningPayload,
  NativeSshAuthorityError,
  type NativeSshEnvelopeVerifier,
  type NativeSshLaunchAuthority,
  type NativeSshSignedEnvelope,
  type NativeSshSignerTransport,
} from "@paperclipai/adapter-utils/host-executor";
import {
  encodeNativeSshSignerFrame,
  readNativeSshSignerFrame,
} from "@paperclipai/adapter-utils/native-ssh-signer-transport";
import { resolveNativeSshSignerPair } from "./native-ssh-authority.js";

const REQUEST_ID = "73efe034-f471-4a3c-a5f0-50187895d33a";
const REQUEST = { version: "1", opaqueRequestId: REQUEST_ID } as const;

const keys = generateKeyPairSync("ed25519");
const PUBLIC_PEM = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

let stubCounter = 0;
const openStubs: Array<() => Promise<void>> = [];

afterEach(async () => {
  const closers = openStubs.splice(0);
  for (const close of closers.reverse()) await close();
});

function cannedEnvelope(): NativeSshSignedEnvelope {
  // The verifier reads the authority opaquely (stable JSON), so a minimal
  // stand-in proves the wiring passes the key through; full envelope shape
  // is covered where authorities are built.
  const authority = { opaqueRequestId: REQUEST_ID } as unknown as NativeSshLaunchAuthority;
  const unsigned = { version: "1" as const, audience: NATIVE_SSH_ENVELOPE_AUDIENCE, authority };
  const signature = cryptoSign(null, Buffer.from(nativeSshEnvelopeSigningPayload(unsigned)), keys.privateKey);
  return { ...unsigned, signature: signature.toString("base64") };
}

async function startStubSigner(reply: unknown): Promise<{ socketPath: string; requests: unknown[] }> {
  const socketPath = join(tmpdir(), `native-ssh-wiring-${process.pid}-${stubCounter++}.sock`);
  await unlink(socketPath).catch(() => {});
  const requests: unknown[] = [];
  const server: Server = createServer((socket) => {
    void (async () => {
      try {
        const body = await readNativeSshSignerFrame(socket, { timeoutMs: 2_000 });
        requests.push(JSON.parse(body.toString("utf8")));
        socket.write(encodeNativeSshSignerFrame(Buffer.from(JSON.stringify(reply), "utf8")));
      } catch {
        // The transport under test owns the failure classification.
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  openStubs.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => {});
  });
  return { socketPath, requests };
}

describe("resolveNativeSshSignerPair", () => {
  it("leaves the seam dormant when nothing is configured", () => {
    expect(resolveNativeSshSignerPair({})).toEqual({ signer: undefined, verifyEnvelope: undefined });
    expect(
      resolveNativeSshSignerPair({ signer: null, verifyEnvelope: null, endpoint: null, publicKeyPem: null }),
    ).toEqual({ signer: undefined, verifyEnvelope: undefined });
  });

  it("passes an explicit pair through untouched", () => {
    const signer = { requestEnvelope: async () => ({}) } as NativeSshSignerTransport;
    const verifyEnvelope: NativeSshEnvelopeVerifier = () => true;
    const resolved = resolveNativeSshSignerPair({ signer, verifyEnvelope });
    expect(resolved.signer).toBe(signer);
    expect(resolved.verifyEnvelope).toBe(verifyEnvelope);
  });

  it("leaves a partial explicit pair alone: existing callers keep their behavior", () => {
    const signer = { requestEnvelope: async () => ({}) } as NativeSshSignerTransport;
    expect(resolveNativeSshSignerPair({ signer })).toEqual({ signer, verifyEnvelope: undefined });
  });

  it("refuses a half-set endpoint before any launch", () => {
    expect(() => resolveNativeSshSignerPair({ endpoint: "/run/signer.sock" })).toThrowError(
      expect.objectContaining({ code: "native_ssh_authority_invalid" }),
    );
    expect(() => resolveNativeSshSignerPair({ publicKeyPem: PUBLIC_PEM })).toThrowError(
      expect.objectContaining({ code: "native_ssh_authority_invalid" }),
    );
  });

  it("treats blank endpoint text as unset, not as a socket path", () => {
    expect(resolveNativeSshSignerPair({ endpoint: "  " })).toEqual({
      signer: undefined,
      verifyEnvelope: undefined,
    });
    expect(() => resolveNativeSshSignerPair({ endpoint: "  ", publicKeyPem: PUBLIC_PEM })).toThrowError(
      expect.objectContaining({ code: "native_ssh_authority_invalid" }),
    );
  });

  it("refuses an explicit pair mixed with endpoint config", () => {
    const signer = { requestEnvelope: async () => ({}) } as NativeSshSignerTransport;
    expect(() =>
      resolveNativeSshSignerPair({ signer, endpoint: "/run/signer.sock", publicKeyPem: PUBLIC_PEM }),
    ).toThrowError(expect.objectContaining({ code: "native_ssh_authority_invalid" }));
  });

  it("refuses an unusable public key with the seam's own error code", () => {
    expect(() =>
      resolveNativeSshSignerPair({ endpoint: "/run/signer.sock", publicKeyPem: "not-a-key" }),
    ).toThrowError(NativeSshAuthorityError);
    expect(() =>
      resolveNativeSshSignerPair({ endpoint: "/run/signer.sock", publicKeyPem: "not-a-key" }),
    ).toThrowError(expect.objectContaining({ code: "native_ssh_authority_invalid" }));
  });

  it("builds a transport that speaks framed v1 to the configured socket", async () => {
    const envelope = cannedEnvelope();
    const { socketPath, requests } = await startStubSigner({ ok: true, envelope });
    const resolved = resolveNativeSshSignerPair({ endpoint: socketPath, publicKeyPem: PUBLIC_PEM });
    expect(resolved.signer).toBeDefined();
    await expect(resolved.signer!.requestEnvelope({ ...REQUEST })).resolves.toEqual(envelope);
    expect(requests).toEqual([{ version: "1", opaqueRequestId: REQUEST_ID }]);
  });

  it("builds a verifier that accepts the configured key and nothing else", async () => {
    const { socketPath } = await startStubSigner({ ok: true, envelope: cannedEnvelope() });
    const resolved = resolveNativeSshSignerPair({ endpoint: socketPath, publicKeyPem: PUBLIC_PEM });
    const verify = resolved.verifyEnvelope!;
    const good = cannedEnvelope();
    expect(await verify(good)).toBe(true);
    expect(await verify({ ...good, signature: Buffer.alloc(64).toString("base64") })).toBe(false);
    const other = generateKeyPairSync("ed25519");
    const forged = cryptoSign(null, Buffer.from(nativeSshEnvelopeSigningPayload(good)), other.privateKey);
    expect(await verify({ ...good, signature: forged.toString("base64") })).toBe(false);
  });
});
