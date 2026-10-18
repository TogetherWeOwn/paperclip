type TerminalCloseInput = {
  actorType: "board" | "agent" | "none";
  actorAgentId: string | null;
  issueStatus: string;
  assigneeAgentId: string | null;
  targetStatus: unknown;
  resumeRequested: boolean;
  reopenRequested: boolean;
  setsBlockers: boolean;
};

/**
 * The one transition out of `blocked` that a low-trust actor keeps: the
 * assignee moving its own card to `done` or `cancelled`. Recovery parks a
 * failed low-trust review card `blocked`, and a low-trust actor can already do
 * `in_progress -> done`, so this adds no revival path: reopen, resume, blocker
 * edits and every non-terminal target stay denied.
 */
export function isAssigneeTerminalCloseOfBlockedCard(
  input: TerminalCloseInput,
): boolean {
  if (input.actorType !== "agent") return false;
  if (!input.actorAgentId) return false;
  if (input.issueStatus !== "blocked") return false;
  if (input.targetStatus !== "done" && input.targetStatus !== "cancelled")
    return false;
  if (input.resumeRequested || input.reopenRequested || input.setsBlockers)
    return false;
  return input.assigneeAgentId === input.actorAgentId;
}
