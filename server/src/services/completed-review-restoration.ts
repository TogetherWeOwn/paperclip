import { and, asc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import {
  type Db,
  activityLog,
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { hasInteractionContinuationWakeContext } from "../modules/wake-queue/domain/context.js";
import { logActivity, publishActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";
import { planCompletedReviewRestoration } from "./completed-review-reconciliation-evidence.js";
import { readCompletedReviewEvidenceContext } from "./completed-review-receipt.js";
import { queuedCommentIdsFromRunContext, queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { executeIssuePostCommitActions, issueService, type IssuePostCommitAction } from "./issues.js";

export type CompletedReviewRestorationInput = {
  companyId: string;
  issueId: string;
  completionActivityId: string;
  wakeupRequestId: string;
  actor: Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId">;
};

type IssueRow = typeof issues.$inferSelect;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function refusesIndependentContinuation(value: unknown) {
  const context = record(value);
  return context.resumeIntent === true || context.followUpRequested === true ||
    context.mutation === "interaction" || hasInteractionContinuationWakeContext(context);
}

function assertIssueContext(context: unknown, issueId: string) {
  const row = record(context);
  const ids = [row.issueId, row.taskId, row.taskKey].filter((id) => id != null);
  return ids.length > 0 && ids.every((id) => id === issueId);
}

function refuse(reason: string): never {
  throw conflict("Completed review restoration refused", { reason });
}

/** Locators select persisted evidence, not client state or replacement approvals. */
export function completedReviewRestorationService(db: Db) {
  return {
    async restore(input: CompletedReviewRestorationInput, authorize: (tx: Db, issue: IssueRow) => Promise<void>) {
      const publications: ActivityPublication[] = [];
      const postCommitActions: IssuePostCommitAction[] = [];
      const result = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        // Row locking serializes projection/idempotency. Predicate reads below
        // participate in the serializable fence, including new evidence rows.
        await tx.execute(sql`select set_config('lock_timeout', '3s', true)`);
        await tx.execute(sql`select set_config('statement_timeout', '15s', true)`);
        const [issue] = await tx.select().from(issues)
          .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
          .for("update");
        if (!issue) throw notFound("Issue not found");
        await authorize(tx, issue);
        if (issue.hiddenAt || issue.conversationAgentId || issue.monitorNextCheckAt) refuse("unsupported_issue_state");
        if (await getExecutionBlocker(tx, input.companyId, input.issueId) ||
            await issueTreeControlService(tx).getActivePauseHoldGate(input.companyId, input.issueId)) refuse("execution_hold");

        const rows = await tx.select().from(activityLog).where(and(
          eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, input.issueId),
        )).orderBy(asc(activityLog.createdAt), asc(activityLog.id));
        const completionRow = rows.find((row) => row.id === input.completionActivityId);
        if (!completionRow) refuse("missing_completion_evidence");
        const activity = (row: typeof activityLog.$inferSelect) => ({ ...row, issueId: row.entityId });
        const completion = activity(completionRow);
        // The approval's own required comment is inserted in the receipt's
        // transaction; its audit publication is recorded after commit. Bind
        // that one event by persisted id/actor/run, never by text or timing.
        const completionCommentId = completion.details?.completionCommentId;
        if (typeof completionCommentId !== "string") refuse("missing_completion_comment");
        const commentActivities = rows.filter((row) => row.action === "issue.comment_added" &&
          row.details?.commentId === completionCommentId);
        if (commentActivities.length !== 1 || commentActivities.some((row) =>
          row.actorType !== completion.actorType || row.actorId !== completion.actorId || row.runId !== completion.runId ||
          row.details?.resumeIntent === true || row.details?.followUpRequested === true || row.details?.reopened === true
        )) refuse("completion_comment_mismatch");
        const laterRows = rows.filter((row) => row.id !== completion.id && row.id !== commentActivities[0].id &&
          row.createdAt >= completion.createdAt);
        const restorations = laterRows.filter((row) => row.action === "issue.completed_review_restored");
        if (restorations.length > 1 || restorations.some((row) =>
          row.details?.completionActivityId !== completion.id || row.details?.wakeupRequestId !== input.wakeupRequestId
        )) refuse("conflicting_restoration");
        const restoration = restorations[0];
        let callerRun: typeof heartbeatRuns.$inferSelect | undefined;
        if (input.actor.actorType === "agent") {
          if (!input.actor.runId) throw unauthorized("Agent run attribution required");
          [callerRun] = await tx.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.actor.runId),
            eq(heartbeatRuns.agentId, input.actor.actorId),
          )).for("update");
          if (!callerRun || input.actor.agentId !== input.actor.actorId || callerRun.status !== "running" ||
              !assertIssueContext(callerRun.contextSnapshot, input.issueId)) throw forbidden("Restoration requires this issue's active agent run");
          if (refusesIndependentContinuation(callerRun.contextSnapshot)) refuse("independent_continuation");
          const replayByOriginalActor = restoration?.actorType === "agent" &&
            restoration.actorId === input.actor.actorId && restoration.runId === input.actor.runId;
          if (!replayByOriginalActor && issue.assigneeAgentId !== input.actor.actorId) throw forbidden("Restoration requires the current assignee");
          if ([issue.checkoutRunId, issue.executionRunId].some((id) => id && id !== callerRun!.id)) {
            refuse("conflicting_issue_run");
          }
        } else if (input.actor.actorType !== "user") {
          throw forbidden("Restoration requires an authenticated issue actor");
        }
        if (restoration && laterRows.some((row) => row.id !== restoration.id && row.createdAt >= restoration.createdAt)) {
          refuse("newer_work_or_governance");
        }

        const [wake] = await tx.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.wakeupRequestId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        )).for("update");
        if (!wake || wake.reason !== "issue_execution_promoted" || !wake.runId) refuse("missing_promoted_wake");
        const [promotedRun] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, wake.runId),
          eq(heartbeatRuns.wakeupRequestId, wake.id), eq(heartbeatRuns.agentId, wake.agentId),
        )).for("update");
        if (!promotedRun || !assertIssueContext(promotedRun.contextSnapshot, input.issueId)) refuse("wake_lineage_mismatch");
        const payload = record(wake.payload);
        const context = record(payload._paperclipWakeContext);
        const runContext = record(promotedRun.contextSnapshot);
        const reason = context.wakeReason ?? runContext.wakeReason;
        if (!["issue_commented", "issue_reopened_via_comment", "issue_comment_mentioned"].includes(String(reason)) ||
            [payload, context, runContext].some(refusesIndependentContinuation)) refuse("independent_continuation");
        const commentIds = queuedCommentIdsFromWakePayload(payload);
        const runCommentIds = queuedCommentIdsFromRunContext(runContext);
        if (!commentIds.length || commentIds.length !== runCommentIds.length ||
            commentIds.some((id) => !runCommentIds.includes(id)) || wake.requestedAt > completion.createdAt) {
          refuse("wake_lineage_mismatch");
        }
        const comments = await tx.select().from(issueComments).where(and(
          eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
        )).orderBy(asc(issueComments.id));
        const evidenceComments = comments.filter((row) => commentIds.includes(row.id));
        if (evidenceComments.some((row) => row.deletedAt || row.updatedAt >= completion.createdAt)) refuse("comment_changed");
        const completionComment = comments.find((row) => row.id === completionCommentId);
        if (!completionComment || completionComment.deletedAt || completionComment.updatedAt.getTime() !== completionComment.createdAt.getTime() ||
            completionComment.createdByRunId !== completion.runId ||
            (completion.actorType === "agent"
              ? completionComment.authorAgentId !== completion.actorId || completionComment.authorUserId !== null
              : completionComment.authorUserId !== completion.actorId || completionComment.authorAgentId !== null)) {
          refuse("completion_comment_mismatch");
        }
        const newerComments = comments.some((row) => row.id !== completionCommentId &&
          (row.createdAt >= completion.createdAt || row.updatedAt >= completion.createdAt));

        const interactions = await tx.select().from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
          or(eq(issueThreadInteractions.status, "pending"), gte(issueThreadInteractions.updatedAt, completion.createdAt)),
        ));
        const recovery = await tx.select().from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
          or(inArray(issueRecoveryActions.status, ["active", "escalated"]), gte(issueRecoveryActions.updatedAt, completion.createdAt)),
        ));
        const linkedApprovals = await tx.select().from(issueApprovals).innerJoin(approvals, and(
          eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, input.companyId),
        )).where(and(eq(issueApprovals.companyId, input.companyId), eq(issueApprovals.issueId, input.issueId)));
        const blockers = await tx.select().from(issueRelations).innerJoin(issues, and(
          eq(issues.id, issueRelations.issueId), eq(issues.companyId, input.companyId),
        )).where(and(
          eq(issueRelations.companyId, input.companyId), eq(issueRelations.relatedIssueId, input.issueId),
          eq(issueRelations.type, "blocks"),
          or(ne(issues.status, "done"), gte(issueRelations.updatedAt, completion.createdAt)),
        ));
        const activeRuns = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.status, ["queued", "running"]),
          or(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${input.issueId}`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskKey' = ${input.issueId}`,
            eq(heartbeatRuns.nativeIssueId, input.issueId)),
          ...(input.actor.runId ? [ne(heartbeatRuns.id, input.actor.runId)] : []),
        ));
        const newerWakes = await tx.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, input.companyId), ne(agentWakeupRequests.id, wake.id),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
          gte(agentWakeupRequests.requestedAt, completion.createdAt),
        ));
        const contextEvidence = await readCompletedReviewEvidenceContext(tx, issue);
        const laterActivities = laterRows.filter((row) => row.id !== restoration?.id).map(activity);
        // The release run must be the one whose original final approval is in
        // this receipt, not an unrelated heartbeat reopening the same issue.
        if (laterActivities[0]?.runId !== completion.runId) refuse("wake_lineage_mismatch");
        const plan = planCompletedReviewRestoration({
          companyId: input.companyId, issueId: input.issueId, status: issue.status, executionState: issue.executionState,
          ...contextEvidence, completion, laterActivities,
          staleWake: { companyId: input.companyId, issueId: input.issueId, commentIds, promotedRunId: promotedRun.id },
          comments: evidenceComments,
          hasNewerWorkOrGovernance: newerComments || interactions.length > 0 || recovery.length > 0 ||
            blockers.length > 0 || activeRuns.length > 0 || newerWakes.length > 0 || linkedApprovals.some(({ approvals: row, issue_approvals: link }) =>
              row.status !== "approved" || row.updatedAt >= completion.createdAt || link.createdAt >= completion.createdAt),
          restoredCompletionActivityId: restoration ? String(restoration.details?.completionActivityId) : null,
        });
        if (plan.outcome === "refused") refuse(plan.reason);
        if (!plan.returnAssignee) refuse("missing_return_assignee");
        if (plan.outcome === "already_restored") {
          if (issue.assigneeAgentId !== (plan.returnAssignee.type === "agent" ? plan.returnAssignee.agentId : null) ||
              issue.assigneeUserId !== (plan.returnAssignee.type === "user" ? plan.returnAssignee.userId : null)) refuse("restoration_drifted");
          return { outcome: plan.outcome, issue, completionActivityId: plan.completionActivityId };
        }
        const updated = await issueService(tx).updateForCompany(issue.id, input.companyId, {
          status: "done", executionState: { ...plan.executionState },
          assigneeAgentId: plan.returnAssignee.type === "agent" ? plan.returnAssignee.agentId : null,
          assigneeUserId: plan.returnAssignee.type === "user" ? plan.returnAssignee.userId : null,
        }, tx, publications, postCommitActions);
        if (!updated) throw notFound("Issue not found");
        await logActivity(tx, {
          ...input.actor, companyId: input.companyId, action: "issue.completed_review_restored",
          entityType: "issue", entityId: issue.id,
          details: {
            completionActivityId: plan.completionActivityId, decisionIds: plan.decisionIds,
            wakeupRequestId: wake.id, promotedRunId: promotedRun.id, commentIds,
            previousStatus: issue.status, status: "done", source: "completed_review_restoration",
          },
        }, publications);
        return { outcome: plan.outcome, issue: updated, completionActivityId: plan.completionActivityId };
      }, { isolationLevel: "serializable" }).catch((error: unknown) => {
        let cause: unknown = error;
        for (let depth = 0; depth < 4; depth++) {
          const row = record(cause);
          if (["40001", "40P01", "55P03", "57014"].includes(String(row.code))) refuse("concurrent_change_or_timeout");
          cause = row.cause;
        }
        throw error;
      });
      for (const publication of publications) publishActivity(publication);
      await executeIssuePostCommitActions(db, postCommitActions);
      return result;
    },
  };
}
