import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as netCreateServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  PluginHttpResponseTooLargeError,
  executePinnedHttpRequest,
  resolvePluginFetchByteLimit,
  runPluginHttpFetch,
  type ValidatedFetchTarget,
} from "../services/plugin-host-services.js";

/**
 * TWO-424 — `ctx.http.fetch` byte cap, redirect mode and abort.
 *
 * The host used to buffer up to 200 MB before any plugin-side cap ran, and it
 * dropped `redirect` and `signal`. These tests hit loopback servers through the
 * pinned request path directly: the SSRF resolver refuses loopback, so the
 * redirect tests inject a resolver that pins every hop to the test server.
 */

const openServers: Array<Server | NetServer> = [];
const openSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server | NetServer): Promise<number> {
  openServers.push(server);
  server.on("connection", (socket: Socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

async function httpServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return listen(createServer(handler));
}

function loopbackTarget(port: number, path = "/"): ValidatedFetchTarget {
  return {
    parsedUrl: new URL(`http://plugin-fetch.test:${port}${path}`),
    resolvedAddress: "127.0.0.1",
    hostHeader: `plugin-fetch.test:${port}`,
    useTls: false,
  };
}

const loopbackResolver = async (url: string) => {
  const parsed = new URL(url);
  return { ...loopbackTarget(Number(parsed.port)), parsedUrl: parsed, hostHeader: parsed.host };
};

describe("plugin http.fetch response byte cap", () => {
  it("returns a body that fits under maxResponseBytes", async () => {
    const port = await httpServer((_req, res) => res.end("x".repeat(1000)));

    const result = await executePinnedHttpRequest(loopbackTarget(port), undefined, new AbortController().signal, 1000);

    expect(result.status).toBe(200);
    expect(result.body).toHaveLength(1000);
  });

  it("aborts an endless chunked body as soon as it crosses the cap", async () => {
    let bytesSent = 0;
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
    const port = await httpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }); // no content-length: chunked
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      const timer = setInterval(() => {
        bytesSent += chunk.length;
        res.write(chunk);
      }, 1);
      res.on("close", () => {
        clearInterval(timer);
        closed();
      });
    });

    const error = await executePinnedHttpRequest(
      loopbackTarget(port),
      undefined,
      new AbortController().signal,
      64 * 1024,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PluginHttpResponseTooLargeError);
    expect((error as PluginHttpResponseTooLargeError).code).toBe(PLUGIN_RPC_ERROR_CODES.HTTP_RESPONSE_TOO_LARGE);
    expect((error as Error).message).toContain("while streaming");
    // The host hung up; the server did not keep streaming into it.
    await socketClosed;
    expect(bytesSent).toBeLessThan(10 * 1024 * 1024);
  });

  it("refuses a declared content-length over the cap before reading the body", async () => {
    const port = await httpServer((_req, res) => {
      // Claims 10 GB, sends a little, then stalls: only the header can trigger the cap.
      res.writeHead(200, { "content-length": String(10 * 1024 * 1024 * 1024) });
      res.write("partial");
    });

    const error = await executePinnedHttpRequest(
      loopbackTarget(port),
      undefined,
      new AbortController().signal,
      1024,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PluginHttpResponseTooLargeError);
    expect((error as Error).message).toContain("content-length");
  });

  it("does not trust a false, small content-length on an oversized body", async () => {
    // Raw socket: declare 16 bytes, then send 1 MB. The parser must stop at the
    // declared length (or fail); the host never buffers the extra bytes.
    const server = netCreateServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\ncontent-length: 16\r\nconnection: close\r\n\r\n");
        socket.end(Buffer.alloc(1024 * 1024, 0x62));
      });
    });
    const port = await listen(server);

    const outcome = await executePinnedHttpRequest(
      loopbackTarget(port),
      undefined,
      new AbortController().signal,
      1024,
    ).then((result) => ({ body: result.body }), (err: unknown) => ({ err }));

    if ("body" in outcome) {
      expect(outcome.body.length).toBeLessThanOrEqual(16);
    } else {
      expect(outcome.err).toBeInstanceOf(Error);
    }
  });

  it("validates maxResponseBytes and clamps it to the host-wide cap", () => {
    expect(resolvePluginFetchByteLimit(undefined)).toBe(200 * 1024 * 1024);
    expect(resolvePluginFetchByteLimit(4096)).toBe(4096);
    expect(resolvePluginFetchByteLimit(0)).toBe(0);
    expect(resolvePluginFetchByteLimit(Number.MAX_SAFE_INTEGER)).toBe(200 * 1024 * 1024);
    for (const bad of [-1, 1.5, Number.NaN, "1024", Infinity]) {
      expect(() => resolvePluginFetchByteLimit(bad)).toThrow(/maxResponseBytes/);
    }
  });
});

describe("plugin http.fetch abort", () => {
  it("rejects promptly when the signal aborts mid-body", async () => {
    const port = await httpServer((_req, res) => {
      res.writeHead(200);
      res.write("first chunk"); // then stall forever
    });
    const controller = new AbortController();

    const pending = executePinnedHttpRequest(loopbackTarget(port), undefined, controller.signal);
    setTimeout(() => controller.abort(), 50);

    await expect(pending).rejects.toThrow();
  });
});

describe("plugin http.fetch redirect mode", () => {
  async function redirectServer() {
    const seen: Array<{ url: string; method: string; authorization?: string; body: string }> = [];
    const port = await httpServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ url: req.url ?? "", method: req.method ?? "", authorization: req.headers.authorization, body });
        if (req.url === "/start") {
          res.writeHead(302, { location: "/final" });
          res.end();
        } else if (req.url === "/see-other") {
          res.writeHead(303, { location: "/final" });
          res.end();
        } else if (req.url === "/loop") {
          res.writeHead(307, { location: "/loop" });
          res.end();
        } else {
          res.end("final");
        }
      });
    });
    return { port, seen };
  }

  it("returns the 3xx as-is when redirect is unset or manual", async () => {
    const { port, seen } = await redirectServer();
    for (const init of [undefined, { redirect: "manual" } as RequestInit]) {
      const result = await runPluginHttpFetch(
        `http://127.0.0.1:${port}/start`, init, new AbortController().signal, 1024, loopbackResolver,
      );
      expect(result.status).toBe(302);
      expect(result.headers.location).toBe("/final");
    }
    expect(seen.map((r) => r.url)).toEqual(["/start", "/start"]);
  });

  it("rejects on a 3xx when redirect is error", async () => {
    const { port } = await redirectServer();
    await expect(runPluginHttpFetch(
      `http://127.0.0.1:${port}/start`, { redirect: "error" }, new AbortController().signal, 1024, loopbackResolver,
    )).rejects.toThrow(/redirect mode is "error"/);
  });

  it("follows and re-resolves each hop when redirect is follow", async () => {
    const { port, seen } = await redirectServer();
    const resolved: string[] = [];
    const result = await runPluginHttpFetch(
      `http://127.0.0.1:${port}/start`,
      { redirect: "follow" },
      new AbortController().signal,
      1024,
      async (url) => { resolved.push(new URL(url).pathname); return loopbackResolver(url); },
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe("final");
    expect(resolved).toEqual(["/start", "/final"]);
    expect(seen.map((r) => r.url)).toEqual(["/start", "/final"]);
  });

  it("turns a 303 after POST into a bodiless GET", async () => {
    const { port, seen } = await redirectServer();
    await runPluginHttpFetch(
      `http://127.0.0.1:${port}/see-other`,
      { redirect: "follow", method: "POST", body: "payload", headers: { "content-type": "text/plain" } },
      new AbortController().signal,
      1024,
      loopbackResolver,
    );
    expect(seen.map((r) => [r.url, r.method, r.body])).toEqual([
      ["/see-other", "POST", "payload"],
      ["/final", "GET", ""],
    ]);
  });

  it("drops authorization when a followed redirect changes origin", async () => {
    const final = await redirectServer();
    const hop = await httpServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${final.port}/final` });
      res.end();
    });
    await runPluginHttpFetch(
      `http://127.0.0.1:${hop}/`,
      { redirect: "follow", headers: { authorization: "Bearer secret" } },
      new AbortController().signal,
      1024,
      loopbackResolver,
    );
    expect(final.seen).toHaveLength(1);
    expect(final.seen[0]!.authorization).toBeUndefined();
  });

  it("stops after too many redirects", async () => {
    const { port } = await redirectServer();
    await expect(runPluginHttpFetch(
      `http://127.0.0.1:${port}/loop`, { redirect: "follow" }, new AbortController().signal, 1024, loopbackResolver,
    )).rejects.toThrow(/Too many redirects/);
  });
});
