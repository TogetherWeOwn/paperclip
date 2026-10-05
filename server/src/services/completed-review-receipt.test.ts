import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { type Db, issueExecutionDecisions, issueWorkProducts } from "@paperclipai/db";
import { collectCompletedReviewReceipt, readCompletedReviewEvidenceContext, type CompletedReviewReceiptIssue } from "./completed-review-receipt.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture() {
  const at = new Date("2026-10-01T11:32:00Z");
  const scope = { companyId: id(1), issueId: id(2) };
  const issue: CompletedReviewReceiptIssue = {
    id: scope.issueId, companyId: scope.companyId, status: "done",
    title: "Delivered change", description: "Original slice", projectId: id(9), goalId: null,
    parentId: null, workMode: "standard", executionWorkspaceId: null,
    reviewPolicy: "not_creator", responsibleUserId: "responsible-user", createdByAgentId: id(3), createdByUserId: null,
    executionPolicy: { mode: "normal", commentRequired: true,
      stages: [{ id: id(4), type: "review", approvalsNeeded: 1,
        participants: [{ id: id(5), type: "agent", agentId: id(6), userId: null }] }] },
    executionState: {
      status: "completed", completedStageIds: [id(4)], lastDecisionId: id(7), lastDecisionOutcome: "approved",
      currentStageId: null, currentStageIndex: null, currentStageType: null, currentParticipant: null,
      returnAssignee: { type: "agent", agentId: id(3), userId: null }, changesRequestedCount: 0,
      reviewRequest: null, monitor: null,
    },
  };
  const decisions = [{ ...scope, id: id(7), stageId: id(4), stageType: "review", outcome: "approved",
    actorAgentId: id(6), actorUserId: null, createdByRunId: id(8), createdAt: at, updatedAt: at }];
  const products = [{ ...scope, id: id(10), status: "merged", updatedAt: at }];
  const docs = [{ issue_documents: { ...scope, id: id(11) }, documents: { id: id(12), latestRevisionId: id(13) } }];
  const conditions: unknown[] = [];
  const tx = { select: vi.fn(() => ({ from: (table: unknown) => {
    const rows = table === issueExecutionDecisions ? decisions : table === issueWorkProducts ? products : docs;
    const query = {
      innerJoin: vi.fn(() => query),
      where: vi.fn((condition: unknown) => { conditions.push(condition); return query; }),
      orderBy: vi.fn(async () => rows),
    };
    return query;
  } })) } as unknown as Db;
  return { issue, decisions, products, docs, tx, conditions,
    actor: { actorType: "agent", actorId: id(6), runId: id(8) } };
}

describe("persisted completion receipt collection (mock DB only)", () => {
  it("reads company/issue-scoped persisted rows and retains their approval ids", async () => {
    const f = fixture();
    const result = await collectCompletedReviewReceipt(f.tx, f.issue, f.actor);
    expect(result).toEqual(expect.objectContaining({ version: 1, companyId: f.issue.companyId,
      issueId: f.issue.id, decisionIds: [id(7)] }));
    expect(f.conditions).toHaveLength(3);
    const dialect = new PgDialect();
    for (const condition of f.conditions) {
      const { params } = dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
      expect(params).toEqual([f.issue.companyId, f.issue.id]);
    }
  });

  it("refuses a missing or newer adverse decision rather than sealing client state", async () => {
    const f = fixture();
    f.decisions[0].outcome = "rejected";
    expect(await collectCompletedReviewReceipt(f.tx, f.issue, f.actor)).toBeNull();
    f.decisions.length = 0;
    expect(await collectCompletedReviewReceipt(f.tx, f.issue, f.actor)).toBeNull();
  });

  it.each(["policy", "work product", "document", "description"])("binds the full persisted %s revision", async (kind) => {
    const f = fixture();
    const before = await collectCompletedReviewReceipt(f.tx, f.issue, f.actor);
    if (kind === "policy") f.issue.reviewPolicy = "anyone";
    if (kind === "work product") f.products[0].updatedAt = new Date("2026-10-01T11:33:00Z");
    if (kind === "document") f.docs[0].documents.latestRevisionId = id(14);
    if (kind === "description") f.issue.description = "New work";
    const after = await collectCompletedReviewReceipt(f.tx, f.issue, f.actor);
    expect(before).not.toBeNull();
    expect(after).not.toEqual(before);
  });

  it("does not publish raw document bodies or work product contents in a receipt", async () => {
    const f = fixture();
    const context = await readCompletedReviewEvidenceContext(f.tx, f.issue);
    expect(context.delivery.documents).toEqual(f.docs);
    const result = await collectCompletedReviewReceipt(f.tx, f.issue, f.actor);
    expect(Object.keys(result!)).toEqual(["version", "companyId", "issueId", "policyDigest", "deliveryDigest", "decisionIds"]);
  });
});
