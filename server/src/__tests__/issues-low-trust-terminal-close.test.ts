import { describe, expect, it } from "vitest";
import { isAssigneeTerminalCloseOfBlockedCard } from "../routes/issues-low-trust-terminal-close.js";

const base = {
  actorType: "agent",
  actorAgentId: "agent-1",
  issueStatus: "blocked",
  assigneeAgentId: "agent-1",
  targetStatus: "done",
  resumeRequested: false,
  reopenRequested: false,
  setsBlockers: false,
} as const;

describe("isAssigneeTerminalCloseOfBlockedCard", () => {
  it.each(["done", "cancelled"])(
    "allows the assignee to move its own blocked card to %s",
    (targetStatus) => {
      expect(
        isAssigneeTerminalCloseOfBlockedCard({ ...base, targetStatus }),
      ).toBe(true);
    },
  );

  it.each([
    ["a non-assignee agent", { actorAgentId: "agent-2" }],
    ["a board actor", { actorType: "board", actorAgentId: null }],
    ["an unassigned card", { assigneeAgentId: null }],
    ["a card that is not blocked", { issueStatus: "in_progress" }],
    ["a todo target", { targetStatus: "todo" }],
    ["an in_progress target", { targetStatus: "in_progress" }],
    ["an in_review target", { targetStatus: "in_review" }],
    ["no target status", { targetStatus: undefined }],
    ["resume", { resumeRequested: true }],
    ["reopen", { reopenRequested: true }],
    ["a blocker edit", { setsBlockers: true }],
  ] as const)("denies %s", (_label, override) => {
    expect(isAssigneeTerminalCloseOfBlockedCard({ ...base, ...override })).toBe(
      false,
    );
  });
});
