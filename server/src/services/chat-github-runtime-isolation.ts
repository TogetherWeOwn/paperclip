import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import dns from "node:dns/promises";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agents, environments, heartbeatRuns, chatGitHubReviewCandidates, chatGitHubReviewEnrollments, type Db,
} from "@paperclipai/db";
import { runSshCommand, shellQuote } from "@paperclipai/adapter-utils/ssh";
import type { AdapterExecutionTarget, AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { ConfigurationIncompleteFailure } from "./configuration-incomplete-failure.js";
import { githubCandidateRunBoundary } from "./chat-github-isolation.js";
import { githubCandidateMayWake } from "./chat-github-shadow.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { githubComparisonEligibility, githubPrimaryInputSource, GITHUB_SHADOW_PROTOCOL } from "./chat-github-comparison.js";
import { githubCandidateHooks } from "./chat-github-hooks.js";

const certificateSchema = z.object({
  environmentId: z.string().uuid(),
  companyId: z.string().uuid(),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
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
 */
export const GITHUB_ISOLATION_PROBE = `import errno, json, os, pwd, socket, sys
p = json.load(sys.stdin)
checks = {"primaryCanariesDenied": False, "githubDenied": False, "configFresh": False}
username = pwd.getpwuid(os.geteuid()).pw_name
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
    try:
        os.mkdir(p["home"], 0o700)
        with open(os.path.join(p["home"], ".probe-owner"), "x") as owner: owner.write(p["nonce"])
        for child in (".claude", ".config", ".cache", ".local", "tmp", "workspace"):
            os.mkdir(os.path.join(p["home"], child), 0o700)
        siblings = [name for name in os.listdir(os.path.dirname(p["home"])) if name != os.path.basename(p["home"])]
        checks["configFresh"] = not siblings and not os.listdir(os.path.join(p["home"], ".claude"))
    except OSError:
        pass
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
print(json.dumps({"nonce": p["nonce"], "username": username, "home": p["home"], "checks": checks, "hooksDigest": hooks_digest}))
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
    || (env.ANTHROPIC_BASE_URL != null && env.ANTHROPIC_BASE_URL !== "http://127.0.0.1:8317")) {
    refuse("github_candidate_isolation_unavailable");
  }
  const providerEnv = Object.fromEntries(
    ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
      "API_TIMEOUT_MS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"].flatMap(key =>
      typeof env[key] === "string" ? [[key, env[key]]] : []),
  );
  return { ...config, cwd, extraArgs: ["--disallowedTools", "WebSearch", "WebFetch"], env: { ...providerEnv, ...prepared.env,
    PATH: "/usr/local/bin:/usr/bin:/bin", PAPERCLIP_API_URL: "http://127.0.0.1:3100",
    PAPERCLIP_ASSIGNED_MODEL: typeof config.model === "string" ? config.model : providerEnv.ANTHROPIC_MODEL ?? "",
    PAPERCLIP_RUN_SCRATCH_DIR: `${prepared.home}/tmp`,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } };
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
  const home = `/home/paperclip-shadow/.paperclip-runtime/isolated/${boundary.namespace}`;
  const nonce = randomUUID();
  const hooks = await githubCandidateHooks(home);
  let checks = { primaryCanariesDenied: false, githubDenied: false, configFresh: false };
  let proofReceived = false;
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
      stdin: JSON.stringify({ nonce, home, hooks, canaries: certificate.primaryCanaries.map(c => c.remotePath), githubAddresses: addresses.slice(0, 4).map(a => a.address) }),
      timeoutMs: 15_000, maxBuffer: 8192,
    });
    const proof = JSON.parse(result.stdout);
    if (proof.nonce !== nonce || proof.username !== "paperclip-shadow" || proof.home !== home) throw new Error("probe_binding_mismatch");
    if (!proof.checks || Object.keys(checks).some(key => typeof proof.checks[key] !== "boolean")) throw new Error("probe_checks_malformed");
    checks = { primaryCanariesDenied: proof.checks.primaryCanariesDenied,
      githubDenied: proof.checks.githubDenied, configFresh: proof.checks.configFresh };
    // The probe intentionally does not install hooks after failed confinement.
    // A bound negative proof remains contamination, not a missing-hook outage.
    if (Object.values(checks).every(Boolean) && proof.hooksDigest !== hooks.digest) throw new Error("probe_hooks_mismatch");
    proofReceived = true;
  } catch { /* Infrastructure errors are missing evidence, not demonstrated contamination. */ }
  const passed = proofReceived && Object.values(checks).every(Boolean);
  const failure = proofReceived ? "github_candidate_contaminated" : "github_candidate_isolation_error";
  const receipt = { version: 1, runId: run.id, candidateId: boundary.candidate.id, armId: boundary.candidate.armId,
    environmentId: environment.id, namespace: boundary.namespace, configurationDigest: certificate.configurationDigest,
    certificateDigest: certificateDigest(certificate),
    home, checkedAt: new Date().toISOString(), status: passed ? "passed" : proofReceived ? "failed" : "error", checks,
    // This certifies only this candidate's runtime. It never promotes the
    // primary's non-isolated namespace or claims tool equivalence.
    candidateRuntimeCertified: passed, disallowedTools: ["WebSearch", "WebFetch"],
    primaryToolPolicy: boundary.enrollment.envelope.primaryToolPolicy ?? null,
    hooksDigest: hooks.digest,
    primaryBlindingVersion: GITHUB_SHADOW_PROTOCOL.primaryBlindingVersion,
    comparisonEligibility: githubComparisonEligibility({ environmentCertified: true, selfTestRecorded: true,
      selfTestPassed: passed, primaryBlindingActive: boundary.enrollment.envelope.protocol?.primaryBlindingVersion === GITHUB_SHADOW_PROTOCOL.primaryBlindingVersion,
      snapshotAvailable: !!boundary.enrollment.envelope.snapshot, roundOrdinal: boundary.enrollment.roundOrdinal,
      primaryInputSource: await githubPrimaryInputSource(db, boundary.enrollment) }) };
  try {
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
      env: { HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude`, XDG_CONFIG_HOME: `${home}/.config`,
        XDG_CACHE_HOME: `${home}/.cache`, XDG_DATA_HOME: `${home}/.local`, TMPDIR: `${home}/tmp` },
      target: { ...target, githubCandidateIsolation: { namespace: boundary.namespace, home },
        remoteCwd: `${home}/workspace`, spec: { ...target.spec, remoteCwd: `${home}/workspace` } },
    };
    await assertGitHubCandidateDispatch(db, prepared, prepared.target);
    return prepared;
  } catch (error) {
    // Preparation can create a home and then fail before returning a handle to
    // heartbeat. Clean that path too; leftover homes fail the next sibling probe.
    await cleanupGitHubCandidateRuntime({ home, namespace: boundary.namespace, target, cleanupNonce: nonce }).catch(() => undefined);
    throw error;
  }
}

export async function cleanupGitHubCandidateRuntime(prepared: Pick<PreparedGitHubCandidateRuntime, "home" | "namespace" | "target" | "cleanupNonce">) {
  if (!/^[a-f0-9]{64}$/.test(prepared.namespace)
    || prepared.home !== `/home/paperclip-shadow/.paperclip-runtime/isolated/${prepared.namespace}`) {
    throw new Error("Invalid candidate cleanup namespace");
  }
  // rmtree does not follow nested symlinks. Never interpolate arbitrary config
  // paths, remove siblings, or remove the shared isolated parent.
  await runSshCommand(prepared.target.spec,
    `python3 -c ${shellQuote(GITHUB_ISOLATION_CLEANUP)} ${shellQuote(prepared.home)} ${shellQuote(prepared.cleanupNonce)}`,
    { timeoutMs: 15_000, maxBuffer: 8192 });
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
  if (!receipt || receipt.status !== "passed" || receipt.candidateId !== prepared.candidateId || receipt.namespace !== prepared.namespace
    || receipt.configurationDigest !== prepared.configurationDigest || receipt.certificateDigest !== prepared.certificateDigest)
    refuse("github_candidate_isolation_unavailable");
}
