import { and, asc, eq } from "drizzle-orm";
import {
  type Db,
  documents,
  issueDocuments,
  issueExecutionDecisions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { sealCompletedReviewEvidence } from "./completed-review-reconciliation-evidence.js";

export type CompletedReviewReceiptIssue = Pick<typeof issues.$inferSelect,
  "id" | "companyId" | "status" | "executionState" | "executionPolicy" | "reviewPolicy" |
  "responsibleUserId" | "createdByAgentId" | "createdByUserId" | "title" | "description" |
  "projectId" | "goalId" | "parentId" | "workMode" | "executionWorkspaceId"
>;

/** Read persisted evidence inside the transaction holding the issue's row lock. */
export async function readCompletedReviewEvidenceContext(tx: Db, issue: CompletedReviewReceiptIssue) {
  const decisions = await tx.select().from(issueExecutionDecisions)
    .where(and(eq(issueExecutionDecisions.companyId, issue.companyId), eq(issueExecutionDecisions.issueId, issue.id)))
    .orderBy(asc(issueExecutionDecisions.id));
  const workProducts = await tx.select().from(issueWorkProducts)
    .where(and(eq(issueWorkProducts.companyId, issue.companyId), eq(issueWorkProducts.issueId, issue.id)))
    .orderBy(asc(issueWorkProducts.id));
  const documentRows = await tx.select().from(issueDocuments)
    .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, issue.companyId)))
    .where(and(eq(issueDocuments.companyId, issue.companyId), eq(issueDocuments.issueId, issue.id)))
    .orderBy(asc(issueDocuments.id));
  return {
    policy: {
      executionPolicy: issue.executionPolicy,
      reviewPolicy: issue.reviewPolicy,
      responsibleUserId: issue.responsibleUserId,
      createdByAgentId: issue.createdByAgentId,
      createdByUserId: issue.createdByUserId,
    },
    delivery: {
      issue: {
        title: issue.title,
        description: issue.description,
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        workMode: issue.workMode,
        executionWorkspaceId: issue.executionWorkspaceId,
      },
      workProducts,
      documents: documentRows,
    },
    decisions,
  };
}

/** Called only after the final stage decision and done projection are persisted. */
export async function collectCompletedReviewReceipt(tx: Db, issue: CompletedReviewReceiptIssue, actor: {
  actorType: string;
  actorId: string;
  runId: string | null;
}) {
  const context = await readCompletedReviewEvidenceContext(tx, issue);
  return sealCompletedReviewEvidence({
    companyId: issue.companyId,
    issueId: issue.id,
    status: issue.status,
    executionState: issue.executionState,
    ...context,
    ...actor,
  });
}
