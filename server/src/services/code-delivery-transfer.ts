import { and, eq, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import type { DeliveryIssue } from "./code-delivery-authority.js";

export async function assertDeliveryTransferDestination(tx: Db, destination: DeliveryIssue) {
  const denied = (reason: string) => conflict("Delivery transfer destination is unavailable", { code: "code_delivery_decision_conflict", reason });
  if (!["todo", "in_progress", "in_review"].includes(destination.status)
    || !destination.assigneeAgentId || destination.assigneeUserId) throw denied("destination_not_runnable");
  await assertAssignableAgent(tx, destination.companyId, destination.assigneeAgentId, { kind: "work" });
  const [agent] = await tx.select({ status: agents.status }).from(agents).where(and(eq(agents.companyId, destination.companyId),
    eq(agents.id, destination.assigneeAgentId))).for("share");
  if (!agent || ["paused", "error", "terminated", "pending_approval"].includes(agent.status)) throw denied("destination_not_runnable");
  const monitor = parseIssueExecutionState(destination.executionState)?.monitor;
  const now = Date.now();
  const monitorLive = monitor?.status === "scheduled" && monitor.nextCheckAt && Date.parse(monitor.nextCheckAt) > now
    && destination.monitorNextCheckAt?.getTime() === Date.parse(monitor.nextCheckAt)
    && monitor.timeoutAt && Date.parse(monitor.timeoutAt) > Date.parse(monitor.nextCheckAt)
    && monitor.maxAttempts != null && monitor.attemptCount < monitor.maxAttempts;
  const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, destination.companyId),
    eq(heartbeatRuns.agentId, destination.assigneeAgentId), sql`${heartbeatRuns.status} in ('queued', 'running')`,
    sql`(${heartbeatRuns.issueId} = ${destination.id} or ${heartbeatRuns.nativeIssueId} = ${destination.id})`)).limit(1).for("share");
  if (!monitorLive && !run) throw denied("destination_has_no_wake_path");
}
