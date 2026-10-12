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
const CORRELATION_ID_RE = /^[A-Za-z0-9._:/-]+$/;

const storage = new AsyncLocalStorage<RequestAuditContext>();

export function getRequestAuditContext(): RequestAuditContext | undefined {
  return storage.getStore();
}

export function runWithRequestAuditContext<T>(
  context: RequestAuditContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 32;
    out += code <= 0x1f || code === 0x7f ? " " : ch;
  }
  return out;
}

function readReason(req: Request): string | null {
  const raw = req.header(CHANGE_REASON_HEADER);
  if (!raw) return null;
  const cleaned = stripControlChars(raw).trim().slice(0, MAX_REASON_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

function readCorrelationId(req: Request): string | null {
  const raw = req.header(CORRELATION_ID_HEADER)?.trim();
  if (
    !raw ||
    raw.length > MAX_CORRELATION_ID_LENGTH ||
    !CORRELATION_ID_RE.test(raw)
  )
    return null;
  return raw;
}

export function buildRequestAuditContext(
  req: Request,
): RequestAuditContext | null {
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
 * Merge request provenance into activity details. `details.audit` is a reserved
 * key: any caller-supplied value is stripped and replaced with the current
 * request context, or removed when there is no context, so callers can never
 * forge provenance. The merged block is redacted downstream by
 * `redactActivityDetails` together with the rest of `details`, because the
 * free-text reason is caller data and may contain secrets.
 */
export function withRequestAuditDetails(
  details: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const context = storage.getStore();
  const base: Record<string, unknown> = details ? { ...details } : {};
  if (AUDIT_DETAILS_KEY in base) delete base[AUDIT_DETAILS_KEY];
  if (!context) return details ? base : details;
  const audit: Record<string, string> = { actorSource: context.actorSource };
  if (context.keyId) audit.keyId = context.keyId;
  if (context.reason) audit.reason = context.reason;
  if (context.correlationId) audit.correlationId = context.correlationId;
  return { ...base, [AUDIT_DETAILS_KEY]: audit };
}

/**
 * Run detached background work (fire-and-forget agent runs) outside the
 * request audit context, so rows written by agent/system actors are not stamped
 * with the waking human's provenance. Request-synchronous writes keep the stamp.
 */
export function runOutsideRequestAuditContext<T>(fn: () => T): T {
  return storage.exit(fn);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ]),
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
