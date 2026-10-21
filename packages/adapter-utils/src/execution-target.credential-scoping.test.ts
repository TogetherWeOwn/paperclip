/**
 * Credential-to-destination scoping acceptance tests: bridge fan-out (T2),
 * header passthrough (T3), sanitized logging (T4), permitted bridge writes
 * (T5), bridge-token host-worthlessness (T1 token half).
 *
 * Every test drives the REAL `startAdapterExecutionTargetPaperclipBridge`
 * against local stub HTTP servers (`hostApiUrl` override seam) with synthetic
 * credentials. No real GitHub, no production, no network beyond loopback.
 *
 * Expected verdict on the pre-fix tree: T2.1 (307/308) and T4.1 (debug query
 * log) FAIL for the gaps they pin; the rest pass as behavior controls.
 * Builder slices must green the failures without breaking the controls, and
 * must not edit this file.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AdapterSandboxExecutionTarget,
  startAdapterExecutionTargetPaperclipBridge,
} from "./execution-target.js";
import { runChildProcess } from "./server-utils.js";

// Synthetic credentials. Shaped like the real thing (JWT = three dot
// segments; bridge token = base64url without dots) but inert: the stubs
// below are the only verifiers, and nothing here leaves loopback.
const SYNTHETIC_HOST_JWT =
  "c3ludGhldGljLWJyaWRnZS10ZXN0.SU5KRy1IRUFERVI.eU5KRy1TSUdOQVRVUkU";
const CALLER_AUTH_CANARY = "CALLER-SUPPLIED-AUTH-CANARY-0001";
const QUERY_CANARY = "QUERY-CANARY-bridge-debug-0002";
const BODY_CANARY = "BODY-CANARY-bridge-forward-0003";
const FOREIGN_BODY_CANARY = "BODY-CANARY-redirect-0004";

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
  handler: (
    req: IncomingMessage,
    body: string,
  ) =>
    | { status: number; headers?: Record<string, string>; body: string }
    | { status: number; headers?: Record<string, string>; body: string }
    | Promise<{
        status: number;
        headers?: Record<string, string>;
        body: string;
      }>,
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
    const out = await handler(req, body);
    res.writeHead(
      out.status,
      out.headers ?? { "content-type": "application/json" },
    );
    res.end(out.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected the stub server to listen on a TCP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function createLocalSandboxRunner() {
  let counter = 0;
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    }) => {
      counter += 1;
      const command = input.command === "bash" ? "/bin/bash" : input.command;
      return runChildProcess(
        `sandbox-run-${counter}`,
        command,
        input.args ?? [],
        {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(
            1,
            Math.ceil((input.timeoutMs ?? 30_000) / 1000),
          ),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
          onSpawn: input.onSpawn
            ? async (meta) =>
                input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
            : undefined,
        },
      );
    },
  };
}

describe("bridge credential-to-destination scoping", () => {
  const cleanupDirs: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close().catch(() => undefined);
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function startBridge(input: {
    hostApiUrl: string;
    hostApiToken?: string;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  }) {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-bridge-scoping-"),
    );
    cleanupDirs.push(rootDir);
    const remoteCwd = path.join(rootDir, "workspace");
    const runtimeRootDir = path.join(remoteCwd, ".paperclip-runtime", "codex");
    await mkdir(runtimeRootDir, { recursive: true });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd,
      runner: createLocalSandboxRunner(),
      timeoutMs: 30_000,
    };
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: "run-scoping",
      target,
      runtimeRootDir,
      adapterKey: "codex",
      hostApiToken: input.hostApiToken ?? SYNTHETIC_HOST_JWT,
      hostApiUrl: input.hostApiUrl,
      onLog: input.onLog,
    });
    if (!bridge) throw new Error("Expected the test bridge to start.");
    closers.push(() => bridge.stop());
    return bridge;
  }

  it.each([307, 308])(
    "T2.1: a %i from the stub host to a foreign origin forwards neither auth nor body",
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
          headers: {
            location: `${foreign.origin}/collect`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ redirect: true }),
        }),
        hostRequests,
      );
      closers.push(host.close);

      const bridge = await startBridge({ hostApiUrl: host.origin });
      const response = await fetch(
        `${bridge.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ body: `note ${FOREIGN_BODY_CANARY}` }),
        },
      );
      // Drain the bridge response so the forward fully settles before asserting.
      await response.arrayBuffer().catch(() => undefined);

      expect(hostRequests).toHaveLength(1);
      expect(foreignRequests).toEqual([]);
      const foreignBodies = foreignRequests
        .map((request) => request.body)
        .join("\n");
      expect(foreignBodies).not.toContain(FOREIGN_BODY_CANARY);
      const foreignAuth = foreignRequests
        .map((request) => request.headers.authorization)
        .join("\n");
      expect(foreignAuth).not.toContain(SYNTHETIC_HOST_JWT);
      expect(foreignAuth).not.toContain(String(bridge.env.PAPERCLIP_API_KEY));
    },
  );

  it("T2.2: caller Authorization is overwritten — the stub host sees the host token only", {
    timeout: 30_000,
  }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startBridge({ hostApiUrl: host.origin });
    // The caller authenticates to the bridge with the bridge token; the
    // fan-out must replace it with the host token toward the pinned host URL.
    const response = await fetch(
      `${bridge.env.PAPERCLIP_API_URL}/api/agents/me`,
      {
        headers: {
          authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
        },
      },
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer().catch(() => undefined);

    expect(hostRequests).toHaveLength(1);
    expect(hostRequests[0]?.headers.authorization).toBe(
      `Bearer ${SYNTHETIC_HOST_JWT}`,
    );
    expect(JSON.stringify(hostRequests[0]?.headers)).not.toContain(
      String(bridge.env.PAPERCLIP_API_KEY),
    );
    expect(JSON.stringify(hostRequests[0]?.headers)).not.toContain(
      CALLER_AUTH_CANARY,
    );
  });

  it("T3.1: caller auth/cookie/capability headers are stripped on the forward leg; allowlisted headers pass", {
    timeout: 30_000,
  }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startBridge({ hostApiUrl: host.origin });
    const response = await fetch(
      `${bridge.env.PAPERCLIP_API_URL}/api/agents/me`,
      {
        headers: {
          authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
          accept: "application/json",
          "if-none-match": 'W/"sentinel"',
          "x-paperclip-github-capability": "capability-sentinel",
          cookie: "session=CALLER-COOKIE-CANARY",
          "x-paperclip-evil-injection": "evil-canary",
          "x-bridge-debug": "debug-canary",
        },
      },
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer().catch(() => undefined);

    expect(hostRequests).toHaveLength(1);
    const forwarded = hostRequests[0]?.headers ?? {};
    expect(forwarded.accept).toContain("application/json");
    expect(forwarded["if-none-match"]).toBe('W/"sentinel"');
    expect(forwarded["x-paperclip-github-capability"]).toBe(
      "capability-sentinel",
    );
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded["x-paperclip-evil-injection"]).toBeUndefined();
    expect(forwarded["x-bridge-debug"]).toBeUndefined();
  });

  it("T3.2: the response leg reflects no auth material", {
    timeout: 30_000,
  }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({
        status: 200,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer HOST-RESPONSE-AUTH-CANARY",
          "set-cookie": "session=HOST-RESPONSE-COOKIE-CANARY",
          "x-paperclip-internal": "internal-canary",
        },
        body: JSON.stringify({ ok: true }),
      }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startBridge({ hostApiUrl: host.origin });
    const response = await fetch(
      `${bridge.env.PAPERCLIP_API_URL}/api/agents/me`,
      {
        headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}` },
      },
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer().catch(() => undefined);

    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-paperclip-internal")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("T4.1: bridge debug logs carry no credential canaries — endpoint is origin+path, query/body stay out", {
    timeout: 30_000,
  }, async () => {
    vi.stubEnv("PAPERCLIP_BRIDGE_DEBUG", "1");
    const logChunks: string[] = [];
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 201, body: JSON.stringify({ id: "comment-1" }) }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startBridge({
      hostApiUrl: host.origin,
      onLog: async (_stream, chunk) => {
        logChunks.push(chunk);
      },
    });
    const getResponse = await fetch(
      `${bridge.env.PAPERCLIP_API_URL}/api/agents/me?next=${QUERY_CANARY}&token=${QUERY_CANARY}`,
      { headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}` } },
    );
    await getResponse.arrayBuffer().catch(() => undefined);
    const postResponse = await fetch(
      `${bridge.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: `note ${BODY_CANARY}` }),
      },
    );
    await postResponse.arrayBuffer().catch(() => undefined);

    const logs = logChunks.join("\n");
    expect(logs).not.toContain(QUERY_CANARY);
    expect(logs).not.toContain(BODY_CANARY);
    expect(logs).not.toContain(SYNTHETIC_HOST_JWT);
    expect(logs).not.toContain(String(bridge.env.PAPERCLIP_API_KEY));
  });

  it("T5.1: Paperclip API writes via the bridge succeed against the stub host", {
    timeout: 30_000,
  }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      (_req, body) => ({
        status: 201,
        body: JSON.stringify({ id: "comment-9", echo: JSON.parse(body).body }),
      }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startBridge({ hostApiUrl: host.origin });
    const response = await fetch(
      `${bridge.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "hello from the bridge" }),
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: "comment-9" });
    expect(hostRequests).toHaveLength(1);
    expect(hostRequests[0]?.headers.authorization).toBe(
      `Bearer ${SYNTHETIC_HOST_JWT}`,
    );
    expect(hostRequests[0]?.body).toContain("hello from the bridge");
  });

  it("T1.5: the loopback bridge accepts its bridge token and rejects wrong or missing tokens", {
    timeout: 30_000,
  }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      hostRequests,
    );
    closers.push(host.close);

    const bridge = await startBridge({ hostApiUrl: host.origin });
    const good = await fetch(`${bridge.env.PAPERCLIP_API_URL}/api/agents/me`, {
      headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}` },
    });
    expect(good.status).toBe(200);
    await good.arrayBuffer().catch(() => undefined);

    const wrong = await fetch(`${bridge.env.PAPERCLIP_API_URL}/api/agents/me`, {
      headers: { authorization: "Bearer wrong-bridge-token" },
    });
    expect(wrong.status).toBe(401);
    await wrong.arrayBuffer().catch(() => undefined);

    const missing = await fetch(
      `${bridge.env.PAPERCLIP_API_URL}/api/agents/me`,
    );
    expect(missing.status).toBe(401);
    await missing.arrayBuffer().catch(() => undefined);

    // Only the authenticated call reached the stub host.
    expect(hostRequests).toHaveLength(1);
  });

  it("T1.6: the bridge token is host-worthless — a stub host that verifies JWT shape rejects it", {
    timeout: 30_000,
  }, async () => {
    const hostRequests: RecordedRequest[] = [];
    const host = await startStubServer((req) => {
      const auth = req.headers.authorization ?? "";
      // The host API verifies Bearer JWTs (three dot segments). Anything
      // else is not a host credential.
      const bearer = auth.startsWith("Bearer ")
        ? auth.slice("Bearer ".length)
        : "";
      const jwtShaped = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
        bearer,
      );
      return jwtShaped
        ? { status: 200, body: JSON.stringify({ ok: true }) }
        : { status: 401, body: JSON.stringify({ error: "invalid token" }) };
    }, hostRequests);
    closers.push(host.close);

    const bridge = await startBridge({ hostApiUrl: host.origin });
    const bridgeToken = String(bridge.env.PAPERCLIP_API_KEY);
    expect(bridgeToken).not.toBe(SYNTHETIC_HOST_JWT);
    expect(bridgeToken).not.toMatch(/\./);

    const bridgeTokenDirect = await fetch(`${host.origin}/api/agents/me`, {
      headers: { authorization: `Bearer ${bridgeToken}` },
    });
    expect(bridgeTokenDirect.status).toBe(401);
    await bridgeTokenDirect.arrayBuffer().catch(() => undefined);

    const hostJwtDirect = await fetch(`${host.origin}/api/agents/me`, {
      headers: { authorization: `Bearer ${SYNTHETIC_HOST_JWT}` },
    });
    expect(hostJwtDirect.status).toBe(200);
    await hostJwtDirect.arrayBuffer().catch(() => undefined);
  });
});
