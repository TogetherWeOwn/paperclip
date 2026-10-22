import { and, eq } from "drizzle-orm";
import { issueEventWaitCoverage, issues, type Db } from "@paperclipai/db";
import { issueExecutionPolicySchema, type RegisterIssueWaitCoverage } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { persistActivity, publishActivity } from "./activity-log.js";

const COVERAGE_TTL_MS = 12 * 60 * 60 * 1000;

export function issueWaitCoverageService(db: Db) {
  return {
    register: async (
      companyId: string,
      issueId: string,
      input: RegisterIssueWaitCoverage,
      actor: { type: "board"; id: string; runId: string | null },
    ) => {
      const result = await db.transaction(async (tx) => {
        // Serialize snapshots and registrations against issue assignment/policy changes.
        const [issue] = await tx.select().from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
          .for("no key update");
        if (!issue) throw notFound("Issue not found");
        if (issue.assigneeUserId !== null || issue.assigneeAgentId !== input.armedAssigneeAgentId
          || issue.status !== input.armedStatus) {
          throw unprocessable("Armed snapshot does not match the current issue");
        }
        const now = new Date();
        const observedAt = new Date(input.observedAt);
        if (observedAt.getTime() > now.getTime()) throw unprocessable("Observation cannot be in the future");
        const parsedPolicy = issue.executionPolicy === null ? null : issueExecutionPolicySchema.safeParse(issue.executionPolicy);
        if (parsedPolicy && !parsedPolicy.success) throw unprocessable("Cannot bound coverage against an invalid monitor policy");
        const timeout = parsedPolicy?.success ? parsedPolicy.data.monitor?.timeoutAt : null;
        const expiresAt = new Date(Math.min(now.getTime() + COVERAGE_TTL_MS, timeout ? Date.parse(timeout) : Infinity));
        const key = and(
          eq(issueEventWaitCoverage.companyId, companyId),
          eq(issueEventWaitCoverage.issueId, issueId),
          eq(issueEventWaitCoverage.serviceName, input.serviceName),
          eq(issueEventWaitCoverage.externalRef, input.externalRef),
        );
        const [previous] = await tx.select().from(issueEventWaitCoverage).where(key);
        if (previous && previous.observedAt.getTime() > observedAt.getTime()) {
          throw conflict("Observation predates registered coverage");
        }
        const observation = {
          sourceKind: input.sourceKind,
          eventRevision: input.eventRevision,
          armedRevision: input.armedRevision,
          observationStatus: input.observationStatus,
          observedAt,
          armedAssigneeAgentId: input.armedAssigneeAgentId,
          armedStatus: input.armedStatus,
          fallbackAt: input.fallbackAt === null ? null : new Date(input.fallbackAt),
          expiresAt,
          registeredByActor: { type: actor.type, id: actor.id },
          updatedAt: now,
        };
        const [coverage] = await tx.insert(issueEventWaitCoverage).values({
          companyId, issueId, serviceName: input.serviceName, externalRef: input.externalRef,
          ...observation,
        }).onConflictDoUpdate({
          target: [issueEventWaitCoverage.issueId, issueEventWaitCoverage.serviceName, issueEventWaitCoverage.externalRef],
          // Registration cannot clear an unresolved event; delivery acknowledgement is a later slice.
          set: observation,
        }).returning();
        const { publication } = await persistActivity(tx as unknown as Db, {
          companyId,
          actorType: "user",
          actorId: actor.id,
          runId: actor.runId,
          action: "issue.wait_coverage_registered",
          entityType: "issue",
          entityId: issueId,
          details: { coverageId: coverage!.id, sourceKind: input.sourceKind, observationStatus: input.observationStatus },
        });
        return { coverage: coverage!, publication };
      });
      publishActivity(result.publication);
      return result.coverage;
    },
  };
}
