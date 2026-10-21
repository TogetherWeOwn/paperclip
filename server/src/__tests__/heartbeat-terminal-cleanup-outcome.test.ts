import { describe, expect, it } from "vitest";
import { isTerminalResultCleanupSuccess } from "../services/terminal-cleanup-outcome.js";

const cleanupEvidence = (overrides: Record<string, unknown> = {}) => ({
  kind: "terminal_result_cleanup",
  stopped: true,
  stopReason: "unmanaged_background_task_stopped",
  reason: "unmanaged background task stopped; no durable live path",
  terminalResultSeen: true,
  signal: "SIGTERM",
  forceKilled: false,
  ...overrides,
});

// Shape of the live failures: result_json.subtype=success, is_error=false,
// terminal_reason=completed, plus the terminal_result_cleanup evidence.
const successResultJson = (overrides: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  unmanagedBackgroundTask: cleanupEvidence(),
  ...overrides,
});

describe("isTerminalResultCleanupSuccess", () => {
  it("forgives exit 143 after a terminal success result stopped by cleanup", () => {
    expect(
      isTerminalResultCleanupSuccess({
        exitCode: 143,
        signal: null,
        errorMessage: null,
        errorCode: null,
        resultJson: successResultJson(),
      }),
    ).toBe(true);
  });

  it("forgives a reported SIGTERM after a terminal success result", () => {
    expect(
      isTerminalResultCleanupSuccess({
        exitCode: null,
        signal: "SIGTERM",
        errorMessage: null,
        errorCode: null,
        resultJson: successResultJson(),
      }),
    ).toBe(true);
  });

  it("still fails a bare exit 143 with no cleanup evidence", () => {
    expect(
      isTerminalResultCleanupSuccess({
        exitCode: 143,
        signal: null,
        errorMessage: null,
        errorCode: null,
        resultJson: { subtype: "success", is_error: false },
      }),
    ).toBe(false);
  });

  it("still fails when no terminal result was seen", () => {
    expect(
      isTerminalResultCleanupSuccess({
        exitCode: 143,
        signal: null,
        errorMessage: null,
        errorCode: null,
        resultJson: successResultJson({
          unmanagedBackgroundTask: cleanupEvidence({
            terminalResultSeen: false,
          }),
        }),
      }),
    ).toBe(false);
  });

  it("still fails an is_error result even with cleanup evidence", () => {
    expect(
      isTerminalResultCleanupSuccess({
        exitCode: 143,
        signal: null,
        errorMessage: "Claude exited with code 143",
        errorCode: null,
        resultJson: successResultJson({ is_error: true }),
      }),
    ).toBe(false);
  });

  it("still fails a refusal code carried with a null message", () => {
    expect(
      isTerminalResultCleanupSuccess({
        exitCode: 143,
        signal: null,
        errorMessage: null,
        errorCode: "claude_refusal",
        resultJson: successResultJson(),
      }),
    ).toBe(false);
  });

  it("still fails a non-cleanup exit code with cleanup evidence", () => {
    expect(
      isTerminalResultCleanupSuccess({
        exitCode: 1,
        signal: null,
        errorMessage: null,
        errorCode: null,
        resultJson: successResultJson(),
      }),
    ).toBe(false);
  });

  it("still fails a SIGKILL escalation with cleanup evidence", () => {
    expect(
      isTerminalResultCleanupSuccess({
        exitCode: 137,
        signal: "SIGKILL",
        errorMessage: null,
        errorCode: null,
        resultJson: successResultJson({
          unmanagedBackgroundTask: cleanupEvidence({ forceKilled: true }),
        }),
      }),
    ).toBe(false);
  });

  it("does not claim an ordinary clean exit", () => {
    expect(
      isTerminalResultCleanupSuccess({
        exitCode: 0,
        signal: null,
        errorMessage: null,
        errorCode: null,
        resultJson: { subtype: "success", is_error: false },
      }),
    ).toBe(false);
  });
});
