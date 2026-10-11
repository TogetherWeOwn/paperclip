/**
 * Native bounded read-only observation scope for the held cap-zero flow
 * ([TOG-21648](/TOG/issues/TOG-21648)).
 *
 * Mandatory security specification: CISO verdict
 * `ciso-read-only-boundary` revision `a983eaa4-7311-4d05-b812-f532352858ad`,
 * admitted by the COO in `admission-decision` revision
 * `b7c8b124-7db1-4fac-b960-e9fc520215f4`. This module is the immutable
 * deny-by-default ceiling; it is pure (no DB, no writes) so it can be
 * unit-tested in isolation.
 *
 * Ceiling, in one place:
 * - one company (`OBSERVER_SCOPE_COMPANY_ID`), one purpose
 *   (`held-cap-zero-observation`), non-sliding validity of at most 35 minutes;
 * - ONLY `GET /api/companies/{companyId}/issues`,
 *   `GET /api/companies/{companyId}/heartbeat-runs` and
 *   `GET /api/companies/{companyId}/live-runs`, with the bounded query
 *   allowlists below (complete pagination preserved);
 * - every other verb (including HEAD/OPTIONS), path, company, key-management,
 *   secret, log, runtime, workspace or single-issue read is denied;
 * - enforced before generic actor permissions; caller headers and later
 *   principal-role elevation cannot widen it;
 * - unknown/malformed scopes, expired/revoked tokens and invalid queries fail
 *   closed and never fall back to `standard` scope or cached authority.
 *
 * Permitted auth/audit bookkeeping (explicit): the auth middleware's existing
 * per-request `agent_api_keys.lastUsedAt` touch and its auth-failure audit
 * rows (`auth.agent_jwt_run_header_mismatch`,
 * `auth.agent_key_missing_responsible_user`). Permitted observer reads perform
 * zero recovery, scheduling or business-state writes: the observer handlers
 * call only the pure read services listed in `../routes/observer.ts` and
 * never the recovery-revalidating issue GET path.
 *
 * There is no issuance endpoint in this admission. Observer scopes exist only
 * as synthetic test fixtures until a later authorized issuance act.
 */
import {
  ISSUE_STATUSES,
  isUuidLike,
  observerAgentKeyScopeSchema,
  type ObserverAgentKeyScope,
} from "@paperclipai/shared";

/** The single admitted company for the held cap-zero observation. */
export const OBSERVER_SCOPE_COMPANY_ID = "ef993a7e-5ea7-445f-ba88-27a6a2690c3a";

/** Observer query bounds. */
export const OBSERVER_ISSUES_LIMIT_DEFAULT = 500;
export const OBSERVER_ISSUES_LIMIT_MAX = 1000;
export const OBSERVER_HEARTBEAT_LIMIT_DEFAULT = 200;
export const OBSERVER_HEARTBEAT_LIMIT_MAX = 1000;
export const OBSERVER_LIVE_LIMIT_DEFAULT = 50;
export const OBSERVER_LIVE_LIMIT_MAX = 50;
export const OBSERVER_LIVE_MIN_COUNT_MAX = 50;

/** Route templates an observer credential may read (GET only). */
export type ObserverRouteKind = "issues" | "heartbeat-runs" | "live-runs";

const OBSERVER_ROUTE_PATTERN =
  /^\/api\/companies\/([^/]+)\/(issues|heartbeat-runs|live-runs)\/?$/;

export function matchObserverRoute(path: string): {
  kind: ObserverRouteKind;
  companyId: string;
} | null {
  const match = OBSERVER_ROUTE_PATTERN.exec(path);
  if (!match) return null;
  return { kind: match[2] as ObserverRouteKind, companyId: match[1] };
}

export type ObserverActor = {
  type: "agent";
  companyId: string;
  keyScope: ObserverAgentKeyScope;
};

export function asObserverActor(actor: unknown): ObserverActor | null {
  if (
    typeof actor !== "object" ||
    actor === null ||
    (actor as { type?: unknown }).type !== "agent"
  ) {
    return null;
  }
  const candidate = actor as {
    type: "agent";
    companyId?: unknown;
    keyScope?: unknown;
  };
  if (typeof candidate.companyId !== "string") return null;
  if (
    typeof candidate.keyScope !== "object" ||
    candidate.keyScope === null ||
    (candidate.keyScope as { kind?: unknown }).kind !== "observer"
  ) {
    return null;
  }
  return {
    type: "agent",
    companyId: candidate.companyId,
    keyScope: candidate.keyScope as ObserverAgentKeyScope,
  };
}

export type ObserverScopeCheck =
  | { ok: true; scope: ObserverAgentKeyScope }
  | { ok: false; code: "INVALID_OBSERVER_SCOPE" | "OBSERVER_SCOPE_EXPIRED"; error: string };

/**
 * Validate an observer scope: shape (including the at-most-35-minute total
 * window), the fixed admitted company, and the non-sliding validity window
 * against `now`. Call on every request; never cache the result.
 */
export function validateObserverScope(
  scope: unknown,
  now: Date = new Date(),
): ObserverScopeCheck {
  const parsed = observerAgentKeyScopeSchema.safeParse(scope);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_OBSERVER_SCOPE",
      error: "Observer scope is unknown or malformed",
    };
  }
  const valid = parsed.data;
  if (valid.companyId !== OBSERVER_SCOPE_COMPANY_ID) {
    return {
      ok: false,
      code: "INVALID_OBSERVER_SCOPE",
      error: "Observer scope company is outside this admission",
    };
  }
  const nowMs = now.getTime();
  const issuedMs = Date.parse(valid.issuedAt);
  const expiresMs = Date.parse(valid.expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    return {
      ok: false,
      code: "INVALID_OBSERVER_SCOPE",
      error: "Observer scope timestamps are invalid",
    };
  }
  if (nowMs < issuedMs || nowMs >= expiresMs) {
    return {
      ok: false,
      code: "OBSERVER_SCOPE_EXPIRED",
      error: "Observer scope is expired or not yet valid",
    };
  }
  return { ok: true, scope: valid };
}

export type ObserverCeilingCheck =
  | { ok: true; kind: ObserverRouteKind; companyId: string; scope: ObserverAgentKeyScope }
  | { ok: false; code: "OBSERVER_METHOD_DENIED" | "OBSERVER_ROUTE_DENIED" | "OBSERVER_COMPANY_DENIED" | "INVALID_OBSERVER_SCOPE" | "OBSERVER_SCOPE_EXPIRED"; error: string };

/**
 * The deny-by-default ceiling. Runs before generic actor permissions on every
 * request carrying an observer credential, including direct API access.
 * Role elevation, instance-admin status and caller headers are deliberately
 * not consulted: they cannot widen this ceiling.
 */
export function checkObserverCeiling(input: {
  actor: unknown;
  method: string;
  path: string;
  now?: Date;
}): ObserverCeilingCheck | null {
  const observer = asObserverActor(input.actor);
  if (!observer) return null;
  if (input.method !== "GET") {
    return {
      ok: false,
      code: "OBSERVER_METHOD_DENIED",
      error: "Observer scope permits only GET",
    };
  }
  const route = matchObserverRoute(input.path);
  if (!route) {
    return {
      ok: false,
      code: "OBSERVER_ROUTE_DENIED",
      error: "Observer scope denies this path",
    };
  }
  const scopeCheck = validateObserverScope(observer.keyScope, input.now);
  if (!scopeCheck.ok) return scopeCheck;
  if (
    route.companyId !== scopeCheck.scope.companyId ||
    route.companyId !== observer.companyId ||
    route.companyId !== OBSERVER_SCOPE_COMPANY_ID
  ) {
    return {
      ok: false,
      code: "OBSERVER_COMPANY_DENIED",
      error: "Observer scope denies this company",
    };
  }
  return {
    ok: true,
    kind: route.kind,
    companyId: route.companyId,
    scope: scopeCheck.scope,
  };
}

function unknownQueryKeys(
  query: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | null {
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function parseBoundedInt(
  raw: unknown,
  input: { min: number; max: number },
): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < input.min || parsed > input.max) {
    return null;
  }
  return parsed;
}

export type ObserverIssuesFilters = {
  status?: string[];
  limit: number;
  offset: number;
  sortField?: "updated" | "id";
  sortDir?: "asc" | "desc";
};

const OBSERVER_ISSUES_QUERY_KEYS = new Set(["status", "limit", "offset", "sortField", "sortDir"]);

export type ObserverQueryCheck<T> =
  | { ok: true; filters: T }
  | { ok: false; error: string };

/**
 * Bounded issue-list query. Accepts exactly the paged status reads the pinned
 * cap-zero consumer performs (`status`, `limit`, `offset`, `sortField`,
 * `sortDir`); every other key is an invalid query. Unlike the lenient
 * standard path, out-of-range values are rejected rather than clamped.
 */
export function parseObserverIssuesQuery(
  query: Record<string, unknown>,
): ObserverQueryCheck<ObserverIssuesFilters> {
  const unknown = unknownQueryKeys(query, OBSERVER_ISSUES_QUERY_KEYS);
  if (unknown) {
    return { ok: false, error: `Observer issues read denies query parameter '${unknown}'` };
  }
  let status: string[] | undefined;
  const rawStatus = query.status;
  if (rawStatus !== undefined) {
    const values = Array.isArray(rawStatus) ? rawStatus : [rawStatus];
    const split = values.flatMap((value) =>
      typeof value === "string" ? value.split(",") : [],
    );
    if (split.length === 0 || split.some((value) => typeof value !== "string")) {
      return { ok: false, error: "Observer issues read requires valid status values" };
    }
    const normalized = split.map((value) => value.trim()).filter(Boolean);
    if (
      normalized.length === 0 ||
      normalized.some((value) => !(ISSUE_STATUSES as readonly string[]).includes(value))
    ) {
      return { ok: false, error: "Observer issues read requires valid status values" };
    }
    status = [...new Set(normalized)];
  }
  let limit = OBSERVER_ISSUES_LIMIT_DEFAULT;
  if (query.limit !== undefined) {
    const parsed = parseBoundedInt(query.limit, { min: 1, max: OBSERVER_ISSUES_LIMIT_MAX });
    if (parsed === null) {
      return { ok: false, error: `Observer issues read requires limit 1-${OBSERVER_ISSUES_LIMIT_MAX}` };
    }
    limit = parsed;
  }
  let offset = 0;
  if (query.offset !== undefined) {
    const parsed = parseBoundedInt(query.offset, { min: 0, max: Number.MAX_SAFE_INTEGER });
    if (parsed === null) {
      return { ok: false, error: "Observer issues read requires a non-negative integer offset" };
    }
    offset = parsed;
  }
  let sortField: ObserverIssuesFilters["sortField"];
  if (query.sortField !== undefined) {
    if (query.sortField !== "updated" && query.sortField !== "id") {
      return { ok: false, error: "Observer issues read requires sortField 'updated' or 'id'" };
    }
    sortField = query.sortField;
  }
  let sortDir: ObserverIssuesFilters["sortDir"];
  if (query.sortDir !== undefined) {
    if (query.sortDir !== "asc" && query.sortDir !== "desc") {
      return { ok: false, error: "Observer issues read requires sortDir 'asc' or 'desc'" };
    }
    sortDir = query.sortDir;
  }
  return { ok: true, filters: { status, limit, offset, sortField, sortDir } };
}

export type ObserverHeartbeatFilters = {
  agentId?: string;
  limit: number;
  summary: boolean;
};

const OBSERVER_HEARTBEAT_QUERY_KEYS = new Set(["agentId", "limit", "summary"]);

export function parseObserverHeartbeatQuery(
  query: Record<string, unknown>,
): ObserverQueryCheck<ObserverHeartbeatFilters> {
  const unknown = unknownQueryKeys(query, OBSERVER_HEARTBEAT_QUERY_KEYS);
  if (unknown) {
    return { ok: false, error: `Observer heartbeat read denies query parameter '${unknown}'` };
  }
  let agentId: string | undefined;
  if (query.agentId !== undefined) {
    if (typeof query.agentId !== "string" || !isUuidLike(query.agentId.trim())) {
      return { ok: false, error: "Observer heartbeat read requires a UUID agentId" };
    }
    agentId = query.agentId.trim();
  }
  let limit = OBSERVER_HEARTBEAT_LIMIT_DEFAULT;
  if (query.limit !== undefined) {
    const parsed = parseBoundedInt(query.limit, { min: 1, max: OBSERVER_HEARTBEAT_LIMIT_MAX });
    if (parsed === null) {
      return { ok: false, error: `Observer heartbeat read requires limit 1-${OBSERVER_HEARTBEAT_LIMIT_MAX}` };
    }
    limit = parsed;
  }
  let summary = false;
  if (query.summary !== undefined) {
    if (query.summary === "true" || query.summary === "1") summary = true;
    else if (query.summary === "false" || query.summary === "0") summary = false;
    else return { ok: false, error: "Observer heartbeat read requires summary true or false" };
  }
  return { ok: true, filters: { agentId, limit, summary } };
}

export type ObserverLiveFilters = {
  limit: number;
  minCount: number;
};

const OBSERVER_LIVE_QUERY_KEYS = new Set(["limit", "minCount"]);

export function parseObserverLiveQuery(
  query: Record<string, unknown>,
): ObserverQueryCheck<ObserverLiveFilters> {
  const unknown = unknownQueryKeys(query, OBSERVER_LIVE_QUERY_KEYS);
  if (unknown) {
    return { ok: false, error: `Observer live read denies query parameter '${unknown}'` };
  }
  // Strict where the standard path is lenient: invalid values fail closed
  // instead of falling back to defaults.
  let limit = OBSERVER_LIVE_LIMIT_DEFAULT;
  if (query.limit !== undefined) {
    const parsed = parseBoundedInt(query.limit, { min: 1, max: OBSERVER_LIVE_LIMIT_MAX });
    if (parsed === null) {
      return { ok: false, error: `Observer live read requires limit 1-${OBSERVER_LIVE_LIMIT_MAX}` };
    }
    limit = parsed;
  }
  let minCount = 0;
  if (query.minCount !== undefined) {
    const parsed = parseBoundedInt(query.minCount, { min: 0, max: OBSERVER_LIVE_MIN_COUNT_MAX });
    if (parsed === null) {
      return { ok: false, error: `Observer live read requires minCount 0-${OBSERVER_LIVE_MIN_COUNT_MAX}` };
    }
    minCount = parsed;
  }
  return { ok: true, filters: { limit, minCount } };
}

/**
 * Allowlist projection: keep documented needed keys that are present, drop
 * everything else (context snapshots, run outputs, env values, evidence
 * blobs, free-text summaries). Pick-if-present keeps the projection robust to
 * service shape drift: missing keys are omitted, never fabricated.
 */
export function pickPresent<T extends Record<string, unknown>>(
  row: unknown,
  allowlist: readonly string[],
): Partial<T> {
  const output: Record<string, unknown> = {};
  if (typeof row !== "object" || row === null) return output as Partial<T>;
  const source = row as Record<string, unknown>;
  for (const key of allowlist) {
    if (Object.hasOwn(source, key)) output[key] = source[key];
  }
  return output as Partial<T>;
}

/** Issue identity/status plus sanitized safety references. */
export const OBSERVER_ISSUE_FIELDS = [
  "id",
  "identifier",
  "title",
  "status",
  "priority",
  "projectId",
  "parentId",
  "assigneeAgentId",
  "assigneeUserId",
  "createdAt",
  "updatedAt",
] as const;

/** Active-recovery safety join without evidence/fingerprint/policy blobs. */
export const OBSERVER_RECOVERY_ACTION_FIELDS = [
  "id",
  "sourceIssueId",
  "recoveryIssueId",
  "kind",
  "status",
  "ownerType",
  "ownerAgentId",
  "ownerUserId",
  "cause",
  "attemptCount",
  "maxAttempts",
  "nextAction",
  "createdAt",
  "updatedAt",
] as const;

/** Successful-run handoff join without the free-text progress summary. */
export const OBSERVER_HANDOFF_FIELDS = [
  "state",
  "required",
  "hasLiveContinuation",
  "liveRunId",
  "sourceRunId",
  "correctiveRunId",
  "assigneeAgentId",
  "createdAt",
] as const;

/** Run status/time/retry metadata plus the sanitized issue reference. */
export const OBSERVER_RUN_FIELDS = [
  "id",
  "companyId",
  "agentId",
  "status",
  "runtimeMode",
  "invocationSource",
  "triggerDetail",
  "errorCode",
  "retryOfRunId",
  "processLossRetryCount",
  "scheduledRetryAt",
  "scheduledRetryAttempt",
  "scheduledRetryReason",
  "continuationAttempt",
  "livenessState",
  "livenessReason",
  "lastUsefulActionAt",
  "lastOutputAt",
  "startedAt",
  "finishedAt",
  "createdAt",
  "updatedAt",
] as const;

export function projectObserverIssue(row: unknown): Record<string, unknown> {
  const issue = pickPresent<Record<string, unknown>>(row, OBSERVER_ISSUE_FIELDS);
  const output: Record<string, unknown> = { ...issue };
  if (typeof row === "object" && row !== null) {
    const source = row as Record<string, unknown>;
    if (source.activeRecoveryAction && typeof source.activeRecoveryAction === "object") {
      output.activeRecoveryAction = pickPresent(
        source.activeRecoveryAction,
        OBSERVER_RECOVERY_ACTION_FIELDS,
      );
    } else if (Object.hasOwn(source, "activeRecoveryAction")) {
      output.activeRecoveryAction = null;
    }
    if (source.successfulRunHandoff && typeof source.successfulRunHandoff === "object") {
      output.successfulRunHandoff = pickPresent(
        source.successfulRunHandoff,
        OBSERVER_HANDOFF_FIELDS,
      );
    } else if (Object.hasOwn(source, "successfulRunHandoff")) {
      output.successfulRunHandoff = null;
    }
  }
  return output;
}

export function projectObserverRun(
  row: unknown,
  issueId: string | null = null,
): Record<string, unknown> {
  const run = pickPresent<Record<string, unknown>>(row, OBSERVER_RUN_FIELDS);
  if (issueId) run.issueId = issueId;
  else if (
    typeof row === "object" &&
    row !== null &&
    typeof (row as Record<string, unknown>).contextIssueId === "string"
  ) {
    run.issueId = (row as Record<string, unknown>).contextIssueId;
  }
  // The execution projection is already a sanitized diagnostic join
  // (phase/label/cause/retry/attempt); forward it, never raw snapshots.
  if (
    typeof row === "object" &&
    row !== null &&
    typeof (row as Record<string, unknown>).execution === "object" &&
    (row as Record<string, unknown>).execution !== null
  ) {
    run.execution = (row as Record<string, unknown>).execution;
  }
  return run;
}
