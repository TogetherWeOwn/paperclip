import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { chatGitHubReviewCandidates, heartbeatRuns, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { hasGitHubPrimaryBlinding } from "./chat-github-primary-blinding-state.js";
import { githubRunCapability } from "./chat-github-shadow.js";

/** Identify isolation from the persisted RUN, never a caller-selected issue or
 * mutable agent configuration. A malformed capability must not downgrade to a
 * normal unrestricted session. This is independent of the enrollment kill flag:
 * disabling future enrollment must not unblind existing candidates. */
export async function githubCandidateRunBoundary(db: Db, session: {
  companyId: string; agentId: string | null; runId: string | null; issueId?: string | null;
}) {
  if (!session.agentId || !session.runId) return null;
  const [run] = await db.select({
    nativeIssueId: heartbeatRuns.nativeIssueId,
    issueId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'issueId'`,
    taskId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'taskId'`,
    wakeCommentId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'wakeCommentId'`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, session.runId), eq(heartbeatRuns.companyId, session.companyId),
    eq(heartbeatRuns.agentId, session.agentId),
  ));
  if (!run) return null;
  const issueId = run.nativeIssueId ?? run.issueId ?? run.taskId;
  const commentId = run.wakeCommentId;
  // Check every persisted alias for denial, as the outbound fence does. A
  // conflicting native task must not hide a candidate contextSnapshot.taskId.
  const issueIds = [...new Set([run.nativeIssueId, run.issueId, run.taskId]
    .filter((id): id is string => typeof id === "string"))];
  // An empty OR is elided by Drizzle, so reject it before querying.
  if (!issueIds.length && typeof commentId !== "string") return null;
  const [candidate] = await db.select().from(chatGitHubReviewCandidates).where(and(
    eq(chatGitHubReviewCandidates.companyId, session.companyId),
    or(
      issueIds.length ? inArray(chatGitHubReviewCandidates.issueId, issueIds) : undefined,
      typeof commentId === "string" ? eq(chatGitHubReviewCandidates.commentId, commentId) : undefined,
    ),
  ));
  if (!candidate) return null;
  if (typeof issueId !== "string" || session.issueId && session.issueId !== issueId)
    throw forbidden("Paired review context cannot be retargeted");
  const capability = await githubRunCapability(db, { ...session, issueId });
  if (!capability?.candidate || capability.candidate.id !== candidate.id)
    throw forbidden("Paired review native capability is invalid");
  const namespace = createHash("sha256").update(JSON.stringify([
    "github-review-v1", session.companyId, candidate.enrollmentId,
    candidate.armId, capability.enrollment!.headSha, session.runId,
  ])).digest("hex");
  return { issueId, namespace, candidate, enrollment: capability.enrollment! };
}

/** Direct API surfaces can reveal issue history, run logs, credentials and
 * memory. Only minting an exactly run-bound gateway session is allowed here;
 * that gateway independently limits both discovery AND dispatch to native tools.
 * This is defense in depth, not a filesystem/network sandbox certificate. */
export async function assertGitHubCandidateApiBoundary(db: Db, session: {
  companyId: string; agentId: string; runId: string | null; credential?: "agent_jwt" | "agent_key";
}, request: { method: string; originalUrl: string }) {
  // Runs on every agent request: companies that never admitted a candidate take a
  // zero-query path. This is the same fail-closed in-memory set as the API
  // blinding (admission barrier + startup bootstrap); while bootstrap is
  // uncertain or an admission is pending, every company keeps querying.
  if (!hasGitHubPrimaryBlinding(db, session.companyId)) return;
  // Durable candidate admission is only a DENY signal, never a capability grant.
  // Configuration alone changes no authority. Once admitted, retirement or the
  // kill switch must not restore a clone's broader long-lived credentials.
  const [admission] = await db.select({ id: chatGitHubReviewCandidates.id }).from(chatGitHubReviewCandidates).where(and(
    eq(chatGitHubReviewCandidates.companyId, session.companyId), eq(chatGitHubReviewCandidates.agentId, session.agentId),
  )).limit(1);
  if (admission && session.credential === "agent_key")
    throw forbidden("Paired candidates require signed run-bound credentials", { code: "github_candidate_api_denied" });
  const boundary = await githubCandidateRunBoundary(db, session);
  if (!boundary) {
    if (admission) {
      // Admission confines candidate RUNS, not every future task of the agent.
      // Only a signed, persisted run proves a separate non-candidate execution;
      // long-lived keys and fabricated run IDs remain fail-closed.
      const [ordinaryRun] = session.credential === "agent_jwt" && session.runId
        ? await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, session.runId), eq(heartbeatRuns.companyId, session.companyId),
            eq(heartbeatRuns.agentId, session.agentId),
          )) : [];
      if (!ordinaryRun) throw forbidden("Paired candidate credentials have no verified native run capability", { code: "github_candidate_api_denied" });
    }
    return;
  }
  // An API key's run header is caller-controlled and proves no run authority.
  if (session.credential !== "agent_key" && request.method === "POST"
    && request.originalUrl.split("?")[0] === "/api/tool-gateway/sessions") return;
  throw forbidden("Paired candidates may access only their snapshot-backed review gateway", { code: "github_candidate_api_denied" });
}
