import type { Db, issues } from "@paperclipai/db";
import type { AuthorizationActor } from "./authorization.js";
import { codeDeliveryReadinessService, type DeliveryTransaction, type PreparedCodeDeliveryReadiness } from "./code-delivery-readiness.js";
import { deliveryReadinessConflict } from "./code-delivery-readiness-policy.js";
import { applyIssueExecutionPolicyTransition } from "./issue-execution-policy.js";

export function assertIssueMutationDoesNotTerminalize(input: Parameters<typeof applyIssueExecutionPolicyTransition>[0]) {
  const transition = applyIssueExecutionPolicyTransition(input);
  const status = transition.patch.status ?? input.requestedStatus;
  if (status === "done" || status === "cancelled") throw deliveryReadinessConflict("terminal_effects_preparation_required");
}

export type IssueCodeDeliveryPreparation = {
  actor: AuthorizationActor;
  prepared: PreparedCodeDeliveryReadiness | null;
};

type PostCommitBuffer = { length: number; splice(start: number): unknown };

export async function applyIssueCodeDelivery<T>(input: {
  transaction: DeliveryTransaction;
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId">;
  patch: Partial<Pick<typeof issues.$inferInsert, "status" | "completedAt" | "cancelledAt">>;
  attribution: { agentId?: string | null; userId?: string | null; runId?: string | null };
  preparation?: IssueCodeDeliveryPreparation;
  postCommitBuffers: PostCommitBuffer[];
  mutate: (tx: DeliveryTransaction) => Promise<T>;
}): Promise<T> {
  const status = input.patch.status;
  if ((input.patch.completedAt != null && status !== "done") || (input.patch.cancelledAt != null && status !== "cancelled")) {
    throw deliveryReadinessConflict("terminal_timestamp_requires_status");
  }
  if (status !== "done" && status !== "cancelled") return input.mutate(input.transaction);
  const preparation = input.preparation;
  if (!preparation) throw deliveryReadinessConflict("preparation_required");
  const actor = preparation.actor;
  const { agentId, userId, runId } = input.attribution;
  if ((actor.type === "agent" && (!agentId || actor.agentId !== agentId || !runId || actor.runId !== runId || userId))
    || (actor.type === "board" && (!userId || actor.userId !== userId || agentId || runId))
    || (actor.type !== "agent" && actor.type !== "board")) {
    throw deliveryReadinessConflict("mutation_actor_mismatch");
  }
  const bufferLengths = input.postCommitBuffers.map(buffer => buffer.length);
  try {
    const applied = await codeDeliveryReadinessService(input.transaction as unknown as Db).apply(
      input.transaction, input.issue.companyId, input.issue.id, status, actor, preparation.prepared, input.mutate,
    );
    return applied.result;
  } catch (error) {
    input.postCommitBuffers.forEach((buffer, index) => buffer.splice(bufferLengths[index]!));
    throw error;
  }
}
