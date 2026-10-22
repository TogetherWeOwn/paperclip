import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { expect, it } from "vitest";
import {
  isReviewWaitNeverStartedCancellation,
  legacyExecutionNeedsReconciliation,
} from "./legacy-execution-recovery.js";

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated"])("does not invent unknown provider actions after exhausted %s bootstrap retries", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "setup_failed" })).toBe(true);
});

it("permits subscription waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 12,
    resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
  } })).toBe(true);
});

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});

 it("continues a conversation without requiring receipts, even after automatic attempts are exhausted", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("retries a busy AI subscription only when no provider work started", () => {
   const waiting = { runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 10,
     resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } };
   expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
 });


it.each(["failed", "timed_out", "cancelled"])("holds an unsafe archive after %s even with conversation or bootstrap evidence", (status) => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status, errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1",
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "max_turns",
  } })).toBe(true);
});


it("retains conversation retry eligibility for a transient restore lock timeout", () => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "failed", errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_lock_timeout", conversationContinuation: "continue_conversation_v1",
  } })).toBe(false);
});


it("recognizes only an unclaimed pre-dispatch review wait receipt", () => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_continuation_waiting_on_review",
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" } };
  expect(isPreDispatchReviewWait(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  for (const patch of [
    { startedAt: new Date() }, { processPid: 123 }, { processGroupId: 123 },
    { processStartedAt: new Date() }, { nativeSessionId: "provider-session" }, { nativeIssueId: "native-task" },
    { sessionIdAfter: "provider-session" }, { runtimeModeResolvedAt: new Date() },
    { controllerBootId: "live-controller" }, { controllerLeaseExpiresAt: new Date() }, { executionStage: "preparing" },
    { errorCode: "operator_interrupted" }, { resultJson: {} },
    { resultJson: { ...run.resultJson, stopReason: "cancelled" } },
    { resultJson: { ...run.resultJson, workspaceRestoreFailure: "restore_unsafe_archive" } },
  ]) expect(isPreDispatchReviewWait({ ...run, ...patch })).toBe(false);
});

it("permits model-decision waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "model_decision_pending", scheduledRetryAttempt: 3,
    resultJson: { executionRecovery: { kind: "model_decision_pending", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "model_decision_pending", providerWorkStarted: true },
  } })).toBe(true);
});

const reviewWait = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "issue_continuation_waiting_on_review",
  startedAt: null, processStartedAt: null, processPid: null, processGroupId: null,
  lastOutputAt: null, lastOutputSeq: 0, scheduledRetryAttempt: 4,
  resultJson: {
    stopReason: "issue_continuation_waiting_on_review",
    timeoutSource: "stale_queued_run_gate", effectiveTimeoutSec: 0, timeoutFired: false,
  },
};

it("holds a gate-cancelled review-wait continuation until retained evidence is checked", () => {
  // The row receipt matches the never-started shape, but the synchronous
  // classifier stays conservative: only legacyExecutionNeedsReconciliation-
  // WithEvidence (after isPreDispatchReviewWaitVerified finds no launch or
  // cleanup rows) may lift the hold. See the wake-queue "verified
  // pre-dispatch review wait" cases for the exempt-vs-held matrix.
  expect(isReviewWaitNeverStartedCancellation(reviewWait)).toBe(true);
  expect(legacyExecutionNeedsReconciliation(reviewWait)).toBe(true);
});

it.each([
  ["a process identity", { processPid: 4321 }],
  ["a process start", { processStartedAt: new Date() }],
  ["a run start", { startedAt: new Date() }],
  ["emitted output", { lastOutputSeq: 3 }],
  ["output timing", { lastOutputAt: new Date(), lastOutputSeq: 1 }],
  ["a non-cancelled status", { status: "failed" }],
])("keeps the reconciliation hold for a review-wait run with %s", (_label, patch) => {
  expect(legacyExecutionNeedsReconciliation({ ...reviewWait, ...patch })).toBe(true);
});

it.each([
  ["missing gate marker", { stopReason: "issue_continuation_waiting_on_review" }],
  ["missing stop reason", { timeoutSource: "stale_queued_run_gate" }],
  ["empty result", {}],
])("keeps the reconciliation hold when the review-wait evidence is incomplete: %s", (_label, resultJson) => {
  expect(legacyExecutionNeedsReconciliation({ ...reviewWait, resultJson })).toBe(true);
});

it("keeps the unsafe-archive hold ahead of the review-wait exemption", () => {
  expect(legacyExecutionNeedsReconciliation({
    ...reviewWait,
    resultJson: { ...reviewWait.resultJson, workspaceRestoreFailure: "restore_unsafe_archive" },
  })).toBe(true);
});
