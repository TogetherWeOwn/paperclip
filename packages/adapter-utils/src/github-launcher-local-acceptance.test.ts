import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";

// Test-author-owned acceptance contract. Change implementation, not these
// expectations, when local commands capture credentials or a probe re-enters PATH.
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Invocation = { args: string[]; probe: boolean; managedPath: boolean };
type Output = { args: string[]; managedCredential: boolean; ambientCredential: boolean };

async function fixture(status: "available" | "unavailable" = "available") {
  const root = await mkdtemp(path.join(os.tmpdir(), "github-local-acceptance-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const managed = path.join(root, "managed");
  const real = path.join(root, "real");
  const home = path.join(root, "home");
  for (const directory of [managed, real, home]) await mkdir(directory);
  const trace = path.join(root, "invocations.jsonl");
  await writeFile(trace, "");
  await symlink(process.execPath, path.join(real, "node"));
  for (const tool of ["git", "gh"]) {
    await writeFile(path.join(managed, tool), githubLauncherSource(), { mode: 0o700 });
    // Replace only the terminal executable: the generated launcher, its capture,
    // and its loopback HTTP exchange are real. No Git/GitHub network is possible.
    await writeFile(path.join(real, tool), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const probe = args.some(arg => arg.toLowerCase() === 'extensions.partialclone');
fs.appendFileSync(process.env.ACCEPTANCE_TRACE, JSON.stringify({
  args, probe,
  managedPath: process.env.PATH.split(path.delimiter).includes(process.env.ACCEPTANCE_MANAGED),
}) + '\\n');
if (!probe) process.stdout.write(JSON.stringify({
  args,
  managedCredential: process.env.GH_TOKEN === 'fixture-managed-only',
  ambientCredential: process.env.GH_TOKEN === 'fixture-ambient-only' || process.env.GITHUB_TOKEN === 'fixture-ambient-only',
}));
`, { mode: 0o700 });
  }
  const requests: Array<{ method: string | undefined; url: string | undefined; authorized: boolean }> = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorized: req.headers.authorization === "Bearer fixture-capability-only" });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(status === "available"
      ? { status, env: { GH_TOKEN: "fixture-managed-only", GITHUB_TOKEN: "fixture-managed-only" } }
      : { status, reason: "Fixture access unavailable", env: {} }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const { port } = server.address() as { port: number };
  // Deliberately do not inherit the run's credentials, launchers, shell hooks,
  // Git configuration, SSH agent, or application/database environment.
  const env: NodeJS.ProcessEnv = {
    ...githubBrokerEnvironment({ GH_TOKEN: "fixture-ambient-only", GITHUB_TOKEN: "fixture-ambient-only" }, {
      url: `http://127.0.0.1:${port}`, token: "fixture-capability-only",
    }),
    PATH: `${managed}${path.delimiter}${real}`,
    HOME: home, TMPDIR: root,
    GH_CONFIG_DIR: path.join(root, "gh-config"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "empty.gitconfig"),
    ACCEPTANCE_TRACE: trace, ACCEPTANCE_MANAGED: managed,
  };
  return {
    requests,
    async run(tool: "git" | "gh", args: string[]) {
      const result = await exec(path.join(managed, tool), args, {
        cwd: root, env, timeout: 4_000, maxBuffer: 64 * 1024,
      });
      for (const sentinel of ["fixture-managed-only", "fixture-ambient-only", "fixture-capability-only"]) {
        expect((result.stdout + result.stderr).includes(sentinel), "credential values stay out of output").toBe(false);
      }
      return { output: JSON.parse(result.stdout) as Output, stderr: result.stderr };
    },
    async invocations(): Promise<Invocation[]> {
      return (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    },
  };
}

describe("strictly local Git credential-capture acceptance", () => {
  // Removing the local-only branch must fail these zero-capture assertions.
  it.each([
    ["status", "--porcelain"],
    ["diff", "--stat"],
    ["diff", "--cached", "--stat"],
    ["log", "-1", "--oneline"],
    ["rev-parse", "HEAD"],
    ["ls-files", "--cached"],
  ])("does not capture credentials for git %j", async (...args) => {
    const test = await fixture();
    const result = await test.run("git", args);
    expect(result.output.args).toEqual(args);
    expect(result.output.ambientCredential).toBe(false);
    expect(test.requests).toHaveLength(0);
    expect(result.output.managedCredential).toBe(false);
    expect(result.stderr).toBe("");
  });

  // A denylist or a classifier that skips global options/aliases would wrongly
  // withhold the existing authorization path from one or more of these inputs.
  it.each([
    ["fetch", "origin"],
    ["push", "origin", "HEAD"],
    ["pull", "--ff-only"],
    ["clone", "https://example.invalid/repository.git"],
    ["ls-remote", "origin"],
    ["remote", "update"],
    ["submodule", "update", "--init"],
    ["lfs", "pull"],
    ["archive", "--remote=origin", "HEAD"],
    ["st"],
    ["unknown-command"],
    [],
    ["-C", ".", "status"],
    ["--git-dir=.git", "status"],
    ["--no-pager", "log"],
    ["-c", "alias.status=!git fetch", "status"],
    ["-c", "credential.helper=fixture-helper", "diff"],
    ["diff", "--ext-diff"],
    ["config", "--get", "remote.origin.url"],
  ])("retains capture for network or ambiguous git %j", async (...args) => {
    const test = await fixture();
    const result = await test.run("git", args);
    expect(result.output.args).toEqual(args);
    expect(test.requests).toEqual([{
      method: "POST", url: "/runtime-tools/github/credentials", authorized: true,
    }]);
    expect(result.output.managedCredential).toBe(true);
    expect(result.output.ambientCredential).toBe(false);
  });

  it.each([["api", "user"], ["status"], []])("never classifies gh %j as local Git", async (...args) => {
    const test = await fixture();
    const result = await test.run("gh", args);
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]?.authorized).toBe(true);
    expect(result.output).toEqual({ args, managedCredential: true, ambientCredential: false });
  });

  it("captures each network command independently rather than caching a run credential", async () => {
    const test = await fixture();
    await test.run("git", ["fetch", "origin"]);
    await test.run("git", ["fetch", "origin"]);
    expect(test.requests).toHaveLength(2);
    expect(test.requests.every(request => request.authorized)).toBe(true);
  });

  it("does not contact even an unavailable broker for a strictly local status", async () => {
    const test = await fixture("unavailable");
    const result = await test.run("git", ["status", "--porcelain"]);
    expect(test.requests).toHaveLength(0);
    expect(result.output.managedCredential).toBe(false);
    expect(result.output.ambientCredential).toBe(false);
    expect(result.stderr).toBe("");
  });

  it.each(["git", "gh"] as const)("does not restore ambient credentials when %s capture is unavailable", async tool => {
    const test = await fixture("unavailable");
    const args = tool === "git" ? ["fetch", "origin"] : ["api", "user"];
    const result = await test.run(tool, args);
    expect(test.requests).toHaveLength(1);
    expect(result.output).toEqual({ args, managedCredential: false, ambientCredential: false });
    expect(result.stderr).toContain("Fixture access unavailable");
  });

  // Inspect actual subprocess environments, not source text. The stable base
  // need not have a partial-clone probe; if one is added, it must also be shim-free.
  // The terminal fake never spawns Git itself, so a broken PATH stays bounded.
  it("keeps Git execution and any probe shim-free without extra broker captures", async () => {
    const test = await fixture();
    await test.run("git", ["fetch", "origin"]);
    const invocations = await test.invocations();
    expect(invocations).toContainEqual({ args: ["fetch", "origin"], probe: false, managedPath: false });
    expect(invocations.every(invocation => !invocation.managedPath)).toBe(true);
    expect(test.requests).toHaveLength(1);
  });
});
