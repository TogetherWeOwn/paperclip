import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import net, { type Server } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_SSH_ENVELOPE_AUDIENCE } from "@paperclipai/adapter-utils/host-executor";
import { createNativeSshSignerDaemon, type NativeSshSignerDaemon } from "./native-ssh-signer-daemon.js";

// Only synthetic files and AF_UNIX listeners in this test's private scratch.
// Regressions caught: unconditional unlink, Node's original-bind-path unlink,
// insecure/created parents, overlapping lifecycle operations, and failed-bind leaks.
const keys = generateKeyPairSync("ed25519");
let root: string;
const daemons: NativeSshSignerDaemon[] = [];
const servers: Server[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "s-"));
  await fs.chmod(root, 0o700);
  const createServer = net.createServer;
  vi.spyOn(net, "createServer").mockImplementation((...args: Parameters<typeof net.createServer>) => {
    const server = createServer(...args);
    servers.push(server);
    return server;
  });
  // Production uses named builtin imports; keep them attached to the observed
  // real functions when installing/restoring failure injection.
  syncBuiltinESMExports();
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const daemon of daemons.splice(0).reverse()) await daemon.close().catch(() => {});
  for (const server of servers.splice(0).reverse()) await closeServer(server);
  await fs.rm(root, { recursive: true, force: true });
});

function daemonAt(socketPath = join(root, "s")) {
  syncBuiltinESMExports();
  const daemon = createNativeSshSignerDaemon({
    socketPath,
    expectedPeer: {
      uid: process.geteuid!(), gid: process.getegid!(),
      executable: "/usr/bin/synthetic-signer-client", executableSha256: "ab".repeat(32),
      cgroup: "/synthetic.service",
    },
    policy: { audience: NATIVE_SSH_ENVELOPE_AUDIENCE, maxLifetimeSeconds: 60 },
    privateKey: keys.privateKey,
    loadRecordedAuthority: () => null,
    peerResolver: () => null,
  });
  daemons.push(daemon);
  return daemon;
}

async function closeServer(server: Server) {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listenerAt(path: string) {
  const server = net.createServer((socket) => socket.end("synthetic-listener"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

async function readListener(path: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(path);
    let text = "";
    socket.setTimeout(1_000, () => socket.destroy(new Error("synthetic socket timed out")));
    socket.on("data", (chunk) => { text += chunk.toString(); });
    socket.once("error", reject);
    socket.once("end", () => { socket.destroy(); resolve(text); });
  });
}

async function identity(path: string) {
  const st = await fs.lstat(path);
  return { dev: st.dev, ino: st.ino, uid: st.uid, mode: st.mode, nlink: st.nlink };
}

async function attemptListen(daemon: NativeSshSignerDaemon) {
  syncBuiltinESMExports();
  return daemon.listen().then(() => null, (error: unknown) => error);
}

async function expectAbsent(path: string) {
  await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("signer socket ownership", () => {
  it("refuses an occupied regular file without changing its inode or contents", async () => {
    const path = join(root, "s");
    await fs.writeFile(path, "synthetic-sentinel");
    const before = await identity(path);
    const daemon = daemonAt(path);
    const error = await attemptListen(daemon);
    await daemon.close();
    expect.soft(error).toBeInstanceOf(Error);
    expect.soft(await identity(path).catch(() => null)).toEqual(before);
    expect(await fs.readFile(path, "utf8").catch(() => null)).toBe("synthetic-sentinel");
  });

  it("refuses an occupied symlink without changing the link or its target", async () => {
    const path = join(root, "s");
    const target = join(root, "sentinel");
    await fs.writeFile(target, "synthetic-target");
    await fs.symlink(target, path);
    const before = await identity(path);
    const targetBefore = await identity(target);
    const daemon = daemonAt(path);
    const error = await attemptListen(daemon);
    await daemon.close();
    expect.soft(error).toBeInstanceOf(Error);
    expect.soft(await identity(path).catch(() => null)).toEqual(before);
    expect.soft(await fs.readlink(path).catch(() => null)).toBe(target);
    expect.soft(await identity(target)).toEqual(targetBefore);
    expect(await fs.readFile(target, "utf8")).toBe("synthetic-target");
  });

  it("refuses an occupied live socket and leaves that listener reachable after close", async () => {
    const path = join(root, "s");
    await listenerAt(path);
    const before = await identity(path);
    const daemon = daemonAt(path);
    const error = await attemptListen(daemon);
    await daemon.close();
    expect.soft(error).toBeInstanceOf(Error);
    expect.soft(await identity(path).catch(() => null)).toEqual(before);
    expect(await readListener(path).catch(() => null)).toBe("synthetic-listener");
  });

  it.each(["file", "listener"])("close before listen preserves an unrelated %s", async (kind) => {
    const path = join(root, "s");
    if (kind === "file") await fs.writeFile(path, "synthetic-sentinel");
    else await listenerAt(path);
    const before = await identity(path);
    await daemonAt(path).close();
    expect.soft(await identity(path).catch(() => null)).toEqual(before);
    if (kind === "file") expect(await fs.readFile(path, "utf8").catch(() => null)).toBe("synthetic-sentinel");
    else expect(await readListener(path).catch(() => null)).toBe("synthetic-listener");
  });

  it.each(["file", "listener"])("close after a failed listen preserves an unrelated %s", async (kind) => {
    const path = join(root, "s");
    const daemon = daemonAt(path);
    const listen = vi.spyOn(net.Server.prototype, "listen").mockImplementationOnce(function (this: Server) {
      queueMicrotask(() => this.emit("error", Object.assign(new Error("synthetic bind failure"), { code: "EADDRINUSE" })));
      return this;
    });
    const error = await attemptListen(daemon);
    listen.mockRestore();
    if (kind === "file") await fs.writeFile(path, "synthetic-sentinel");
    else await listenerAt(path);
    const before = await identity(path);
    await daemon.close();
    expect.soft(error).toMatchObject({ code: "EADDRINUSE" });
    expect.soft(await identity(path).catch(() => null)).toEqual(before);
    if (kind === "file") expect(await fs.readFile(path, "utf8").catch(() => null)).toBe("synthetic-sentinel");
    else expect(await readListener(path).catch(() => null)).toBe("synthetic-listener");
  });

  it.each(["file", "listener"])("closing an owned socket preserves a replacement %s (including Node auto-unlink)", async (kind) => {
    const daemon = daemonAt();
    await daemon.listen();
    await fs.unlink(daemon.socketPath);
    if (kind === "file") await fs.writeFile(daemon.socketPath, "replacement-sentinel");
    else await listenerAt(daemon.socketPath);
    const before = await identity(daemon.socketPath);
    await daemon.close();
    expect.soft(await identity(daemon.socketPath).catch(() => null)).toEqual(before);
    if (kind === "file") expect(await fs.readFile(daemon.socketPath, "utf8").catch(() => null)).toBe("replacement-sentinel");
    else expect(await readListener(daemon.socketPath).catch(() => null)).toBe("synthetic-listener");
  });

  it("publishes a socket with mode 0660 and cleans up only its own socket and private directory", async () => {
    const daemon = daemonAt();
    await daemon.listen();
    const st = await fs.lstat(daemon.socketPath);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o660);
    const children = await fs.readdir(root, { withFileTypes: true });
    const privateDirs = children.filter((entry) => entry.isDirectory());
    expect(privateDirs).toHaveLength(1);
    const privatePath = join(root, privateDirs[0].name);
    expect((await fs.lstat(privatePath)).mode & 0o777).toBe(0o700);
    const bound = servers.map((server) => server.address()).find((address) => typeof address === "string");
    expect(typeof bound).toBe("string");
    expect(relative(privatePath, bound as string)).not.toMatch(/^\.\.|^\//);
    const privateSocket = await fs.lstat(bound as string);
    expect(privateSocket.isSocket()).toBe(true);
    expect({ dev: privateSocket.dev, ino: privateSocket.ino }).toEqual({ dev: st.dev, ino: st.ino });
    await daemon.close();
    await expectAbsent(daemon.socketPath);
    expect(await fs.readdir(root)).toEqual([]);
    expect(servers.every((server) => !server.listening)).toBe(true);
  });

  it("does not unlink a replacement parent directory's sentinel", async () => {
    const parent = join(root, "p");
    const moved = join(root, "old");
    await fs.mkdir(parent, { mode: 0o700 });
    const daemon = daemonAt(join(parent, "s"));
    await daemon.listen();
    await fs.rename(parent, moved);
    await fs.mkdir(parent, { mode: 0o700 });
    await fs.writeFile(daemon.socketPath, "new-parent-sentinel");
    const before = await identity(daemon.socketPath);
    await daemon.close();
    expect.soft(await identity(daemon.socketPath).catch(() => null)).toEqual(before);
    expect(await fs.readFile(daemon.socketPath, "utf8").catch(() => null)).toBe("new-parent-sentinel");
  });

  it("supports repeated listen and close without deleting a later sentinel", async () => {
    const daemon = daemonAt();
    await daemon.listen();
    await daemon.listen();
    await daemon.close();
    await fs.writeFile(daemon.socketPath, "after-close-sentinel");
    const before = await identity(daemon.socketPath);
    await daemon.close();
    expect.soft(await identity(daemon.socketPath).catch(() => null)).toEqual(before);
    expect(await fs.readFile(daemon.socketPath, "utf8").catch(() => null)).toBe("after-close-sentinel");
  });

  it("serializes concurrent listen calls and then removes its own socket", async () => {
    const daemon = daemonAt();
    await Promise.all([daemon.listen(), daemon.listen()]);
    expect((await fs.lstat(daemon.socketPath)).isSocket()).toBe(true);
    await Promise.all([daemon.close(), daemon.close()]);
    await expectAbsent(daemon.socketPath);
    expect(await fs.readdir(root)).toEqual([]);
    expect(servers.every((server) => !server.listening)).toBe(true);
  });

  it("serializes close behind an in-flight listen without leaking the published socket", async () => {
    const daemon = daemonAt();
    await Promise.all([daemon.listen(), daemon.close()]);
    await expectAbsent(daemon.socketPath);
    expect(await fs.readdir(root)).toEqual([]);
    expect(servers.every((server) => !server.listening)).toBe(true);
  });

  it("cleans up a post-bind chmod failure with no listening server left behind", async () => {
    const daemon = daemonAt();
    const chmod = fs.chmod;
    let injected = 0;
    vi.spyOn(fs, "chmod").mockImplementation(async (path, mode) => {
      if ((await fs.lstat(path)).isSocket()) {
        injected++;
        throw Object.assign(new Error("synthetic chmod failure"), { code: "EACCES" });
      }
      return chmod(path, mode);
    });
    const error = await attemptListen(daemon);
    expect.soft(injected).toBe(1);
    expect.soft(error).toMatchObject({ code: "EACCES" });
    // Assert BEFORE daemon.close(): failed listen must unwind itself.
    expect.soft(servers.every((server) => !server.listening)).toBe(true);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("cleans up a publication failure with no listening server left behind", async () => {
    const daemon = daemonAt();
    let injected = 0;
    vi.spyOn(fs, "link").mockImplementation(async () => {
      injected++;
      throw Object.assign(new Error("synthetic publication failure"), { code: "EACCES" });
    });
    const error = await attemptListen(daemon);
    expect.soft(injected).toBe(1);
    expect.soft(error).toMatchObject({ code: "EACCES" });
    expect.soft(servers.every((server) => !server.listening)).toBe(true);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("exclusive publication refuses a newly occupied path and preserves its sentinel", async () => {
    const daemon = daemonAt();
    const link = fs.link;
    let injected = 0;
    vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
      injected++;
      await fs.writeFile(destination, "publication-race-sentinel", { flag: "wx" });
      return link(source, destination);
    });
    const error = await attemptListen(daemon);
    await daemon.close();
    expect.soft(injected).toBe(1);
    expect.soft(error).toMatchObject({ code: "EEXIST" });
    expect.soft(servers.every((server) => !server.listening)).toBe(true);
    expect(await fs.readFile(daemon.socketPath, "utf8").catch(() => null)).toBe("publication-race-sentinel");
    expect(await fs.readdir(root)).toEqual(["s"]);
  });
});

describe("signer socket trusted parent", () => {
  it("refuses a missing parent instead of creating it", async () => {
    const parent = join(root, "missing");
    const daemon = daemonAt(join(parent, "s"));
    expect.soft(await attemptListen(daemon)).toBeInstanceOf(Error);
    await daemon.close();
    await expectAbsent(parent);
  });

  it.each([0o770, 0o707, 0o777])("refuses a group/other-writable parent (%s)", async (mode) => {
    await fs.chmod(root, mode);
    const before = await identity(root);
    const daemon = daemonAt();
    const error = await attemptListen(daemon);
    await daemon.close();
    expect.soft(error).toBeInstanceOf(Error);
    expect.soft(await identity(root)).toEqual(before);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a symlink parent without modifying the real directory", async () => {
    const real = join(root, "real");
    const alias = join(root, "alias");
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, alias);
    const before = await identity(real);
    const daemon = daemonAt(join(alias, "s"));
    expect.soft(await attemptListen(daemon)).toBeInstanceOf(Error);
    await daemon.close();
    expect.soft(await fs.readlink(alias)).toBe(real);
    expect.soft(await identity(real)).toEqual(before);
    expect(await fs.readdir(real)).toEqual([]);
  });

  it("refuses a noncanonical absolute path without modifying the canonical parent", async () => {
    const outcome = await Promise.resolve().then(async () => {
      const daemon = daemonAt(`${root}/../${root.split("/").at(-1)}/s`);
      const error = await attemptListen(daemon);
      await daemon.close();
      return error;
    }).catch((error) => error);
    expect.soft(outcome).toBeInstanceOf(Error);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a relative path before creating any files", async () => {
    // Constructor validation is also an acceptable refusal; no relative file is created.
    const outcome = await Promise.resolve().then(async () => attemptListen(daemonAt("./synthetic-signer.sock"))).catch((e) => e);
    expect(outcome).toBeInstanceOf(Error);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a parent not owned by the daemon euid (synthetic stat metadata)", async () => {
    // No chown or privilege changes: only the parent uid observation is substituted.
    const lstat = fs.lstat;
    const stat = fs.stat;
    const foreign = (value: Awaited<ReturnType<typeof fs.lstat>>) => new Proxy(value, {
      get(target, key) { return key === "uid" ? process.geteuid!() + 1 : Reflect.get(target, key); },
    });
    vi.spyOn(fs, "lstat").mockImplementation((async (path: Parameters<typeof fs.lstat>[0], options: never) => {
      const value = await lstat(path, options);
      return String(path) === root ? foreign(value) : value;
    }) as typeof fs.lstat);
    vi.spyOn(fs, "stat").mockImplementation((async (path: Parameters<typeof fs.stat>[0], options: never) => {
      const value = await stat(path, options);
      return String(path) === root ? foreign(value) : value;
    }) as typeof fs.stat);
    const daemon = daemonAt();
    const error = await attemptListen(daemon);
    await daemon.close();
    expect.soft(error).toBeInstanceOf(Error);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
