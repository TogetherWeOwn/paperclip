import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("managed GitHub launchers", () => {
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
    const result = await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-m", "Probe"], { cwd: root, env: {
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
    const bin = path.join(root, "managed"), realBin = path.join(root, "real"), repo = path.join(root, "repo");
    for (const dir of [bin, realBin, repo, path.join(bin, "gh-config")]) await mkdir(dir, { recursive: true });
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
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
      expect(req.headers.authorization).toBe("Bearer run-capability");
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
    }, { url: `http://127.0.0.1:${address.port}`, token: "run-capability" }), PATH: `${bin}:${realBin}:${process.env.PATH}`,
    // Every operation must recapture here, so the per-run credential cache is off.
    PAPERCLIP_GITHUB_CREDENTIAL_CACHE_TTL_MS: "0" };
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
  async function brokerFixture(prefix: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), repo = path.join(root, "repo"), upstream = path.join(root, "upstream");
    for (const dir of [bin, repo, upstream]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(String(req.headers["x-paperclip-github-capability"]));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: {
        GH_TOKEN: "credential-secret-value", GIT_AUTHOR_NAME: "Managed", GIT_AUTHOR_EMAIL: "managed@example.test",
        GIT_COMMITTER_NAME: "Managed", GIT_COMMITTER_EMAIL: "managed@example.test",
      } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const envFor = (capability: string, extra: Record<string, string> = {}) => ({
      ...process.env,
      ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: capability }),
      PATH: `${bin}:${process.env.PATH}`, ...extra,
    });
    await exec("git", ["init", upstream]);
    await exec("git", ["-C", upstream, "-c", "user.name=U", "-c", "user.email=u@example.test", "commit", "--allow-empty", "-m", "upstream"]);
    await exec("git", ["init", repo]);
    await exec("git", ["-C", repo, "remote", "add", "origin", upstream]);
    const git = (env: NodeJS.ProcessEnv, ...args: string[]) => exec(path.join(bin, "git"), args, { cwd: repo, env });
    return { bin, repo, requests, envFor, git };
  }

  it("captures credentials only for network, identity, and unknown Git commands", async () => {
    const f = await brokerFixture("paperclip-github-network-only-");
    const env = f.envFor("run-capability", { PAPERCLIP_GITHUB_CREDENTIAL_CACHE_TTL_MS: "0" });
    for (const args of [
      ["status", "--porcelain"], ["-c", "core.quotePath=false", "status"], ["-C", f.repo, "diff"], ["log", "--oneline", "-1", "--all"],
      ["rev-parse", "--git-dir"], ["branch", "--list"], ["worktree", "list"], ["config", "user.name", "Local"], ["remote", "-v"],
      ["remote", "get-url", "origin"], ["--no-pager", "show-ref"], ["--version"],
    ]) await f.git(env, ...args).catch(() => undefined);
    expect(f.requests).toEqual([]);
    await f.git(env, "fetch", "origin");
    expect(f.requests).toHaveLength(1);
    await f.git(env, "-C", f.repo, "-c", "protocol.version=2", "ls-remote", "origin");
    await f.git(env, "remote", "update");
    await f.git(env, "commit", "--allow-empty", "-m", "managed identity");
    expect(f.requests).toHaveLength(4);
    expect((await f.git(env, "log", "-1", "--format=%an")).stdout.trim()).toBe("Managed");
    expect(f.requests).toHaveLength(4);
  }, 30_000);

  it("captures credentials for local commands in a partial clone, which can fetch lazily", async () => {
    const f = await brokerFixture("paperclip-github-partial-");
    const env = f.envFor("run-capability", { PAPERCLIP_GITHUB_CREDENTIAL_CACHE_TTL_MS: "0" });
    await exec("git", ["-C", f.repo, "config", "core.repositoryformatversion", "1"]);
    await exec("git", ["-C", f.repo, "config", "extensions.partialClone", "origin"]);
    await f.git(env, "status", "--porcelain");
    expect(f.requests).toHaveLength(1);
  }, 30_000);

  it("reuses a sealed per-run credential capture until it expires", async () => {
    const f = await brokerFixture("paperclip-github-cache-");
    const env = f.envFor("run-capability");
    await f.git(env, "fetch", "origin");
    await f.git(env, "commit", "--allow-empty", "-m", "cached identity");
    expect(f.requests).toEqual(["run-capability"]);
    expect((await f.git(env, "log", "-1", "--format=%an")).stdout.trim()).toBe("Managed");
    const cacheDirectory = path.join(f.bin, "credential-cache");
    const [entry] = await readdir(cacheDirectory);
    expect((await stat(cacheDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(cacheDirectory, entry))).mode & 0o777).toBe(0o600);
    const sealed = await readFile(path.join(cacheDirectory, entry), "utf8");
    expect(sealed).not.toMatch(/credential-secret-value|Managed|run-capability/);
    // Another capability cannot open this run's entry and captures its own.
    await f.git(f.envFor("other-capability"), "fetch", "origin");
    expect(f.requests).toEqual(["run-capability", "other-capability"]);
    // A tampered entry is ignored rather than trusted.
    const tampered = JSON.parse(sealed) as { tag: string };
    const tag = Buffer.from(tampered.tag, "base64");
    tag[0] ^= 1;
    await writeFile(path.join(cacheDirectory, entry), JSON.stringify({ ...tampered, tag: tag.toString("base64") }));
    await f.git(env, "fetch", "origin");
    expect(f.requests).toHaveLength(3);
    const shortLived = f.envFor("short-capability", { PAPERCLIP_GITHUB_CREDENTIAL_CACHE_TTL_MS: "1" });
    await f.git(shortLived, "fetch", "origin");
    await new Promise(resolve => setTimeout(resolve, 20));
    await f.git(shortLived, "fetch", "origin");
    expect(f.requests.filter(request => request === "short-capability")).toHaveLength(2);
  }, 30_000);
});
