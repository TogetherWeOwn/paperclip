/**
 * Failing-first canonical-target acceptance. Only transport I/O is replaced:
 * public bridge factories, generated gateway handlers, host authorizers, queue
 * workers and forwarders run unchanged. No listener binds, fetch leaves this
 * process, host route runs, or real credential is read.
 *
 * Breaks caught: raw authorization followed by URL normalization; gateway
 * normalization before host validation; decoded separators and malformed path
 * encodings; a path validator incorrectly inspecting query data; removal of
 * route/token/header restrictions. Builder owns source changes, not this file.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import http2 from "node:http2";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { type Duplex, duplexPair, PassThrough, Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandManagedDuplexChannel,
  CommandManagedRuntimeRunner,
} from "./command-managed-runtime.js";
import { startAdapterExecutionTargetPaperclipBridge } from "./execution-target.js";
import {
  createHttp2BridgeServer,
  type Http2BridgeForwardRequest,
} from "./http2-bridge-server.js";
import {
  createFileSystemSandboxCallbackBridgeQueueClient,
  getSandboxCallbackBridgeServerSource,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeWorker,
} from "./sandbox-callback-bridge.js";

const HOST_ORIGIN = "https://callback-host.example.test";
const HOST_TOKEN = "synthetic.header.signature";
const RUN_ID = "synthetic-callback-run";
const H2_TOKEN = "synthetic-opaque-http2-bridge-token";
const QUERY =
  "?next=../%2e%2e/%2F/%5C&url=https://outside.example.test/a&literal=%23";
const JSON_BODY = Buffer.from('{"body":"synthetic acceptance note"}');
const UPLOAD_BODY = Buffer.concat([
  Buffer.from(
    '--offline-boundary\r\nContent-Disposition: form-data; name="file"; filename="proof.bin"\r\nContent-Type: application/octet-stream\r\n\r\n',
  ),
  Buffer.from([0, 255, 128, 13, 10]),
  Buffer.from("\r\n--offline-boundary--\r\n"),
]);

type TargetCase = { name: string; method: string; target: string };
const INVALID: TargetCase[] = [
  {
    name: "demonstrated encoded parent",
    method: "POST",
    target: "/api/issues/%2e%2e/comments",
  },
  {
    name: "demonstrated literal parent",
    method: "POST",
    target: "/api/issues/../comments",
  },
  {
    name: "demonstrated instructions fragment",
    method: "PATCH",
    target: "/api/agents/synthetic-agent#ignored/instructions-path",
  },
  {
    name: "fragment on an otherwise allowed read",
    method: "GET",
    target: "/api/issues/issue-1#ignored",
  },
  {
    name: "fragment after an allowed write",
    method: "POST",
    target: "/api/issues/issue-1/comments#ignored",
  },
  {
    name: "fragment in raw query",
    method: "POST",
    target: "/api/issues/issue-1/comments?view=full#ignored",
  },
  {
    name: "literal current segment",
    method: "POST",
    target: "/api/issues/./comments",
  },
  {
    name: "encoded current segment",
    method: "POST",
    target: "/api/issues/%2E/comments",
  },
  {
    name: "mixed encoded parent",
    method: "POST",
    target: "/api/issues/.%2e/comments",
  },
  {
    name: "mixed encoded parent reversed",
    method: "POST",
    target: "/api/issues/%2E./comments",
  },
  {
    name: "parent alias of permitted route",
    method: "POST",
    target: "/api/issues/extra/../issue-1/comments",
  },
  {
    name: "encoded alias of permitted route",
    method: "POST",
    target: "/api/issues/extra/%2e%2E/issue-1/comments",
  },
  {
    name: "encoded slash lower case",
    method: "POST",
    target: "/api/issues/issue%2fother/comments",
  },
  {
    name: "encoded slash upper case",
    method: "POST",
    target: "/api/issues/issue%2Fother/comments",
  },
  {
    name: "encoded backslash",
    method: "POST",
    target: "/api/issues/issue%5cother/comments",
  },
  {
    name: "encoded backslash upper case",
    method: "POST",
    target: "/api/issues/issue%5Cother/comments",
  },
  {
    name: "literal backslash",
    method: "POST",
    target: "/api/issues/issue\\other/comments",
  },
  {
    name: "bare percent",
    method: "POST",
    target: "/api/issues/issue%/comments",
  },
  {
    name: "short escape",
    method: "POST",
    target: "/api/issues/issue%2/comments",
  },
  {
    name: "nonhex escape",
    method: "POST",
    target: "/api/issues/issue%GG/comments",
  },
  {
    name: "invalid UTF8 escape",
    method: "POST",
    target: "/api/issues/issue%C0%AE/comments",
  },
  {
    name: "encoded NUL",
    method: "POST",
    target: "/api/issues/issue%00/comments",
  },
  {
    name: "foreign absolute form",
    method: "POST",
    target: "https://outside.example.test/api/issues/issue-1/comments",
  },
  {
    name: "same-origin absolute form",
    method: "POST",
    target: "https://callback-host.example.test/api/issues/issue-1/comments",
  },
  {
    name: "network-path form",
    method: "POST",
    target: "//outside.example.test/api/issues/issue-1/comments",
  },
];
const RESTRICTED: TargetCase[] = [
  {
    name: "broader agent update",
    method: "PATCH",
    target: "/api/agents/synthetic-agent",
  },
  {
    name: "wrong comment method",
    method: "DELETE",
    target: "/api/issues/issue-1/comments",
  },
  {
    name: "wrong document method",
    method: "DELETE",
    target: "/api/issues/issue-1/documents/plan",
  },
  {
    name: "extra upload segment",
    method: "POST",
    target: "/api/companies/company-1/issues/issue-1/attachments/extra",
  },
  {
    name: "broker lookalike",
    method: "POST",
    target: "/runtime-tools/github/credentials/extra",
  },
  {
    name: "unrelated secrets route",
    method: "GET",
    target: "/api/companies/company-1/secrets",
  },
];
const VALID = [
  {
    name: "comment",
    method: "POST",
    target: "/api/issues/issue-1/comments",
    body: JSON_BODY,
    contentType: "application/json",
  },
  {
    name: "document",
    method: "PUT",
    target: "/api/issues/issue-1/documents/plan",
    body: Buffer.from('{"body":"# Plan"}'),
    contentType: "application/json",
  },
  {
    name: "binary multipart upload",
    method: "POST",
    target: "/api/companies/company-1/issues/issue-1/attachments",
    body: UPLOAD_BODY,
    contentType: "multipart/form-data; boundary=offline-boundary",
  },
  {
    name: "broker",
    method: "POST",
    target: "/runtime-tools/github/credentials",
    body: Buffer.from("{}"),
    contentType: "application/json",
  },
  {
    name: "instructions",
    method: "PATCH",
    target: "/api/agents/synthetic-agent/instructions-path",
    body: Buffer.from('{"path":"AGENTS.md"}'),
    contentType: "application/json",
  },
];

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;
type Reply = { status: number; body: Buffer; headers: Record<string, string> };

/** Replace the OS listener, not any handler/validator registered on it. */
function offlineListener(handler: Handler) {
  const server = Object.assign(new EventEmitter(), {
    listen: (_port: number, _host: string, ready: () => unknown) => {
      void Promise.resolve().then(ready);
      return server;
    },
    address: () => ({ address: "127.0.0.1", family: "IPv4", port: 31999 }),
    close: (closed: (error?: Error) => void) => closed(),
  });
  return { server, handler };
}

async function deliver(
  handler: Handler,
  request: {
    method: string;
    target: string;
    token?: string;
    body?: Buffer;
    contentType?: string;
  },
): Promise<Reply> {
  const req = Object.assign(Readable.from(request.body ? [request.body] : []), {
    method: request.method,
    url: request.target,
    headers: {
      ...(request.token === undefined
        ? {}
        : { authorization: `Bearer ${request.token}` }),
      "content-type": request.contentType ?? "application/json",
      accept: "application/json",
      "if-match": '"synthetic-match"',
      "if-none-match": 'W/"synthetic-cache"',
      "x-paperclip-github-capability": "synthetic-broker-capability",
      cookie: "session=synthetic-cookie",
      "proxy-authorization": "synthetic-proxy-auth",
      "x-paperclip-run-id": "spoofed-run",
      "x-bridge-debug": "synthetic-drop-me",
    },
  });
  return new Promise<Reply>((resolve, reject) => {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader: (key: string, value: string) => {
        headers[key.toLowerCase()] = value;
      },
      writeHead(status: number, values: Record<string, string> = {}) {
        this.statusCode = status;
        Object.assign(headers, values);
        this.headersSent = true;
      },
      end(body: string | Buffer = "") {
        resolve({ status: this.statusCode, headers, body: Buffer.from(body) });
      },
      destroy: () => reject(new Error("Offline response destroyed")),
    };
    Promise.resolve(
      handler(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      ),
    ).catch(reject);
  });
}

const require = createRequire(import.meta.url);
/** Compile the entire shipped gateway, replacing only imports' I/O endpoints. */
async function loadGateway(
  env: Record<string, string>,
  h2ClientSide?: Duplex,
): Promise<Handler> {
  let handler: Handler | undefined;
  let ready: Promise<unknown> = Promise.resolve();
  let connected: Promise<unknown> = Promise.resolve();
  const source = getSandboxCallbackBridgeServerSource();
  // Keep imports at module scope, wrapping the complete executable body only
  // to let the VM await the shipped top-level startup. No policy is substituted.
  const imports = source.match(/^import .+;$/gm) ?? [];
  const body = source.replace(/^import .+;$/gm, "");
  const compiled = transformSync(
    `${imports.join("\n")}\n(async () => { ${body}\n })()`,
    {
      format: "cjs",
      platform: "node",
      target: "node24",
    },
  ).code;
  await runInNewContext(
    compiled,
    {
      require: (name: string) => {
        if (name === "node:http")
          return {
            createServer: (callback: Handler) => {
              handler = callback;
              const { server } = offlineListener(callback);
              server.listen = (_port, _host, callback) => {
                ready = Promise.resolve().then(callback);
                return server;
              };
              return server;
            },
          };
        if (name === "node:http2" && h2ClientSide)
          return {
            ...http2,
            connect: (authority: string) => {
              const session = http2.connect(authority, {
                createConnection: () => h2ClientSide,
              });
              // Let the host send GOAWAY while the paired transport is still live.
              cleanups.unshift(async () => {
                session.destroy();
              });
              connected = new Promise((resolve, reject) => {
                session.once("connect", resolve);
                session.once("error", reject);
              });
              return session;
            },
          };
        return require(name);
      },
      exports: {},
      Buffer,
      URL,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      process: {
        env,
        pid: 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        on: () => {},
        exit: (code: number) => {
          throw new Error(`Offline gateway exited ${code}`);
        },
      },
    },
    { filename: "actual-callback-gateway.cjs", timeout: 5_000 },
  );
  await ready;
  await connected;
  if (!handler)
    throw new Error("Actual gateway did not register its HTTP handler");
  return handler;
}

/** Execute only the real queue's filesystem shell work in a credential-free env. */
function offlineQueueRunner(
  onGateway: (handler: Handler) => void,
): CommandManagedRuntimeRunner {
  return {
    execute: async (input) => {
      const script = input.args?.at(-1) ?? "";
      const result = {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      };
      if (input.env?.PAPERCLIP_BRIDGE_TOKEN) {
        onGateway(await loadGateway(input.env));
        return { ...result, stdout: '{"pid":12345}\n' };
      }
      // There is no child gateway process to signal: it lives in the VM above.
      if (script.includes('kill "$pid" 2>/dev/null || true')) return result;
      return new Promise((resolve, reject) => {
        const child = spawn("/bin/bash", ["-c", script], {
          cwd: input.cwd,
          env: { PATH: "/usr/bin:/bin", ...input.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (exitCode, signal) => {
          clearTimeout(timer);
          resolve({ ...result, exitCode, signal, stdout, stderr });
        });
        child.stdin.end(input.stdin);
      });
    },
  };
}

function channelFor(duplex: Duplex): CommandManagedDuplexChannel {
  return {
    write: (data) => {
      duplex.write(Buffer.from(data));
    },
    onData: (listener) => {
      duplex.on("data", listener);
    },
    onExit: (listener) => {
      duplex.on("end", () => listener({ exitCode: null }));
    },
    stop: () => {
      duplex.destroy();
    },
    close: async () => {
      duplex.end();
    },
  };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()?.();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

function expectDenied(reply: Reply, forwards: unknown[]) {
  // A denied upstream reply is NOT evidence of prevention. Count first.
  expect(forwards, "noncanonical request reached the forward boundary").toEqual(
    [],
  );
  expect([400, 403]).toContain(reply.status);
}

function expectAllowedHeaders(
  headers: Record<string, string>,
  contentType: string,
) {
  expect(headers).toMatchObject({
    accept: "application/json",
    "content-type": contentType,
    "if-match": '"synthetic-match"',
    "if-none-match": 'W/"synthetic-cache"',
    "x-paperclip-github-capability": "synthetic-broker-capability",
  });
  for (const key of ["cookie", "proxy-authorization", "x-bridge-debug"])
    expect(headers[key]).toBeUndefined();
}

describe.each(["local_v1", "queue_v1"] as const)(
  "canonical callback target: %s actual ingress to fetch",
  (mode) => {
    let handler: Handler;
    let token: string;
    let queueDir: string;
    let forwards: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: Buffer;
      redirect: RequestRedirect | undefined;
    }>;

    beforeEach(async () => {
      vi.stubEnv("PAPERCLIP_BRIDGE_DEBUG", "0");
      forwards = [];
      vi.stubGlobal("fetch", async (url: URL | string, init: RequestInit) => {
        forwards.push({
          url: String(url),
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          body:
            init.body === undefined
              ? Buffer.alloc(0)
              : Buffer.from(init.body as Uint8Array),
          redirect: init.redirect,
        });
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      if (mode === "local_v1") {
        vi.spyOn(http, "createServer").mockImplementation(((
          callback: Handler,
        ) => {
          const listener = offlineListener(callback);
          handler = listener.handler;
          return listener.server;
        }) as typeof http.createServer);
      }
      const root = await mkdtemp(
        path.join(
          process.env.PAPERCLIP_SCRATCH_DIR ?? os.tmpdir(),
          "callback-acceptance-",
        ),
      );
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const bridge = await startAdapterExecutionTargetPaperclipBridge({
        runId: RUN_ID,
        adapterKey: "codex",
        runtimeRootDir: root,
        hostApiUrl: HOST_ORIGIN,
        hostApiToken: HOST_TOKEN,
        target:
          mode === "local_v1"
            ? { kind: "local" }
            : {
                kind: "remote",
                transport: "sandbox",
                providerKey: "e2b",
                environmentId: "synthetic-environment",
                leaseId: "synthetic-lease",
                remoteCwd: root,
                timeoutMs: 5_000,
                streamRunLogs: false,
                runner: offlineQueueRunner((callback) => {
                  handler = callback;
                }),
              },
      });
      if (!bridge) throw new Error("Actual bridge factory returned no bridge");
      cleanups.push(() => bridge.stop());
      token = String(bridge.env.PAPERCLIP_API_KEY);
      queueDir = String(bridge.env.PAPERCLIP_BRIDGE_QUEUE_DIR ?? "");
      expect(bridge.env.PAPERCLIP_API_BRIDGE_MODE).toBe(mode);
      expect(token).not.toBe(HOST_TOKEN);
      expect(token).not.toContain(".");
    });

    it.each(INVALID)("zero forwards for $name", async ({ method, target }) => {
      expectDenied(
        await deliver(handler, { method, target, token, body: JSON_BODY }),
        forwards,
      );
    });

    it.each(RESTRICTED)(
      "retains restriction: $name",
      async ({ method, target }) => {
        expectDenied(
          await deliver(handler, { method, target, token, body: JSON_BODY }),
          forwards,
        );
      },
    );

    async function assertPositive(
      control: (typeof VALID)[number],
      query: string,
    ) {
      const reply = await deliver(handler, {
        ...control,
        target: control.target + query,
        token,
      });
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body.toString())).toEqual({ ok: true });
      expect(forwards).toHaveLength(1);
      const forwarded = forwards[0];
      expect(forwarded.url).toBe(HOST_ORIGIN + control.target + query);
      expect(forwarded.method).toBe(control.method);
      expect(forwarded.body).toEqual(control.body);
      expect(forwarded.redirect).toBe("manual");
      expectAllowedHeaders(forwarded.headers, control.contentType);
      expect(forwarded.headers.authorization).toBe(`Bearer ${HOST_TOKEN}`);
      expect(forwarded.headers["x-paperclip-run-id"]).toBe(RUN_ID);
      expect(JSON.stringify(forwarded)).not.toContain(token);
    }

    it.each(VALID)(
      "positive $name preserves bytes, query, headers and fixed origin",
      async (control) => {
        await assertPositive(control, "?view=compact&literal=%23");
      },
    );

    it.each(VALID)(
      "query separation: $name permits traversal-looking query data",
      async (control) => {
        await assertPositive(control, QUERY);
      },
    );

    it.each([undefined, "wrong-bridge-token", HOST_TOKEN])(
      "does not accept missing/wrong/host credentials (%s)",
      async (presented) => {
        const reply = await deliver(handler, {
          method: "POST",
          target: "/api/issues/issue-1/comments",
          token: presented,
          body: JSON_BODY,
        });
        expect(forwards).toEqual([]);
        expect(reply.status).toBe(401);
      },
    );

    // A compromised queue producer can supply raw paths that the generated HTTP
    // ingress would normalize away. Use the actual factory's worker AND fetch
    // closure, not an injected always-allow authorizer or replacement forwarder.
    if (mode === "queue_v1") {
      it.each([
        ...INVALID,
        {
          name: "query smuggled into envelope path",
          method: "POST",
          target: "/api/issues/issue-1?ignored=/comments",
        },
      ])(
        "raw queue envelope: zero forwards for $name",
        async ({ method, target }) => {
          const dirs = sandboxCallbackBridgeDirectories(queueDir);
          const id = "synthetic-raw-target";
          await writeFile(
            path.join(dirs.requestsDir, `${id}.json`),
            JSON.stringify({
              id,
              method,
              path: target,
              query: "",
              headers: { "content-type": "application/json" },
              body: JSON_BODY.toString(),
              createdAt: new Date().toISOString(),
            }),
          );
          let response: Reply | undefined;
          await vi.waitFor(
            async () => {
              const envelope = JSON.parse(
                await readFile(
                  path.join(dirs.responsesDir, `${id}.json`),
                  "utf8",
                ),
              );
              response = {
                status: envelope.status,
                body: Buffer.from(envelope.body),
                headers: envelope.headers,
              };
            },
            { timeout: 5_000, interval: 10 },
          );
          expectDenied(response as Reply, forwards);
        },
      );
    }
  },
);

describe.each(["raw HTTP2 stream", "generated HTTP2 ingress"] as const)(
  "canonical callback target: %s",
  (mode) => {
    let client: http2.ClientHttp2Session;
    let handler: Handler;
    let forwarded: Http2BridgeForwardRequest[];

    beforeEach(async () => {
      forwarded = [];
      const [serverSide, clientSide] = duplexPair();
      const host = createHttp2BridgeServer({
        bridgeToken: H2_TOKEN,
        closeGraceMs: 20,
        forwardRequest: async (request) => {
          forwarded.push(request);
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from('{"ok":true}'),
          };
        },
      });
      host.bindChannel(channelFor(serverSide));
      cleanups.push(async () => {
        await host.close();
        client?.destroy();
        clientSide.destroy();
        serverSide.destroy();
      });
      if (mode === "raw HTTP2 stream") {
        client = http2.connect("http://offline.example.test", {
          createConnection: () => clientSide,
        });
      } else {
        handler = await loadGateway(
          {
            PAPERCLIP_API_BRIDGE_MODE: "http2_v1",
            PAPERCLIP_BRIDGE_TOKEN: H2_TOKEN,
            PAPERCLIP_BRIDGE_PORT: "31999",
            PAPERCLIP_BRIDGE_NONCE: "synthetic-nonce",
          },
          clientSide,
        );
      }
    });

    async function send(request: {
      method: string;
      target: string;
      token?: string;
      body?: Buffer;
      contentType?: string;
    }): Promise<Reply> {
      if (mode === "generated HTTP2 ingress") return deliver(handler, request);
      return new Promise((resolve, reject) => {
        const stream = client.request(
          {
            ":method": request.method,
            ":path": request.target,
            ...(request.token === undefined
              ? {}
              : { authorization: `Bearer ${request.token}` }),
            "content-type": request.contentType ?? "application/json",
            accept: "application/json",
            "if-match": '"synthetic-match"',
            "if-none-match": 'W/"synthetic-cache"',
            "x-paperclip-github-capability": "synthetic-broker-capability",
            cookie: "session=synthetic-cookie",
            "x-paperclip-run-id": "spoofed-run",
            "x-bridge-debug": "synthetic-drop-me",
          },
          { endStream: false },
        );
        let status = 0;
        const chunks: Buffer[] = [];
        stream.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        stream.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        stream.on("end", () =>
          resolve({ status, headers: {}, body: Buffer.concat(chunks) }),
        );
        stream.on("error", reject);
        stream.end(request.body);
      });
    }

    // Node's real HTTP/2 engine refuses absolute-form :path before our host
    // handler. Do not report those transport resets as application-policy tests.
    const reachable =
      mode === "raw HTTP2 stream"
        ? INVALID.filter((test) => !test.target.startsWith("https://"))
        : INVALID;
    it.each(reachable)(
      "zero forwards for $name",
      async ({ method, target }) => {
        const reply = await send({
          method,
          target,
          token: H2_TOKEN,
          body: method === "GET" ? undefined : JSON_BODY,
        });
        expectDenied(reply, forwarded);
      },
    );

    if (mode === "raw HTTP2 stream") {
      it.each(INVALID.filter((test) => test.target.startsWith("https://")))(
        "transport-only refusal (host unreachable): $name",
        async ({ method, target }) => {
          await expect(
            send({ method, target, token: H2_TOKEN, body: JSON_BODY }),
          ).rejects.toThrow(/NGHTTP2_PROTOCOL_ERROR/);
          expect(forwarded).toEqual([]);
        },
      );
    }

    it.each(RESTRICTED)(
      "retains restriction: $name",
      async ({ method, target }) => {
        expectDenied(
          await send({
            method,
            target,
            token: H2_TOKEN,
            body: method === "GET" ? undefined : JSON_BODY,
          }),
          forwarded,
        );
      },
    );

    async function assertPositive(
      control: (typeof VALID)[number],
      query: string,
    ) {
      const reply = await send({
        ...control,
        target: control.target + query,
        token: H2_TOKEN,
      });
      expect(reply.status).toBe(200);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({
        method: control.method,
        pathname: control.target,
        query,
        body: control.body,
      });
      expectAllowedHeaders(forwarded[0].headers, control.contentType);
      expect(forwarded[0].headers.authorization).toBeUndefined();
      expect(forwarded[0].headers["x-paperclip-run-id"]).toBeUndefined();
      expect(JSON.stringify(forwarded[0])).not.toContain(H2_TOKEN);
    }

    it.each(VALID)(
      "positive $name preserves path, query, bytes and allowed headers",
      async (control) => {
        await assertPositive(control, "?view=compact&literal=%23");
      },
    );

    it.each(VALID)(
      "query separation: $name permits traversal-looking query data",
      async (control) => {
        await assertPositive(control, QUERY);
      },
    );

    it.each([undefined, "wrong-bridge-token", HOST_TOKEN])(
      "does not accept missing/wrong/host credentials (%s)",
      async (token) => {
        const reply = await send({
          method: "POST",
          target: "/api/issues/issue-1/comments",
          token,
          body: JSON_BODY,
        });
        expect(forwarded).toEqual([]);
        expect(reply.status).toBe(401);
      },
    );
  },
);

// Worker policy must not disappear when a caller uses the exported queue worker
// independently of the execution-target factory. No custom authorization seam.
describe("standalone public queue worker canonical-target boundary", () => {
  it.each(INVALID)(
    "zero handler attempts for $name",
    async ({ method, target }) => {
      const root = await mkdtemp(
        path.join(
          process.env.PAPERCLIP_SCRATCH_DIR ?? os.tmpdir(),
          "callback-worker-acceptance-",
        ),
      );
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const dirs = sandboxCallbackBridgeDirectories(root);
      await mkdir(dirs.requestsDir, { recursive: true });
      const id = "synthetic-request";
      await writeFile(
        path.join(dirs.requestsDir, `${id}.json`),
        JSON.stringify({
          id,
          method,
          path: target,
          query: "",
          headers: {},
          body: "{}",
          createdAt: new Date().toISOString(),
        }),
      );
      const handled: unknown[] = [];
      const worker = await startSandboxCallbackBridgeWorker({
        client: createFileSystemSandboxCallbackBridgeQueueClient(),
        queueDir: root,
        handleRequest: async (request) => {
          handled.push(request);
          return { status: 200, body: "{}" };
        },
      });
      cleanups.push(() => worker.stop());
      await worker.stop({ drainTimeoutMs: 5_000 });
      const response = JSON.parse(
        await readFile(path.join(dirs.responsesDir, `${id}.json`), "utf8"),
      );
      expectDenied(
        {
          status: response.status,
          headers: response.headers,
          body: Buffer.from(response.body),
        },
        handled,
      );
    },
  );
});
