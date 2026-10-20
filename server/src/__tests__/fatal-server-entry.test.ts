import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

function runServerEntry(main: boolean) {
  const entryUrl = new URL("../index.ts", import.meta.url);
  const policyUrl = new URL("../fatal-exception-policy.ts", import.meta.url);
  const compile = (url: URL) => transformSync(readFileSync(url, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "node24",
    sourcefile: fileURLToPath(url),
    // The VM loader supplies this module's real URL, like an ESM loader would.
    define: { "import.meta.url": JSON.stringify(entryUrl.href) },
  }).code;
  const entryCode = compile(entryUrl);
  const policyCode = compile(policyUrl);
  // Execute the entire production entry and real fatal policy in a disposable
  // process. Only external startup/SDK dependencies are replaced. In particular,
  // neither startServer nor the installer is rewritten or called by this test.
  const script = `
    const { Script } = require("node:vm");
    const nativeRequire = require;
    const send = (kind, fields = {}) => console.log(JSON.stringify({ kind, ...fields }));
    let makeSentryReady;
    let finishShutdown;
    const sentryReady = new Promise(resolve => { makeSentryReady = resolve; });
    const shutdownDone = new Promise(resolve => { finishShutdown = resolve; });
    const describeError = error => ({ name: error.name, message: error.message });
    const sentinel = new RangeError("hermetic entry fault");
    const stubs = {
      "./instrumentation.js": {
        // Stop real startup before Sentry readiness, configuration, DB, or HTTP.
        instrumentationReady: new Promise(() => {}),
      },
      "./sentry.js": {
        sentryReady,
        captureException(error) { send("capture", describeError(error)); },
        shutdownSentry() {
          send("shutdown-start");
          return shutdownDone.then(() => { send("shutdown-complete"); });
        },
      },
      "./middleware/logger.js": {
        logger: {
          fatal({ err }, message) { send("fatal", { log: message, ...describeError(err) }); },
        },
      },
      "./startup-recovery-state.js": {
        setStartupRecoveryPhase(phase) { send("startup-phase", { phase }); },
      },
      "@paperclipai/shared/node-version": { warnIfUnsupportedNodeVersion() {} },
    };
    function load(code, filename) {
      const module = { exports: {} };
      new Script("(function(require, module, exports) {\\n" + code + "\\n})", { filename })
        .runInThisContext()(dependency, module, module.exports);
      return module.exports;
    }
    let policy;
    function dependency(name) {
      if (name === "./fatal-exception-policy.js") {
        return policy ??= load(${JSON.stringify(policyCode)}, ${JSON.stringify(fileURLToPath(policyUrl))});
      }
      if (["node:path", "node:url", "node:process"].includes(name)) return nativeRequire(name);
      const stub = stubs[name] ?? {};
      // Fail closed if startup ever crosses the blocked instrumentation await.
      // Unknown imports are inert, never resolved to real DB/network modules.
      return new Proxy({ __esModule: true, ...stub }, {
        get(target, key) {
          if (key in target) return target[key];
          throw new Error("unexpected startup dependency: " + name + "." + String(key));
        },
      });
    }
    process.on("exit", code => send("exit", { code }));
    process.argv[1] = ${JSON.stringify(main ? fileURLToPath(entryUrl) : "/hermetic/importer.cjs")};
    load(${JSON.stringify(entryCode)}, ${JSON.stringify(fileURLToPath(entryUrl))});
    send("binding", { listeners: process.listenerCount("uncaughtException") });
    if (${JSON.stringify(main)}) {
      // A genuine uncaught exception reaches the actual Node process listener.
      setImmediate(() => { throw sentinel; });
      // Leave a complete event-loop turn for the fatal handler's microtasks.
      // Node need not drain them immediately after a callback throws.
      setImmediate(() => setImmediate(() => {
        send("before-ready");
        send("sentry-ready");
        makeSentryReady();
        setImmediate(() => {
          send("before-shutdown-complete");
          finishShutdown();
        });
      }));
    }
  `;
  return spawnSync(process.execPath, ["--input-type=commonjs", "--eval", script], {
    encoding: "utf8",
    timeout: 10_000,
    // Never inherit live DB, monitoring, provider, or Paperclip credentials.
    env: {},
  });
}

describe("fatal policy production server entry binding", () => {
  it("binds the real process and logs, awaits readiness, captures, flushes, then exits 1", () => {
    // Removing the installer from index.ts must fail this test even though the
    // helper-only tests and Node's default exit status would still pass.
    const child = runServerEntry(true);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(1);
    const events = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((event) => event.kind === "binding")).toEqual({ kind: "binding", listeners: 1 });
    expect(child.stderr).toBe("");
    expect(events.map((event) => event.kind)).toEqual([
      "startup-phase",
      "binding",
      "fatal",
      "before-ready",
      "sentry-ready",
      "capture",
      "shutdown-start",
      "before-shutdown-complete",
      "shutdown-complete",
      "exit",
    ]);
    expect(events[0]).toEqual({ kind: "startup-phase", phase: "starting" });
    expect(events[1]).toEqual({ kind: "binding", listeners: 1 });
    expect(events[2]).toMatchObject({
      name: "RangeError",
      message: "hermetic entry fault",
      log: expect.stringMatching(/fatal uncaught exception/),
    });
    expect(events[5]).toEqual({ kind: "capture", name: "RangeError", message: "hermetic entry fault" });
    expect(events[9]).toEqual({ kind: "exit", code: 1 });
  });

  it("does not install a process listener or start the server when imported", () => {
    const child = runServerEntry(false);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { kind: "binding", listeners: 0 },
      { kind: "exit", code: 0 },
    ]);
  });
});
