import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo, Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Server as TlsServer } from "node:tls";
import { afterAll } from "vitest";

type SupertestServer = NetServer & {
  address(): ReturnType<NetServer["address"]>;
  listen(port: number): NetServer;
};

type SupertestTestInstance = {
  _server?: SupertestServer;
};

type SupertestTestConstructor = {
  prototype: {
    serverAddress(this: SupertestTestInstance, app: SupertestServer, path: string): string;
    __paperclipLoopbackPatched?: boolean;
  };
};

const require = createRequire(import.meta.url);
const SupertestTest = require("supertest/lib/test.js") as SupertestTestConstructor;

// Route and service suites that reach the codex adapter resolve its managed
// home and auth cache under the Paperclip instance root. Left to the
// environment that is the developer's (or the live server's) own instance, and
// each run would leave `companies/<id>/codex-home` and `codex-auth-cache`
// directories in it. Use a throwaway root per test file; suites that need a
// specific home set their own and restore this one.
//
// The runtime-context and skill-cache snapshots under that root are made
// read-only (0o555) on purpose, and a read-only directory cannot have its
// entries unlinked, so make the tree writable before removing it.
function removeTestDirectory(directory: string) {
  const makeWritable = (current: string) => {
    fs.chmodSync(current, 0o700);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) makeWritable(path.join(current, entry.name));
    }
  };
  try {
    makeWritable(directory);
  } catch {
    // Already gone or unreadable; rmSync below reports anything that matters.
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

const testPaperclipHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-home-"));
process.env.PAPERCLIP_HOME = testPaperclipHome;
afterAll(() => {
  removeTestDirectory(testPaperclipHome);
});

if (!process.env.CODEX_HOME) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-codex-home-"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-vitest"}\n', { mode: 0o600 });
  process.env.CODEX_HOME = codexHome;
  afterAll(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
  });
}

// The automatic Tailscale HTTPS default (PAP-17158) probes for a real host
// broker socket, so leaving it enabled would make every test that starts a
// service named `paperclip-dev` behave differently on a broker-capable host
// than on CI. Tests that exercise the default opt in explicitly.
if (!process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS) {
  process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = "off";
}

if (!SupertestTest.prototype.__paperclipLoopbackPatched) {
  SupertestTest.prototype.serverAddress = function serverAddress(app, path) {
    const addr = app.address();

    if (!addr) {
      this._server = app.listen(0) as SupertestServer;
    }

    const listeningAddress = app.address() as AddressInfo | string | null;
    if (!listeningAddress || typeof listeningAddress === "string") {
      throw new Error("Expected Supertest server to listen on a TCP port");
    }

    const host = listeningAddress.address === "::"
      ? "[::1]"
      : listeningAddress.address === "0.0.0.0"
        ? "127.0.0.1"
        : listeningAddress.address;
    const protocol = app instanceof TlsServer ? "https" : "http";
    return `${protocol}://${host}:${listeningAddress.port}${path}`;
  };

  SupertestTest.prototype.__paperclipLoopbackPatched = true;
}
