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

const DEFAULT_FRESHNESS_MS = 2 * 60 * 60 * 1000;

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invalid(reason: string): DurableWaitDecision {
  return { valid: false, reason, suppressibleFallback: false };
}

/** Trusted snapshot only; never reads a clock, fetches coverage, or changes a wait. */
export function evaluateDurableWait(facts: DurableWaitFacts, now: number): DurableWaitDecision {
  if (!finite(now) || !facts || (facts.mode !== "shadow" && facts.mode !== "enforce")) {
    return invalid("mode_off_or_unknown_facts");
  }
  const { issue, coverage, monitor, budget, competing } = facts;
  if (!issue || !coverage || !budget || !competing) return invalid("missing_facts");
  if (!nonempty(issue.id) || !nonempty(issue.companyId)
    || coverage.companyId !== issue.companyId || coverage.issueId !== issue.id) {
    return invalid("coverage_scope_mismatch");
  }
  if ((issue.status !== "in_progress" && issue.status !== "in_review")
    || issue.status !== coverage.armedStatus || !nonempty(issue.assigneeAgentId)
    || issue.assigneeAgentId !== coverage.armedAssigneeAgentId || issue.assigneeUserId !== null) {
    return invalid("armed_identity_changed");
  }
  const actor = coverage.registeredByActor;
  if (!actor || (actor.type !== "board" && actor.type !== "system") || !nonempty(actor.id)
    || coverage.sourceKind !== "github_pr" || !nonempty(coverage.serviceName)
    || !nonempty(coverage.externalRef) || coverage.serviceName === "AI provider quota") {
    return invalid("untrusted_coverage");
  }
  if (coverage.observationStatus !== "ok" || !nonempty(coverage.eventRevision)
    || coverage.eventRevision !== coverage.armedRevision) {
    return invalid("observation_changed_or_failed");
  }
  const freshnessMs = facts.freshnessMs === undefined ? DEFAULT_FRESHNESS_MS : facts.freshnessMs;
  if (!finite(freshnessMs) || freshnessMs <= 0 || !finite(coverage.observedAt)
    || coverage.observedAt > now || now - coverage.observedAt >= freshnessMs
    || !finite(coverage.expiresAt) || coverage.expiresAt <= now) {
    return invalid("coverage_stale_or_expired");
  }
  if (coverage.unresolvedActionableEventAt !== null) return invalid("actionable_event");
  if (competing.activeRun !== false || competing.queuedWake !== false || competing.queuedRun !== false
    || competing.scheduledRetry !== false || competing.pendingAgentInteraction !== false
    || competing.pendingAgentApproval !== false) {
    return invalid("competing_path_or_unknown");
  }
  if (!Number.isSafeInteger(budget.attemptCount) || budget.attemptCount < 0
    || !Number.isSafeInteger(budget.maxAttempts) || budget.maxAttempts <= 0
    || budget.attemptCount >= budget.maxAttempts
    || (budget.timeoutAt !== null && (!finite(budget.timeoutAt) || budget.timeoutAt <= now))) {
    return invalid("budget_unknown_or_exhausted");
  }
  const hardBound = Math.min(coverage.expiresAt, budget.timeoutAt ?? Infinity);
  if (monitor === null) {
    if (!finite(coverage.fallbackAt) || coverage.fallbackAt <= now || coverage.fallbackAt > hardBound) {
      return invalid("coverage_fallback_unbounded");
    }
    return { valid: true, reason: "bounded_coverage_wait", suppressibleFallback: false };
  }
  // An unknown/malformed present monitor must not fall through to coverage-only.
  if (!monitor || monitor.kind !== "external_service" || monitor.serviceName !== coverage.serviceName
    || monitor.externalRef !== coverage.externalRef || !finite(monitor.nextCheckAt)) {
    return invalid("monitor_unknown_or_mismatched");
  }
  if (monitor.nextCheckAt > now) {
    if (monitor.nextCheckAt > hardBound) return invalid("monitor_fallback_unbounded");
    return { valid: true, reason: "bounded_future_monitor", suppressibleFallback: false };
  }
  if (!finite(facts.backoffMs) || facts.backoffMs <= 0) return invalid("successor_delay_unknown");
  const candidate = now + facts.backoffMs;
  const successor = Math.min(candidate, hardBound);
  if (!finite(candidate) || !finite(successor) || successor <= now) return invalid("successor_not_future");
  return { valid: true, reason: "due_monitor_with_bounded_successor", suppressibleFallback: true };
}
