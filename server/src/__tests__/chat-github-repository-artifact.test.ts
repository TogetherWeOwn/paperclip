import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as ssh from "@paperclipai/adapter-utils/ssh";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { produceGitHubRepositoryArtifact, githubRepositoryArtifactFile, type GitHubRepositoryArtifact,
  type GitHubRepositoryArtifactRequest } from "../services/chat-github-repository-artifact.js";
import { materializeGitHubCandidateWorkspace } from "../services/chat-github-runtime-isolation.js";
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
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "base");
  base = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "-b", "feature");
  writeFileSync(join(origin, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(origin, "run.sh"), 0o755);
  symlinkSync("README.md", join(origin, "link"));
  writeFileSync(join(origin, "ignored.txt"), "tracked although ignored\n");
  git(origin, "add", "-A");
  git(origin, "add", "-f", "ignored.txt");
  git(origin, "commit", "-q", "-m", "head");
  head = git(origin, "rev-parse", "HEAD");
  // A later fix commit (what the primary might find) and an unrelated branch.
  writeFileSync(join(origin, "fix.txt"), "LATER_FIX_LEAK\n");
  git(origin, "add", "-A");
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
  const event = { headSha: head, baseSha: base, pullNumber: 7 } as never;
  const provider = () => ({ request: async <T>(path: string) => (path === "/pulls/7" ? { head: { sha: head }, base: { sha: base } }
    : path.startsWith("/compare/") ? { merge_base_commit: { sha: base } } : path.includes("/check-runs") ? { check_runs: [] } : []) as T });
  it("seals the artifact under the snapshot digest and records a precise failure otherwise", async () => {
    const artifact = { version: 1, kind: "bundle", path: `${"c".repeat(64)}.bundle`, sha256: "c".repeat(64), bytes: 1, headSha: head, baseSha: base,
      headTree: "d".repeat(40), baseTree: "e".repeat(40), refs: { base: "refs/heads/main", head: "refs/pull/7/head" }, commits: { base, head } } as const;
    const sealed = await captureGitHubReviewSnapshot(provider(), { ...(event as object), headSha: head, baseSha: base } as never, undefined,
      Promise.resolve({ repository: { ...artifact } }));
    expect(sealed.repository).toEqual(artifact);
    const reader = (snapshot: typeof sealed) => githubSnapshotReader(snapshot, { headSha: head, baseSha: base, pullNumber: 7 }, async () => { throw new Error("live"); });
    expect(() => reader(sealed)).not.toThrow();
    expect(() => reader({ ...sealed, repository: { ...artifact, headSha: later } })).toThrow("Invalid sealed review snapshot");
    const mismatched = await captureGitHubReviewSnapshot(provider(), { headSha: head, baseSha: base, pullNumber: 7 } as never, undefined,
      Promise.resolve({ repository: { ...artifact, headSha: later } }));
    expect(mismatched).toMatchObject({ repositoryFailure: "repository_artifact_binding_mismatch" });
    expect(mismatched.repository).toBeUndefined();
    const late = await captureGitHubReviewSnapshot(provider(), { headSha: head, baseSha: base, pullNumber: 7 } as never, undefined,
      Promise.resolve({ repositoryFailure: "repository_artifact_late" }));
    expect(late).toMatchObject({ repositoryFailure: "repository_artifact_late" });
    expect(late.repository).toBeUndefined();
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
    vi.spyOn(ssh, "runSshCommand").mockImplementation(async (_spec, command, options) => {
      commands.push(command);
      const script = /^python3 -c '([\s\S]*)'$/.exec(command)![1]!.replaceAll(`'"'"'`, "'");
      const stdout = execFileSync("python3", ["-c", script], { input: options!.stdin, encoding: "utf8", env: { PATH: process.env.PATH! } });
      return { stdout, stderr: "" };
    });
    return { home, commands };
  }
  const target = { kind: "remote", transport: "ssh", spec: { host: "127.0.0.1", port: 22, username: "paperclip-shadow" } } as unknown as AdapterSshExecutionTarget;

  it.each(["bundle", "synthetic"] as const)("materialises a %s checkout with an offline local origin", async kind => {
    const dir = root();
    const artifact = await produceGitHubRepositoryArtifact(request(), { root: dir,
      remoteUrl: () => kind === "bundle" ? origin : join(scratch, "missing-origin") });
    expect(artifact.kind).toBe(kind);
    const { home } = fakeHost();
    const receipt = await materializeGitHubCandidateWorkspace({ snapshot: { repository: artifact } as never, target, home, nonce: "n", artifactRoot: dir });
    expect(receipt).toMatchObject({ version: 1, status: "materialized", kind, artifactSha256: artifact.sha256,
      head: kind === "bundle" ? head : artifact.commits.head, tree: artifact.headTree,
      baseCommit: kind === "bundle" ? base : artifact.commits.base, baseTree: artifact.baseTree });
    const ws = join(home, "workspace");
    expect(readFileSync(join(ws, "run.sh"), "utf8")).toContain("echo hi");
    expect(git(ws, "rev-parse", "HEAD^{tree}")).toBe(git(origin, "rev-parse", `${head}^{tree}`));
    expect(git(ws, "remote", "-v").split("\n").every(line => line.includes(join(home, ".paperclip-review", "origin.git")))).toBe(true);
    git(ws, "fetch", "-q", "origin");
    expect(git(ws, "diff", "--name-only", "origin/main...HEAD").split("\n").sort()).toEqual(["ignored.txt", "link", "run.sh"]);
    expect(existsSync(join(home, ".paperclip-review", "artifact", "repository.bundle"))).toBe(false);
    mkdirSync(join(ws, ".paperclip-runtime"));
    expect(git(ws, "status", "--porcelain")).toBe("");
    expect(() => git(ws, "cat-file", "-e", later)).toThrow();
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
  });
});
