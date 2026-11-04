import { conflict } from "../errors.js";

// Delivery is not preservation. Native lifecycle/Git locks do not fence all
// enqueue, retry, session, service, lease or external filesystem consumers.
// Until a reviewed admission protocol supplies that exclusion and complete
// retention evidence, no workspace close/cleanup is admitted. In particular,
// clean Git status, merged PRs, metadata and caller callbacks cannot override
// these blockers. Do not inspect or upload file contents to justify refusal.
export function executionWorkspacePreservationBlockingReasons(): string[] {
  return [
    "Workspace preservation is unproved: ignored material, nested/submodule/detached repositories, dirty or untracked files, and incomplete, unreadable or raced inventories must remain in place.",
    "Remote commit preservation is unproved: local ancestry, tracking refs and merged-PR delivery (including squash) do not establish fresh authoritative retention of every affected commit/ref.",
    "Workspace consumer safety is unproved: queued or scheduled retries, shared/session consumers, runtime/environment leases and external writers lack a complete native acquisition fence.",
  ];
}

// Mandatory at lifecycle and physical-cleanup boundaries, including direct
// service calls and retries of legacy closed rows. There is deliberately no
// proof parameter, feature flag, command option or unsafe fallback.
export function assertExecutionWorkspacePreservation(): void {
  throw conflict(
    "Execution workspace preservation preflight blocked close/cleanup",
    {
      code: "execution_workspace_preservation_unproved",
      blockingReasons: executionWorkspacePreservationBlockingReasons(),
    },
  );
}
