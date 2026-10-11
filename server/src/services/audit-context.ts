import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Request-scoped provenance for activity rows. `actor_id` alone cannot tell a
 * browser session from a host producer that shares the same board identity, so
 * every activity row written while handling an authenticated request carries
 * how the caller authenticated (`actorSource`), which credential row it used
 * (`keyId`, never the secret) and an optional caller-supplied reason.
 */
export interface RequestAuditContext {
  actorSource: string;
  keyId: string | null;
  reason: string | null;
  correlationId: string | null;
}

export const CHANGE_REASON_HEADER = "x-paperclip-change-reason";
export const CORRELATION_ID_HEADER = "x-paperclip-correlation-id";

const MAX_REASON_LENGTH = 256;
const MAX_CORRELATION_ID_LENGTH = 128;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const CORRELATION_ID_RE = /^[A-Za-z0-9._:/-]+$/;

const storage = new AsyncLocalStorage<RequestAuditContext>();

export function getRequestAuditContext(): RequestAuditContext | undefined {
  return storage.getStore();
}

export function runWithRequestAuditContext<T>(context: RequestAuditContext, fn: () => T): T {
  return storage.run(context, fn);
}

function readReason(req: Request): string | null {
  const raw = req.header(CHANGE_REASON_HEADER);
  if (!raw) return null;
  const cleaned = raw.replace(CONTROL_CHARS_RE, " ").trim().slice(0, MAX_REASON_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

function readCorrelationId(req: Request): string | null {
  const raw = req.header(CORRELATION_ID_HEADER)?.trim();
  if (!raw || raw.length > MAX_CORRELATION_ID_LENGTH || !CORRELATION_ID_RE.test(raw)) return null;
  return raw;
}

export function buildRequestAuditContext(req: Request): RequestAuditContext | null {
  const actor = req.actor;
  if (!actor || actor.type === "none") return null;
  return {
    actorSource: actor.source ?? "unknown",
    keyId: actor.keyId ?? null,
    reason: readReason(req),
    correlationId: readCorrelationId(req),
  };
}

/** Mount after actor resolution so `req.actor` is final. */
export function auditContextMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const context = buildRequestAuditContext(req);
    if (!context) {
      next();
      return;
    }
    storage.run(context, next);
  };
}

/** Details key under which the request provenance is stored on an activity row. */
export const AUDIT_DETAILS_KEY = "audit";

/**
 * Merge request provenance into already-redacted activity details. Applied
 * after redaction on purpose: the values are an enum, a credential row id and
 * a bounded reason, not caller data. An explicit `audit` key set by the caller
 * wins.
 */
export function withRequestAuditDetails(
  details: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const context = storage.getStore();
  if (!context) return details;
  if (details && AUDIT_DETAILS_KEY in details) return details;
  const audit: Record<string, string> = { actorSource: context.actorSource };
  if (context.keyId) audit.keyId = context.keyId;
  if (context.reason) audit.reason = context.reason;
  if (context.correlationId) audit.correlationId = context.correlationId;
  return { ...(details ?? {}), [AUDIT_DETAILS_KEY]: audit };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Key-order-independent sha256 of a JSON value, for before/after change evidence. */
export function hashJsonValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value ?? null)))
    .digest("hex");
}
