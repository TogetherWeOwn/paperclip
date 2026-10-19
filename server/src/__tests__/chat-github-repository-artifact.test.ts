import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as ssh from "@paperclipai/adapter-utils/ssh";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { awaitGitHubRepositoryArtifact, GitHubRepositoryArtifactError, githubRepositoryArtifactKey, pinGitHubRepositoryArtifact,
  produceGitHubRepositoryArtifact, pruneGitHubRepositoryArtifactStore, startGitHubRepositoryArtifact, githubRepositoryArtifactFile,
  type GitHubRepositoryArtifact, type GitHubRepositoryArtifactProducer, type GitHubRepositoryArtifactRequest } from "../services/chat-github-repository-artifact.js";
import { materializeGitHubCandidateWorkspace, holdGitHubCandidateCheckout, resolveGitHubCandidateCheckout } from "../services/chat-github-runtime-isolation.js";
import { captureGitHubReviewSnapshot, githubSnapshotReader } from "../services/chat-github-review-snapshot.js";

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let scratch: string;
let origin: string;
let base: string, head: string, later: string, other: string;
const roots: string[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "github-artifact-"));
  origin = join(scratch, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "README.md"), "base\r\n");
  writeFileSync(join(origin, ".gitattributes"), "*.md text eol=lf\n");
  writeFileSync(join(origin, ".gitignore"), "ignored.txt\n");
  // Stored with CRLF before any text attribute applies to it (see head commit).
  writeFileSync(join(origin, "legacy.txt"), "one\r\ntwo\r\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "base");
  base = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "-b", "feature");
  writeFileSync(join(origin, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(origin, "run.sh"), 0o755);
  symlinkSync("README.md", join(origin, "link"));
  writeFileSync(join(origin, "ignored.txt"), "tracked although ignored\n");
  writeFileSync(join(origin, ".gitattributes"), "*.md text eol=lf\n*.txt text\n");
  git(origin, "add", "run.sh", "link", ".gitattributes"); // legacy.txt keeps its stored CRLF blob
  git(origin, "add", "-f", "ignored.txt");
  git(origin, "commit", "-q", "-m", "head");
  head = git(origin, "rev-parse", "HEAD");
  // A later fix commit (what the primary might find) and an unrelated branch.
  writeFileSync(join(origin, "fix.txt"), "LATER_FIX_LEAK\n");
  git(origin, "add", "fix.txt");
  git(origin, "commit", "-q", "-m", "later fix");
  later = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "-b", "other", base);
  writeFileSync(join(origin, "other.txt"), "other branch\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "other");
  other = git(origin, "rev-parse", "HEAD");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const root = () => { const dir = mkdtempSync(join(scratch, "root-")); roots.push(dir); return dir; };
const request = (overrides: Partial<GitHubRepositoryArtifactRequest> = {}): GitHubRepositoryArtifactRequest => ({
  repository: "acme/widgets", pullNumber: 7, headSha: head, baseSha: base, baseBranch: "main", token: "fixture-token",
  fetchImpl: githubFixture(), signal: AbortSignal.timeout(60_000), ...overrides,
});

/** api.github.com git/commits + tarball (302 -> codeload), served from the fixture origin. */
function githubFixture(options: { tarballFrom?: (sha: string) => string; hang?: boolean } = {}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const target = new URL(String(url));
    if (options.hang) return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    let match = /^\/repos\/acme\/widgets\/git\/commits\/([a-f0-9]{40})$/.exec(target.pathname);
    if (target.hostname === "api.github.com" && match) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
      return Response.json({ sha: match[1], tree: { sha: git(origin, "rev-parse", `${match[1]}^{tree}`) } });
    }
    match = /^\/repos\/acme\/widgets\/tarball\/([a-f0-9]{40})$/.exec(target.pathname);
    if (target.hostname === "api.github.com" && match) {
      return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/acme/widgets/legacy.tar.gz/${match[1]}?token=signed` } });
    }
    match = /^\/acme\/widgets\/legacy\.tar\.gz\/([a-f0-9]{40})$/.exec(target.pathname);
    if (target.hostname === "codeload.github.com" && match) {
      // The installation token must never be forwarded off api.github.com.
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      const sha = options.tarballFrom ? options.tarballFrom(match[1]!) : match[1]!;
      return new Response(execFileSync("git", ["archive", "--format=tar.gz", `--prefix=acme-widgets-${sha.slice(0, 7)}/`, sha], { cwd: origin }));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function cloneArtifact(artifactRoot: string, artifact: GitHubRepositoryArtifact) {
  const clone = mkdtempSync(join(scratch, "clone-"));
  git(clone, "init", "-q", "--bare", ".");
  git(clone, "fetch", "-q", join(artifactRoot, "artifacts", artifact.path), "+refs/*:refs/*");
  return clone;
}

describe("sealed repository artifact", () => {
  it("bundles exactly the admitted head and base ancestry with no newer commits or refs", async () => {
    const dir = root();
    const artifact = await produceGitHubRepositoryArtifact(request(), { root: dir, remoteUrl: () => origin });
    expect(artifact).toMatchObject({ version: 1, kind: "bundle", headSha: head, baseSha: base, path: `${artifact.sha256}.bundle`,
      headTree: git(origin, "rev-parse", `${head}^{tree}`), baseTree: git(origin, "rev-parse", `${base}^{tree}`),
      refs: { base: "refs/heads/main", head: "refs/pull/7/head" }, commits: { base, head } });
    const clone = cloneArtifact(dir, artifact);
    expect(git(clone, "for-each-ref", "--format=%(objectname) %(refname)").split("\n").sort())
      .toEqual([`${base} refs/heads/main`, `${head} refs/pull/7/head`].sort());
    expect(git(clone, "rev-list", "--all").split("\n").sort()).toEqual(git(origin, "rev-list", head, base).split("\n").sort());
    for (const leak of [later, other]) expect(() => git(clone, "cat-file", "-e", leak)).toThrow();
    expect(execFileSync("git", ["-C", clone, "log", "--all", "-p"], { encoding: "utf8" })).not.toContain("LATER_FIX_LEAK");
    expect(await githubRepositoryArtifactFile(artifact, dir)).toBe(join(dir, "artifacts", artifact.path));
    // The server cache satisfies a later admission without contacting the origin.
    const again = await produceGitHubRepositoryArtifact(request(), { root: dir, remoteUrl: () => join(scratch, "gone") });
    expect(again).toMatchObject({ kind: "bundle", sha256: artifact.sha256 });
  });

  it("falls back to a synthetic two-commit repo whose head tree hash equals the admitted head tree", async () => {
    const dir = root();
    const artifact = await produceGitHubRepositoryArtifact(request(), { root: dir, remoteUrl: () => join(scratch, "missing-origin") });
    expect(artifact).toMatchObject({ kind: "synthetic", headSha: head, baseSha: base,
      headTree: git(origin, "rev-parse", `${head}^{tree}`), baseTree: git(origin, "rev-parse", `${base}^{tree}`) });
    const clone = cloneArtifact(dir, artifact);
    expect(git(clone, "rev-parse", "refs/pull/7/head^{tree}")).toBe(git(origin, "rev-parse", `${head}^{tree}`));
    expect(git(clone, "rev-parse", "refs/heads/main^{tree}")).toBe(git(origin, "rev-parse", `${base}^{tree}`));
    expect(git(clone, "rev-parse", "refs/pull/7/head^")).toBe(artifact.commits.base);
    expect(git(clone, "rev-list", "--all").split("\n")).toHaveLength(2);
    // The stored CRLF blob under a later `text` attribute survives byte-exactly.
    expect(execFileSync("git", ["-C", clone, "cat-file", "-p", "refs/pull/7/head:legacy.txt"], { encoding: "utf8" })).toBe("one\r\ntwo\r\n");
    for (const leak of [later, other, head, base]) expect(() => git(clone, "cat-file", "-e", leak)).toThrow();
  });

  it("fails closed when the synthetic tree does not hash to the admitted tree", async () => {
    await expect(produceGitHubRepositoryArtifact(request({ fetchImpl: githubFixture({ tarballFrom: sha => sha === head ? later : sha }) }),
      { root: root(), remoteUrl: () => join(scratch, "missing-origin") }))
      .rejects.toMatchObject({ reason: "bundle:repository_fetch_failed;synthetic:repository_synthetic_tree_mismatch" });
  });

  it("produces no artifact and a precise reason when the capture window closes", async () => {
    const dir = root();
    await expect(produceGitHubRepositoryArtifact(request({ fetchImpl: githubFixture({ hang: true }), signal: AbortSignal.timeout(300) }),
      { root: dir, remoteUrl: () => join(scratch, "missing-origin") }))
      .rejects.toMatchObject({ reason: "bundle:repository_fetch_failed;synthetic:repository_artifact_late" });
    const aborted = AbortSignal.abort();
    await expect(produceGitHubRepositoryArtifact(request({ signal: aborted }), { root: dir, remoteUrl: () => origin }))
      .rejects.toMatchObject({ reason: "repository_artifact_late" });
    expect(existsSync(join(dir, "artifacts")) ? execFileSync("ls", [join(dir, "artifacts")], { encoding: "utf8" }).trim() : "").toBe("");
  });

  it("enforces the size cap and rejects tampered or relabelled artifacts", async () => {
    const dir = root();
    await expect(produceGitHubRepositoryArtifact(request(), { root: dir, remoteUrl: () => origin, maxBytes: 10 }))
      .rejects.toMatchObject({ reason: "bundle:repository_artifact_too_large;synthetic:repository_artifact_too_large" });
    const artifact = await produceGitHubRepositoryArtifact(request(), { root: dir, remoteUrl: () => origin });
    await expect(githubRepositoryArtifactFile({ ...artifact, path: "../../etc/passwd" }, dir)).rejects.toMatchObject({ reason: "repository_artifact_invalid" });
    writeFileSync(join(dir, "artifacts", artifact.path), "tampered");
    await expect(githubRepositoryArtifactFile(artifact, dir)).rejects.toMatchObject({ reason: "repository_artifact_corrupt" });
  });
});

describe("sealed snapshot binding", () => {
  const ev = () => ({ headSha: head, baseSha: base, pullNumber: 7 }) as never;
  const provider = () => ({ request: async <T>(path: string) => (path === "/pulls/7" ? { head: { sha: head }, base: { sha: base } }
    : path.startsWith("/compare/") ? { merge_base_commit: { sha: base } } : path.includes("/check-runs") ? { check_runs: [] } : []) as T });
  it("seals only metadata: the checkout never blocks or enters the snapshot; an admission-time reason is digest-covered", async () => {
    const plain = await captureGitHubReviewSnapshot(provider(), ev(), undefined);
    expect(plain.repository).toBeUndefined();
    expect(plain.repositoryFailure).toBeUndefined();
    const disabled = await captureGitHubReviewSnapshot(provider(), ev(), undefined, "repository_artifact_disabled");
    expect(disabled).toMatchObject({ repositoryFailure: "repository_artifact_disabled" });
    const reader = (snapshot: typeof disabled) => githubSnapshotReader(snapshot, { headSha: head, baseSha: base, pullNumber: 7 }, async () => { throw new Error("live"); });
    expect(() => reader(disabled)).not.toThrow();
    expect(() => reader({ ...disabled, repositoryFailure: "forged" })).toThrow("Invalid sealed review snapshot");
  });

  it("reads one sweep's resources concurrently (a sequential seal took 5.5-7.1s against GitHub)", async () => {
    const slow = provider();
    let inFlight = 0, peak = 0;
    const timed = { request: async <T>(path: string) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 60));
      inFlight--;
      return slow.request<T>(path);
    } };
    const started = Date.now();
    await captureGitHubReviewSnapshot(timed, ev(), undefined);
    // 2 sweeps x 8 single-page reads: ~120ms concurrent vs ~960ms sequential.
    expect(Date.now() - started).toBeLessThan(500);
    expect(peak).toBe(8);
  });

  it("still detects a head change observed in a concurrent sweep", async () => {
    const moved = { request: async <T>(path: string) => (path === "/pulls/7" ? { head: { sha: later }, base: { sha: base } }
      : provider().request<T>(path)) as T };
    await expect(captureGitHubReviewSnapshot(moved, ev(), undefined)).rejects.toThrow("snapshot_capture_head_changed");
  });
});

describe("admission checkout manifest", () => {
  const admission = { repository: "Acme/Widgets", pullNumber: 7, baseBranch: "main" };
  const fake = (overrides: Partial<GitHubRepositoryArtifact> = {}): GitHubRepositoryArtifact => ({ version: 1, kind: "bundle",
    path: `${"c".repeat(64)}.bundle`, sha256: "c".repeat(64), bytes: 1, headSha: head, baseSha: base, headTree: "d".repeat(40),
    baseTree: "e".repeat(40), refs: { base: "refs/heads/main", head: "refs/pull/7/head" }, commits: { base, head }, ...overrides });
  const start = (dir: string, producer: GitHubRepositoryArtifactProducer, windowMs = 5_000, sha = head) =>
    startGitHubRepositoryArtifact({ ...admission, headSha: sha, baseSha: base, token: "t", fetchImpl: githubFixture() }, { producer, root: dir, windowMs });

  it("records a produced checkout for dispatch without a snapshot dependency", async () => {
    const dir = root();
    const seen: Array<{ deadlineAt?: number; signal: AbortSignal }> = [];
    const result = await start(dir, async request => { seen.push(request); return fake(); });
    expect(result).toEqual({ repository: fake() });
    expect(seen[0]!.signal.aborted).toBe(false);
    expect(seen[0]!.deadlineAt).toBeGreaterThan(Date.now());
    const key = githubRepositoryArtifactKey({ ...admission, headSha: head, baseSha: base });
    expect(JSON.parse(readFileSync(join(dir, "manifests", `${key}.json`), "utf8"))).toMatchObject({ version: 1, key, repository: fake() });
    expect(await awaitGitHubRepositoryArtifact({ ...admission, repository: "acme/widgets", headSha: head, baseSha: base }, { root: dir, deadlineAt: Date.now() }))
      .toEqual({ repository: fake() });
  });

  it("races a producer that ignores its signal: post-abort work only costs the checkout", async () => {
    const dir = root();
    let finish!: (artifact: GitHubRepositoryArtifact) => void;
    const started = Date.now();
    const result = await start(dir, () => new Promise(resolve => { finish = resolve; }), 200);
    expect(result).toEqual({ repositoryFailure: "repository_artifact_late" });
    expect(Date.now() - started).toBeLessThan(2_000);
    finish(fake());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await awaitGitHubRepositoryArtifact({ ...admission, headSha: head, baseSha: base }, { root: dir, deadlineAt: Date.now() }))
      .toEqual({ repositoryFailure: "repository_artifact_late" });
  });

  it("drops a checkout bound to other commits and reports producer failures precisely", async () => {
    expect(await start(root(), async () => fake({ headSha: later }))).toEqual({ repositoryFailure: "repository_artifact_binding_mismatch" });
    expect(await start(root(), async () => { throw new GitHubRepositoryArtifactError("bundle:x;synthetic:y"); }))
      .toEqual({ repositoryFailure: "bundle:x;synthetic:y" });
    expect(await start(root(), async () => { throw new Error("boom"); })).toEqual({ repositoryFailure: "repository_artifact_unavailable" });
  });

  it("waits for in-flight production, bounded, and reports not-ready past the dispatch deadline", async () => {
    const dir = root();
    let finish!: (artifact: GitHubRepositoryArtifact) => void;
    const production = start(dir, () => new Promise(resolve => { finish = resolve; }));
    const key = { ...admission, headSha: head, baseSha: base };
    expect(await awaitGitHubRepositoryArtifact(key, { root: dir, deadlineAt: Date.now() + 50 })).toEqual({ repositoryFailure: "repository_artifact_not_ready" });
    const waiting = awaitGitHubRepositoryArtifact(key, { root: dir, deadlineAt: Date.now() + 5_000 });
    finish(fake());
    expect(await waiting).toEqual({ repository: fake() });
    await production;
    // Nothing produced at all (e.g. production lost in a restart).
    expect(await awaitGitHubRepositoryArtifact({ ...key, headSha: later }, { root: dir, deadlineAt: Date.now() + 60, pollMs: 10 }))
      .toEqual({ repositoryFailure: "repository_artifact_not_ready" });
    // Dispatch measures the bound from admission, not from when it runs.
    const enrollment = { admittedAt: new Date(Date.now() - 200_000), envelope: { event: { ...key, headSha: later }, snapshot: { headSha: later } } } as never;
    const t0 = Date.now();
    expect(await resolveGitHubCandidateCheckout(enrollment, { root: dir })).toEqual({ repositoryFailure: "repository_artifact_not_ready" });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(await resolveGitHubCandidateCheckout({ ...(enrollment as object), envelope: { event: key, snapshot: { repositoryFailure: "repository_artifact_disabled" } } } as never))
      .toBeUndefined();
  });

  it("pins a resolved checkout until released, so the cap cannot evict it while the candidate queues for the lease", async () => {
    const dir = root();
    await start(dir, async () => fake());
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const file = join(dir, "artifacts", fake().path);
    writeFileSync(file, Buffer.alloc(100));
    const key = { ...admission, headSha: head, baseSha: base };
    const enrollment = { admittedAt: new Date(), envelope: { event: key, snapshot: { headSha: head } } } as never;
    const held = await holdGitHubCandidateCheckout(enrollment, { root: dir });
    expect(held.checkout).toEqual({ repository: fake() });
    try {
      await pruneGitHubRepositoryArtifactStore({ root: dir, maxBytes: 1 });
      expect(existsSync(file)).toBe(true);
    } finally { held.release(); held.release(); }
    await pruneGitHubRepositoryArtifactStore({ root: dir, maxBytes: 1 });
    expect(existsSync(file)).toBe(false);
  });
});

describe("repository store disk bound", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  function artifactFile(dir: string, sha: string, bytes: number, ageHours: number) {
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const file = join(dir, "artifacts", `${sha.repeat(64)}.bundle`);
    writeFileSync(file, Buffer.alloc(bytes));
    utimesSync(file, hoursAgo(ageHours), hoursAgo(ageHours));
    return file;
  }
  function manifest(dir: string, key: string, sha: string, ageHours: number) {
    mkdirSync(join(dir, "manifests"), { recursive: true });
    const file = join(dir, "manifests", `${key}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, key, repository: { sha256: sha.repeat(64) } }));
    utimesSync(file, hoursAgo(ageHours), hoursAgo(ageHours));
    return file;
  }

  it("evicts oldest-first above the total cap and never a pinned (materialising) artifact", async () => {
    const dir = root();
    const [a, b, c] = [artifactFile(dir, "a", 100, 3), artifactFile(dir, "b", 100, 2), artifactFile(dir, "c", 100, 1)];
    expect(await pruneGitHubRepositoryArtifactStore({ root: dir, maxBytes: 250 })).toMatchObject({ artifacts: 1, artifactBytes: 100 });
    expect([existsSync(a), existsSync(b), existsSync(c)]).toEqual([false, true, true]);
    const release = pinGitHubRepositoryArtifact("b".repeat(64));
    try {
      await pruneGitHubRepositoryArtifactStore({ root: dir, maxBytes: 50 });
      expect([existsSync(b), existsSync(c)]).toEqual([true, false]);
    } finally { release(); }
    await pruneGitHubRepositoryArtifactStore({ root: dir, maxBytes: 50 });
    expect(existsSync(b)).toBe(false);
  });

  it("never deletes a pinned artifact for age or terminal admission either", async () => {
    const dir = root();
    const old = artifactFile(dir, "f", 10, 24 * 8);
    const release = pinGitHubRepositoryArtifact("f".repeat(64));
    try {
      await pruneGitHubRepositoryArtifactStore({ root: dir, liveKeys: new Set() });
      expect(existsSync(old)).toBe(true);
    } finally { release(); }
    await pruneGitHubRepositoryArtifactStore({ root: dir, liveKeys: new Set() });
    expect(existsSync(old)).toBe(false);
  });

  it("serialises sweeps: a call during an in-flight sweep still applies its own cap", async () => {
    const dir = root();
    const file = artifactFile(dir, "9", 100, 1);
    const first = pruneGitHubRepositoryArtifactStore({ root: dir, maxBytes: 10_000 });
    const second = pruneGitHubRepositoryArtifactStore({ root: dir, maxBytes: 1 });
    expect(await first).toMatchObject({ artifacts: 0 });
    expect(await second).toMatchObject({ artifacts: 1, artifactBytes: 100 });
    expect(existsSync(file)).toBe(false);
  });

  it("reads the cap from PAPERCLIP_GITHUB_SHADOW_ARTIFACT_MAX_BYTES", async () => {
    const dir = root();
    const [a, b] = [artifactFile(dir, "a", 100, 2), artifactFile(dir, "b", 100, 1)];
    vi.stubEnv("PAPERCLIP_GITHUB_SHADOW_ARTIFACT_MAX_BYTES", "150");
    try { await pruneGitHubRepositoryArtifactStore({ root: dir }); } finally { vi.unstubAllEnvs(); }
    expect([existsSync(a), existsSync(b)]).toEqual([false, true]);
  });

  it("deletes a terminal admission's checkout after the grace, keeps live and fresh ones, and expires by retention", async () => {
    const dir = root();
    const live = [manifest(dir, "live", "a", 2), artifactFile(dir, "a", 10, 2)];
    const terminal = [manifest(dir, "done", "b", 2), artifactFile(dir, "b", 10, 2)];
    const fresh = [manifest(dir, "fresh", "c", 0.1), artifactFile(dir, "c", 10, 0.1)];
    const orphan = artifactFile(dir, "d", 10, 2);
    const expired = artifactFile(dir, "e", 10, 8 * 24);
    expect(await pruneGitHubRepositoryArtifactStore({ root: dir, liveKeys: new Set(["live"]) })).toMatchObject({ manifests: 1, artifacts: 3 });
    expect([...live, ...fresh].every(existsSync)).toBe(true);
    expect([...terminal, orphan, expired].some(existsSync)).toBe(false);
    // Without DB state only retention applies to unreferenced artifacts.
    const unknown = artifactFile(dir, "f", 10, 2);
    await pruneGitHubRepositoryArtifactStore({ root: dir });
    expect(existsSync(unknown)).toBe(true);
  });

  it("removes crashed capture/init/manifest debris older than an hour but not live work", async () => {
    const dir = root();
    const paths = { oldCapture: join(dir, "tmp", "capture-old"), newCapture: join(dir, "tmp", "capture-new"),
      oldInit: join(dir, "cache", `${"9".repeat(64)}.git.init-x`), oldTmp: join(dir, "manifests", ".k.u.tmp") };
    for (const p of [paths.oldCapture, paths.newCapture, paths.oldInit, join(dir, "manifests")]) mkdirSync(p, { recursive: true });
    writeFileSync(paths.oldTmp, "{");
    for (const p of [paths.oldCapture, paths.oldInit, paths.oldTmp]) utimesSync(p, hoursAgo(2), hoursAgo(2));
    expect(await pruneGitHubRepositoryArtifactStore({ root: dir })).toMatchObject({ staleWork: 3 });
    expect(Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, existsSync(p)])))
      .toEqual({ oldCapture: false, newCapture: true, oldInit: false, oldTmp: false });
  });

  it("bounds per-repository caches: idle past retention, then least-recently-used above the cache cap", async () => {
    const dir = root();
    const cache = (name: string, bytes: number, usedHoursAgo: number) => {
      const p = join(dir, "cache", `${name.repeat(64)}.git`);
      mkdirSync(join(p, "objects"), { recursive: true });
      writeFileSync(join(p, "objects", "pack"), Buffer.alloc(bytes));
      writeFileSync(join(p, "paperclip-last-used"), "");
      utimesSync(join(p, "paperclip-last-used"), hoursAgo(usedHoursAgo), hoursAgo(usedHoursAgo));
      return p;
    };
    const [idle, older, recent] = [cache("1", 10, 8 * 24), cache("2", 100, 2), cache("3", 100, 1)];
    expect(await pruneGitHubRepositoryArtifactStore({ root: dir, cacheMaxBytes: 150 })).toMatchObject({ caches: 2 });
    expect([existsSync(idle), existsSync(older), existsSync(recent)]).toEqual([false, false, true]);
  });

  it("marks cache use and prunes after every production write", async () => {
    const dir = root();
    artifactFile(dir, "a", 10, 8 * 24);
    await startGitHubRepositoryArtifact({ repository: "acme/widgets", pullNumber: 7, headSha: head, baseSha: base, baseBranch: "main",
      token: "fixture-token", fetchImpl: githubFixture() }, { root: dir, producer: request => produceGitHubRepositoryArtifact(request, { root: dir, remoteUrl: () => origin }) });
    await pruneGitHubRepositoryArtifactStore({ root: dir });
    expect(existsSync(join(dir, "artifacts", `${"a".repeat(64)}.bundle`))).toBe(false);
    const caches = execFileSync("ls", [join(dir, "cache")], { encoding: "utf8" }).trim().split("\n");
    expect(caches).toHaveLength(1);
    expect(existsSync(join(dir, "cache", caches[0]!, "paperclip-last-used"))).toBe(true);
  });
});

describe("candidate workspace materialisation over SSH", () => {
  /** The isolated host is simulated by a local directory: the transfer is a
   * copy and the remote command runs the exact shipped Python program. */
  function fakeHost() {
    const home = mkdtempSync(join(scratch, "isolated-home-"));
    mkdirSync(join(home, "workspace"), { mode: 0o700 });
    vi.spyOn(ssh, "syncDirectoryToSsh").mockImplementation(async input => {
      mkdirSync(input.remoteDir, { recursive: true });
      cpSync(input.localDir, input.remoteDir, { recursive: true, dereference: true });
    });
    const commands: string[] = [];
    const timeouts: Array<number | undefined> = [];
    vi.spyOn(ssh, "runSshCommand").mockImplementation(async (_spec, command, options) => {
      commands.push(command);
      timeouts.push(options?.timeoutMs);
      const script = /^python3 -c '([\s\S]*)'$/.exec(command)![1]!.replaceAll(`'"'"'`, "'");
      const stdout = execFileSync("python3", ["-c", script], { input: options!.stdin, encoding: "utf8", env: { PATH: process.env.PATH! } });
      return { stdout, stderr: "" };
    });
    return { home, commands, timeouts };
  }
  const target = { kind: "remote", transport: "ssh", spec: { host: "127.0.0.1", port: 22, username: "paperclip-shadow" } } as unknown as AdapterSshExecutionTarget;

  it.each(["bundle", "synthetic"] as const)("materialises a %s checkout with an offline local origin", async kind => {
    const dir = root();
    const artifact = await produceGitHubRepositoryArtifact(request(), { root: dir,
      remoteUrl: () => kind === "bundle" ? origin : join(scratch, "missing-origin") });
    expect(artifact.kind).toBe(kind);
    const { home, timeouts } = fakeHost();
    const receipt = await materializeGitHubCandidateWorkspace({ snapshot: { repository: artifact } as never, target, home, nonce: "n", artifactRoot: dir });
    // Both legs run under the host-wide candidate lease, so both are bounded.
    expect(vi.mocked(ssh.syncDirectoryToSsh).mock.calls[0]![0].timeoutMs).toBe(120_000);
    expect(timeouts).toEqual([180_000]);
    expect(receipt).toMatchObject({ version: 1, status: "materialized", kind, artifactSha256: artifact.sha256,
      head: kind === "bundle" ? head : artifact.commits.head, tree: artifact.headTree,
      baseCommit: kind === "bundle" ? base : artifact.commits.base, baseTree: artifact.baseTree });
    const ws = join(home, "workspace");
    expect(readFileSync(join(ws, "run.sh"), "utf8")).toContain("echo hi");
    expect(git(ws, "rev-parse", "HEAD^{tree}")).toBe(git(origin, "rev-parse", `${head}^{tree}`));
    expect(git(ws, "remote", "-v").split("\n").every(line => line.includes(join(home, ".paperclip-review", "origin.git")))).toBe(true);
    git(ws, "fetch", "-q", "origin");
    expect(git(ws, "diff", "--name-only", "origin/main...HEAD").split("\n").sort()).toEqual([".gitattributes", "ignored.txt", "link", "run.sh"]);
    expect(existsSync(join(home, ".paperclip-review", "artifact", "repository.bundle"))).toBe(false);
    mkdirSync(join(ws, ".paperclip-runtime"));
    // An empty dir never shows in status output, so seed a file: without the
    // .paperclip-runtime/ exclude this shows as untracked and fails the test.
    writeFileSync(join(ws, ".paperclip-runtime", "state.json"), "{}");
    // Runtime assets never show as untracked; legacy.txt is git's ordinary
    // CRLF-under-`text` renormalisation notice, identical in any clone.
    expect(git(ws, "status", "--porcelain", "--untracked-files=all")).toBe("M legacy.txt");
    expect(() => git(ws, "cat-file", "-e", later)).toThrow();
  });

  it("materialises a manifest-resolved checkout, records its artifact facts, and pins it against eviction meanwhile", async () => {
    const dir = root();
    const artifact = await produceGitHubRepositoryArtifact(request(), { root: dir, remoteUrl: () => origin });
    const { home } = fakeHost();
    let survived: boolean | undefined;
    const sync = vi.mocked(ssh.syncDirectoryToSsh).getMockImplementation()!;
    vi.mocked(ssh.syncDirectoryToSsh).mockImplementationOnce(async input => {
      await pruneGitHubRepositoryArtifactStore({ root: dir, maxBytes: 1, liveKeys: new Set() });
      survived = existsSync(join(dir, "artifacts", artifact.path));
      return sync(input);
    });
    const receipt = await materializeGitHubCandidateWorkspace({ snapshot: {} as never, checkout: { repository: artifact }, target, home, nonce: "n", artifactRoot: dir });
    expect(survived).toBe(true);
    expect(receipt).toMatchObject({ status: "materialized", artifactSha256: artifact.sha256, artifact });
    // A known admission-time failure wins over any later manifest.
    expect(await materializeGitHubCandidateWorkspace({ snapshot: { repositoryFailure: "repository_artifact_disabled" } as never,
      checkout: { repository: artifact }, target, home: "/h", nonce: "n" })).toMatchObject({ status: "unavailable", reason: "repository_artifact_disabled" });
    expect(await materializeGitHubCandidateWorkspace({ snapshot: {} as never, checkout: { repositoryFailure: "repository_artifact_not_ready" },
      target, home: "/h", nonce: "n" })).toMatchObject({ status: "unavailable", reason: "repository_artifact_not_ready" });
    // Released after materialisation: the cap applies again.
    await pruneGitHubRepositoryArtifactStore({ root: dir, maxBytes: 1 });
    expect(existsSync(join(dir, "artifacts", artifact.path))).toBe(false);
  });

  it("records precise reasons instead of a checkout when the artifact is absent, tampered, or misreported", async () => {
    const dir = root();
    const artifact = await produceGitHubRepositoryArtifact(request(), { root: dir, remoteUrl: () => origin });
    expect(await materializeGitHubCandidateWorkspace({ snapshot: { repositoryFailure: "repository_artifact_late" } as never, target, home: "/h", nonce: "n" }))
      .toEqual({ version: 1, status: "unavailable", kind: null, reason: "repository_artifact_late" });
    expect(await materializeGitHubCandidateWorkspace({ snapshot: undefined, target, home: "/h", nonce: "n" }))
      .toMatchObject({ status: "unavailable", reason: "admission_snapshot_unavailable" });
    expect(await materializeGitHubCandidateWorkspace({ snapshot: { repository: artifact } as never, target, home: "/h", nonce: "n", artifactRoot: root() }))
      .toMatchObject({ status: "unavailable", reason: "repository_artifact_missing" });
    // A host that reports a different head (or a network remote) is not a checkout of the admitted head.
    for (const [forged, reason] of [[{ head: later }, "workspace_head_mismatch"], [{ remotes: ["remote.origin.url https://github.com/acme/widgets.git"] }, "workspace_network_remote_present"],
      [{ nonce: "forged" }, "workspace_proof_binding_mismatch"]] as const) {
      const { home } = fakeHost();
      vi.mocked(ssh.runSshCommand).mockImplementationOnce(async (_spec, _command, options) => {
        const input = JSON.parse(options!.stdin!);
        return { stdout: JSON.stringify({ nonce: input.nonce, home: input.home, error: null, head, tree: artifact.headTree, baseCommit: base,
          baseTree: artifact.baseTree, origin: `${input.home}/.paperclip-review/origin.git`, remotes: [`remote.origin.url ${input.home}/.paperclip-review/origin.git`], ...forged }), stderr: "" };
      });
      expect(await materializeGitHubCandidateWorkspace({ snapshot: { repository: artifact } as never, target, home, nonce: "n", artifactRoot: dir }))
        .toMatchObject({ status: "error", reason });
    }
    const { home } = fakeHost();
    writeFileSync(join(home, "workspace", "stale"), "previous run");
    expect(await materializeGitHubCandidateWorkspace({ snapshot: { repository: artifact } as never, target, home, nonce: "n", artifactRoot: dir }))
      .toMatchObject({ status: "error", reason: "workspace_materialize_failed:workspace_not_empty" });
    vi.mocked(ssh.syncDirectoryToSsh).mockRejectedValueOnce(new Error("ssh down"));
    expect(await materializeGitHubCandidateWorkspace({ snapshot: { repository: artifact } as never, target, home, nonce: "n", artifactRoot: dir }))
      .toMatchObject({ status: "error", reason: "workspace_transfer_failed" });
    vi.mocked(ssh.syncDirectoryToSsh).mockRejectedValueOnce(new ssh.SshSyncTimeoutError(120_000));
    const runs = vi.mocked(ssh.runSshCommand).mock.calls.length;
    expect(await materializeGitHubCandidateWorkspace({ snapshot: { repository: artifact } as never, target, home, nonce: "n", artifactRoot: dir }))
      .toEqual({ version: 1, kind: artifact.kind, artifactSha256: artifact.sha256, status: "error", reason: "workspace_transfer_timeout" });
    expect(vi.mocked(ssh.runSshCommand).mock.calls.length).toBe(runs);
  });
});
