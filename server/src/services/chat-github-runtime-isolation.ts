import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import dns from "node:dns/promises";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agents, environments, heartbeatRuns, chatGitHubReviewCandidates, chatGitHubReviewEnrollments, withDedicatedDbConnection, type Db,
  type GitHubCandidateWorkspaceReceipt, type GitHubReviewInputSnapshot,
} from "@paperclipai/db";
import { isSshSyncTimeoutError, runSshCommand, shellQuote, syncDirectoryToSsh } from "@paperclipai/adapter-utils/ssh";
import type { AdapterExecutionTarget, AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { ConfigurationIncompleteFailure } from "./configuration-incomplete-failure.js";
import { githubCandidateRunBoundary } from "./chat-github-isolation.js";
import { githubCandidateMayWake } from "./chat-github-shadow.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { githubComparisonEligibility, githubPrimaryInputSource, GITHUB_SHADOW_PROTOCOL } from "./chat-github-comparison.js";
import { githubCandidateHooks } from "./chat-github-hooks.js";
import { awaitGitHubRepositoryArtifact, GITHUB_REPOSITORY_ARTIFACT_DISPATCH_WAIT_MS, GitHubRepositoryArtifactError, githubRepositoryArtifactFile,
  pinGitHubRepositoryArtifact, type GitHubRepositoryCheckout } from "./chat-github-repository-artifact.js";

const certificateSchema = z.object({
  environmentId: z.string().uuid(),
  companyId: z.string().uuid(),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  modelProxyPolicy: z.literal("client-tools-only-v1"),
  primaryCanaries: z.array(z.object({
    kind: z.enum(["run", "worktree"]),
    serverPath: z.string().startsWith("/"),
    remotePath: z.string().startsWith("/"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(2).max(16).refine(paths => ["run", "worktree"].every(kind => paths.some(p => p.kind === kind))),
}).strict();
type Certificate = z.infer<typeof certificateSchema>;

/** Operator-owned certification, never an agent/issue config escape hatch.
 * An absent or malformed list preserves the original fail-closed behavior. */
export function githubIsolationCertificates(): Certificate[] {
  try { return z.array(certificateSchema).max(100).parse(JSON.parse(process.env.PAPERCLIP_GITHUB_SHADOW_CERTIFIED_ENVIRONMENTS ?? "[]")); }
  catch { return []; }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function githubIsolationConfigurationDigest(environment: { driver: string; config: unknown; envVars?: unknown }) {
  return createHash("sha256").update(JSON.stringify(canonical({ driver: environment.driver, config: environment.config, envVars: environment.envVars ?? {} }))).digest("hex");
}

function certificateDigest(certificate: Certificate): string {
  return createHash("sha256").update(JSON.stringify(canonical(certificate))).digest("hex");
}

function refuse(reason: string): never {
  throw new ConfigurationIncompleteFailure(`${reason}: no candidate provider work permitted`, {
    configurationIncomplete: { reason },
  });
}

/** Executed by the SSH principal, not by the agent. EACCES/EPERM only: a missing
 * canary or missing interpreter is NOT evidence of confinement. The controller
 * independently verifies each planted canary's bytes through its mounted path.
 * Numeric GitHub addresses bypass DNS (which the egress policy also denies).
 * TLS is deliberately unnecessary: any TCP connection can fetch public answers.
 * Probe, run and cleanup all hold the exclusive host-wide advisory lease, so a
 * home already under isolated/ belongs to a crashed run. Homes idle for
 * GITHUB_ORPHAN_HOME_MIN_AGE_SECONDS are reclaimed (lstat only, rmtree never
 * follows symlinks, only direct children of the isolated parent); a younger
 * one still means namespaceBusy, the backstop should the lease ever be lost.
 * Reclaim refuses (deletes nothing) unless the parent is exactly
 * GITHUB_ISOLATED_PARENT, so a malformed home can never widen it to "/".
 * An allowed-model outage (timeout, 429, 5xx) is missing evidence only when
 * every other check passed: the probe then exits without a proof. Any other
 * failed check keeps the bound negative proof, so a breach is never hidden.
 */
export const GITHUB_ORPHAN_HOME_MIN_AGE_SECONDS = 30 * 60;
/** The only namespace parent the server derives candidate homes under. */
export const GITHUB_ISOLATED_PARENT = "/home/paperclip-shadow/.paperclip-runtime/isolated";
export const GITHUB_ISOLATION_PROBE = `import errno, json, os, pwd, shutil, socket, stat, sys, time, urllib.request, urllib.error
ISOLATED_PARENT = ${JSON.stringify(GITHUB_ISOLATED_PARENT)}
p = json.load(sys.stdin)
def reclaim_orphans(parent, min_age):
    # Exact match only: never "/", an ancestor, a sibling or an unnormalised alias.
    if parent != ISOLATED_PARENT: return 0
    reclaimed = 0
    now = time.time()
    for name in os.listdir(parent):
        if not name or "/" in name or name in (".", ".."): continue
        entry = os.path.join(parent, name)
        try:
            st = os.lstat(entry)
            newest = st.st_mtime
            if stat.S_ISDIR(st.st_mode):
                try: newest = max(newest, os.lstat(os.path.join(entry, ".probe-owner")).st_mtime)
                except OSError: pass
            if now - newest < min_age: continue
            if stat.S_ISDIR(st.st_mode): shutil.rmtree(entry)
            else: os.unlink(entry)
            reclaimed += 1
        except OSError:
            pass
    return reclaimed
checks = {"primaryCanariesDenied": False, "githubDenied": False, "configFresh": False, "providerToolsDenied": False,
          "allowedModelAccepted": False, "otherModelDenied": False, "rawProxyDenied": False}
username = pwd.getpwuid(os.geteuid()).pw_name
namespace_busy = False
orphans_reclaimed = 0
if username == "paperclip-shadow" and os.geteuid() != 0:
    denied = []
    for canary in p["canaries"]:
        try:
            with open(canary, "rb") as f: f.read(1)
            denied.append(False)
        except OSError as e:
            denied.append(e.errno in (errno.EACCES, errno.EPERM))
    checks["primaryCanariesDenied"] = bool(denied) and all(denied)
    blocked = []
    for address in p["githubAddresses"]:
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            try:
                sock.connect((address, 443))
                blocked.append(False)
            except OSError as e:
                blocked.append(e.errno in (errno.EACCES, errno.EPERM, errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ECONNREFUSED, errno.ETIMEDOUT) or isinstance(e, TimeoutError))
    checks["githubDenied"] = bool(blocked) and all(blocked)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(2)
        try:
            sock.connect(("127.0.0.1", 8317))
        except OSError as e:
            checks["rawProxyDenied"] = e.errno in (errno.EACCES, errno.EPERM, errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ECONNREFUSED, errno.ETIMEDOUT) or isinstance(e, TimeoutError)
    base = {"model": p["model"], "max_tokens": 1, "messages": [{"role": "user", "content": "Reply OK"}],
            "context_management": {"edits": [{"type": "clear_thinking_20251015", "keep": "all"}]}}
    def proxy_request(extra, expect_denied, timeout=5):
        request = urllib.request.Request("http://127.0.0.1:8318/v1/messages", data=json.dumps({**base, **extra}).encode(),
            headers={"Authorization": "Bearer " + p.get("proxyToken", ""), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return not expect_denied and 200 <= response.status < 300
        except urllib.error.HTTPError as e:
            # A slow, rate-limited or failing upstream for the allowed model is
            # unavailable (None), not a demonstrated confinement failure. The
            # remaining checks still run so an observed breach is not discarded.
            if not expect_denied and (e.code == 429 or e.code >= 500): return None
            return expect_denied and e.code == 403 and e.headers.get("x-paperclip-shadow-policy") == "client-tools-only-v1"
        except OSError as e:
            if not expect_denied and (isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError)): return None
            return False
    # The allowed model is served by a shared upstream that can queue for minutes.
    checks["allowedModelAccepted"] = proxy_request({}, False, 25)
    checks["otherModelDenied"] = proxy_request({"model": "isolation-probe-" + p["nonce"]}, True)
    checks["providerToolsDenied"] = all([proxy_request(extra, True) for extra in [
        {"tools": [{"type": "web_search_20250305", "name": "web_search"}]},
        {"tools": [{"type": "web_fetch_20250910", "name": "web_fetch"}]},
        {"mcp_servers": [{"type": "url", "url": "https://github.com"}]}]])
    try:
        orphans_reclaimed = reclaim_orphans(os.path.dirname(p["home"]), ${GITHUB_ORPHAN_HOME_MIN_AGE_SECONDS})
        namespace_busy = bool(os.listdir(os.path.dirname(p["home"])))
        if namespace_busy: raise FileExistsError("candidate_namespace_busy")
        os.mkdir(p["home"], 0o700)
        with open(os.path.join(p["home"], ".probe-owner"), "x") as owner: owner.write(p["nonce"])
        for child in (".claude", ".config", ".cache", ".local", "tmp", "workspace"):
            os.mkdir(os.path.join(p["home"], child), 0o700)
        siblings = [name for name in os.listdir(os.path.dirname(p["home"])) if name != os.path.basename(p["home"])]
        checks["configFresh"] = not siblings and not os.listdir(os.path.join(p["home"], ".claude"))
    except OSError:
        pass
if checks["allowedModelAccepted"] is None:
    # Unavailable with nothing else wrong: no proof (isolation_error). Any other
    # failed check is a recorded breach and stays a bound negative proof.
    if all(value for key, value in checks.items() if key != "allowedModelAccepted"): sys.exit("allowed_model_unavailable")
    checks["allowedModelAccepted"] = False
hooks_digest = None
if all(checks.values()) and p.get("hooks"):
    try:
        for relative, content in p["hooks"]["files"].items():
            target = os.path.join(p["home"], relative)
            if os.path.isabs(relative) or ".." in relative.split("/"): raise ValueError("hook_path")
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            with open(target, "x", encoding="utf8") as f: f.write(content)
            with open(target, "r", encoding="utf8") as f:
                if f.read() != content: raise ValueError("hook_bytes")
        hooks_digest = p["hooks"]["digest"]
    except (OSError, ValueError):
        checks["configFresh"] = False
print(json.dumps({"nonce": p["nonce"], "username": username, "home": p["home"], "checks": checks, "namespaceBusy": namespace_busy, "orphansReclaimed": orphans_reclaimed, "hooksDigest": hooks_digest}))
`;

export const GITHUB_ISOLATION_CLEANUP = `import os, shutil, sys
home, nonce = sys.argv[1:3]
if os.path.isdir(home) and not os.path.islink(home):
    try:
        with open(os.path.join(home, ".probe-owner")) as owner: owned = owner.read() == nonce
    except OSError:
        owned = False
    if owned: shutil.rmtree(home)
`;

/** Executed by the isolated SSH principal inside its fresh home. Materialises
 * the sealed artifact as a normal checkout with a LOCAL bare origin, so offline
 * `git fetch origin` / `git diff origin/<base>...HEAD` work and no network
 * remote exists. The controller independently re-verifies every reported hash. */
export const GITHUB_WORKSPACE_MATERIALIZE = `import hashlib, json, os, subprocess, sys
p = json.load(sys.stdin)
home = p["home"]
review = os.path.join(home, ".paperclip-review")
bundle = os.path.join(review, "artifact", "repository.bundle")
origin = os.path.join(review, "origin.git")
ws = os.path.join(home, "workspace")
env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": home, "LANG": "C", "LC_ALL": "C",
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/bin/false"}
def git(*args):
    return subprocess.run(["git", *args], env=env, check=True, capture_output=True, text=True, timeout=300).stdout.strip()
result = {"nonce": p["nonce"], "home": home, "error": None}
try:
    digest = hashlib.sha256()
    with open(bundle, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""): digest.update(chunk)
    if digest.hexdigest() != p["sha256"]: raise ValueError("artifact_digest_mismatch")
    if os.listdir(ws): raise ValueError("workspace_not_empty")
    git("init", "-q", "--bare", origin)
    git("--git-dir", origin, "fetch", "-q", "--no-tags", bundle, "+refs/heads/*:refs/heads/*", "+refs/pull/*:refs/pull/*")
    refs = sorted(git("--git-dir", origin, "for-each-ref", "--format=%(objectname) %(refname)").splitlines())
    expected = sorted({p["commits"]["base"] + " " + p["refs"]["base"], p["commits"]["head"] + " " + p["refs"]["head"]})
    if refs != expected: raise ValueError("artifact_refs_mismatch")
    git("--git-dir", origin, "symbolic-ref", "HEAD", p["refs"]["base"])
    os.remove(bundle)
    git("clone", "-q", "--no-checkout", "--no-hardlinks", origin, ws)
    git("-C", ws, "fetch", "-q", "--no-tags", "origin", "+refs/pull/*:refs/remotes/origin/pull/*")
    git("-C", ws, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", p["commits"]["head"])
    with open(os.path.join(ws, ".git", "info", "exclude"), "a") as f: f.write("\\n.paperclip-runtime/\\n")
    base = "refs/remotes/origin/" + p["refs"]["base"][len("refs/heads/"):]
    result.update({"head": git("-C", ws, "rev-parse", "--verify", "HEAD"),
                   "tree": git("-C", ws, "rev-parse", "--verify", "HEAD^{tree}"),
                   "baseCommit": git("-C", ws, "rev-parse", "--verify", base + "^{commit}"),
                   "baseTree": git("-C", ws, "rev-parse", "--verify", base + "^{tree}"),
                   "remotes": sorted(set(git("-C", ws, "config", "--get-regexp", "^remote[.].*[.]url$").splitlines())),
                   "origin": origin})
except (OSError, ValueError, subprocess.SubprocessError) as e:
    result["error"] = str(e) if isinstance(e, ValueError) else type(e).__name__
print(json.dumps(result))
`;

export const GITHUB_WORKSPACE_TRANSFER_TIMEOUT_MS = 120_000;
export const GITHUB_WORKSPACE_MATERIALIZE_TIMEOUT_MS = 180_000;

/** Transfer + materialise the sealed checkout over the certified SSH channel.
 * Never throws: a missing artifact is a precise, recorded reason and the
 * candidate still runs with workspace equivalence unverified. */
export async function materializeGitHubCandidateWorkspace(input: {
  snapshot: GitHubReviewInputSnapshot | undefined;
  /** Checkout resolved from the admission manifest (artifact not sealed in the snapshot). */
  checkout?: GitHubRepositoryCheckout;
  target: AdapterSshExecutionTarget;
  home: string;
  nonce: string;
  artifactRoot?: string;
}): Promise<GitHubCandidateWorkspaceReceipt> {
  // Legacy snapshots sealed the artifact; newer ones carry only a known
  // admission-time failure and resolve the checkout from the manifest.
  const artifact = input.snapshot?.repository ?? (input.snapshot?.repositoryFailure ? undefined : input.checkout?.repository);
  if (!artifact) return { version: 1, status: "unavailable", kind: null,
    reason: !input.snapshot ? "admission_snapshot_unavailable"
      : input.snapshot.repositoryFailure ?? input.checkout?.repositoryFailure ?? "repository_artifact_missing" };
  // The comparison binds the receipt to these server-authored artifact facts.
  const base = { version: 1 as const, kind: artifact.kind, artifactSha256: artifact.sha256,
    ...(input.snapshot?.repository ? {} : { artifact }) };
  // Never evicted while this candidate hashes and transfers it.
  const release = pinGitHubRepositoryArtifact(artifact.sha256);
  try { return await materializeArtifact(input, artifact, base); }
  finally { release(); }
}

async function materializeArtifact(input: { target: AdapterSshExecutionTarget; home: string; nonce: string; artifactRoot?: string },
  artifact: NonNullable<GitHubReviewInputSnapshot["repository"]>,
  base: Pick<GitHubCandidateWorkspaceReceipt, "version" | "kind" | "artifactSha256" | "artifact">,
): Promise<GitHubCandidateWorkspaceReceipt> {
  let file: string;
  try { file = await githubRepositoryArtifactFile(artifact, input.artifactRoot); }
  catch (error) { return { ...base, status: "unavailable", reason: error instanceof GitHubRepositoryArtifactError ? error.reason : "repository_artifact_missing" }; }
  let staging: string | undefined;
  try {
    staging = await fs.mkdtemp(path.join(tmpdir(), "paperclip-shadow-artifact-"));
    await fs.symlink(file, path.join(staging, "repository.bundle"));
    // Bounded: this runs while holding the host-wide candidate lease.
    try {
      await syncDirectoryToSsh({ spec: input.target.spec, localDir: staging, remoteDir: `${input.home}/.paperclip-review/artifact`,
        followSymlinks: true, timeoutMs: GITHUB_WORKSPACE_TRANSFER_TIMEOUT_MS });
    } catch (error) {
      if (isSshSyncTimeoutError(error)) return { ...base, status: "error", reason: "workspace_transfer_timeout" };
      throw error;
    }
    const result = await runSshCommand(input.target.spec, `python3 -c ${shellQuote(GITHUB_WORKSPACE_MATERIALIZE)}`, {
      stdin: JSON.stringify({ nonce: input.nonce, home: input.home, sha256: artifact.sha256, refs: artifact.refs, commits: artifact.commits }),
      timeoutMs: GITHUB_WORKSPACE_MATERIALIZE_TIMEOUT_MS, maxBuffer: 64 * 1024,
    });
    const proof = JSON.parse(result.stdout) as Record<string, unknown>;
    if (proof.nonce !== input.nonce || proof.home !== input.home) return { ...base, status: "error", reason: "workspace_proof_binding_mismatch" };
    if (proof.error) return { ...base, status: "error", reason: `workspace_materialize_failed:${String(proof.error).slice(0, 80)}` };
    const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
    const observed = { head: hash(proof.head), tree: hash(proof.tree), baseCommit: hash(proof.baseCommit), baseTree: hash(proof.baseTree) };
    const origin = `${input.home}/.paperclip-review/origin.git`;
    const remotes = Array.isArray(proof.remotes) ? proof.remotes : [];
    // Exactly one remote, the local bare origin: no network remote can exist.
    if (proof.origin !== origin || remotes.length !== 1 || remotes[0] !== `remote.origin.url ${origin}`)
      return { ...base, ...observed, status: "error", reason: "workspace_network_remote_present" };
    const matches = artifact.kind === "bundle"
      ? observed.head === artifact.headSha && observed.baseCommit === artifact.baseSha
      : observed.head === artifact.commits.head && observed.baseCommit === artifact.commits.base;
    if (!matches || observed.tree !== artifact.headTree || observed.baseTree !== artifact.baseTree)
      return { ...base, ...observed, status: "error", reason: "workspace_head_mismatch" };
    return { ...base, ...observed, status: "materialized" };
  } catch {
    return { ...base, status: "error", reason: "workspace_transfer_failed" };
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Cross-controller lease on a reserved, dedicated SESSION, never a long idle
 * transaction. idle_in_transaction_session_timeout must not drop confinement
 * while the candidate runs. The normal primary pool is never borrowed. The key
 * is the SSH host/principal (same UID shares files across companies and arms).
 * The probe reclaims homes of crashed runs once idle for the orphan age; a
 * younger one still fails the independent namespaceBusy check. */
export async function acquireGitHubCandidateRuntimeLease(db: Db, hostPrincipal: string): Promise<() => Promise<void>> {
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const holding = withDedicatedDbConnection(db, async dedicated => {
    // reserve() pins the physical connection and prevents pool idle/lifetime
    // recycling between lock and unlock. Session locks do not span transactions.
    const connection = await dedicated.$client.reserve();
    const key = `github-shadow-runtime:${hostPrincipal}`;
    try {
      await connection`select pg_advisory_lock(hashtextextended(${key}, 0))`;
      acquired();
      await released;
      await connection`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    } finally { connection.release(); }
  });
  void holding.catch(failed);
  await ready;
  return async () => { release(); await holding; };
}
const runtimeLeases = new Map<string, () => Promise<void>>();

export interface PreparedGitHubCandidateRuntime {
  companyId: string;
  cleanupNonce: string;
  runId: string;
  candidateId: string;
  enrollmentId: string;
  namespace: string;
  home: string;
  env: Record<string, string>;
  target: AdapterSshExecutionTarget;
  configurationDigest: string;
  certificateDigest: string;
}

/** Only the CLI SSH lane has been certified. Do not silently change engines or
 * ship ambient host auth, injected shell hooks, resume flags, or config seeds. */
export function githubCandidateAdapterConfig(
  prepared: PreparedGitHubCandidateRuntime,
  config: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const env = config.env && typeof config.env === "object" ? config.env as Record<string, unknown> : {};
  if (config.engine !== "cli" || config.isolateRuntime === true || config.managedAiConnection
    || (config.command && config.command !== "claude") || config.chrome === true
    || (config.args != null && (!Array.isArray(config.args) || config.args.length > 0))
    || (config.extraArgs != null && (!Array.isArray(config.extraArgs) || config.extraArgs.length > 0))
    || (env.ANTHROPIC_BASE_URL != null && !["http://127.0.0.1:8317", "http://127.0.0.1:8318"].includes(String(env.ANTHROPIC_BASE_URL)))) {
    refuse("github_candidate_isolation_unavailable");
  }
  const providerEnv = Object.fromEntries(
    ["ANTHROPIC_MODEL",
      "API_TIMEOUT_MS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"].flatMap(key =>
      typeof env[key] === "string" ? [[key, env[key]]] : []),
  );
  return { ...config, cwd, extraArgs: ["--disallowedTools", "WebSearch", "WebFetch"], env: { ...providerEnv, ...prepared.env,
    PATH: "/usr/local/bin:/usr/bin:/bin", PAPERCLIP_API_URL: "http://127.0.0.1:3100",
    PAPERCLIP_ASSIGNED_MODEL: typeof config.model === "string" ? config.model : providerEnv.ANTHROPIC_MODEL ?? "",
    PAPERCLIP_RUN_SCRATCH_DIR: `${prepared.home}/tmp`,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8318", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } };
}

/** Use the same explicit config-before-env precedence as the CLI adapter, but
 * never infer a default provider/model for a certified shadow arm. */
export function githubCandidateProbeModel(config: Record<string, unknown>): string | null {
  const env = config.env && typeof config.env === "object" ? config.env as Record<string, unknown> : {};
  const configured = typeof config.model === "string" ? config.model.trim() : "";
  const environment = typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL.trim() : "";
  return configured || environment || null;
}

export async function resolveGitHubCandidateCheckout(enrollment: Pick<typeof chatGitHubReviewEnrollments.$inferSelect, "envelope" | "admittedAt">,
  options: { root?: string; waitMs?: number; pollMs?: number } = {}): Promise<GitHubRepositoryCheckout | undefined> {
  const { snapshot, event } = enrollment.envelope;
  if (!snapshot || !event || snapshot.repository || snapshot.repositoryFailure) return undefined;
  const admittedAt = enrollment.admittedAt instanceof Date ? enrollment.admittedAt.getTime() : Date.parse(String(enrollment.admittedAt));
  return awaitGitHubRepositoryArtifact(event, { root: options.root, pollMs: options.pollMs,
    deadlineAt: (Number.isFinite(admittedAt) ? admittedAt : Date.now()) + (options.waitMs ?? GITHUB_REPOSITORY_ARTIFACT_DISPATCH_WAIT_MS) });
}

/** Resolve the admission checkout and pin it at once: the cap sweep must not
 * evict it while the candidate queues for the host lease. `release` is idempotent. */
export async function holdGitHubCandidateCheckout(enrollment: Parameters<typeof resolveGitHubCandidateCheckout>[0],
  options: Parameters<typeof resolveGitHubCandidateCheckout>[1] = {}) {
  const checkout = await resolveGitHubCandidateCheckout(enrollment, options);
  const release = checkout?.repository ? pinGitHubRepositoryArtifact(checkout.repository.sha256) : () => undefined;
  return { checkout, release };
}

export async function prepareGitHubCandidateRuntime(db: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  agent: typeof agents.$inferSelect;
}): Promise<PreparedGitHubCandidateRuntime | null> {
  const { run, agent } = input;
  const boundary = await githubCandidateRunBoundary(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id });
  if (!boundary) return null; // Primary never consults certification, SSH, or the switch.
  // A replay must not probe or remove the live namespace of the original run.
  if (Object.hasOwn(boundary.enrollment.isolationTests, run.id)) refuse("github_candidate_isolation_replayed");
  if (!(await githubCandidateMayWake(db, boundary.candidate))) refuse("github_candidate_disabled");
  const certificate = githubIsolationCertificates().find(c => c.companyId === run.companyId && c.environmentId === agent.defaultEnvironmentId);
  // Only the existing Claude SSH adapter is certified by this contract. Other
  // adapters must prove identical HOME/session/transport behavior before entry.
  if (!certificate || agent.adapterType !== "claude_local") refuse("github_candidate_isolation_unavailable");
  const [environment] = await db.select().from(environments).where(eq(environments.id, certificate.environmentId));
  if (!environment || environment.status !== "active" || environment.driver !== "ssh" || githubIsolationConfigurationDigest(environment) !== certificate.configurationDigest)
    refuse("github_candidate_isolation_unavailable");
  const target = await resolveEnvironmentExecutionTarget({ db, companyId: run.companyId, adapterType: agent.adapterType,
    environment, leaseMetadata: null });
  if (target?.kind !== "remote" || target.transport !== "ssh" || target.spec.username !== "paperclip-shadow"
    || target.spec.strictHostKeyChecking !== true || !target.spec.knownHosts)
    refuse("github_candidate_isolation_unavailable");
  const proxyToken = process.env.PAPERCLIP_GITHUB_SHADOW_PROXY_TOKEN;
  const model = githubCandidateProbeModel(agent.adapterConfig as Record<string, unknown>);
  // No synthetic model: both positive and tool-denial probes must exercise the
  // arm's actual model, so a deny-all or model-only filter cannot certify.
  if (!proxyToken || !model) refuse("github_candidate_isolation_unavailable");
  const home = `${GITHUB_ISOLATED_PARENT}/${boundary.namespace}`;
  const nonce = randomUUID();
  const hooks = await githubCandidateHooks(home);
  // Wait for the admission's checkout BEFORE taking the host-wide lease. The
  // wait is bounded relative to admission; late or lost production becomes a
  // precise reason and the candidate runs with equivalence unverified.
  // Pinned from resolution, not from materialisation (see holdGitHubCandidateCheckout).
  const { checkout, release: releasePin } = await holdGitHubCandidateCheckout(boundary.enrollment);
  let releaseLease: () => Promise<void>;
  try { releaseLease = await acquireGitHubCandidateRuntimeLease(db, `${target.spec.host}:${target.spec.port ?? 22}:${target.spec.username}`); }
  catch (error) { releasePin(); throw error; }
  runtimeLeases.set(nonce, releaseLease);
  try {
  // A queued candidate may have been disabled while waiting for the prior arm.
  if (!(await githubCandidateMayWake(db, boundary.candidate))) refuse("github_candidate_disabled");
  let checks = { primaryCanariesDenied: false, githubDenied: false, configFresh: false, providerToolsDenied: false,
    allowedModelAccepted: false, otherModelDenied: false, rawProxyDenied: false };
  let proofReceived = false;
  let probeOrphansReclaimed = 0;
  try {
    for (const canary of certificate.primaryCanaries) {
      const bytes = await fs.readFile(canary.serverPath);
      if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== canary.sha256) throw new Error("canary_unverified");
    }
    // Resolve on the controller: the isolated account is not granted DNS egress.
    const addresses = await Promise.race([
      dns.lookup("github.com", { all: true }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("dns_timeout")), 3000); timer.unref(); }),
    ]);
    const result = await runSshCommand(target.spec, `python3 -c ${shellQuote(GITHUB_ISOLATION_PROBE)}`, {
      stdin: JSON.stringify({ nonce, home, hooks, proxyToken, model, canaries: certificate.primaryCanaries.map(c => c.remotePath), githubAddresses: addresses.slice(0, 4).map(a => a.address) }),
      timeoutMs: 60_000, maxBuffer: 8192,
    });
    const proof = JSON.parse(result.stdout);
    if (proof.nonce !== nonce || proof.username !== "paperclip-shadow" || proof.home !== home) throw new Error("probe_binding_mismatch");
    if (Number.isSafeInteger(proof.orphansReclaimed) && proof.orphansReclaimed > 0) probeOrphansReclaimed = proof.orphansReclaimed;
    if (!proof.checks || Object.keys(checks).some(key => typeof proof.checks[key] !== "boolean")) throw new Error("probe_checks_malformed");
    // A stale/concurrent namespace is missing availability, not proof that this
    // sample read a primary answer. The advisory lease handles healthy overlap.
    if (proof.namespaceBusy === true) throw new Error("candidate_namespace_busy");
    checks = { primaryCanariesDenied: proof.checks.primaryCanariesDenied,
      githubDenied: proof.checks.githubDenied, configFresh: proof.checks.configFresh, providerToolsDenied: proof.checks.providerToolsDenied,
      allowedModelAccepted: proof.checks.allowedModelAccepted, otherModelDenied: proof.checks.otherModelDenied, rawProxyDenied: proof.checks.rawProxyDenied };
    // The probe intentionally does not install hooks after failed confinement.
    // A bound negative proof remains contamination, not a missing-hook outage.
    if (Object.values(checks).every(Boolean) && proof.hooksDigest !== hooks.digest) throw new Error("probe_hooks_mismatch");
    proofReceived = true;
  } catch { /* Infrastructure errors are missing evidence, not demonstrated contamination. */ }
  const passed = proofReceived && Object.values(checks).every(Boolean);
  const failure = proofReceived ? "github_candidate_contaminated" : "github_candidate_isolation_error";
  // Only a confined, fresh home receives repository bytes. A failed proof never
  // gets a checkout; materialisation failure leaves equivalence unverified.
  const workspace = passed ? await materializeGitHubCandidateWorkspace({ snapshot: boundary.enrollment.envelope.snapshot,
    checkout, target, home, nonce }) : undefined;
  releasePin();
  const receipt = { version: 1, runId: run.id, candidateId: boundary.candidate.id, armId: boundary.candidate.armId,
    environmentId: environment.id, namespace: boundary.namespace, configurationDigest: certificate.configurationDigest,
    certificateDigest: certificateDigest(certificate),
    home, checkedAt: new Date().toISOString(), status: passed ? "passed" : proofReceived ? "failed" : "error", checks,
    // This certifies only this candidate's runtime. It never promotes the
    // primary's non-isolated namespace or claims tool equivalence.
    candidateRuntimeCertified: passed, disallowedTools: ["WebSearch", "WebFetch"],
    primaryToolPolicy: boundary.enrollment.envelope.primaryToolPolicy ?? null,
    hooksDigest: hooks.digest,
    orphansReclaimed: probeOrphansReclaimed,
    ...(workspace ? { workspace } : {}),
    primaryBlindingVersion: GITHUB_SHADOW_PROTOCOL.primaryBlindingVersion,
    comparisonEligibility: githubComparisonEligibility({ environmentCertified: true, selfTestRecorded: true,
      selfTestPassed: passed, primaryBlindingActive: boundary.enrollment.envelope.protocol?.primaryBlindingVersion === GITHUB_SHADOW_PROTOCOL.primaryBlindingVersion,
      snapshotAvailable: !!boundary.enrollment.envelope.snapshot, roundOrdinal: boundary.enrollment.roundOrdinal,
      primaryInputSource: await githubPrimaryInputSource(db, boundary.enrollment) }) };
    await db.transaction(async tx => {
      // Append-once evidence. A retry cannot replace failed proof or reuse success.
      const rows = await tx.update(chatGitHubReviewEnrollments).set({
        isolationTests: sql`${chatGitHubReviewEnrollments.isolationTests} || ${JSON.stringify({ [run.id]: receipt })}::jsonb`,
      }).where(and(eq(chatGitHubReviewEnrollments.companyId, run.companyId), eq(chatGitHubReviewEnrollments.id, boundary.enrollment.id),
        sql`not (${chatGitHubReviewEnrollments.isolationTests} ? ${run.id})`)).returning({ id: chatGitHubReviewEnrollments.id });
      if (!rows.length) refuse("github_candidate_isolation_replayed");
      if (!passed) await tx.update(chatGitHubReviewCandidates).set({ state: proofReceived ? "voided" : "unavailable", lastError: failure, nextAttemptAt: null, updatedAt: new Date() })
        .where(and(eq(chatGitHubReviewCandidates.id, boundary.candidate.id), eq(chatGitHubReviewCandidates.companyId, run.companyId),
          sql`${chatGitHubReviewCandidates.state} <> 'voided'`));
    });
    if (!passed) refuse(failure);
    const prepared: PreparedGitHubCandidateRuntime = {
      companyId: run.companyId, runId: run.id, candidateId: boundary.candidate.id, enrollmentId: boundary.enrollment.id,
      namespace: boundary.namespace, home, cleanupNonce: nonce, configurationDigest: certificate.configurationDigest,
      certificateDigest: receipt.certificateDigest,
      env: { ANTHROPIC_AUTH_TOKEN: proxyToken, HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude`, XDG_CONFIG_HOME: `${home}/.config`,
        XDG_CACHE_HOME: `${home}/.cache`, XDG_DATA_HOME: `${home}/.local`, TMPDIR: `${home}/tmp` },
      target: { ...target, githubCandidateIsolation: { namespace: boundary.namespace, home },
        remoteCwd: `${home}/workspace`, spec: { ...target.spec, remoteCwd: `${home}/workspace` } },
    };
    await assertGitHubCandidateDispatch(db, prepared, prepared.target);
    return prepared;
  } catch (error) {
    releasePin();
    await cleanupGitHubCandidateRuntime({ home, namespace: boundary.namespace, target, cleanupNonce: nonce }).catch(() => undefined);
    throw error;
  }
}

export async function cleanupGitHubCandidateRuntime(prepared: Pick<PreparedGitHubCandidateRuntime, "home" | "namespace" | "target" | "cleanupNonce">) {
  if (!/^[a-f0-9]{64}$/.test(prepared.namespace)
    || prepared.home !== `${GITHUB_ISOLATED_PARENT}/${prepared.namespace}`) {
    throw new Error("Invalid candidate cleanup namespace");
  }
  // rmtree does not follow nested symlinks. Never interpolate arbitrary config
  // paths, remove siblings, or remove the shared isolated parent.
  try {
    await runSshCommand(prepared.target.spec,
      `python3 -c ${shellQuote(GITHUB_ISOLATION_CLEANUP)} ${shellQuote(prepared.home)} ${shellQuote(prepared.cleanupNonce)}`,
      { timeoutMs: 15_000, maxBuffer: 8192 });
  } finally {
    const release = runtimeLeases.get(prepared.cleanupNonce);
    runtimeLeases.delete(prepared.cleanupNonce);
    await release?.();
  }
}

/** Recheck the switch, certification and durable receipt at the actual dispatch
 * seam, after all asynchronous setup. Never trust a wake payload's attestation. */
export async function assertGitHubCandidateDispatch(db: Db, prepared: PreparedGitHubCandidateRuntime, target: AdapterExecutionTarget | null | undefined) {
  const [candidate] = await db.select().from(chatGitHubReviewCandidates).where(and(eq(chatGitHubReviewCandidates.id, prepared.candidateId), eq(chatGitHubReviewCandidates.companyId, prepared.companyId)));
  if (!candidate || !(await githubCandidateMayWake(db, candidate))) refuse("github_candidate_disabled");
  const certificate = githubIsolationCertificates().find(c => c.companyId === prepared.companyId && c.environmentId === prepared.target.environmentId);
  const [environment] = await db.select().from(environments).where(eq(environments.id, prepared.target.environmentId!));
  if (!certificate || !environment || environment.status !== "active" || certificate.configurationDigest !== prepared.configurationDigest
    || certificateDigest(certificate) !== prepared.certificateDigest
    || githubIsolationConfigurationDigest(environment) !== prepared.configurationDigest
    || target?.kind !== "remote" || target.transport !== "ssh" || target.environmentId !== prepared.target.environmentId
    || target.remoteCwd !== prepared.target.remoteCwd || target.githubCandidateIsolation?.home !== prepared.home
    || target.githubCandidateIsolation?.namespace !== prepared.namespace
    || JSON.stringify(target.spec) !== JSON.stringify(prepared.target.spec)) refuse("github_candidate_isolation_unavailable");
  const [enrollment] = await db.select().from(chatGitHubReviewEnrollments).where(and(eq(chatGitHubReviewEnrollments.id, prepared.enrollmentId), eq(chatGitHubReviewEnrollments.companyId, prepared.companyId)));
  const receipt = enrollment?.isolationTests[prepared.runId];
  if (!receipt || receipt.status !== "passed" || receipt.checks.providerToolsDenied !== true
    || receipt.checks.allowedModelAccepted !== true || receipt.checks.otherModelDenied !== true || receipt.checks.rawProxyDenied !== true
    || receipt.candidateId !== prepared.candidateId || receipt.namespace !== prepared.namespace
    || receipt.configurationDigest !== prepared.configurationDigest || receipt.certificateDigest !== prepared.certificateDigest)
    refuse("github_candidate_isolation_unavailable");
}
