import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeSshAuthorityError } from "./host-executor.js";
import {
  createUnixSocketNativeSshSignerTransport,
  encodeNativeSshSignerFrame,
  NATIVE_SSH_SIGNER_TRANSPORT_MAX_FRAME_BYTES,
} from "./native-ssh-signer-transport.js";

const REQUEST_ID = "73efe034-f471-4a3c-a5f0-50187895d33a";
const REQUEST = { version: "1", opaqueRequestId: REQUEST_ID } as const;

let stubCounter = 0;
const openStubs: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (openStubs.length) await openStubs.pop()!();
});

function stubSocketPath(): string {
  return join(tmpdir(), `native-ssh-signer-stub-${process.pid}-${stubCounter++}.sock`);
}

function readFrameBody(socket: Socket): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let received = Buffer.alloc(0);
    let frameLength = -1;
    socket.on("data", function onData(chunk: Buffer) {
      received = Buffer.concat([received, chunk]);
      if (frameLength < 0 && received.length >= 4) frameLength = received.readUInt32BE(0);
      if (frameLength >= 0 && received.length >= 4 + frameLength) {
        socket.off("data", onData);
        resolve(received.subarray(4, 4 + frameLength));
      }
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed before frame arrived")));
  });
}

function frameJson(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

interface Stub {
  path: string;
  connections: number;
  rawRequests: Buffer[];
  closedByPeer: number;
}

async function startStub(onFrame?: (body: Buffer, socket: Socket) => void): Promise<Stub & { close: () => Promise<void> }> {
  const path = stubSocketPath();
  await unlink(path).catch(() => {});
  const stub: Stub = { path, connections: 0, rawRequests: [], closedByPeer: 0 };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    stub.connections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      stub.closedByPeer += 1;
      sockets.delete(socket);
    });
    void readFrameBody(socket)
      .then((body) => {
        stub.rawRequests.push(body);
        onFrame?.(body, socket);
      })
      .catch(() => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      server.on("error", () => {});
      resolve();
    });
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(path).catch(() => {});
  };
  openStubs.push(close);
  return { ...stub, close, get connections() { return stub.connections; }, get rawRequests() { return stub.rawRequests; }, get closedByPeer() { return stub.closedByPeer; } };
}

async function rejectedCode(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(NativeSshAuthorityError);
  return (error as NativeSshAuthorityError).code;
}

describe("unix socket signer transport", () => {
  it("sends one framed request and returns the daemon envelope untouched", async () => {
    const envelope = { version: "1", audience: "paperclip-native-ssh", authority: { opaqueRequestId: REQUEST_ID }, signature: "c2ln" };
    const stub = await startStub((body, socket) => {
      expect(JSON.parse(body.toString("utf8"))).toEqual({ version: "1", opaqueRequestId: REQUEST_ID });
      socket.write(frameJson({ ok: true, envelope }));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path);
    await expect(transport.requestEnvelope({ ...REQUEST })).resolves.toEqual(envelope);
    expect(stub.connections).toBe(1);
    expect(stub.rawRequests).toHaveLength(1);
  });

  it("pins the exact wire bytes: u32be length prefix plus compact JSON", async () => {
    const stub = await startStub((body, socket) => {
      socket.write(frameJson({ ok: true, envelope: {} }));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path);
    await transport.requestEnvelope({ ...REQUEST });
    const expected = Buffer.from(JSON.stringify({ version: "1", opaqueRequestId: REQUEST_ID }), "utf8");
    // The stub strips the header; re-encode and compare the full frame shape instead.
    expect(stub.rawRequests[0]).toEqual(expected);
    const frame = encodeNativeSshSignerFrame(expected);
    expect(frame.subarray(0, 4).readUInt32BE(0)).toBe(expected.length);
    expect(frame.subarray(4)).toEqual(expected);
  });

  it("passes an unparseable envelope through for the executor to classify", async () => {
    const stub = await startStub((_body, socket) => {
      socket.write(frameJson({ ok: true, envelope: "not-an-envelope" }));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path);
    await expect(transport.requestEnvelope({ ...REQUEST })).resolves.toBe("not-an-envelope");
  });

  it("refuses when nothing listens on the socket", async () => {
    const transport = createUnixSocketNativeSshSignerTransport(join(tmpdir(), `native-ssh-signer-absent-${process.pid}.sock`), {
      connectTimeoutMs: 500,
    });
    await expect(rejectedCode(transport.requestEnvelope({ ...REQUEST }))).resolves.toBe("native_ssh_signer_unavailable");
  });

  it("refuses when the daemon accepts but never answers", async () => {
    const stub = await startStub();
    const transport = createUnixSocketNativeSshSignerTransport(stub.path, { readTimeoutMs: 50 });
    await expect(rejectedCode(transport.requestEnvelope({ ...REQUEST }))).resolves.toBe("native_ssh_signer_unavailable");
  });

  it("refuses an oversize response length without reading the body", async () => {
    const stub = await startStub((_body, socket) => {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(NATIVE_SSH_SIGNER_TRANSPORT_MAX_FRAME_BYTES + 1, 0);
      socket.write(header);
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path, { readTimeoutMs: 500 });
    const error = await transport.requestEnvelope({ ...REQUEST }).then(
      () => null,
      (thrown: unknown) => thrown as NativeSshAuthorityError,
    );
    expect(error).toBeInstanceOf(NativeSshAuthorityError);
    expect(error?.code).toBe("native_ssh_signer_unavailable");
    expect(error?.message).toMatch(/frame length/);
  });

  it("refuses a zero-length response frame", async () => {
    const stub = await startStub((_body, socket) => {
      socket.write(Buffer.alloc(4));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path, { readTimeoutMs: 500 });
    await expect(rejectedCode(transport.requestEnvelope({ ...REQUEST }))).resolves.toBe("native_ssh_signer_unavailable");
  });

  it("refuses a response that is not JSON", async () => {
    const stub = await startStub((_body, socket) => {
      const payload = Buffer.from("{nope", "utf8");
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(payload.length, 0);
      socket.write(Buffer.concat([header, payload]));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path, { readTimeoutMs: 500 });
    await expect(rejectedCode(transport.requestEnvelope({ ...REQUEST }))).resolves.toBe("native_ssh_signer_unavailable");
  });

  it("refuses a response without a boolean ok verdict", async () => {
    for (const body of [{ ok: "yes" }, { ok: 1 }, [1, 2], 5, "ok", null]) {
      const stub = await startStub((_request, socket) => {
        socket.write(frameJson(body));
      });
      const transport = createUnixSocketNativeSshSignerTransport(stub.path, { readTimeoutMs: 500 });
      await expect(rejectedCode(transport.requestEnvelope({ ...REQUEST }))).resolves.toBe("native_ssh_signer_unavailable");
    }
  });

  it("refuses ok:true without an envelope", async () => {
    const stub = await startStub((_request, socket) => {
      socket.write(frameJson({ ok: true }));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path, { readTimeoutMs: 500 });
    await expect(rejectedCode(transport.requestEnvelope({ ...REQUEST }))).resolves.toBe("native_ssh_signer_unavailable");
  });

  it("surfaces the daemon refusal reason", async () => {
    const stub = await startStub((_body, socket) => {
      socket.write(frameJson({ ok: false, reason: "peer_unauthorized", requestDigest: "ab".repeat(32) }));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path);
    const error = await transport.requestEnvelope({ ...REQUEST }).then(
      () => null,
      (thrown: unknown) => thrown as NativeSshAuthorityError,
    );
    expect(error?.code).toBe("native_ssh_signer_unavailable");
    expect(error?.message).toContain("peer_unauthorized");
  });

  it("refuses a refusal without a reason", async () => {
    const stub = await startStub((_body, socket) => {
      socket.write(frameJson({ ok: false }));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path, { readTimeoutMs: 500 });
    await expect(rejectedCode(transport.requestEnvelope({ ...REQUEST }))).resolves.toBe("native_ssh_signer_unavailable");
  });

  it("truncates an unbounded refusal reason", async () => {
    const stub = await startStub((_body, socket) => {
      socket.write(frameJson({ ok: false, reason: "x".repeat(500) }));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path);
    const error = await transport.requestEnvelope({ ...REQUEST }).then(
      () => null,
      (thrown: unknown) => thrown as NativeSshAuthorityError,
    );
    expect(error?.code).toBe("native_ssh_signer_unavailable");
    expect(error?.message).toContain(`${"x".repeat(128)}…`);
    expect(error?.message.length).toBeLessThan(300);
  });

  it("rejects malformed requests locally without opening a connection", async () => {
    const stub = await startStub((_body, socket) => {
      socket.write(frameJson({ ok: true, envelope: {} }));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path);
    const malformed: unknown[] = [
      null,
      "opaque",
      {},
      { version: "1" },
      { opaqueRequestId: REQUEST_ID },
      { version: "2", opaqueRequestId: REQUEST_ID },
      { version: "1", opaqueRequestId: REQUEST_ID, extra: true },
      { version: "1", opaqueRequestId: "not-a-uuid" },
    ];
    for (const request of malformed) {
      await expect(rejectedCode(transport.requestEnvelope(request as never))).resolves.toBe(
        "native_ssh_signer_request_invalid",
      );
    }
    expect(stub.connections).toBe(0);
  });

  it("rejects empty paths and non-positive timeouts at creation", () => {
    expect(() => createUnixSocketNativeSshSignerTransport("")).toThrowError(
      expect.objectContaining({ code: "native_ssh_authority_invalid" }),
    );
    expect(() => createUnixSocketNativeSshSignerTransport("/tmp/x.sock", { connectTimeoutMs: 0 })).toThrowError(
      expect.objectContaining({ code: "native_ssh_authority_invalid" }),
    );
    expect(() => createUnixSocketNativeSshSignerTransport("/tmp/x.sock", { readTimeoutMs: -1 })).toThrowError(
      expect.objectContaining({ code: "native_ssh_authority_invalid" }),
    );
  });

  it("refuses to encode empty or oversize frames", () => {
    expect(() => encodeNativeSshSignerFrame(Buffer.alloc(0))).toThrowError(
      expect.objectContaining({ code: "native_ssh_signer_unavailable" }),
    );
    expect(() => encodeNativeSshSignerFrame(Buffer.alloc(NATIVE_SSH_SIGNER_TRANSPORT_MAX_FRAME_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: "native_ssh_signer_unavailable" }),
    );
  });

  it("closes its connection after the round trip", async () => {
    let peerSocket: Socket | undefined;
    const stub = await startStub((body, socket) => {
      peerSocket = socket;
      socket.write(frameJson({ ok: true, envelope: {} }));
    });
    const transport = createUnixSocketNativeSshSignerTransport(stub.path);
    await transport.requestEnvelope({ ...REQUEST });
    if (!peerSocket) throw new Error("stub never saw the connection");
    const seen: Socket = peerSocket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stub-side socket never closed")), 2000);
      seen.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    expect(stub.closedByPeer).toBe(1);
  });
});

describe("signer transport self-disable pins", () => {
  it("ignores ambient socket configuration: only the explicit path is used", async () => {
    const stub = await startStub((_body, socket) => {
      socket.write(frameJson({ ok: true, envelope: { marker: true } }));
    });
    vi.stubEnv("PAPERCLIP_NATIVE_SSH_SIGNER_SOCKET", stub.path);
    // The env names the live stub, but the explicit (absent) path still fails: env is never consulted.
    const misdirected = createUnixSocketNativeSshSignerTransport(
      join(tmpdir(), `native-ssh-signer-absent-${process.pid}.sock`),
      { connectTimeoutMs: 200 },
    );
    await expect(rejectedCode(misdirected.requestEnvelope({ ...REQUEST }))).resolves.toBe(
      "native_ssh_signer_unavailable",
    );
    // And the explicit path works with hostile env set.
    vi.stubEnv("PAPERCLIP_NATIVE_SSH_SIGNER_SOCKET", "/nonexistent/rogue.sock");
    const direct = createUnixSocketNativeSshSignerTransport(stub.path);
    await expect(direct.requestEnvelope({ ...REQUEST })).resolves.toEqual({ marker: true });
  });
});
