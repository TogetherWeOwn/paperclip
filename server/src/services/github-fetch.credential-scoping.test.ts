/**
 * Credential-to-destination scoping acceptance tests: ghFetch redirect
 * posture (T8).
 *
 * Server-side api.github.com callers use `ghFetch`, a bare `fetch`
 * passthrough with default redirect-follow. T8.5/T8.6 pin the undici
 * redirect-auth behavior (stripped cross-origin, preserved same-origin) as
 * controls; T8.7 requires an explicit redirect posture and FAILS until B4
 * lands or a CISO exception is recorded; T8.8 pins the connect-failure
 * mapping. Local stub servers and synthetic tokens only. Builder must not
 * edit this file.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ghFetch } from "./github-fetch.js";

const SYNTHETIC_GH_TOKEN = "SYNTHETIC-GH-TOKEN-CANARY-0001";

describe("ghFetch redirect posture", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function startStub(
    handler: (
      req: { url?: string; authorization: unknown },
      body: string,
    ) => { status: number; headers?: Record<string, string>; body: string },
    observed: Array<{ url?: string; authorization: unknown; body: string }>,
  ): Promise<string> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const record = {
          url: req.url,
          authorization: req.headers.authorization,
          body,
        };
        observed.push(record);
        const out = handler(
          { url: req.url, authorization: req.headers.authorization },
          body,
        );
        res.writeHead(
          out.status,
          out.headers ?? { "content-type": "application/json" },
        );
        res.end(out.body);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const { port } = server.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  }

  it("T8.5: a cross-origin redirect carries no Authorization to the foreign origin", {
    timeout: 30_000,
  }, async () => {
    const foreignObserved: Array<{
      url?: string;
      authorization: unknown;
      body: string;
    }> = [];
    const foreign = await startStub(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      foreignObserved,
    );
    const firstObserved: Array<{
      url?: string;
      authorization: unknown;
      body: string;
    }> = [];
    const first = await startStub(
      () => ({
        status: 302,
        headers: { location: `${foreign}/target` },
        body: JSON.stringify({}),
      }),
      firstObserved,
    );

    const response = await ghFetch(`${first}/resource`, {
      headers: { authorization: `Bearer ${SYNTHETIC_GH_TOKEN}` },
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer().catch(() => undefined);

    expect(firstObserved).toHaveLength(1);
    expect(firstObserved[0]?.authorization).toBe(
      `Bearer ${SYNTHETIC_GH_TOKEN}`,
    );
    expect(foreignObserved).toHaveLength(1);
    expect(foreignObserved[0]?.authorization).toBeUndefined();
  });

  it("T8.6: a same-origin redirect preserves Authorization (documented undici behavior)", {
    timeout: 30_000,
  }, async () => {
    const observed: Array<{
      url?: string;
      authorization: unknown;
      body: string;
    }> = [];
    let origin = "";
    origin = await startStub((req) => {
      if (req.url === "/start") {
        return {
          status: 302,
          headers: { location: `${origin}/final` },
          body: JSON.stringify({}),
        };
      }
      return { status: 200, body: JSON.stringify({ ok: true }) };
    }, observed);

    const response = await ghFetch(`${origin}/start`, {
      headers: { authorization: `Bearer ${SYNTHETIC_GH_TOKEN}` },
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer().catch(() => undefined);

    expect(observed).toHaveLength(2);
    expect(observed[1]?.authorization).toBe(`Bearer ${SYNTHETIC_GH_TOKEN}`);
  });

  it("T8.7: ghFetch sets an explicit redirect posture instead of relying on the fetch default", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", (async (_url: unknown, init?: RequestInit) => {
      if (init) seen.push(init);
      return Response.json({ ok: true });
    }) as typeof fetch);
    const response = await ghFetch("https://api.github.com/rate_limit", {
      headers: { authorization: `Bearer ${SYNTHETIC_GH_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBeDefined();
  });

  it("T8.8: connect failures map to an unprocessable host error without leaking the URL", async () => {
    const error = await ghFetch(
      `https://github-unreachable.invalid/x?token=${SYNTHETIC_GH_TOKEN}`,
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("github-unreachable.invalid");
    expect((error as Error).message).not.toContain(SYNTHETIC_GH_TOKEN);
  });
});
