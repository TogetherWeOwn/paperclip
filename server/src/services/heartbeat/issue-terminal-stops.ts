import { and, eq, inArray, or, sql } from "drizzle-orm";
import { codeDeliveryReadinessReceipts, codeDeliveryReceiptConsumptions, codeDeliveryTerminalEffects, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { deliveryReadinessConflict } from "../code-delivery-readiness-policy.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { pendingFailedNativeRetryCancellationCondition } from "../native-runtime/native-cancellation-request.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type IssueBinding = Pick<typeof issues.$inferSelect, "id" | "companyId" | "checkoutRunId" | "executionRunId">;
type Receipt = typeof codeDeliveryReadinessReceipts.$inferSelect;
const MAX_TARGETS = 32;

export async function acceptIssueTerminalRunStops(tx: Transaction, issue: IssueBinding, receipt: Receipt) {
  const [consumption] = await tx.select().from(codeDeliveryReceiptConsumptions).where(and(
    eq(codeDeliveryReceiptConsumptions.receiptId, receipt.id), eq(codeDeliveryReceiptConsumptions.companyId, issue.companyId),
    eq(codeDeliveryReceiptConsumptions.issueId, issue.id),
  ));
  if (receipt.companyId !== issue.companyId || receipt.issueId !== issue.id || !consumption
    || consumption.transactionId !== receipt.transactionId || consumption.issueRevision !== receipt.issueRevision + 1
    || consumption.terminalStatus !== receipt.terminalStatus) throw deliveryReadinessConflict("terminal_effect_receipt_mismatch");
  const [current] = await tx.select({ status: issues.status, revision: issues.codeDeliveryRevision,
    transactionId: sql<string>`pg_current_xact_id()::text` }).from(issues).where(and(
    eq(issues.id, issue.id), eq(issues.companyId, issue.companyId),
  ));
  if (!current || current.status !== receipt.terminalStatus || current.revision !== consumption.issueRevision
    || current.transactionId !== receipt.transactionId) throw deliveryReadinessConflict("terminal_effect_receipt_mismatch");
  const pointed = [issue.executionRunId, issue.checkoutRunId].filter((id): id is string => !!id);
  const boundIssue = sql<string>`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
    nullif(${heartbeatRuns.contextSnapshot}->>'issueId', ''), nullif(${heartbeatRuns.contextSnapshot}->>'taskId', ''))`;
  const targets = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId),
    or(eq(boundIssue, issue.id), ...(pointed.length ? [inArray(heartbeatRuns.id, pointed)] : [])),
    or(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]), pendingFailedNativeRetryCancellationCondition()),
  )).orderBy(heartbeatRuns.id).limit(MAX_TARGETS + 1).for("update", { noWait: true });
  if (targets.length > MAX_TARGETS) throw deliveryReadinessConflict("terminal_effect_target_budget_exceeded");
  for (const run of targets) {
    const source = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
    if (source !== issue.id) throw deliveryReadinessConflict("terminal_effect_run_binding_mismatch");
  }
  if (!targets.length) return [];
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueTerminalStops, issue.companyId);
  return tx.insert(codeDeliveryTerminalEffects).values(targets.map(run => ({
    companyId: issue.companyId, issueId: issue.id, receiptId: receipt.id, runId: run.id, effectKind: "stop_run" as const,
  }))).onConflictDoNothing().returning();
}
