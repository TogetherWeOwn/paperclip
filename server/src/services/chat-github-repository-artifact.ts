import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GitHubReviewRepositoryArtifact } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/** Commit-addressed repository bytes sealed with the admission snapshot. The
 * artifact holds exactly two refs: the PR base and the admitted head. Nothing
 * newer than either commit (later fixes, other branches, tags) can enter. */
export type GitHubRepositoryArtifact = GitHubReviewRepositoryArtifact;

export interface GitHubRepositoryArtifactRequest {
  repository: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  token: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  /** Epoch ms at which `signal` aborts; sizes the bundle share of the window. */
  deadlineAt?: number;
}

export interface GitHubRepositoryArtifactOptions {
  root: string;
  /** Test seam only; production always reads the public GitHub origin. */
  remoteUrl?: (repository: string) => string;
  maxBytes?: number;
  /** Fraction of the remaining capture window the bundle path may use. */
  bundleShare?: number;
  /** Cache warming keeps running after the capture window, bounded by this. */
  cacheFetchTimeoutMs?: number;
}

export class GitHubRepositoryArtifactError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

const commitPattern = /^[a-f0-9]{40}$/;
const fail = (reason: string): never => { throw new GitHubRepositoryArtifactError(reason); };
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // No user/system config, credential helpers, prompts, or hooks from the host.
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false",
    GIT_AUTHOR_NAME: "Paperclip", GIT_AUTHOR_EMAIL: "paperclip@localhost", GIT_COMMITTER_NAME: "Paperclip",
    GIT_COMMITTER_EMAIL: "paperclip@localhost", GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z", GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
    ...extra };
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; input?: Readable; timeoutMs?: number } = {}) {
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) return reject(new GitHubRepositoryArtifactError("repository_artifact_late"));
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? gitEnv(), stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let size = 0;
    const kill = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", kill, { once: true });
    const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : undefined;
    timer?.unref();
    child.stdout!.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 1024 * 1024) stdout += chunk.toString("utf8"); });
    child.stderr!.resume();
    if (options.input && child.stdin) {
      options.input.on("error", kill);
      child.stdin.on("error", () => undefined);
      options.input.pipe(child.stdin);
    }
    child.on("error", reject);
    child.on("close", code => {
      options.signal?.removeEventListener("abort", kill);
      if (timer) clearTimeout(timer);
      if (options.signal?.aborted) reject(new GitHubRepositoryArtifactError("repository_artifact_late"));
      else if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args[0] ?? ""} exited ${code}`));
    });
  });
}
const git = (args: string[], options: Parameters<typeof run>[2] = {}) => run("git", args, options);

async function hasCommit(repo: string, sha: string) {
  try { return (await git(["--git-dir", repo, "cat-file", "-t", sha])).trim() === "commit"; } catch { return false; }
}

async function sha256File(file: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Bundle from an arbitrary object store, never from the cache's own refs. The
 * temporary repository borrows objects through alternates and names only the
 * two admitted commits, so `git bundle` packs exactly their ancestry. */
async function bundleCommits(input: { objects: string; tmp: string; refs: { base: string; head: string };
  commits: { base: string; head: string }; maxBytes: number; signal: AbortSignal }) {
  const repo = path.join(input.tmp, "bundle.git");
  await git(["init", "-q", "--bare", repo], { signal: input.signal });
  await fs.writeFile(path.join(repo, "objects", "info", "alternates"), `${input.objects}\n`);
  await git(["--git-dir", repo, "update-ref", input.refs.base, input.commits.base], { signal: input.signal });
  await git(["--git-dir", repo, "update-ref", input.refs.head, input.commits.head], { signal: input.signal });
  const file = path.join(input.tmp, "repository.bundle");
  await git(["--git-dir", repo, "bundle", "create", "-q", file, input.refs.base, input.refs.head], { signal: input.signal });
  const heads = (await git(["bundle", "list-heads", file], { signal: input.signal })).trim().split("\n").sort();
  const expected = [`${input.commits.base} ${input.refs.base}`, `${input.commits.head} ${input.refs.head}`].sort();
  if (input.commits.base === input.commits.head && input.refs.base === input.refs.head) expected.pop();
  if (JSON.stringify([...new Set(heads)]) !== JSON.stringify([...new Set(expected)])) fail("repository_artifact_invalid");
  const { size } = await fs.stat(file);
  if (size > input.maxBytes) fail("repository_artifact_too_large");
  return { file, size };
}

async function treeOf(repo: string, sha: string, signal?: AbortSignal) {
  const tree = (await git(["--git-dir", repo, "rev-parse", "--verify", `${sha}^{tree}`], { signal })).trim();
  return commitPattern.test(tree) ? tree : fail("repository_artifact_invalid");
}

const cacheLocks = new Map<string, Promise<unknown>>();
function withCacheLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = cacheLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  const tail = next.catch(() => undefined);
  cacheLocks.set(key, tail);
  void tail.then(() => { if (cacheLocks.get(key) === tail) cacheLocks.delete(key); });
  return next;
}

/** Fetch by SHA into a server-side cache. The fetch is NOT bound to the capture
 * window: an oversized first fetch keeps warming the cache for later admissions
 * while this admission falls back to the synthetic artifact. */
function fetchIntoCache(request: GitHubRepositoryArtifactRequest, options: GitHubRepositoryArtifactOptions, cache: string) {
  return withCacheLock(cache, async () => {
    try { await fs.access(path.join(cache, "HEAD")); }
    catch {
      const pending = `${cache}.init-${randomUUID()}`;
      await git(["init", "-q", "--bare", pending]);
      await fs.rename(pending, cache).catch(async () => { await fs.rm(pending, { recursive: true, force: true }); });
    }
    const missing = [];
    for (const sha of new Set([request.headSha, request.baseSha])) if (!(await hasCommit(cache, sha))) missing.push(sha);
    if (missing.length === 0) return;
    const url = options.remoteUrl ? options.remoteUrl(request.repository) : `https://github.com/${request.repository}.git`;
    // The credential travels in the child environment, never in argv or config files.
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${request.token}`).toString("base64")}`;
    await git(["--git-dir", cache, "fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", url,
      ...missing.map(sha => `+${sha}:refs/paperclip/commits/${sha}`)], {
      env: gitEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: header }),
      timeoutMs: options.cacheFetchTimeoutMs ?? 10 * 60_000,
    });
  });
}

async function produceBundle(request: GitHubRepositoryArtifactRequest, options: GitHubRepositoryArtifactOptions, tmp: string, signal: AbortSignal) {
  const cache = path.join(options.root, "cache", `${createHash("sha256").update(request.repository.toLowerCase()).digest("hex")}.git`);
  await fs.mkdir(path.dirname(cache), { recursive: true });
  const fetched = fetchIntoCache(request, options, cache);
  void fetched.catch(() => undefined);
  await Promise.race([fetched.catch(() => fail("repository_fetch_failed")), new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new GitHubRepositoryArtifactError("repository_artifact_late"));
    signal.addEventListener("abort", () => reject(new GitHubRepositoryArtifactError("repository_artifact_late")), { once: true });
  })]);
  for (const sha of [request.headSha, request.baseSha]) if (!(await hasCommit(cache, sha))) fail("repository_fetch_failed");
  const refs = artifactRefs(request);
  const { file, size } = await bundleCommits({ objects: path.join(cache, "objects"), tmp, refs,
    commits: { base: request.baseSha, head: request.headSha }, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES, signal });
  return { file, size, refs, commits: { base: request.baseSha, head: request.headSha },
    headTree: await treeOf(cache, request.headSha, signal), baseTree: await treeOf(cache, request.baseSha, signal) };
}

function artifactRefs(request: Pick<GitHubRepositoryArtifactRequest, "baseBranch" | "pullNumber">) {
  const branch = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?![/.])[A-Za-z0-9._/-]{1,200}(?<![/.])$/.test(request.baseBranch)
    && !request.baseBranch.endsWith(".lock") ? request.baseBranch : "base";
  return { base: `refs/heads/${branch}`, head: `refs/pull/${request.pullNumber}/head` };
}

async function githubJson<T>(request: GitHubRepositoryArtifactRequest, route: string, signal: AbortSignal): Promise<T> {
  const response = await request.fetchImpl(`https://api.github.com/repos/${request.repository}${route}`, { redirect: "error", signal,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${request.token}` } });
  if (!response.ok) fail("repository_synthetic_unavailable");
  return response.json() as Promise<T>;
}

/** Tarball bytes are only trusted after the rebuilt tree hashes to the exact
 * tree GitHub reports for the admitted commit. Filters, export-ignore,
 * export-subst, or submodules make that impossible and fail closed. */
async function syntheticTree(request: GitHubRepositoryArtifactRequest, repo: string, tmp: string, sha: string, maxBytes: number, signal: AbortSignal) {
  const commit = await githubJson<{ sha?: string; tree?: { sha?: string } }>(request, `/git/commits/${sha}`, signal);
  const expected = commit.tree?.sha;
  if (commit.sha !== sha || typeof expected !== "string" || !commitPattern.test(expected)) fail("repository_synthetic_unavailable");
  const located = await request.fetchImpl(`https://api.github.com/repos/${request.repository}/tarball/${sha}`, { redirect: "manual", signal,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${request.token}` } });
  let response = located;
  if (located.status >= 300 && located.status < 400) {
    const location = new URL(located.headers.get("location") ?? "", "https://api.github.com");
    if (location.protocol !== "https:" || location.hostname !== "codeload.github.com") fail("repository_synthetic_unavailable");
    // Signed codeload URL; never forward the installation token off api.github.com.
    response = await request.fetchImpl(location, { redirect: "error", signal });
  }
  if (!response.ok || !response.body) fail("repository_synthetic_unavailable");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) fail("repository_artifact_too_large");
  const work = path.join(tmp, `tree-${sha}`);
  await fs.mkdir(work);
  let received = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => { received += chunk.length; if (received > maxBytes) body.destroy(new GitHubRepositoryArtifactError("repository_artifact_too_large")); });
  await run("tar", ["-xzf", "-", "--strip-components=1", "--no-same-owner", "--no-same-permissions", "-C", work], { signal, input: body, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } })
    .catch(error => { if (received > maxBytes) fail("repository_artifact_too_large"); throw error; });
  const index = path.join(tmp, `index-${sha}`);
  const env = gitEnv({ GIT_INDEX_FILE: index, GIT_DIR: repo, GIT_WORK_TREE: work });
  await git(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.fileMode=true", "-c", "core.symlinks=true",
    "-c", "core.ignorecase=false", "-c", "core.precomposeunicode=false", "add", "-A", "-f", "--", "."], { env, signal, cwd: work });
  const tree = (await git(["write-tree"], { env, signal, cwd: work })).trim();
  await fs.rm(work, { recursive: true, force: true });
  if (tree !== expected) fail("repository_synthetic_tree_mismatch");
  return tree;
}

async function produceSynthetic(request: GitHubRepositoryArtifactRequest, options: GitHubRepositoryArtifactOptions, tmp: string, signal: AbortSignal) {
  const repo = path.join(tmp, "synthetic.git");
  await git(["init", "-q", "--bare", repo], { signal });
  // Highest-precedence attributes: hash the exported bytes exactly as stored.
  await fs.writeFile(path.join(repo, "info", "attributes"), "* -text -eol -filter -ident -working-tree-encoding -crlf\n");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const baseTree = await syntheticTree(request, repo, tmp, request.baseSha, maxBytes, signal);
  const headTree = await syntheticTree(request, repo, tmp, request.headSha, maxBytes, signal);
  const env = gitEnv({ GIT_DIR: repo });
  const base = (await git(["commit-tree", baseTree, "-m", `Synthetic base tree of ${request.baseSha}`], { env, signal })).trim();
  const head = (await git(["commit-tree", headTree, "-p", base, "-m", `Synthetic head tree of ${request.headSha}`], { env, signal })).trim();
  const refs = artifactRefs(request);
  const { file, size } = await bundleCommits({ objects: path.join(repo, "objects"), tmp, refs, commits: { base, head }, maxBytes, signal });
  return { file, size, refs, commits: { base, head }, headTree, baseTree };
}

async function pruneArtifacts(root: string) {
  const dir = path.join(root, "artifacts");
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > ARTIFACT_RETENTION_MS) await fs.rm(file, { force: true });
  }
}

/** Preferred: a real bundle of the admitted head+base ancestry. Fallback: two
 * synthetic commits whose trees equal the admitted base/head trees. Either
 * path respects the admission capture signal; no artifact is a precise reason. */
export async function produceGitHubRepositoryArtifact(request: GitHubRepositoryArtifactRequest, options: GitHubRepositoryArtifactOptions): Promise<GitHubRepositoryArtifact> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) || request.repository.includes(".."))
    fail("repository_artifact_invalid");
  if (!commitPattern.test(request.headSha) || !commitPattern.test(request.baseSha) || !Number.isSafeInteger(request.pullNumber) || request.pullNumber < 1)
    fail("repository_artifact_invalid");
  await fs.mkdir(path.join(options.root, "tmp"), { recursive: true });
  await fs.mkdir(path.join(options.root, "artifacts"), { recursive: true });
  void pruneArtifacts(options.root).catch(() => undefined);
  const tmp = await fs.mkdtemp(path.join(options.root, "tmp", "capture-"));
  try {
    let produced: Awaited<ReturnType<typeof produceBundle>>;
    let kind: GitHubRepositoryArtifact["kind"] = "bundle";
    // Reserve the tail of the capture window for the synthetic fallback.
    const share = options.bundleShare ?? 0.6;
    const bundleWindow = new AbortController();
    const remaining = Math.max(0, (request.deadlineAt ?? Date.now() + 15_000) - Date.now());
    const timer = setTimeout(() => bundleWindow.abort(), Math.floor(share * remaining));
    timer.unref();
    const bundleSignal = AbortSignal.any([request.signal, bundleWindow.signal]);
    try {
      produced = await produceBundle(request, options, tmp, bundleSignal);
    } catch (bundleError) {
      if (request.signal.aborted) fail("repository_artifact_late");
      const bundleReason = bundleError instanceof GitHubRepositoryArtifactError ? bundleError.reason : "repository_fetch_failed";
      kind = "synthetic";
      try { produced = await produceSynthetic(request, options, tmp, request.signal); }
      catch (syntheticError) {
        if (request.signal.aborted) fail(`bundle:${bundleReason};synthetic:repository_artifact_late`);
        fail(`bundle:${bundleReason};synthetic:${syntheticError instanceof GitHubRepositoryArtifactError ? syntheticError.reason : "repository_synthetic_unavailable"}`);
      }
    } finally { clearTimeout(timer); }
    const sha256 = await sha256File(produced!.file);
    const name = `${sha256}.bundle`;
    await fs.rename(produced!.file, path.join(options.root, "artifacts", name));
    // Refresh retention on content-addressed reuse.
    await fs.utimes(path.join(options.root, "artifacts", name), new Date(), new Date()).catch(() => undefined);
    // A finished artifact is commit-addressed; the snapshot capture alone
    // decides whether the admission itself was late.
    return { version: 1, kind, path: name, sha256, bytes: produced!.size, headSha: request.headSha, baseSha: request.baseSha,
      headTree: produced!.headTree, baseTree: produced!.baseTree, refs: produced!.refs, commits: produced!.commits };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Resolve a sealed artifact to a verified local file. Never trust a path from
 * the snapshot beyond its content-addressed name. */
export async function githubRepositoryArtifactFile(artifact: GitHubRepositoryArtifact, root = githubRepositoryArtifactRoot()) {
  if (artifact.path !== `${artifact.sha256}.bundle` || !/^[a-f0-9]{64}$/.test(artifact.sha256)) fail("repository_artifact_invalid");
  const file = path.join(root, "artifacts", artifact.path);
  try { await fs.access(file); } catch { fail("repository_artifact_missing"); }
  if (await sha256File(file) !== artifact.sha256) fail("repository_artifact_corrupt");
  return file;
}

export function githubRepositoryArtifactRoot() {
  return process.env.PAPERCLIP_GITHUB_SHADOW_REPOSITORY_DIR?.trim()
    || path.join(resolvePaperclipInstanceRoot(), "data", "github-shadow-repositories");
}

export type GitHubRepositoryArtifactProducer = (request: GitHubRepositoryArtifactRequest) => Promise<GitHubRepositoryArtifact>;
let producerOverride: GitHubRepositoryArtifactProducer | null | undefined;

/** Test seam: inject a producer (or null to disable) without touching GitHub. */
export function setGitHubRepositoryArtifactProducer(producer: GitHubRepositoryArtifactProducer | null | undefined) {
  producerOverride = producer;
}

export function githubRepositoryArtifactProducer(): GitHubRepositoryArtifactProducer | null {
  if (producerOverride !== undefined) return producerOverride;
  if (process.env.PAPERCLIP_GITHUB_SHADOW_REPOSITORY_ARTIFACTS === "off") return null;
  return request => produceGitHubRepositoryArtifact(request, { root: githubRepositoryArtifactRoot() });
}
