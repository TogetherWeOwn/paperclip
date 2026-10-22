// Acceptance-owned structural contract. Times are epoch milliseconds; null is known absence.
// These facts come from trusted server snapshots, never directly from a registration body.
export interface DurableWaitFacts {
  mode: "off" | "shadow" | "enforce";
  freshnessMs?: number;
  issue: {
    id: string;
    companyId: string;
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  };
  coverage: {
    issueId: string;
    companyId: string;
    serviceName: string;
    externalRef: string;
    sourceKind: string;
    registeredByActor: { type: "board" | "system"; id: string };
    eventRevision: string;
    armedRevision: string;
    observationStatus: "ok" | "error";
    observedAt: number;
    expiresAt: number;
    armedAssigneeAgentId: string;
    armedStatus: string;
    fallbackAt: number | null;
    unresolvedActionableEventAt: number | null;
  } | null;
  monitor: {
    kind: "external_service";
    serviceName: string;
    externalRef: string;
    nextCheckAt: number;
  } | null;
  // Explicit policy budget is required even when monitor is null.
  budget: { attemptCount: number; maxAttempts: number; timeoutAt: number | null };
  backoffMs?: number;
  competing: {
    activeRun: boolean;
    queuedWake: boolean;
    queuedRun: boolean;
    scheduledRetry: boolean;
    pendingAgentInteraction: boolean;
    pendingAgentApproval: boolean;
  };
}

export interface DurableWaitDecision {
  valid: boolean;
  reason: string;
  suppressibleFallback: boolean;
}

export const NOW = Date.parse("2026-10-22T12:00:00.000Z");
export const HOUR = 60 * 60 * 1000;
export const COMPANY = "10000000-0000-4000-8000-000000000001";
export const ISSUE = "20000000-0000-4000-8000-000000000001";
export const AGENT = "30000000-0000-4000-8000-000000000001";
export const OTHER_COMPANY = "10000000-0000-4000-8000-000000000002";
export const OTHER_ISSUE = "20000000-0000-4000-8000-000000000002";
export const OTHER_AGENT = "30000000-0000-4000-8000-000000000002";
export const EXTERNAL_REF = "https://github.com/example/project/pull/42";

export function waitFacts(): DurableWaitFacts {
  return {
    mode: "enforce",
    issue: { id: ISSUE, companyId: COMPANY, status: "in_review", assigneeAgentId: AGENT, assigneeUserId: null },
    coverage: {
      issueId: ISSUE,
      companyId: COMPANY,
      serviceName: "github-pr-controller",
      externalRef: EXTERNAL_REF,
      sourceKind: "github_pr",
      registeredByActor: { type: "board", id: "board-user" },
      eventRevision: "head-a:checks-pending:review-none:mergeable",
      armedRevision: "head-a:checks-pending:review-none:mergeable",
      observationStatus: "ok",
      observedAt: NOW - HOUR,
      expiresAt: NOW + 12 * HOUR,
      armedAssigneeAgentId: AGENT,
      armedStatus: "in_review",
      fallbackAt: NOW + HOUR,
      unresolvedActionableEventAt: null,
    },
    monitor: { kind: "external_service", serviceName: "github-pr-controller", externalRef: EXTERNAL_REF, nextCheckAt: NOW + HOUR },
    budget: { attemptCount: 0, maxAttempts: 3, timeoutAt: null },
    backoffMs: HOUR,
    competing: {
      activeRun: false,
      queuedWake: false,
      queuedRun: false,
      scheduledRetry: false,
      pendingAgentInteraction: false,
      pendingAgentApproval: false,
    },
  };
}
