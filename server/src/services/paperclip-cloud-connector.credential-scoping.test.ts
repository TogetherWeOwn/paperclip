/**
 * Credential-to-destination scoping acceptance tests: cloud connector
 * redirect posture (T8).
 *
 * The connector POSTs body secrets (refreshToken/token/binding) with plain
 * `fetch` and no `redirect` option: a 307/308 from the connector endpoint
 * re-sends the body — including the secret — to the redirect target.
 * T8.3/T8.4 pin the required end state (explicit no-follow posture; no body
 * secret reaches a foreign origin) and FAIL until B4 lands or a CISO
 * exception is recorded. Local stub servers and synthetic keys only; real
 * ed25519/x25519 keypairs are generated per test. Builder must not edit this
 * file.
 */
import { createServer } from "node:http";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPaperclipCloudConnector,
  type PaperclipCloudConnectorConfig,
} from "./paperclip-cloud-connector.js";

const SYNTHETIC_REFRESH_TOKEN = "SYNTHETIC-REFRESH-TOKEN-CANARY-0001";

function rawPrivateKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { d?: string };
  if (!jwk.d) throw new Error("missing private key bytes");
  return jwk.d;
}

function testConfig(baseUrl: string): PaperclipCloudConnectorConfig {
  const signing = generateKeyPairSync("ed25519");
  const sealing = generateKeyPairSync("x25519");
  return {
    baseUrl,
    instanceId: "inst_scoping_test",
    environment: "staging",
    signPrivateKey: rawPrivateKey(signing.privateKey),
    sealPrivateKey: rawPrivateKey(sealing.privateKey),
  };
}

describe("cloud connector redirect scoping", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("T8.3: connector requests carry an explicit no-follow redirect posture", async () => {
    const seen: RequestInit[] = [];
    const connector = createPaperclipCloudConnector({
      config: testConfig("https://connector.example.invalid"),
      request: (async (_url: unknown, init?: RequestInit) => {
        if (init) seen.push(init);
        return Response.json({ status: "active" });
      }) as typeof fetch,
    });
    await connector.getInstanceStatus().catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    for (const init of seen) {
      expect(init.redirect ?? "follow").toMatch(/^(manual|error)$/);
    }
  });

  it("T8.4: a 307/308 from the connector endpoint forwards no body secret to the foreign origin", { timeout: 30_000 }, async () => {
    const foreignBodies: string[] = [];
    const foreign = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        foreignBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => foreign.close((error) => (error ? reject(error) : resolve()))));
    const foreignPort = (foreign.address() as { port: number }).port;

    const endpoint = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${foreignPort}/collect` });
      res.end(JSON.stringify({ redirect: true }));
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => endpoint.close((error) => (error ? reject(error) : resolve()))));
    const endpointPort = (endpoint.address() as { port: number }).port;

    const connector = createPaperclipCloudConnector({
      config: testConfig(`http://127.0.0.1:${endpointPort}`),
    });
    await connector
      .refresh({
        subject: "user_scoping",
        companyId: "company_scoping",
        profile: "gmail.read",
        refreshToken: SYNTHETIC_REFRESH_TOKEN,
      })
      .catch(() => undefined);

    expect(foreignBodies).toEqual([]);
    expect(foreignBodies.join("\n")).not.toContain(SYNTHETIC_REFRESH_TOKEN);
  });
});
