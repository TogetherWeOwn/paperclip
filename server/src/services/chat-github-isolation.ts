import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { chatGitHubReviewCandidates, heartbeatRuns, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { githubRunCapability } from "./chat-github-shadow.js";

/** Identify isolation from the persisted RUN, never a caller-selected issue or
 * mutable agent configuration. A malformed capability must not downgrade to a
 * normal unrestricted session. This is independent of the enrollment kill flag:
 * disabling future enrollment must not unblind existing candidates. */
export async function githubCandidateRunBoundary(db: Db, session: {
  companyId: string; agentId: string | null; runId: string | null; issueId?: string | null;
}) {
  if (!session.agentId || !session.runId) return null;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, session.runId), eq(heartbeatRuns.companyId, session.companyId),
    eq(heartbeatRuns.agentId, session.agentId),
  ));
  if (!run) return null;
  const issueId = run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
  const commentId = run.contextSnapshot?.wakeCommentId;
  // An empty OR is elided by Drizzle, so reject it before querying.
  if (typeof issueId !== "string" && typeof commentId !== "string") return null;
  const [candidate] = await db.select().from(chatGitHubReviewCandidates).where(and(
    eq(chatGitHubReviewCandidates.companyId, session.companyId),
    or(
      typeof issueId === "string" ? eq(chatGitHubReviewCandidates.issueId, issueId) : undefined,
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
  companyId: string; agentId: string; runId: string;
}, request: { method: string; originalUrl: string }) {
  if (!(await githubCandidateRunBoundary(db, session))) return;
  if (request.method === "POST" && request.originalUrl.split("?")[0] === "/api/tool-gateway/sessions") return;
  throw forbidden("Paired candidates may access only their snapshot-backed review gateway", { code: "github_candidate_api_denied" });
}
