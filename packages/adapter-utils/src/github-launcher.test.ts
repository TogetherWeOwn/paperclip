import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource, LEGACY_GITHUB_LAUNCHER_SHA256 } from "./github-launcher.js";
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
// The launcher deployed before the recursion fix (b721d24ca), byte for byte.
const legacyLauncherSource = () => readFile(new URL("./test-fixtures/github-launcher-b721d24ca.txt", import.meta.url), "utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("managed GitHub launchers", () => {
  it("lists distinct SHA-256 digests of earlier launcher releases", () => {
    expect(new Set(LEGACY_GITHUB_LAUNCHER_SHA256).size).toBe(LEGACY_GITHUB_LAUNCHER_SHA256.length);
    for (const digest of LEGACY_GITHUB_LAUNCHER_SHA256) expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(LEGACY_GITHUB_LAUNCHER_SHA256).not.toContain(sha256(githubLauncherSource()));
  });

  it("passes the shim-free PATH to wrappers and reaches the next Git executable once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-path-wrapper-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const launcherDir = path.join(root, "managed");
    const otherLauncherDir = path.join(root, "other-managed");
    const legacyLauncherDir = path.join(root, "legacy-managed");
    const editedLauncherDir = path.join(root, "edited");
    const quotedLauncherDir = path.join(root, "quoted");
    const wrapperDir = path.join(root, "wrapper");
    const realDir = path.join(root, "real");
    for (const dir of [launcherDir, otherLauncherDir, legacyLauncherDir, editedLauncherDir, quotedLauncherDir, wrapperDir, realDir]) await mkdir(dir);
    const wrapperTrace = path.join(root, "wrapper-trace");
    const realTrace = path.join(root, "real-trace");
    await writeFile(path.join(launcherDir, "git"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(otherLauncherDir, "git"), githubLauncherSource(), { mode: 0o700 });
    const legacySource = await legacyLauncherSource();
    expect(LEGACY_GITHUB_LAUNCHER_SHA256).toContain(sha256(legacySource));
    await writeFile(path.join(legacyLauncherDir, "git"), legacySource, { mode: 0o700 });
    // Lookalikes are not byte-identical to any shipped launcher, so they must stay on PATH.
    // They only provide `gh`, so the launcher never resolves them as the next `git`.
    await writeFile(path.join(editedLauncherDir, "gh"), `${githubLauncherSource()}// local edit\n`, { mode: 0o700 });
    await writeFile(path.join(quotedLauncherDir, "gh"), `#!/usr/bin/env node
// Custom wrapper that only quotes launcher fingerprints, with a forged hash line.
// PAPERCLIP_GITHUB_LAUNCHER_SIGNATURE: paperclip-managed-github-launcher:v1:${"0".repeat(64)}
// const { spawn } = require('node:child_process');
// const directory = path.dirname(fs.realpathSync(process.argv[1]));
// const executable = originalPath.map(p => path.join(p, program)).find(p => {
// PAPERCLIP_GITHUB_BROKER_TOKEN /runtime-tools/github/credentials
`, { mode: 0o700 });
    await writeFile(path.join(wrapperDir, "git"), `#!/usr/bin/env node
// Custom wrapper that calls git again through PATH.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
fs.appendFileSync(process.env.WRAPPER_TRACE, JSON.stringify({ path: process.env.PATH, active: process.env.PAPERCLIP_GITHUB_SHIM_ACTIVE }) + "\\n");
const env = { ...process.env, PATH: process.env.PATH.split(path.delimiter).filter(dir => dir !== process.env.WRAPPER_BIN).join(path.delimiter) };
const result = spawnSync("git", process.argv.slice(2), { env, encoding: "utf8" });
if (result.error) throw result.error;
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`, { mode: 0o700 });
    await writeFile(path.join(realDir, "git"), `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.REAL_TRACE, "run\\n");
process.stdout.write("real git reached\\n");
`, { mode: 0o700 });

    let brokerRequests = 0;
    const server = createServer((_req, res) => {
      brokerRequests++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "absent", env: {} }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const { port } = server.address() as { port: number };
    const result = await exec(path.join(launcherDir, "git"), ["--version"], { cwd: root, timeout: 5_000, env: {
      ...process.env,
      ...githubBrokerEnvironment({ WRAPPER_BIN: wrapperDir, WRAPPER_TRACE: wrapperTrace, REAL_TRACE: realTrace }, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      GH_CONFIG_DIR: path.join(root, "config"),
      PATH: [launcherDir, wrapperDir, otherLauncherDir, legacyLauncherDir, editedLauncherDir, quotedLauncherDir, realDir, process.env.PATH].join(path.delimiter),
    } });
    const wrapperRuns = (await readFile(wrapperTrace, "utf8")).trim().split("\n");
    const wrapperEnv = JSON.parse(wrapperRuns[0]!);
    expect(result.stdout).toBe("real git reached\n");
    expect(wrapperRuns).toHaveLength(1);
    expect(wrapperEnv.path.split(path.delimiter)).toContain(wrapperDir);
    expect(wrapperEnv.path.split(path.delimiter)).not.toContain(launcherDir);
    expect(wrapperEnv.path.split(path.delimiter)).not.toContain(otherLauncherDir);
    expect(wrapperEnv.path.split(path.delimiter)).not.toContain(legacyLauncherDir);
    expect(wrapperEnv.path.split(path.delimiter)).toContain(editedLauncherDir);
    expect(wrapperEnv.path.split(path.delimiter)).toContain(quotedLauncherDir);
    expect(wrapperEnv.active).toBeUndefined();
    expect((await readFile(realTrace, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(brokerRequests).toBe(1);
  });

  it("does not trust a caller marker to skip broker mediation or config isolation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-forged-marker-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const launcherDir = path.join(root, "managed");
    const realDir = path.join(root, "real");
    await mkdir(launcherDir);
    await mkdir(realDir);
    const configRoot = path.join(root, "config");
    await writeFile(path.join(launcherDir, "git"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realDir, "git"), `#!/usr/bin/env node
const fs = require("node:fs");
process.stdout.write(JSON.stringify({
  configExists: fs.existsSync(process.env.GH_CONFIG_DIR),
  token: process.env.GH_TOKEN ?? null,
  global: process.env.GIT_CONFIG_GLOBAL,
  askpass: process.env.GIT_ASKPASS,
  marker: process.env.PAPERCLIP_GITHUB_SHIM_ACTIVE ?? null,
  config: process.env.GH_CONFIG_DIR,
}));
`, { mode: 0o700 });

    let brokerRequests = 0;
    const server = createServer((_req, res) => {
      brokerRequests++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: "broker-token" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const { port } = server.address() as { port: number };
    const broker = { url: `http://127.0.0.1:${port}`, token: "run-capability" };
    const environment = githubBrokerEnvironment({ PAPERCLIP_GITHUB_SHIM_ACTIVE: "1", GH_TOKEN: "host-token" }, broker);
    expect(environment.PAPERCLIP_GITHUB_SHIM_ACTIVE).toBe("");
    const result = await exec(path.join(launcherDir, "git"), ["--version"], { cwd: root, timeout: 5_000, env: {
      ...process.env,
      ...environment,
      GH_CONFIG_DIR: configRoot,
      GH_TOKEN: "caller-token",
      GIT_CONFIG_GLOBAL: "/caller/config",
      GIT_ASKPASS: "/caller/askpass",
      PATH: [launcherDir, realDir, path.dirname(process.execPath)].join(path.delimiter),
      PAPERCLIP_GITHUB_SHIM_ACTIVE: "1",
    } });
    const child = JSON.parse(result.stdout);
    expect(child.configExists).toBe(true);
    expect(child.token).toBe("broker-token");
    expect(child.global).toBe("/dev/null");
    expect(child.askpass).toBeUndefined();
    expect(child.marker).toBeNull();
    expect(child.config).not.toBe(configRoot);
    expect(child.config.startsWith(`${configRoot}${path.sep}`)).toBe(true);
    expect(brokerRequests).toBe(1);
  });

  it.each(["repository", "command"])("uses explicit %s identity for local commits without managed credentials", async (identitySource) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-local-identity-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const env = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "host-token", GIT_AUTHOR_NAME: "Host", GIT_COMMITTER_NAME: "Host",
    }, { url: "", token: "" }), PATH: `${bin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: root, env })).stdout.trim();
    // No configured identity must fail, rather than guessing the host user's.
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    await expect(git("var", "GIT_COMMITTER_IDENT")).rejects.toThrow();
    if (identitySource === "repository") {
      await git("config", "user.name", "Local Author");
      await git("config", "user.email", "local@example.test");
    }
    await git(...(identitySource === "command" ? ["-c", "user.name=Local Author", "-c", "user.email=local@example.test"] : []),
      "commit", "--allow-empty", "-m", "Local work");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Local Author <local@example.test>|Local Author <local@example.test>");
  });

  it.each(["broker-offline", "config-unwritable", "capability-rejected"])("keeps real local Git usable when %s", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-failure-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.name", "Local Author"]);
    await exec("git", ["-C", root, "config", "user.email", "local@example.test"]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    if (failure === "broker-offline") await new Promise<void>(resolve => server.close(() => resolve()));
    else cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const configRoot = path.join(root, "config");
    if (failure === "config-unwritable") await writeFile(configRoot, "not a directory");
    const result = await exec(path.join(bin, "git"), ["status", "--porcelain"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({ GH_TOKEN: "host-must-not-leak" }, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
    expect(result.stderr).toContain(failure === "broker-offline" ? "broker_transport_unavailable" : failure === "config-unwritable" ? "configuration_directory_unavailable" : "capability_rejected");
    expect(result.stderr).not.toMatch(/host-must-not-leak|private-capability/);
    await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-m", "Offline work"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
  });

  it("explains unavailable access while allowing local work without credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-diagnostic-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    const server = createServer((_req,res) => {
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"unavailable",reason:"More than one managed GitHub identity matches this run",env:{GH_TOKEN:"must-not-be-used"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...process.env,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${process.env.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:null});
    expect(result.stderr).toContain("More than one managed GitHub identity matches this run");
    expect(result.stderr).not.toMatch(/host-token|must-not-be-used|run-capability/);
  });
  it("captures each command's identity and clears host credentials when the next person has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-launcher-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), otherBin = path.join(root, "other-managed"), realBin = path.join(root, "real"), repo = path.join(root, "repo");
    for (const dir of [bin, otherBin, realBin, repo, path.join(bin, "gh-config")]) await mkdir(dir, { recursive: true });
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(otherBin, "git"), await legacyLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const identity=execFileSync('git',['var','GIT_AUTHOR_IDENT'],{encoding:'utf8'}).trim();
process.stdout.write(JSON.stringify({identity, token:process.env.GH_TOKEN ?? null, global:process.env.GIT_CONFIG_GLOBAL, config:process.env.GH_CONFIG_DIR}));
`, { mode: 0o700 });
    let user: string | null = "A", captures = 0;
    let heldCapture: (() => void) | null = null;
    let releaseCapture: (() => void) | null = null;
    const server = createServer((req, res) => {
      captures++;
      expect(req.headers["x-paperclip-github-capability"]).toBe("run-capability");
      const selected = user;
      res.setHeader("content-type", "application/json");
      const finish = () => res.end(JSON.stringify(selected ? { status: "available", env: {
        GH_TOKEN: `credential-${selected}`, GITHUB_TOKEN: `credential-${selected}`,
        GIT_AUTHOR_NAME: selected, GIT_AUTHOR_EMAIL: `${selected}@example.test`,
        GIT_COMMITTER_NAME: selected, GIT_COMMITTER_EMAIL: `${selected}@example.test`,
      } } : { status: "absent", env: {} }));
      if (heldCapture) { const captured = heldCapture; heldCapture = null; releaseCapture = finish; captured(); }
      else finish();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address() as { port: number };
    const env: NodeJS.ProcessEnv = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "ambient-host-token", GIT_AUTHOR_NAME: "Host", GIT_AUTHOR_EMAIL: "host@example.test",
    }, { url: `http://127.0.0.1:${address.port}`, token: "run-capability" }), PATH: `${bin}:${otherBin}:${realBin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: repo, env })).stdout.trim();
    await git("init");
    await git("config", "user.name", "Repository Author");
    await git("config", "user.email", "repository@example.test");
    await git("commit", "--allow-empty", "-m", "A");
    user = "B";
    await git("commit", "--allow-empty", "-m", "B");
    user = "A";
    await git("commit", "--allow-empty", "-m", "A again");
    expect(await git("log", "--format=%an <%ae>|%cn <%ce>" )).toBe("A <A@example.test>|A <A@example.test>\nB <B@example.test>|B <B@example.test>\nA <A@example.test>|A <A@example.test>");
    const before = captures;
    const gh = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(gh.identity).toContain("A <A@example.test>");
    expect(gh.token).toBe("credential-A");
    expect(captures - before).toBe(1); // gh's child Git retains the same capture.
    const captured = new Promise<void>(resolve => { heldCapture = resolve; });
    const operationA = exec(path.join(bin, "gh"), [], { cwd: repo, env });
    await captured;
    user = "B";
    const operationB = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    releaseCapture!();
    const completedA = JSON.parse((await operationA).stdout);
    expect(completedA.token).toBe("credential-A");
    expect(operationB.token).toBe("credential-B");
    expect(completedA.config).not.toBe(operationB.config);
    user = null;
    await git("commit", "--allow-empty", "-m", "Local identity");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Repository Author <repository@example.test>|Repository Author <repository@example.test>");
    const anonymous = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(anonymous.token).toBeNull();
    await git("config", "--unset", "user.name");
    await git("config", "--unset", "user.email");
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    expect(await git("status", "--porcelain")).toBe(""); // unrelated public/local Git still works
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_AUTHOR_NAME).toBe("");
  });
});
