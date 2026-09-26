import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

const execFile = promisify(execFileCallback);
const TEST_TIMEOUT_MS = 60_000;
const cleanupDirs: string[] = [];
let originalPath = "";

afterEach(async () => {
  if (originalPath) {
    process.env.PATH = originalPath;
    originalPath = "";
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function trackDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFile("git", ["-C", cwd, ...args], { timeout: 30_000 })).stdout.trim();
}

// The fake `ssh` routes on the remote script (last argv, `sh -c '<script>'`).
// Bundle-export scripts replay a payload file to stdout; every other script
// (tar download, du probe) runs locally with `sh -c`, since the "remote" dir
// in these tests is a real local path. Non-bundle invocations never touch the
// bundle call counter.
function fakeSshRouterScript(bundleHandler: string): string {
  return [
    "#!/usr/bin/env node",
    "const { spawnSync } = require('node:child_process');",
    "const outer = process.argv[process.argv.length - 1];",
    "const inner = outer.startsWith('sh -c ') ? outer.slice('sh -c '.length) : outer;",
    "const script = inner.startsWith(\"'\") && inner.endsWith(\"'\")",
    "  ? inner.slice(1, -1).split(`'\"'\"'`).join(\"'\")",
    "  : inner;",
    "if (!script.includes('bundle create')) {",
    "  const done = spawnSync('sh', ['-c', script], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "  process.exit(done.status ?? 1);",
    "}",
    bundleHandler,
    "",
  ].join("\n");
}

async function installFakeSsh(binDirPrefix: string, script: string): Promise<void> {
  const binDir = await trackDir(binDirPrefix);
  await writeFile(path.join(binDir, "ssh"), script, { mode: 0o755 });
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
}

// Installs a fake `ssh` whose stdout replays `payloadPath` through a slow
// Transform with a small highWaterMark, then exits. The old
// pipe()+close→sink.end() shape resolved on child close and truncated the
// tail; pipeline() must drain everything first.
async function installFakeSshSlowStream(payloadPath: string, exitCode: number): Promise<void> {
  await installFakeSsh(
    "paperclip-fake-ssh-slow-",
    fakeSshRouterScript(
      [
        "const { createReadStream } = require('node:fs');",
        "const { Transform } = require('node:stream');",
        `const payloadPath = ${JSON.stringify(payloadPath)};`,
        `const exitCode = ${JSON.stringify(exitCode)};`,
        "const slow = new Transform({",
        "  highWaterMark: 64,",
        "  transform(chunk, _enc, cb) { setTimeout(() => cb(null, chunk), 5); },",
        "});",
        "createReadStream(payloadPath).pipe(slow).pipe(process.stdout, { end: false });",
        "// Exit only after stdout flushes: process.exit() on source 'end'",
        "// can drop buffered tail bytes (the same truncation shape under test).",
        "slow.on('end', () => process.stdout.end(() => process.exit(exitCode)));",
      ].join("\n"),
    ),
  );
}

// Installs a fake `ssh` that serves one payload on the first bundle-export
// invocation and the other afterwards (polarity via `serveFullFirst`),
// tracking bundle-call count in a file next to the script so the child
// processes share it.
async function installFakeSshFlakyStream(
  fullPayloadPath: string,
  truncatedPayloadPath: string,
  options: { serveFullFirst?: boolean } = {},
): Promise<void> {
  const binDir = await trackDir("paperclip-fake-ssh-flaky-");
  const countPath = path.join(binDir, "count.txt");
  await writeFile(countPath, "0", "utf8");
  const serveFullFirst = options.serveFullFirst !== false;
  await writeFile(
    path.join(binDir, "ssh"),
    fakeSshRouterScript(
      [
        "const { createReadStream, readFileSync, writeFileSync } = require('node:fs');",
        `const countPath = ${JSON.stringify(countPath)};`,
        `const fullPath = ${JSON.stringify(fullPayloadPath)};`,
        `const truncPath = ${JSON.stringify(truncatedPayloadPath)};`,
        `const serveFullFirst = ${serveFullFirst ? "true" : "false"};`,
        "const count = Number(readFileSync(countPath, 'utf8').trim() || '0');",
        "writeFileSync(countPath, String(count + 1));",
        "const firstIsFull = count === 0 ? serveFullFirst : !serveFullFirst;",
        "const chosen = firstIsFull ? fullPath : truncPath;",
        "const stream = createReadStream(chosen);",
        "stream.pipe(process.stdout, { end: false });",
        "stream.on('end', () => process.stdout.end(() => process.exit(0)));",
      ].join("\n"),
    ),
    { mode: 0o755 },
  );
  if (!originalPath) {
    originalPath = process.env.PATH ?? "";
  }
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
}

function baseSpec(): SshRemoteExecutionSpec {
  return {
    host: "fake-host",
    port: 22,
    username: "fake-user",
    remoteCwd: "/fake/remote",
    remoteWorkspacePath: "/fake/remote",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: false,
  };
}

async function createRemoteRepo(rootDir: string): Promise<{ remoteDir: string; head: string }> {
  const remoteDir = path.join(rootDir, "remote");
  await execFile("git", ["init", "-b", "main", remoteDir], { timeout: 30_000 });
  await git(remoteDir, ["config", "user.name", "Paperclip Test"]);
  await git(remoteDir, ["config", "user.email", "test@paperclip.dev"]);
  // Random payload so the bundle is large enough to exercise backpressure.
  const big = path.join(rootDir, "big.bin");
  const writer = spawn("sh", ["-c", `head -c 1500000 /dev/urandom > ${JSON.stringify(big)}`]);
  await new Promise<void>((resolve, reject) => {
    writer.on("error", reject);
    writer.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))));
  });
  await writeFile(path.join(remoteDir, "tracked.txt"), "remote content\n", "utf8");
  await execFile("sh", ["-c", `cp ${JSON.stringify(big)} ${JSON.stringify(path.join(remoteDir, "big.bin"))}`], {
    timeout: 30_000,
  });
  await git(remoteDir, ["add", "tracked.txt", "big.bin"]);
  await git(remoteDir, ["commit", "-m", "remote work"]);
  return { remoteDir, head: await git(remoteDir, ["rev-parse", "HEAD"]) };
}

describe("ssh bundle stream", () => {
  it("drains the full bundle through a slow progress counter before resolving", async () => {
    const rootDir = await trackDir("paperclip-ssh-bundle-drain-");
    const { remoteDir, head } = await createRemoteRepo(rootDir);
    await git(remoteDir, ["update-ref", "refs/paperclip/ssh-sync/export", "HEAD"]);
    const payloadPath = path.join(rootDir, "export.bundle");
    await git(remoteDir, ["bundle", "create", payloadPath, "refs/paperclip/ssh-sync/export"]);

    await installFakeSshSlowStream(payloadPath, 0);

    const localDir = path.join(rootDir, "local");
    await execFile("git", ["init", "-b", "main", localDir], { timeout: 30_000 });
    await git(localDir, ["config", "user.name", "Paperclip Test"]);
    await git(localDir, ["config", "user.email", "test@paperclip.dev"]);
    await git(localDir, ["commit", "--allow-empty", "-m", "seed"]);

    const seen: string[] = [];
    await restoreWorkspaceFromSshExecution({
      spec: baseSpec(),
      localDir,
      remoteDir,
      onProgress: (line: string) => {
        seen.push(line);
      },
    });

    const imported = await git(localDir, ["rev-parse", "HEAD"]);
    expect(imported).toBe(head);
    const size = (await stat(payloadPath)).size;
    expect(size).toBeGreaterThan(1_000_000);
    expect(seen.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it("rejects when the ssh child exits nonzero even after a full drain", async () => {
    const rootDir = await trackDir("paperclip-ssh-bundle-exit-");
    const { remoteDir } = await createRemoteRepo(rootDir);
    await git(remoteDir, ["update-ref", "refs/paperclip/ssh-sync/export", "HEAD"]);
    const payloadPath = path.join(rootDir, "export.bundle");
    await git(remoteDir, ["bundle", "create", payloadPath, "refs/paperclip/ssh-sync/export"]);

    await installFakeSshSlowStream(payloadPath, 3);

    const localDir = path.join(rootDir, "local");
    await execFile("git", ["init", "-b", "main", localDir], { timeout: 30_000 });
    await git(localDir, ["config", "user.name", "Paperclip Test"]);
    await git(localDir, ["config", "user.email", "test@paperclip.dev"]);
    await git(localDir, ["commit", "--allow-empty", "-m", "seed"]);

    await expect(
      restoreWorkspaceFromSshExecution({ spec: baseSpec(), localDir, remoteDir }),
    ).rejects.toThrow(/ssh exited with code 3/);
  }, TEST_TIMEOUT_MS);

  it("re-streams once when the first download is truncated, then imports the head", async () => {
    const rootDir = await trackDir("paperclip-ssh-bundle-retry-");
    const { remoteDir, head } = await createRemoteRepo(rootDir);
    await git(remoteDir, ["update-ref", "refs/paperclip/ssh-sync/export", "HEAD"]);
    const fullPath = path.join(rootDir, "full.bundle");
    await git(remoteDir, ["bundle", "create", fullPath, "refs/paperclip/ssh-sync/export"]);
    const fullBytes = await readFile(fullPath);
    const truncPath = path.join(rootDir, "trunc.bundle");
    await writeFile(truncPath, fullBytes.subarray(0, Math.floor(fullBytes.length * 0.4)));

    await installFakeSshFlakyStream(fullPath, truncPath, { serveFullFirst: false });

    const localDir = path.join(rootDir, "local");
    await execFile("git", ["init", "-b", "main", localDir], { timeout: 30_000 });
    await git(localDir, ["config", "user.name", "Paperclip Test"]);
    await git(localDir, ["config", "user.email", "test@paperclip.dev"]);
    await git(localDir, ["commit", "--allow-empty", "-m", "seed"]);

    const seen: string[] = [];
    await restoreWorkspaceFromSshExecution({
      spec: baseSpec(),
      localDir,
      remoteDir,
      onProgress: (line: string) => {
        seen.push(line);
      },
    });

    expect(await git(localDir, ["rev-parse", "HEAD"])).toBe(head);
    // The terminal completion line still lands after the retry succeeds.
    expect(seen.join("")).toMatch(/100%|MB/);
  }, TEST_TIMEOUT_MS);

  it("fails instead of retrying forever when every stream is truncated", async () => {
    const rootDir = await trackDir("paperclip-ssh-bundle-retry-once-");
    const { remoteDir } = await createRemoteRepo(rootDir);
    await git(remoteDir, ["update-ref", "refs/paperclip/ssh-sync/export", "HEAD"]);
    const fullPath = path.join(rootDir, "full.bundle");
    await git(remoteDir, ["bundle", "create", fullPath, "refs/paperclip/ssh-sync/export"]);
    const fullBytes = await readFile(fullPath);
    const truncPath = path.join(rootDir, "trunc.bundle");
    await writeFile(truncPath, fullBytes.subarray(0, Math.floor(fullBytes.length * 0.4)));

    // Both serves are the truncated payload, so the retry also fails and the
    // fetch error surfaces instead of retrying forever.
    await installFakeSshFlakyStream(truncPath, truncPath, { serveFullFirst: false });

    const localDir = path.join(rootDir, "local");
    await execFile("git", ["init", "-b", "main", localDir], { timeout: 30_000 });
    await git(localDir, ["config", "user.name", "Paperclip Test"]);
    await git(localDir, ["config", "user.email", "test@paperclip.dev"]);
    await git(localDir, ["commit", "--allow-empty", "-m", "seed"]);

    await expect(
      restoreWorkspaceFromSshExecution({ spec: baseSpec(), localDir, remoteDir }),
    ).rejects.toThrow(/early EOF|index-pack/i);
  }, TEST_TIMEOUT_MS);

  it("still round-trips prepare/restore through the fixture counter path", async () => {
    const rootDir = await trackDir("paperclip-ssh-bundle-counter-");
    const localRepo = path.join(rootDir, "local-workspace");
    await execFile("git", ["init", "-b", "main", localRepo], { timeout: 30_000 });
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const slowCounter = new Transform({
      highWaterMark: 64,
      transform(chunk: Buffer, _encoding, callback) {
        setTimeout(() => callback(null, chunk), 5);
      },
    });

    // The real `ssh` binary is untouched here; this only proves a slow
    // counter Transform preserves every byte through pipeline semantics.
    const { pipeline } = await import("node:stream/promises");
    const { createWriteStream } = await import("node:fs");
    const outPath = path.join(rootDir, "out.bin");
    const payload = Buffer.alloc(300_000, "x");
    const { Readable } = await import("node:stream");
    await pipeline(Readable.from([payload]), slowCounter, createWriteStream(outPath));
    expect((await stat(outPath)).size).toBe(payload.length);

    await expect(
      prepareWorkspaceForSshExecution({
        spec: { ...baseSpec(), host: "invalid.invalid" },
        localDir: localRepo,
      }),
    ).rejects.toThrow();
  }, TEST_TIMEOUT_MS);
});
