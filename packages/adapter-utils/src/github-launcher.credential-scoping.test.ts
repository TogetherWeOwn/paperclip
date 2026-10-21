/**
 * Credential-to-destination scoping acceptance tests: GitHub launcher broker
 * base validation (T8) and managed-broker success path (T5).
 *
 * The launcher POSTs the run's GitHub capability to
 * `PAPERCLIP_GITHUB_BROKER_URL || PAPERCLIP_API_URL` with no host validation
 * today: steering either var at an attacker's host exfiltrates the
 * capability. T8.1a/T8.1b pin the required end state — refuse before the
 * capability is sent — and FAIL until B4 lands (or a CISO exception is
 * recorded). T5.2/T8.2 pin the success and no-follow behavior as controls.
 * Real launcher execution against local stub servers; synthetic credentials
 * only. Builder must not edit this file.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  githubBrokerEnvironment,
  githubLauncherSource,
} from "./github-launcher.js";

const exec = promisify(execFile);

const SYNTHETIC_BROKER_TOKEN = "SYNTHETIC-BROKER-CAPABILITY-0001";
const SYNTHETIC_API_URL = "https://paperclip-host.invalid";
const SYNTHETIC_GH_TOKEN = "SYNTHETIC-MANAGED-GH-TOKEN-0002";

interface RecordedRequest {
  method: string;
  url: string;
  capability: unknown;
  authorization: unknown;
  body: string;
}

describe("launcher broker-base scoping", () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function stageLauncher() {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-launcher-scoping-"),
    );
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    const realBin = path.join(root, "real");
    await mkdir(bin);
    await mkdir(realBin);
    await writeFile(path.join(bin, "gh"), githubLauncherSource(), {
      mode: 0o700,
    });
    await writeFile(
      path.join(realBin, "gh"),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));",
      { mode: 0o700 },
    );
    return { root, bin, realBin };
  }

  async function startRecorder(
    handler: (recorded: RecordedRequest) => {
      status: number;
      headers?: Record<string, string>;
      body: string;
    },
  ): Promise<{ origin: string; requests: RecordedRequest[] }> {
    const requests: RecordedRequest[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const recorded: RecordedRequest = {
          method: req.method ?? "GET",
          url: req.url ?? "/",
          capability: req.headers["x-paperclip-github-capability"],
          authorization: req.headers.authorization,
          body,
        };
        requests.push(recorded);
        const out = handler(recorded);
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
    return { origin: `http://127.0.0.1:${port}`, requests };
  }

  it("T8.1a: a broker base outside the API origin is refused before the capability is sent", {
    timeout: 30_000,
  }, async () => {
    const { root, bin, realBin } = await stageLauncher();
    const evil = await startRecorder(() => ({
      status: 200,
      body: JSON.stringify({ status: "available", env: {} }),
    }));

    const result = await exec(path.join(bin, "gh"), [], {
      env: {
        ...process.env,
        ...githubBrokerEnvironment(
          {},
          { url: evil.origin, token: SYNTHETIC_BROKER_TOKEN },
        ),
        PAPERCLIP_API_URL: SYNTHETIC_API_URL,
        GH_CONFIG_DIR: root,
        PATH: `${bin}:${realBin}:${process.env.PATH}`,
      },
    });

    expect(evil.requests).toEqual([]);
    expect(result.stderr).toMatch(/Paperclip: GitHub /);
    expect(JSON.parse(result.stdout)).toEqual({ token: null });
  });

  it("T8.1b: an attacker path smuggled in the broker base never steers the credentials request", {
    timeout: 30_000,
  }, async () => {
    const { root, bin, realBin } = await stageLauncher();
    const evil = await startRecorder(() => ({
      status: 200,
      body: JSON.stringify({ status: "available", env: {} }),
    }));

    await exec(path.join(bin, "gh"), [], {
      env: {
        ...process.env,
        ...githubBrokerEnvironment(
          {},
          { url: `${evil.origin}/evil-path`, token: SYNTHETIC_BROKER_TOKEN },
        ),
        PAPERCLIP_API_URL: SYNTHETIC_API_URL,
        GH_CONFIG_DIR: root,
        PATH: `${bin}:${realBin}:${process.env.PATH}`,
      },
    });

    // Either the base is refused outright (no request) or the request lands
    // on exactly the credentials endpoint — never under the attacker path.
    for (const request of evil.requests) {
      expect(request.url).toBe("/runtime-tools/github/credentials");
    }
    expect(evil.requests.map((request) => request.url)).not.toContain(
      "/evil-path/runtime-tools/github/credentials",
    );
    if (evil.requests.length > 0) {
      expect(evil.requests).toHaveLength(1);
    }
  });

  it("T5.2: managed GitHub via the launcher broker succeeds against the stub broker", {
    timeout: 30_000,
  }, async () => {
    const { root, bin, realBin } = await stageLauncher();
    const broker = await startRecorder((recorded) => {
      expect(recorded.capability).toBe(SYNTHETIC_BROKER_TOKEN);
      expect(recorded.url).toBe("/runtime-tools/github/credentials");
      return {
        status: 200,
        body: JSON.stringify({
          status: "available",
          env: {
            GH_TOKEN: SYNTHETIC_GH_TOKEN,
            GITHUB_TOKEN: SYNTHETIC_GH_TOKEN,
          },
        }),
      };
    });

    const result = await exec(path.join(bin, "gh"), [], {
      env: {
        ...process.env,
        ...githubBrokerEnvironment(
          { GH_TOKEN: "ambient-host-token" },
          { url: broker.origin, token: SYNTHETIC_BROKER_TOKEN },
        ),
        PAPERCLIP_API_URL: broker.origin,
        GH_CONFIG_DIR: root,
        PATH: `${bin}:${realBin}:${process.env.PATH}`,
      },
    });

    expect(broker.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({ token: SYNTHETIC_GH_TOKEN });
    expect(result.stderr).not.toMatch(/ambient-host-token/);
  });

  it("T8.2: a redirect from the broker is never followed with the capability (redirect error pin)", {
    timeout: 30_000,
  }, async () => {
    const { root, bin, realBin } = await stageLauncher();
    const foreign = await startRecorder(() => ({
      status: 200,
      body: JSON.stringify({ status: "available", env: {} }),
    }));
    const broker = await startRecorder(() => ({
      status: 307,
      headers: { location: `${foreign.origin}/collect` },
      body: JSON.stringify({ redirect: true }),
    }));

    const result = await exec(path.join(bin, "gh"), [], {
      env: {
        ...process.env,
        ...githubBrokerEnvironment(
          {},
          { url: broker.origin, token: SYNTHETIC_BROKER_TOKEN },
        ),
        PAPERCLIP_API_URL: broker.origin,
        GH_CONFIG_DIR: root,
        PATH: `${bin}:${realBin}:${process.env.PATH}`,
      },
    });

    expect(broker.requests).toHaveLength(1);
    expect(foreign.requests).toEqual([]);
    expect(result.stderr).toMatch(/broker_transport_unavailable/);
    expect(JSON.parse(result.stdout)).toEqual({ token: null });
  });
});
