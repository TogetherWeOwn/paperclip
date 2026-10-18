import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, chatGitHubReviews, type chatGitHubReviewEnrollments, type Db,
  type GitHubCandidateWorkspaceReceipt, type GitHubReviewRepositoryArtifact } from "@paperclipai/db";
import { runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

export const GITHUB_REVIEW_RUN_EVIDENCE = "github_review.runtime_evidence";
const commit = /^[a-f0-9]{40}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === "string" && /^[\w.:-]{1,200}$/.test(value);
const names = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1024 && value.every(name);
const sorted = (values: string[]) => [...new Set(values)].sort();

/** How the arm's CLI saw the repository. The primary reviews from its agent
 * home and clones/fetches GitHub itself; the candidate gets a sealed checkout. */
export type GitHubReviewWorkspaceKind = "checkout" | "agent_home_with_network_git" | "isolated_checkout";
const workspaceKinds = new Set<GitHubReviewWorkspaceKind>(["checkout", "agent_home_with_network_git", "isolated_checkout"]);

export interface GitHubReviewRunEvidence {
  version: 1;
  cli: { claudeCodeVersion: string; tools: string[]; mcpServers: string[]; permissionMode: string } | null;
  workspaceHead: string | null;
  workspaceTree?: string | null;
  workspaceKind?: GitHubReviewWorkspaceKind | null;
}

/** An allowlist, not a copy of the init event: no prompts, cwd, session IDs,
 * credentials, MCP URLs, or model output are persisted in this receipt. */
export function githubCliInitFacts(event: unknown): GitHubReviewRunEvidence["cli"] {
  if (!object(event) || event.type !== "system" || event.subtype !== "init"
    || typeof event.claude_code_version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(event.claude_code_version)
    || !names(event.tools) || !name(event.permissionMode) || !Array.isArray(event.mcp_servers)
    || event.mcp_servers.length > 128 || !event.mcp_servers.every(server => object(server) && name(server.name))) return null;
  return { claudeCodeVersion: event.claude_code_version, tools: sorted(event.tools),
    mcpServers: sorted(event.mcp_servers.map(server => server.name as string)), permissionMode: event.permissionMode };
}

export function githubRunEvidence(value: unknown): GitHubReviewRunEvidence | null {
  if (!object(value) || value.version !== 1) return null;
  const cli = value.cli;
  const facts = object(cli) ? githubCliInitFacts({ type: "system", subtype: "init", claude_code_version: cli.claudeCodeVersion,
    tools: cli.tools, mcp_servers: Array.isArray(cli.mcpServers) ? cli.mcpServers.map(name => ({ name })) : null,
    permissionMode: cli.permissionMode }) : null;
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
  record: (evidence: GitHubReviewRunEvidence) => Promise<void>;
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
            await input.record({ version: 1, cli: githubCliInitFacts(event), ...await observe(event.cwd) });
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

export function githubPairEquivalence(evidence?: GitHubPairRunEvidence & GitHubPairWorkspaceBinding) {
  const primary = evidence?.primaryRuns.flat() ?? [];
  const candidate = evidence?.candidateRun ?? [];
  const complete = !!evidence && evidence.primaryRuns.length > 0 && evidence.primaryRuns.every(run => run.length > 0) && candidate.length > 0;
  const p = primary.map(githubRunEvidence), c = candidate.map(githubRunEvidence);
  const reference = p[0]?.cli;
  const removals = new Set(["WebSearch", "WebFetch"]);
  const equal = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  const tools = complete && !!reference && [...p, ...c].every(run => run?.cli
    && run.cli.claudeCodeVersion === reference.claudeCodeVersion && run.cli.permissionMode === reference.permissionMode
    && equal(run.cli.mcpServers, reference.mcpServers))
    && p.every(run => equal(run!.cli!.tools, reference.tools))
    && c.every(run => equal(run!.cli!.tools, reference.tools.filter(tool => !removals.has(tool))));
  const admitted = typeof evidence?.admittedHead === "string" && commit.test(evidence.admittedHead);
  const primaryOk = p.every(run => run?.workspaceHead === evidence?.admittedHead
    || (run?.workspaceHead === null && run.workspaceKind === "agent_home_with_network_git"));
  const workspaceReason = !complete ? "run_evidence_incomplete" : !admitted ? "admitted_head_invalid"
    : !primaryOk ? "primary_workspace_unverified" : candidateWorkspaceReason(evidence!, c);
  return { tools, workspace: workspaceReason === null, workspaceReason };
}
