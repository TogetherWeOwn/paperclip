import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, chatGitHubReviews, type chatGitHubReviewEnrollments, type Db,
  type GitHubCandidateWorkspaceReceipt, type GitHubReviewRepositoryArtifact } from "@paperclipai/db";
import { runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

export const GITHUB_REVIEW_RUN_EVIDENCE = "github_review.runtime_evidence";
const commit = /^[a-f0-9]{40}$/;
const semver = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})((?:[-+][\w.-]+)?)$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === "string" && /^[\w.:-]{1,200}$/.test(value);
const names = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1024 && value.every(name);
/** MCP server names are user-facing labels ("Paperclip projects"): bounded
 * printable ASCII, inner spaces allowed, never a persisted redaction mask. */
const mcpServerName = (value: unknown): value is string => typeof value === "string"
  && /^[\x21-\x7e](?:[\x20-\x7e]{0,198}[\x21-\x7e])?$/.test(value) && !value.includes(REDACTED_EVENT_VALUE);
const sorted = (values: string[]) => [...new Set(values)].sort();

/** How the arm's CLI saw the repository. The primary reviews from its agent
 * home and clones/fetches GitHub itself; the candidate gets a sealed checkout. */
export type GitHubReviewWorkspaceKind = "checkout" | "agent_home_with_network_git" | "isolated_checkout";
const workspaceKinds = new Set<GitHubReviewWorkspaceKind>(["checkout", "agent_home_with_network_git", "isolated_checkout"]);

export type GitHubReviewCliFacts = { claudeCodeVersion: string; tools: string[]; mcpServers: string[]; permissionMode: string };

/** Normalised observation (also the legacy version-1 receipt shape). */
export interface GitHubReviewRunEvidence {
  version: 1;
  cli: GitHubReviewCliFacts | null;
  workspaceHead: string | null;
  workspaceTree?: string | null;
  workspaceKind?: GitHubReviewWorkspaceKind | null;
}

/** Storage encoding of the CLI facts. Run events pass through
 * boundHeartbeatRunEventPayloadForStorage and redactEventPayload before they
 * are persisted: the redactor masks every dotted `x.y.z` string as a JWT
 * ("2.1.284" became "***REDACTED***") and the bound keeps at most 50 items per
 * array (a 60-tool primary inventory gained a truncation marker). So the
 * version is stored as integers plus dot-free suffix segments, and inventories
 * as chunks below the array bound. Neither global guard is weakened. */
export interface GitHubReviewCliFactsRecord {
  claudeCodeVersionParts: [number, number, number];
  /** Pre-release/build suffix split at its dots: "-beta.1" -> ["-beta", "1"]. */
  claudeCodeVersionSuffix: string[];
  toolChunks: string[][];
  mcpServerChunks: string[][];
  permissionMode: string;
}

export interface GitHubReviewRunEvidenceRecord extends Omit<GitHubReviewRunEvidence, "version" | "cli"> {
  version: 2;
  cli: GitHubReviewCliFactsRecord | null;
}

const RECORD_CHUNK_ITEMS = 32;
const chunk = (values: string[]) => Array.from({ length: Math.ceil(values.length / RECORD_CHUNK_ITEMS) },
  (_, index) => values.slice(index * RECORD_CHUNK_ITEMS, (index + 1) * RECORD_CHUNK_ITEMS));
const unchunk = (value: unknown): unknown[] | null => Array.isArray(value) && value.length <= 48
  && value.every(part => Array.isArray(part) && part.length <= RECORD_CHUNK_ITEMS) ? (value as unknown[][]).flat() : null;

/** An allowlist, not a copy of the init event: no prompts, cwd, session IDs,
 * credentials, MCP URLs, or model output are persisted in this receipt. */
export function githubCliInitFacts(event: unknown): GitHubReviewRunEvidence["cli"] {
  if (!object(event) || event.type !== "system" || event.subtype !== "init"
    || typeof event.claude_code_version !== "string" || !semver.test(event.claude_code_version)
    || !names(event.tools) || !name(event.permissionMode) || !Array.isArray(event.mcp_servers)
    || event.mcp_servers.length > 128 || !event.mcp_servers.every(server => object(server) && mcpServerName(server.name))) return null;
  return { claudeCodeVersion: event.claude_code_version, tools: sorted(event.tools),
    mcpServers: sorted(event.mcp_servers.map(server => server.name as string)), permissionMode: event.permissionMode };
}

/** The receipt actually written as a run event (see GitHubReviewCliFactsRecord). */
export function githubRunEvidenceRecord(evidence: GitHubReviewRunEvidence): GitHubReviewRunEvidenceRecord {
  const { cli, ...workspace } = evidence;
  const parsed = cli ? semver.exec(cli.claudeCodeVersion) : null;
  return { ...workspace, version: 2, cli: cli && parsed ? {
    claudeCodeVersionParts: [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])],
    claudeCodeVersionSuffix: parsed[4] ? parsed[4].split(".") : [],
    toolChunks: chunk(cli.tools), mcpServerChunks: chunk(cli.mcpServers), permissionMode: cli.permissionMode,
  } : null };
}

/** Accepts the version-2 storage encoding and the version-1 shape. Version-1
 * receipts persisted before the encoding existed carry a masked CLI version and
 * stay unverified: a mask is never treated as a version. */
export function githubRunEvidence(value: unknown): GitHubReviewRunEvidence | null {
  if (!object(value) || (value.version !== 1 && value.version !== 2)) return null;
  const cli = value.cli;
  let facts: GitHubReviewRunEvidence["cli"] = null;
  if (object(cli) && value.version === 1) {
    facts = githubCliInitFacts({ type: "system", subtype: "init", claude_code_version: cli.claudeCodeVersion,
      tools: cli.tools, mcp_servers: Array.isArray(cli.mcpServers) ? cli.mcpServers.map(name => ({ name })) : null,
      permissionMode: cli.permissionMode });
  } else if (object(cli)) {
    const parts = cli.claudeCodeVersionParts, suffix = cli.claudeCodeVersionSuffix, servers = unchunk(cli.mcpServerChunks);
    const version = Array.isArray(parts) && parts.length === 3 && parts.every(part => Number.isSafeInteger(part) && (part as number) >= 0)
      && Array.isArray(suffix) && suffix.length <= 32 && suffix.every(segment => typeof segment === "string" && !segment.includes("."))
      ? `${parts.join(".")}${suffix.join(".")}` : null;
    facts = githubCliInitFacts({ type: "system", subtype: "init", claude_code_version: version, tools: unchunk(cli.toolChunks),
      mcp_servers: servers ? servers.map(name => ({ name })) : null, permissionMode: cli.permissionMode });
  }
  const hash = (entry: unknown) => typeof entry === "string" && commit.test(entry) ? entry : null;
  return { version: 1, cli: facts, workspaceHead: hash(value.workspaceHead), workspaceTree: hash(value.workspaceTree),
    workspaceKind: workspaceKinds.has(value.workspaceKind as GitHubReviewWorkspaceKind) ? value.workspaceKind as GitHubReviewWorkspaceKind : null };
}

/** Read the actual execution target, never the host mirror or an admitted SHA
 * relabelled as an observation. An empty candidate workspace stays unverified. */
export async function githubWorkspaceHead(input: { runId: string; target: AdapterExecutionTarget | null | undefined; cwd: string; env: Record<string, string> }) {
  try {
    const cwd = input.target?.kind === "remote" ? input.target.remoteCwd : input.cwd;
    if (!cwd) return null;
    const result = await runAdapterExecutionTargetShellCommand(input.runId, input.target,
      `git -C ${shellQuote(cwd)} rev-parse --verify HEAD`, { cwd: input.cwd, env: input.env, timeoutSec: 3 });
    const head = result.stdout.trim();
    return result.exitCode === 0 && !result.timedOut && commit.test(head) ? head : null;
  } catch { return null; }
}

/** HEAD and its tree from the actual execution target. A synthetic checkout is
 * proven by tree identity, so both are observed in one command. */
export async function githubWorkspaceState(input: { runId: string; target: AdapterExecutionTarget | null | undefined; cwd: string; env: Record<string, string> }) {
  try {
    const cwd = input.target?.kind === "remote" ? input.target.remoteCwd : input.cwd;
    if (!cwd) return { head: null, tree: null };
    const result = await runAdapterExecutionTargetShellCommand(input.runId, input.target,
      `git -C ${shellQuote(cwd)} rev-parse --verify HEAD && git -C ${shellQuote(cwd)} rev-parse --verify 'HEAD^{tree}'`,
      { cwd: input.cwd, env: input.env, timeoutSec: 3 });
    const [head, tree] = result.stdout.trim().split("\n").map(line => line.trim());
    return result.exitCode === 0 && !result.timedOut && commit.test(head ?? "") && commit.test(tree ?? "")
      ? { head: head!, tree: tree! } : { head: null, tree: null };
  } catch { return { head: null, tree: null }; }
}

/** Stream-json may split anywhere. Oversize/non-JSON lines are never evidence.
 * Every init is retained: a reconnect with a changed inventory cannot replace the
 * first receipt, and a malformed init cannot be repaired by a later good one. */
export function createGitHubRunEvidenceCollector(input: {
  expectedCwd: string;
  workspaceHead: () => Promise<string | null | { head: string | null; tree: string | null }>;
  /** Receives the storage encoding, never the dotted/unbounded observation. */
  record: (evidence: GitHubReviewRunEvidenceRecord) => Promise<void>;
  /** Candidate runs in its sealed checkout; a primary without a checkout HEAD
   * is recorded as reviewing from its agent home with network git. */
  role?: "primary" | "candidate";
}) {
  const observe = async (cwd: unknown): Promise<Pick<GitHubReviewRunEvidence, "workspaceHead" | "workspaceTree" | "workspaceKind">> => {
    const state = cwd === input.expectedCwd ? await input.workspaceHead() : null;
    const head = typeof state === "string" || state === null ? state : state.head;
    const tree = state && typeof state === "object" ? { workspaceTree: state.tree } : {};
    if (!input.role) return { workspaceHead: head, ...tree };
    const workspaceKind: GitHubReviewWorkspaceKind | null = cwd !== input.expectedCwd ? null
      : input.role === "candidate" ? "isolated_checkout" : head ? "checkout" : "agent_home_with_network_git";
    return { workspaceHead: head, ...tree, workspaceKind };
  };
  let pending = "";
  let dropping = false;
  let queue = Promise.resolve();
  const consume = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream !== "stdout") return;
    for (const [index, part] of chunk.split("\n").entries()) {
      if (index > 0) {
        if (!dropping) {
          let event: unknown;
          try { event = JSON.parse(pending); } catch { /* Non-JSON CLI diagnostics. */ }
          if (object(event) && event.type === "system" && event.subtype === "init") {
            await input.record(githubRunEvidenceRecord({ version: 1, cli: githubCliInitFacts(event), ...await observe(event.cwd) }));
          }
        }
        pending = ""; dropping = false;
      }
      if (!dropping && pending.length + part.length <= 256 * 1024) pending += part;
      else { pending = ""; dropping = true; }
    }
  };
  return (stream: "stdout" | "stderr", chunk: string) => {
    const next = queue.then(() => consume(stream, chunk));
    queue = next.catch(() => undefined);
    return next;
  };
}

type Store = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface GitHubPairRunEvidence {
  primaryRuns: unknown[][];
  candidateRun: unknown[];
}

/** Bind primary observations to ALL primary runs for this exact admission/head,
 * including retries. Bind candidate observations to the requested run+agent.
 * Missing events stay empty; no previous run or latest successful arm fallback. */
export async function githubPairRunEvidence(db: Store, enrollment: typeof chatGitHubReviewEnrollments.$inferSelect,
  candidate: { agentId: string }, runId: string): Promise<GitHubPairRunEvidence> {
  const reviews = await db.select({ runId: chatGitHubReviews.runId }).from(chatGitHubReviews).where(and(
    eq(chatGitHubReviews.companyId, enrollment.companyId), eq(chatGitHubReviews.endpointId, enrollment.endpointId),
    eq(chatGitHubReviews.headSha, enrollment.headSha ?? ""), isNull(chatGitHubReviews.shadowLabel), isNotNull(chatGitHubReviews.runId),
    or(eq(chatGitHubReviews.deliveryId, enrollment.originDeliveryId), eq(chatGitHubReviews.admissionDeliveryId, enrollment.originDeliveryId)),
  ));
  const primaryIds = [...new Set(reviews.flatMap(review => review.runId ? [review.runId] : []))];
  const events = await db.select({ runId: heartbeatRunEvents.runId, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, heartbeatRunEvents.runId),
      eq(heartbeatRuns.companyId, heartbeatRunEvents.companyId), eq(heartbeatRuns.agentId, heartbeatRunEvents.agentId)))
    .where(and(eq(heartbeatRunEvents.companyId, enrollment.companyId), eq(heartbeatRunEvents.eventType, GITHUB_REVIEW_RUN_EVIDENCE),
      or(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.agentId, candidate.agentId)),
        primaryIds.length ? inArray(heartbeatRuns.id, primaryIds) : undefined)));
  return { primaryRuns: primaryIds.map(id => events.filter(event => event.runId === id).map(event => event.payload)),
    candidateRun: events.filter(event => event.runId === runId).map(event => event.payload) };
}

export interface GitHubPairWorkspaceBinding {
  admittedHead: string | null;
  admittedBase?: string | null;
  repository?: GitHubReviewRepositoryArtifact;
  candidateWorkspace?: GitHubCandidateWorkspaceReceipt;
}

/** Workspace equivalence is capability equivalence: both arms hold a full local
 * checkout of the admitted head. The primary proves it by a checkout HEAD or by
 * reviewing from its agent home with network git; the candidate by a verified
 * materialisation receipt (bundle HEAD = admitted head, or synthetic HEAD tree =
 * admitted head tree, with the base present) that its CLI init then observed. */
function candidateWorkspaceReason(evidence: GitHubPairWorkspaceBinding, runs: (GitHubReviewRunEvidence | null)[]): string | null {
  const { repository: artifact, candidateWorkspace: receipt, admittedHead } = evidence;
  if (!artifact) return "repository_artifact_unavailable";
  if (!receipt) return "candidate_workspace_not_recorded";
  if (receipt.status !== "materialized") return receipt.reason ?? "candidate_workspace_unavailable";
  if (artifact.headSha !== admittedHead || (evidence.admittedBase != null && artifact.baseSha !== evidence.admittedBase))
    return "repository_artifact_binding_mismatch";
  if (receipt.artifactSha256 !== artifact.sha256 || receipt.kind !== artifact.kind) return "candidate_workspace_artifact_mismatch";
  const bound = artifact.kind === "bundle"
    ? receipt.head === admittedHead && receipt.baseCommit === artifact.baseSha
    : receipt.head === artifact.commits.head && receipt.baseCommit === artifact.commits.base;
  if (!bound || receipt.tree !== artifact.headTree || receipt.baseTree !== artifact.baseTree) return "candidate_workspace_head_mismatch";
  if (!runs.every(run => !!run && run.workspaceHead === receipt.head && run.workspaceTree === receipt.tree))
    return "candidate_cli_workspace_unobserved";
  return null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Capabilities the paired candidate is deliberately denied, keyed like
 * GITHUB_SHADOW_PROTOCOL.deviations (which records each reason and bias).
 * Every denial removes a capability from the candidate only, so each one
 * favours the primary: the conservative direction for "can the candidate
 * replace the primary gate". Matching is by exact name, exact prefix, or an
 * anchored pattern; nothing else may differ between the arms. */
export const GITHUB_SHADOW_CANDIDATE_DENIALS = {
  webTools: { tools: ["WebSearch", "WebFetch"] },
  /** Claude Code names MCP tools `mcp__<server, non-word chars as _>__<tool>`. */
  paperclipBoardMcp: {
    mcpServers: ["Paperclip projects", "Paperclip connections"],
    toolPrefixes: ["mcp__Paperclip_projects__", "mcp__Paperclip_connections__"],
  },
  /** GITHUB_BOT_TOOLS minus GITHUB_CANDIDATE_REVIEW_TOOL_NAMES on the
   * `paperclip-assigned` gateway, where `github-bot.<endpointId>:<tool>` is
   * exposed as `github-bot_<endpointId>_<tool>`. */
  githubPublication: {
    toolPattern: `^mcp__paperclip-assigned__github-bot_${UUID}_(?:comment|formal_review|update_comment)$`,
  },
  webCapableMcpApps: { toolPrefixes: ["mcp__paperclip-assigned__mcp_"] },
  sharedMemory: { toolPrefixes: ["mcp__paperclip-assigned__paperclip-plugin-hindsight_"] },
} as const;

const deniedTools = new Set<string>(GITHUB_SHADOW_CANDIDATE_DENIALS.webTools.tools);
const deniedToolPrefixes: readonly string[] = [...GITHUB_SHADOW_CANDIDATE_DENIALS.paperclipBoardMcp.toolPrefixes,
  ...GITHUB_SHADOW_CANDIDATE_DENIALS.webCapableMcpApps.toolPrefixes, ...GITHUB_SHADOW_CANDIDATE_DENIALS.sharedMemory.toolPrefixes];
const deniedToolPattern = new RegExp(GITHUB_SHADOW_CANDIDATE_DENIALS.githubPublication.toolPattern);
const deniedMcpServers = new Set<string>(GITHUB_SHADOW_CANDIDATE_DENIALS.paperclipBoardMcp.mcpServers);

export function githubShadowCandidateDeniedTool(tool: string) {
  return deniedTools.has(tool) || deniedToolPrefixes.some(prefix => tool.startsWith(prefix)) || deniedToolPattern.test(tool);
}

export function githubShadowCandidateDeniedMcpServer(server: string) {
  return deniedMcpServers.has(server);
}

export function githubPairEquivalence(evidence?: GitHubPairRunEvidence & GitHubPairWorkspaceBinding) {
  const primary = evidence?.primaryRuns.flat() ?? [];
  const candidate = evidence?.candidateRun ?? [];
  const complete = !!evidence && evidence.primaryRuns.length > 0 && evidence.primaryRuns.every(run => run.length > 0) && candidate.length > 0;
  const p = primary.map(githubRunEvidence), c = candidate.map(githubRunEvidence);
  const reference = p[0]?.cli;
  const equal = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  // The candidate must hold exactly the primary inventory minus the denials:
  // no other missing tool/server and no candidate-only tool/server.
  const tools = complete && !!reference && [...p, ...c].every(run => run?.cli
    && run.cli.claudeCodeVersion === reference.claudeCodeVersion && run.cli.permissionMode === reference.permissionMode)
    && p.every(run => equal(run!.cli!.tools, reference.tools) && equal(run!.cli!.mcpServers, reference.mcpServers))
    && c.every(run => equal(run!.cli!.tools, reference.tools.filter(tool => !githubShadowCandidateDeniedTool(tool)))
      && equal(run!.cli!.mcpServers, reference.mcpServers.filter(server => !githubShadowCandidateDeniedMcpServer(server))));
  const admitted = typeof evidence?.admittedHead === "string" && commit.test(evidence.admittedHead);
  const primaryOk = p.every(run => run?.workspaceHead === evidence?.admittedHead
    || (run?.workspaceHead === null && run.workspaceKind === "agent_home_with_network_git"));
  const workspaceReason = !complete ? "run_evidence_incomplete" : !admitted ? "admitted_head_invalid"
    : !primaryOk ? "primary_workspace_unverified" : candidateWorkspaceReason(evidence!, c);
  return { tools, workspace: workspaceReason === null, workspaceReason };
}
