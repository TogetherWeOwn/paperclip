import { and, eq, inArray } from "drizzle-orm";
import { activityLog, agents, codeDeliveryAuthorities, codeDeliveryDecisions, codeDeliveryDiscoveries, codeDeliveryObligations, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { forbidden, notFound } from "../errors.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { resolveIssueReviewRequester } from "./issue-review-policy.js";

export type DeliveryIssue = typeof issues.$inferSelect;
export type DeliveryActor = { type: "agent" | "user"; id: string; runId: string | null };

export function deliveryActor(actor: AuthorizationActor): DeliveryActor {
  if (actor.type === "agent" && actor.agentId && actor.runId && actor.companyId) {
    return { type: "agent", id: actor.agentId, runId: actor.runId };
  }
  if (actor.type === "board" && actor.userId) return { type: "user", id: actor.userId, runId: null };
  throw forbidden("An authenticated delivery decision actor is required", { code: "code_delivery_authority_denied" });
}

export async function readDeliveryIssue(db: Db, companyId: string, issueId: string, actor: AuthorizationActor, mutate = true) {
  if (actor.type === "agent" && actor.companyId !== companyId) throw notFound("Task not found");
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (!issue) throw notFound("Task not found");
  const resource = { type: "issue" as const, companyId, issueId, projectId: issue.projectId,
    parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status };
  const access = authorizationService(db);
  if (!(await access.decide({ actor, action: "issue:read", resource })).allowed) throw notFound("Task not found");
  if (mutate) {
    const mutation = await access.decide({ actor, action: "issue:mutate", resource });
    if (!mutation.allowed) throw forbidden(mutation.explanation);
    if (actor.type === "agent") {
      const principal = deliveryActor(actor);
      const run = await assertAgentRunWriteAllowed(db, companyId, { agentId: principal.id, runId: principal.runId });
      if (!run || run.status !== "running") throw forbidden("An active task run is required");
    }
  }
  return issue;
}

export async function lockDeliveryIssues(tx: Db, actor: AuthorizationActor, companyId: string, issueIds: string[]) {
  const principal = deliveryActor(actor);
  if (actor.type === "agent" && actor.companyId !== companyId) throw notFound("Task not found");
  let sourceIssueId: string | null = null;
  if (principal.type === "agent") {
    const [run] = await tx.select({ nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
      context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, principal.runId!),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, principal.id)));
    const source = run?.nativeIssueId ?? run?.issueId ?? run?.context?.issueId ?? run?.context?.taskId;
    if (typeof source !== "string" || !isUuidLike(source)) throw forbidden("Run binding unavailable");
    sourceIssueId = source;
  }
  const ids = [...new Set([...issueIds, ...(sourceIssueId ? [sourceIssueId] : [])])].sort();
  const rows = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)))
    .orderBy(issues.id).for("update");
  if (ids.some(id => !rows.some(row => row.id === id))) throw notFound("Task not found");
  if (principal.type === "agent") {
    const run = await assertAgentRunWriteAllowed(tx, companyId, { agentId: principal.id, runId: principal.runId });
    const source = rows.find(row => row.id === sourceIssueId)!;
    if (!run || run.status !== "running" || source.workMode !== "standard"
      || source.assigneeAgentId !== principal.id || source.assigneeUserId
      || (run.runtimeMode === "native" && source.executionRunId !== principal.runId)) {
      throw forbidden("The task is no longer writable by this run");
    }
  }
  for (const issue of rows.filter(row => issueIds.includes(row.id))) {
    const resource = { type: "issue" as const, companyId, issueId: issue.id, projectId: issue.projectId,
      parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status };
    const access = authorizationService(tx);
    if (!(await access.decide({ actor, action: "issue:read", resource })).allowed) throw notFound("Task not found");
    const mutation = await access.decide({ actor, action: "issue:mutate", resource });
    if (!mutation.allowed) throw forbidden(mutation.explanation);
  }
  return rows;
}

export async function assertDeliveryAdjudicator(tx: Db, issue: DeliveryIssue, actor: AuthorizationActor) {
  const principal = deliveryActor(actor);
  const state = parseIssueExecutionState(issue.executionState);
  const returnAssignee = state?.returnAssignee;
  const executor = returnAssignee ?? (issue.assigneeAgentId ? { type: "agent", agentId: issue.assigneeAgentId } : { type: "user", userId: issue.assigneeUserId });
  const requester = await resolveIssueReviewRequester(tx, issue);
  const same = (type: string, id: unknown) => principal.type === type && principal.id === id;
  const excludedPrincipals: Array<{ type: "agent" | "user"; id: string }> = [];
  const exclude = (type: "agent" | "user", id: unknown) => {
    if (typeof id === "string" && id && !excludedPrincipals.some(p => p.type === type && p.id === id)) excludedPrincipals.push({ type, id });
  };
  exclude("agent", issue.createdByAgentId);
  exclude("user", issue.createdByUserId);
  exclude(executor.type, executor.type === "agent" ? executor.agentId : executor.userId);
  if (requester) exclude(requester.type, requester.id);
  const registrations = await tx.select({ provenance: codeDeliveryObligations.provenance }).from(codeDeliveryObligations)
    .where(and(eq(codeDeliveryObligations.companyId, issue.companyId), eq(codeDeliveryObligations.ownerIssueId, issue.id)));
  for (const { provenance } of registrations) {
    const actor = provenance.actor;
    if (actor && typeof actor === "object" && "type" in actor && "id" in actor
      && (actor.type === "agent" || actor.type === "user")) exclude(actor.type, actor.id);
  }
  const inherited = await tx.select({ authority: codeDeliveryDecisions.authority }).from(codeDeliveryObligations)
    .innerJoin(codeDeliveryDecisions, and(eq(codeDeliveryDecisions.companyId, codeDeliveryObligations.companyId),
      eq(codeDeliveryDecisions.id, codeDeliveryObligations.transferDecisionId)))
    .where(and(eq(codeDeliveryObligations.companyId, issue.companyId), eq(codeDeliveryObligations.ownerIssueId, issue.id)));
  for (const { authority } of inherited) {
    if (!Array.isArray(authority.excludedPrincipals)) throw forbidden("Delivery transfer provenance unavailable", { code: "code_delivery_authority_denied" });
    for (const value of authority.excludedPrincipals) {
      if (value && typeof value === "object" && (value.type === "agent" || value.type === "user")) exclude(value.type, value.id);
    }
  }
  const discoveries = await tx.select({ snapshot: codeDeliveryDiscoveries.snapshot, productId: codeDeliveryDiscoveries.sourceWorkProductId }).from(codeDeliveryDiscoveries)
    .where(and(eq(codeDeliveryDiscoveries.companyId, issue.companyId), eq(codeDeliveryDiscoveries.issueId, issue.id)));
  const sourceRuns = [...new Set(discoveries.map(({ snapshot }) => snapshot.created_by_run_id)
    .filter((id): id is string => typeof id === "string" && isUuidLike(id)))];
  const runs = sourceRuns.length ? await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, issue.companyId), inArray(heartbeatRuns.id, sourceRuns))) : [];
  const activities = discoveries.length ? await tx.select({ actorType: activityLog.actorType, actorId: activityLog.actorId,
    details: activityLog.details }).from(activityLog).where(and(eq(activityLog.companyId, issue.companyId),
    eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.work_product_created"))) : [];
  for (const run of runs) exclude("agent", run.agentId);
  for (const activity of activities) {
    if ((activity.actorType === "agent" || activity.actorType === "user")
      && discoveries.some(discovery => discovery.productId === activity.details?.workProductId)) exclude(activity.actorType, activity.actorId);
  }
  excludedPrincipals.sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  if (excludedPrincipals.some(p => same(p.type, p.id))) {
    throw forbidden("Delivery decisions require an independent adjudicator", { code: "code_delivery_authority_denied" });
  }
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
  if (policy?.stages.length) {
    const last = policy.stages.at(-1)!;
    const participant = state?.currentParticipant;
    const isPrincipal = (p: { type: string; agentId?: string | null; userId?: string | null }) =>
      same(p.type, p.type === "agent" ? p.agentId : p.userId);
    if (issue.status !== "in_review" || state?.status !== "pending" || state.currentStageId !== last.id
      || state.currentStageIndex !== policy.stages.length - 1 || state.currentStageType !== last.type
      || !participant || !isPrincipal(participant) || !last.participants.some(isPrincipal)
      || !policy.stages.slice(0, -1).every(stage => state.completedStageIds.includes(stage.id))) {
      throw forbidden("Only the pending final-stage participant can adjudicate delivery", { code: "code_delivery_authority_denied" });
    }
    return { kind: "final_stage", stageId: last.id, participant, policy, state, excludedPrincipals };
  }
  if ((issue.executionPolicy && !policy) || (issue.executionState && !state) || state?.status === "pending") {
    throw forbidden("Delivery review state is not adjudicable", { code: "code_delivery_authority_denied" });
  }
  const [authority] = await tx.select().from(codeDeliveryAuthorities).where(eq(codeDeliveryAuthorities.companyId, issue.companyId)).for("share");
  const [agent] = principal.type === "agent" ? await tx.select({ status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, issue.companyId), eq(agents.id, principal.id))).for("share") : [];
  if (!authority || principal.type !== "agent" || authority.technicalAgentId !== principal.id || !agent
    || ["paused", "terminated", "pending_approval", "error"].includes(agent.status)) {
    throw forbidden("A configured independent technical authority is required for a task without stages", { code: "code_delivery_authority_denied" });
  }
  return { kind: "technical_authority", agentId: principal.id, authorityRevision: authority.revision, excludedPrincipals };
}
