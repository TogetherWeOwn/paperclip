import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { claimNativeReviewExecutionLock, readNativeReviewAssignmentContext } from "./native-review-participant.js";

/** The run, wake, and issue lock form one reviewer admission claim. */
export async function claimQueuedNativeReviewRun(db: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  agentNameKey: string | null;
  claimedAt: Date;
  claimValues: PgUpdateSetSource<typeof heartbeatRuns>;
  // TOG-28460: the production claim path (heartbeat claimQueuedRun) passes
  // the agent's cap so burst wakes serialize here. Optional so direct
  // callers (tests, tooling) keep the historical uncapped behavior.
  maxConcurrentRuns?: number;
}): Promise<typeof heartbeatRuns.$inferSelect | null> {
  const context = input.run.contextSnapshot as Record<string, unknown> | null;
  const issueId = context?.issueId;
  if (typeof issueId !== "string" || !readNativeReviewAssignmentContext(context)) return null;
  return db.transaction(async (tx) => {
    // TOG-28460: agents row first, matching the ordinary/comment claim
    // paths in heartbeat claimQueuedRun. The recount and the claim below
    // share this connection, so concurrent schedulers on other processes
    // serialize here. At cap the run stays queued for a later drain pass.
    await tx.execute(
      sql`select id from agents where id = ${input.run.agentId} and company_id = ${input.run.companyId} for update`,
    );
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, input.run.agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    if (
      input.maxConcurrentRuns !== undefined &&
      Number(count ?? 0) >= input.maxConcurrentRuns
    ) {
      return null;
    }
    // Match the queue editor's lock order: issue, wake, then run.
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, issueId), eq(issues.companyId, input.run.companyId),
    )).for("update");
    if (!issue) return null;
    if (input.run.wakeupRequestId) {
      const [wake] = await tx.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.id, input.run.wakeupRequestId),
        eq(agentWakeupRequests.companyId, input.run.companyId),
        eq(agentWakeupRequests.agentId, input.run.agentId),
      )).for("update");
      if (!wake || wake.status !== "queued" || wake.runId !== input.run.id) return null;
    }
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId),
      eq(heartbeatRuns.agentId, input.run.agentId),
    )).for("update");
    if (!run || run.status !== "queued" || run.wakeupRequestId !== input.run.wakeupRequestId) return null;
    if ((run.contextSnapshot as Record<string, unknown> | null)?.issueId !== issueId) return null;
    const locked = await claimNativeReviewExecutionLock(tx as unknown as Db, {
      companyId: run.companyId, issueId, agentId: run.agentId, runId: run.id,
      contextSnapshot: context, agentNameKey: input.agentNameKey, claimedAt: input.claimedAt,
    });
    if (!locked) return null;
    const [claimed] = await tx.update(heartbeatRuns).set({
      ...input.claimValues, status: "running", startedAt: run.startedAt ?? input.claimedAt,
      updatedAt: input.claimedAt,
    }).where(eq(heartbeatRuns.id, run.id)).returning();
    if (run.wakeupRequestId) await tx.update(agentWakeupRequests).set({
      status: "claimed", claimedAt: input.claimedAt, updatedAt: input.claimedAt,
    }).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
    return claimed ?? null;
  });
}
