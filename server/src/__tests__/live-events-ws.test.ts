import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logger } from "../middleware/logger.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableDestroyed = false;
  endedChunks: string[] = [];
  destroyCalls = 0;

  end(chunk?: string) {
    if (chunk) this.endedChunks.push(chunk);
    this.writableEnded = true;
    this.writable = false;
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("finish");
      if (!this.destroyed) {
        this.emit("close");
      }
    });
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("close");
    return this;
  }

  emitSocketError(err: Error) {
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("error", err);
  }
}

function createUpgradeRequest(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: "/api/companies/company-1/events/ws",
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("setupLiveEventsWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not write a rejection response after the raw upgrade socket is already closed", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    socket.destroy();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyCalls).toBe(1);
  });

  it("handles raw upgrade socket errors during async authorization", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    expect(() => socket.emitSocketError(new Error("write EPIPE"))).not.toThrow();
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: "/api/companies/company-1/events/ws" }),
      "live websocket upgrade socket error",
    );
    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys and cleans up listeners after flushing a rejection response", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("finish")).toBe(0);
  });

  it("authorizes a cloud-proxied browser for a company in its membership scope", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    const socket = new FakeUpgradeSocket();
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => {
        // Stop before the ws handshake writes to the fake socket; the
        // assertion is that authorization passed without any rejection.
        socket.writable = false;
        return { userId: "cloud-user-1", companyIds: ["company-1", "company-2"] };
      },
    });

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("rejects a cloud actor for a company outside its membership scope", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => ({ userId: "cloud-user-1", companyIds: ["company-other"] }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    // A resolved cloud actor is authoritative; the session path must not run.
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("falls through to session auth when no cloud actor resolves", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => null,
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(1);
    expect(socket.endedChunks[0]).toContain("403 Forbidden");
  });
});

describe("live-events websocket agent-key scopes", () => {
  const OBSERVER_COMPANY = "ef993a7e-5ea7-445f-ba88-27a6a2690c3a";

  function observerScopeFixture() {
    const now = Date.now();
    return {
      kind: "observer",
      companyId: OBSERVER_COMPANY,
      purpose: "held-cap-zero-observation",
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
    };
  }

  function trackingKeyDb(keyRow: Record<string, unknown> | null) {
    let updates = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(keyRow ? [keyRow] : []),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => {
            updates += 1;
            return Promise.resolve([]);
          },
        }),
      }),
    };
    return { db, getUpdates: () => updates };
  }

  async function upgrade(
    db: unknown,
    token: string,
    companyId: string,
    stopBeforeHandshake = false,
  ): Promise<string[]> {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, db as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: async () => null,
    });
    const socket = new FakeUpgradeSocket();
    // Denials write the 403 on a writable socket. The allowed control stops
    // before the ws handshake writes: passing authorization with no rejection
    // is the assertion there.
    if (stopBeforeHandshake) socket.writable = false;
    const req = createUpgradeRequest({
      url: `/api/companies/${companyId}/events/ws`,
      headers: { authorization: `Bearer ${token}` },
    });
    server.emit("upgrade", req, socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();
    return socket.endedChunks;
  }

  it("rejects observer keys without touching lastUsedAt", async () => {
    const token = "observer-token";
    const { db, getUpdates } = trackingKeyDb({
      id: "key-1",
      agentId: "agent-1",
      companyId: OBSERVER_COMPANY,
      keyHash: createHash("sha256").update(token).digest("hex"),
      scopeConfig: observerScopeFixture(),
      revokedAt: null,
    });
    const chunks = await upgrade(db, token, OBSERVER_COMPANY);
    expect(chunks[0]).toContain("403 Forbidden");
    expect(getUpdates()).toBe(0);
  });

  it("rejects unparseable key scopes instead of treating them as standard", async () => {
    const token = "weird-token";
    const { db, getUpdates } = trackingKeyDb({
      id: "key-2",
      agentId: "agent-1",
      companyId: OBSERVER_COMPANY,
      keyHash: createHash("sha256").update(token).digest("hex"),
      scopeConfig: { kind: "nope" },
      revokedAt: null,
    });
    const chunks = await upgrade(db, token, OBSERVER_COMPANY);
    expect(chunks[0]).toContain("403 Forbidden");
    expect(getUpdates()).toBe(0);
  });

  it("still upgrades standard keys", async () => {
    const token = "standard-token";
    const { db, getUpdates } = trackingKeyDb({
      id: "key-3",
      agentId: "agent-1",
      companyId: OBSERVER_COMPANY,
      keyHash: createHash("sha256").update(token).digest("hex"),
      scopeConfig: { kind: "standard" },
      revokedAt: null,
    });
    const chunks = await upgrade(db, token, OBSERVER_COMPANY, true);
    expect(chunks).toEqual([]);
    expect(getUpdates()).toBe(1);
  });
});
