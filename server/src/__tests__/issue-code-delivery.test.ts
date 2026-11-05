import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationActor } from "../services/authorization.js";
import type { DeliveryTransaction, PreparedCodeDeliveryReadiness } from "../services/code-delivery-readiness.js";
import { applyIssueCodeDelivery, assertIssueMutationDoesNotTerminalize } from "../services/issue-code-delivery.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

const boundary = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("../services/code-delivery-readiness.js", () => ({ codeDeliveryReadinessService: () => ({ apply: boundary.apply }) }));

const actor: AuthorizationActor = { type: "board", userId: "reviewer", source: "session" };
const token = Object.freeze({}) as PreparedCodeDeliveryReadiness;
const tx = Object.freeze({}) as DeliveryTransaction;
const issue = { id: "issue", companyId: "company" };
const attribution = { userId: "reviewer" };

beforeEach(() => boundary.apply.mockReset());

describe("unprepared terminal-effects preflight", () => {
  function staged(index: number) {
    const policy = normalizeIssueExecutionPolicy({ mode: "normal", commentRequired: true, stages: [
      { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "user", userId: "security" }] },
      { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "user", userId: "reviewer" }] },
    ] })!;
    const participant = policy.stages[index].participants[0];
    return { issue: { status: "in_review", assigneeUserId: participant.userId, executionPolicy: policy, executionState: {
      status: "pending", currentStageId: policy.stages[index].id, currentStageIndex: index, currentStageType: "review",
      currentParticipant: { type: "user", userId: participant.userId }, returnAssignee: { type: "agent", agentId: randomUUID() },
      completedStageIds: policy.stages.slice(0, index).map(stage => stage.id), lastDecisionId: null, lastDecisionOutcome: null,
    } }, policy, requestedStatus: "done", requestedAssigneePatch: {}, actor: { userId: participant.userId }, commentBody: "Approved" };
  }

  it("allows an earlier native approval because its effective status remains in_review", () => {
    const input = staged(0), before = structuredClone(input);
    expect(() => assertIssueMutationDoesNotTerminalize(input)).not.toThrow();
    expect(input).toEqual(before);
    expect(boundary.apply).not.toHaveBeenCalled();
  });

  it("denies the final native approval before any terminal effects can start", () => {
    const input = staged(1), before = structuredClone(input);
    expect(() => assertIssueMutationDoesNotTerminalize(input)).toThrow(expect.objectContaining({
      status: 409, details: { code: "code_delivery_not_ready", reason: "terminal_effects_preparation_required" },
    }));
    expect(input).toEqual(before);
  });

  it.each(["done", "cancelled"])("denies no-stage %s before any terminal effects can start", requestedStatus => {
    expect(() => assertIssueMutationDoesNotTerminalize({ issue: { status: "in_progress" }, policy: null,
      requestedStatus, requestedAssigneePatch: {}, actor: { userId: "reviewer" } })).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe("common issue delivery mutation boundary", () => {
  it.each(["done", "cancelled"])("refuses unprepared effective %s without invoking the mutation", async status => {
    const mutate = vi.fn();
    await expect(applyIssueCodeDelivery({ transaction: tx, issue, patch: { status }, attribution,
      postCommitBuffers: [], mutate })).rejects.toMatchObject({ status: 409, details: { reason: "preparation_required" } });
    expect(mutate).not.toHaveBeenCalled();
    expect(boundary.apply).not.toHaveBeenCalled();
  });

  it.each(["in_review", "in_progress", "blocked", "todo", undefined])("does no delivery work for effective %s", async status => {
    const mutate = vi.fn().mockResolvedValue("updated");
    await expect(applyIssueCodeDelivery({ transaction: tx, issue, patch: { status }, attribution: {},
      postCommitBuffers: [], mutate })).resolves.toBe("updated");
    expect(mutate).toHaveBeenCalledExactlyOnceWith(tx);
    expect(boundary.apply).not.toHaveBeenCalled();
  });

  it.each([{ completedAt: new Date() }, { cancelledAt: new Date() }, { status: "in_review", completedAt: new Date() }])(
    "refuses terminal timestamp writes without the matching effective terminal status", async patch => {
      const mutate = vi.fn();
      await expect(applyIssueCodeDelivery({ transaction: tx, issue, patch, attribution,
        postCommitBuffers: [], mutate })).rejects.toMatchObject({ status: 409, details: { reason: "terminal_timestamp_requires_status" } });
      expect(mutate).not.toHaveBeenCalled();
      expect(boundary.apply).not.toHaveBeenCalled();
    },
  );

  it.each([
    { actor, attribution: {} },
    { actor, attribution: { userId: "author" } },
    { actor, attribution: { userId: "reviewer", agentId: "author" } },
    { actor: { type: "none" } as AuthorizationActor, attribution: {} },
    { actor: { type: "agent", agentId: "author", runId: "run" } as AuthorizationActor, attribution: { agentId: "author" } },
    { actor: { type: "agent", agentId: "author", runId: "run" } as AuthorizationActor, attribution: { agentId: "other", runId: "run" } },
    { actor: { type: "agent", agentId: "author", runId: "run" } as AuthorizationActor, attribution: { agentId: "author", runId: "run", userId: "reviewer" } },
  ])("cannot apply another principal's preparation", async value => {
    const mutate = vi.fn();
    await expect(applyIssueCodeDelivery({ transaction: tx, issue, patch: { status: "done" }, attribution: value.attribution,
      preparation: { actor: value.actor, prepared: token }, postCommitBuffers: [], mutate }))
      .rejects.toMatchObject({ status: 409, details: { reason: "mutation_actor_mismatch" } });
    expect(boundary.apply).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled"])("runs effective %s only on the receipt savepoint", async status => {
    const savepoint = Object.freeze({ nested: true }) as unknown as DeliveryTransaction;
    boundary.apply.mockImplementation(async (_tx, _companyId, _issueId, _status, _actor, _token, mutate) => ({
      receipt: { id: "receipt" }, result: await mutate(savepoint),
    }));
    const mutate = vi.fn().mockResolvedValue("updated");
    await expect(applyIssueCodeDelivery({ transaction: tx, issue, patch: { status }, attribution,
      preparation: { actor, prepared: token }, postCommitBuffers: [], mutate })).resolves.toBe("updated");
    expect(boundary.apply).toHaveBeenCalledExactlyOnceWith(tx, "company", "issue", status, actor, token, mutate);
    expect(mutate).toHaveBeenCalledExactlyOnceWith(savepoint);
  });

  it("drops only this attempt's post-commit effects if the receipt savepoint rolls back", async () => {
    const publications = ["earlier publication"], actions = ["earlier action"];
    const mutate = vi.fn(async () => { publications.push("terminal publication"); actions.push("stop run"); return "updated"; });
    boundary.apply.mockImplementation(async (_tx, _companyId, _issueId, _status, _actor, _token, callback) => {
      await callback(tx);
      throw new Error("receipt not consumed");
    });
    await expect(applyIssueCodeDelivery({ transaction: tx, issue, patch: { status: "done" }, attribution,
      preparation: { actor, prepared: token }, postCommitBuffers: [publications, actions], mutate })).rejects.toThrow("receipt not consumed");
    expect(publications).toEqual(["earlier publication"]);
    expect(actions).toEqual(["earlier action"]);
  });

  it("keeps effects available to the outer transaction owner after successful consumption", async () => {
    const actions: string[] = [];
    boundary.apply.mockImplementation(async (_tx, _companyId, _issueId, _status, _actor, _token, callback) => ({ result: await callback(tx) }));
    const mutate = vi.fn(async () => { actions.push("cancel after outer commit"); return { status: "done" }; });
    await expect(applyIssueCodeDelivery({ transaction: tx, issue, patch: { status: "done" }, attribution,
      preparation: { actor, prepared: token }, postCommitBuffers: [actions], mutate })).resolves.toEqual({ status: "done" });
    expect(actions).toEqual(["cancel after outer commit"]);
  });
});
