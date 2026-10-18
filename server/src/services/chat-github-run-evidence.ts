import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, chatGitHubReviews, type chatGitHubReviewEnrollments, type Db } from "@paperclipai/db";
import { runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

export const GITHUB_REVIEW_RUN_EVIDENCE = "github_review.runtime_evidence";
const commit = /^[a-f0-9]{40}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === "string" && /^[\w.:-]{1,200}$/.test(value);
const names = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1024 && value.every(name);
const sorted = (values: string[]) => [...new Set(values)].sort();

export interface GitHubReviewRunEvidence {
  version: 1;
  cli: { claudeCodeVersion: string; tools: string[]; mcpServers: string[]; permissionMode: string } | null;
  workspaceHead: string | null;
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
  return { version: 1, cli: facts, workspaceHead: typeof value.workspaceHead === "string" && commit.test(value.workspaceHead) ? value.workspaceHead : null };
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

/** Stream-json may split anywhere. Oversize/non-JSON lines are never evidence.
 * Every init is retained: a reconnect with a changed inventory cannot replace the
 * first receipt, and a malformed init cannot be repaired by a later good one. */
export function createGitHubRunEvidenceCollector(input: {
  expectedCwd: string;
  workspaceHead: () => Promise<string | null>;
  record: (evidence: GitHubReviewRunEvidence) => Promise<void>;
}) {
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
            await input.record({ version: 1, cli: githubCliInitFacts(event),
              workspaceHead: event.cwd === input.expectedCwd ? await input.workspaceHead() : null });
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

export function githubPairEquivalence(evidence?: GitHubPairRunEvidence & { admittedHead: string | null }) {
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
  const workspace = complete && typeof evidence?.admittedHead === "string" && commit.test(evidence.admittedHead)
    && [...p, ...c].every(run => run?.workspaceHead === evidence.admittedHead);
  return { tools, workspace };
}
