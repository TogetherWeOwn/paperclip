import type { Request, Response } from "express";
import {
  asObserverActor,
  checkObserverCeiling,
  parseObserverHeartbeatQuery,
  parseObserverIssuesQuery,
  parseObserverLiveQuery,
  projectObserverIssue,
  projectObserverRun,
  validateObserverScope,
} from "../services/observer-scope.js";

/**
 * Observer read handlers ([TOG-21648](/TOG/issues/TOG-21648)).
 *
 * Pure projections from read services — never the recovery-revalidating issue
 * GET handler. Each handler re-validates the observer ceiling (scope shape,
 * admitted company, non-sliding expiry) on the request, validates the bounded
 * query allowlist, calls ONLY the injected pure read deps, and returns the
 * allowlisted projection. There are no write-capable deps by construction:
 * recovery revalidation, scheduling and business-state writes cannot be
 * reached from here. Dependencies are injected so isolated tests can spy that
 * forbidden requests stop before mutation handlers and permitted reads issue
 * zero recovery/business-state writes.
 */

export type ObserverIssuesDeps = {
  listIssues: (
    companyId: string,
    filters: { status?: string[]; limit: number; offset: number; sortField?: "updated" | "id"; sortDir?: "asc" | "desc" },
  ) => Promise<unknown[]>;
  listActiveRecoveries: (
    companyId: string,
    issueIds: string[],
  ) => Promise<Map<string, unknown>>;
  listHandoffs: (
    companyId: string,
    issueIds: string[],
  ) => Promise<Map<string, unknown>>;
};

function deny(res: Response, code: string, error: string, status = 403) {
  res.status(status).json({ error, code });
}

function denyBadQuery(res: Response, error: string) {
  deny(res, "OBSERVER_INVALID_QUERY", error, 400);
}

/** Re-check the ceiling inside the handler so direct handler access is also gated. */
function ceilingFor(
  req: Request,
  kind: "issues" | "heartbeat-runs" | "live-runs",
  companyId: string,
): { ok: true } | { ok: false; response: { code: string; error: string; status: number } } {
  const check = checkObserverCeiling({
    actor: req.actor,
    method: req.method,
    path: `/api/companies/${companyId}/${kind}`,
  });
  if (!check || !check.ok) {
    const code = !check ? "OBSERVER_ROUTE_DENIED" : check.code;
    const error = !check ? "Observer scope denies this request" : check.error;
    return { ok: false, response: { code, error, status: 403 } };
  }
  return { ok: true };
}

export async function handleObserverIssuesList(
  req: Request,
  res: Response,
  companyId: string,
  deps: ObserverIssuesDeps,
): Promise<void> {
  const ceiling = ceilingFor(req, "issues", companyId);
  if (!ceiling.ok) {
    deny(res, ceiling.response.code, ceiling.response.error, ceiling.response.status);
    return;
  }
  const parsed = parseObserverIssuesQuery(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    denyBadQuery(res, parsed.error);
    return;
  }
  // Pure reads only. `listIssues` is the issue read service (no recovery
  // revalidation: that lives in the standard GET handler, which this path
  // never enters). Recovery/handoff joins are read-only maps.
  const rows = await deps.listIssues(companyId, parsed.filters);
  const ids = rows
    .map((row) =>
      typeof row === "object" && row !== null
        ? (row as Record<string, unknown>).id
        : null,
    )
    .filter((id): id is string => typeof id === "string");
  const [recoveries, handoffs] = await Promise.all([
    deps.listActiveRecoveries(companyId, ids),
    deps.listHandoffs(companyId, ids),
  ]);
  res.json(
    rows.map((row) => {
      const id =
        typeof row === "object" && row !== null
          ? (row as Record<string, unknown>).id
          : null;
      const withJoins =
        typeof row === "object" && row !== null && typeof id === "string"
          ? {
              ...(row as Record<string, unknown>),
              activeRecoveryAction: recoveries.get(id) ?? null,
              successfulRunHandoff: handoffs.get(id) ?? null,
            }
          : row;
      return projectObserverIssue(withJoins);
    }),
  );
}

export type ObserverHeartbeatDeps = {
  listHeartbeatRuns: (
    companyId: string,
    agentId: string | undefined,
    limit: number,
    options: { summary: boolean },
  ) => Promise<unknown[]>;
};

export async function handleObserverHeartbeatRuns(
  req: Request,
  res: Response,
  companyId: string,
  deps: ObserverHeartbeatDeps,
): Promise<void> {
  const ceiling = ceilingFor(req, "heartbeat-runs", companyId);
  if (!ceiling.ok) {
    deny(res, ceiling.response.code, ceiling.response.error, ceiling.response.status);
    return;
  }
  const parsed = parseObserverHeartbeatQuery(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    denyBadQuery(res, parsed.error);
    return;
  }
  const rows = await deps.listHeartbeatRuns(
    companyId,
    parsed.filters.agentId,
    parsed.filters.limit,
    { summary: parsed.filters.summary },
  );
  // Heartbeat list rows carry summarized context/result columns; the observer
  // projection keeps status/time/retry metadata plus the issue reference and
  // drops result summaries, usage, log and session fields.
  res.json(
    (rows as unknown[]).map((row) => {
      const contextIssueId =
        typeof row === "object" && row !== null
          ? (row as Record<string, unknown>).contextIssueId
          : null;
      return projectObserverRun(
        row,
        typeof contextIssueId === "string" ? contextIssueId : null,
      );
    }),
  );
}

export type ObserverLiveDeps = {
  queryLiveRuns: (
    companyId: string,
    filters: { limit: number; minCount: number },
  ) => Promise<unknown[]>;
  getExecutionProjections: (
    companyId: string,
    runIds: string[],
  ) => Promise<Map<string, unknown>>;
};

export async function handleObserverLiveRuns(
  req: Request,
  res: Response,
  companyId: string,
  deps: ObserverLiveDeps,
): Promise<void> {
  const ceiling = ceilingFor(req, "live-runs", companyId);
  if (!ceiling.ok) {
    deny(res, ceiling.response.code, ceiling.response.error, ceiling.response.status);
    return;
  }
  const parsed = parseObserverLiveQuery(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    denyBadQuery(res, parsed.error);
    return;
  }
  const rows = await deps.queryLiveRuns(companyId, parsed.filters);
  const ids = rows
    .map((row) =>
      typeof row === "object" && row !== null
        ? (row as Record<string, unknown>).id
        : null,
    )
    .filter((id): id is string => typeof id === "string");
  // The execution projection is the sanitized live/queued/retrying safety
  // join (phase/label/cause/retry/attempt); it forwards no snapshots.
  const projections = await deps.getExecutionProjections(companyId, ids);
  res.json(
    rows.map((row) => {
      const id =
        typeof row === "object" && row !== null
          ? (row as Record<string, unknown>).id
          : null;
      const issueId =
        typeof row === "object" && row !== null
          ? (row as Record<string, unknown>).issueId
          : null;
      const withJoins =
        typeof row === "object" && row !== null
          ? {
              ...(row as Record<string, unknown>),
              execution:
                typeof id === "string" ? (projections.get(id) ?? null) : null,
            }
          : row;
      return projectObserverRun(
        withJoins,
        typeof issueId === "string" ? issueId : null,
      );
    }),
  );
}

/** Exported for route wiring: true when this request must take the observer path. */
export function isObserverRequest(req: Request): boolean {
  return asObserverActor(req.actor) !== null;
}

export { validateObserverScope };
