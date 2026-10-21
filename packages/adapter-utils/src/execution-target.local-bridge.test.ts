/**
 * B1 pins for the real local/legacy loopback bridge (`local_v1`): env shape,
 * token separation, 401/403 denials, redirect refusal, and debug-log
 * sanitization — all against local stub HTTP servers with synthetic
 * credentials. Nothing here leaves loopback.
 *
 * The execute-level wiring is pinned (mocked bridge) in
 * execute.credential-scoping.test.ts T1.1–T1.3; these pins cover the real
 * bridge the mock stands in for.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADAPTER_EXECUTION_TARGET_LOCAL_BRIDGE_MODE,
  adapterExecutionTargetUsesLocalPaperclipBridge,
  startAdapterExecutionTargetPaperclipBridge,
} from "./execution-target.js";

// Synthetic credentials. Shaped like the real thing (JWT = three dot
// segments; bridge token = base64url without dots) but inert: the stubs
// below are the only verifiers, and nothing here leaves loopback.
const SYNTHETIC_HOST_JWT = "c3ludGhldGljLWxvY2FsLWJyaWRnZS5IWU9TVC1KV1Q.eU5KRy1TSUdOQVRVUkU";
const QUERY_CANARY = "QUERY-CANARY-local-bridge-debug-0001";
const BODY_CANARY = "BODY-CANARY-local-bridge-forward-0002";
const FOREIGN_BODY_CANARY = "BODY-CANARY-local-bridge-redirect-0003";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function startStubServer(
  handler: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body: string },
  recorded: RecordedRequest[],
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    recorded.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: { ...req.headers },
      body,
    });
    const out = handler(req, body);
    res.writeHead(out.status, out.headers ?? { "content-type": "application/json" });
    res.end(out.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected the stub server to listen on a TCP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("local loopback bridge (local_v1)", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close().catch(() => undefined);
    }
  });

  async function startLocalBridge(input: {
    hostApiUrl: string;
    hostApiToken?: string | null;
    target?: { kind: "local" } | null;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  }) {
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-local-bridge",
      target: input.target === undefined ? { kind: "local" } : input.target,
      runtimeRootDir: null,
      adapterKey: "claude",
      hostApiToken: input.hostApiToken === undefined ? SYNTHETIC_HOST_JWT : input.hostApiToken,
      hostApiUrl: input.hostApiUrl,
      onLog: input.onLog,
    });
    if (bridge) closers.push(() => bridge.stop());
    return bridge;
  }

  it("uses the local bridge for local and legacy (null) targets only", () => {
    expect(adapterExecutionTargetUsesLocalPaperclipBridge({ kind: "local" })).toBe(true);
    expect(adapterExecutionTargetUsesLocalPaperclipBridge(null)).toBe(true);
    expect(adapterExecutionTargetUsesLocalPaperclipBridge(undefined)).toBe(true);
    expect(
      adapterExecutionTargetUsesLocalPaperclipBridge({ kind: "remote", transport: "ssh", remoteCwd: "/w", spec: {} } as never),
    ).toBe(false);
  });

  it("swaps the host JWT + host URL for a bridge token + loopback URL in local_v1 mode", { timeout: 30_000 }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      hostRequests,
    );
    closers.push(host.close);

    for (const target of [{ kind: "local" } as const, null]) {
      const bridge = await startLocalBridge({ hostApiUrl: host.origin, target });
      expect(bridge).not.toBeNull();
      const env = bridge!.env;
      const apiUrl = new URL(env.PAPERCLIP_API_URL);
      expect(apiUrl.hostname).toBe("127.0.0.1");
      expect(env.PAPERCLIP_API_URL).not.toBe(host.origin);
      expect(env.PAPERCLIP_API_KEY).toBeDefined();
      expect(env.PAPERCLIP_API_KEY).not.toBe(SYNTHETIC_HOST_JWT);
      expect(env.PAPERCLIP_API_KEY).not.toContain(".");
      expect(env.PAPERCLIP_API_BRIDGE_MODE).toBe(ADAPTER_EXECUTION_TARGET_LOCAL_BRIDGE_MODE);
      expect(env.PAPERCLIP_API_BRIDGE_MODE).toBe("local_v1");
      expect(env).not.toHaveProperty("PAPERCLIP_BRIDGE_QUEUE_DIR");
      expect(JSON.stringify(env)).not.toContain(SYNTHETIC_HOST_JWT);
    }
  });

  it("returns null without a host token: nothing to scope, legacy passthrough", { timeout: 30_000 }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      hostRequests,
    );
    closers.push(host.close);

    expect(await startLocalBridge({ hostApiUrl: host.origin, hostApiToken: null })).toBeNull();
    expect(await startLocalBridge({ hostApiUrl: host.origin, hostApiToken: "  " })).toBeNull();
  });

  it("forwards writes to the pinned host with the host token, never the bridge token", { timeout: 30_000 }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      (_req, body) => ({ status: 201, body: JSON.stringify({ id: "comment-9", echo: JSON.parse(body).body }) }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startLocalBridge({ hostApiUrl: host.origin });
    const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: "hello from the local bridge" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: "comment-9" });
    expect(hostRequests).toHaveLength(1);
    expect(hostRequests[0]?.headers.authorization).toBe(`Bearer ${SYNTHETIC_HOST_JWT}`);
    expect(JSON.stringify(hostRequests[0]?.headers)).not.toContain(String(bridge!.env.PAPERCLIP_API_KEY));
    expect(hostRequests[0]?.body).toContain("hello from the local bridge");
  });

  it("rejects wrong or missing bridge tokens with 401 and never forwards them", { timeout: 30_000 }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startLocalBridge({ hostApiUrl: host.origin });
    const wrong = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, {
      headers: { authorization: "Bearer wrong-bridge-token" },
    });
    expect(wrong.status).toBe(401);
    await wrong.arrayBuffer().catch(() => undefined);

    const missing = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`);
    expect(missing.status).toBe(401);
    await missing.arrayBuffer().catch(() => undefined);

    expect(hostRequests).toEqual([]);
  });

  it("denies non-allowlisted routes with 403 and never forwards them", { timeout: 30_000 }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startLocalBridge({ hostApiUrl: host.origin });
    const denied = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/secret-admin-route`, {
      headers: { authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}` },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: expect.stringMatching(/^Route not allowed:/) });
    expect(hostRequests).toEqual([]);
  });

  it.each([307, 308])(
    "a %i from the stub host to a foreign origin is refused with 502 and never followed",
    { timeout: 30_000 },
    async (status) => {
      const foreignRequests: RecordedRequest[] = [];
      const foreign = await startStubServer(
        () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
        foreignRequests,
      );
      closers.push(foreign.close);
      const hostRequests: RecordedRequest[] = [];
      const host = await startStubServer(
        () => ({
          status,
          headers: { location: `${foreign.origin}/collect`, "content-type": "application/json" },
          body: JSON.stringify({ redirect: true }),
        }),
        hostRequests,
      );
      closers.push(host.close);

      const bridge = await startLocalBridge({ hostApiUrl: host.origin });
      const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: `note ${FOREIGN_BODY_CANARY}` }),
      });
      expect(response.status).toBe(502);
      await response.arrayBuffer().catch(() => undefined);

      expect(hostRequests).toHaveLength(1);
      expect(foreignRequests).toEqual([]);
    },
  );

  it("debug logs carry origin+path only: query, body, and tokens stay out", { timeout: 30_000 }, async () => {
    vi.stubEnv("PAPERCLIP_BRIDGE_DEBUG", "1");
    const logChunks: string[] = [];
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 201, body: JSON.stringify({ id: "comment-1" }) }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startLocalBridge({
      hostApiUrl: host.origin,
      onLog: async (_stream, chunk) => {
        logChunks.push(chunk);
      },
    });
    const getResponse = await fetch(
      `${bridge!.env.PAPERCLIP_API_URL}/api/agents/me?next=${QUERY_CANARY}&token=${QUERY_CANARY}`,
      { headers: { authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}` } },
    );
    await getResponse.arrayBuffer().catch(() => undefined);
    const postResponse = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: `note ${BODY_CANARY}` }),
    });
    await postResponse.arrayBuffer().catch(() => undefined);

    const logs = logChunks.join("\n");
    expect(logs).not.toContain(QUERY_CANARY);
    expect(logs).not.toContain(BODY_CANARY);
    expect(logs).not.toContain(SYNTHETIC_HOST_JWT);
    expect(logs).not.toContain(String(bridge!.env.PAPERCLIP_API_KEY));
  });

  it("stop() closes the loopback listener", { timeout: 30_000 }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startLocalBridge({ hostApiUrl: host.origin });
    const baseUrl = bridge!.env.PAPERCLIP_API_URL;
    const before = await fetch(`${baseUrl}/api/agents/me`, {
      headers: { authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}` },
    });
    expect(before.status).toBe(200);
    await before.arrayBuffer().catch(() => undefined);

    await bridge!.stop();
    await expect(
      fetch(`${baseUrl}/api/agents/me`, {
        headers: { authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}` },
      }),
    ).rejects.toThrow();
  });
});
