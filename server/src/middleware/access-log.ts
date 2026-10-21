// Minimal retained access log: one JSON line per HTTP request.
//
// Unlike the pino-http lines (which silence noisy success routes to keep
// stdout readable), this log records EVERY request with no silencing, so
// request counts around an incident window stay reconstructible after the
// container that served them is gone. Each line carries only timestamp,
// method, redacted path, matched route pattern, status, duration, and the
// pino request id for correlation with server.log. No headers, no bodies,
// no query strings (the shared requestLogUrl policy already drops those).
//
// Mounted immediately after httpLogger so `id` matches the pino-http lines.

import type { NextFunction, Request, Response } from "express";
import { requestLogUrl } from "./http-log-policy.js";
import { getFileLogging } from "./file-logging.js";
import type { RotatingFileSink } from "./rotating-file-sink.js";

export interface AccessLogLine {
  /** ISO timestamp of response finish. */
  t: string;
  /** HTTP method. */
  m: string;
  /** Redacted request path (shared policy with pino-http lines). */
  p: string;
  /** Response status code. */
  s: number;
  /** Wall time from middleware entry to finish, milliseconds, 0.1 precision. */
  d: number;
  /** pino-http request id for correlation, when assigned. */
  id: string | null;
  /** Matched Express route pattern, when the router matched one. */
  r?: string;
}

function requestIdOf(req: Request): string | null {
  const id = (req as unknown as { id?: unknown }).id;
  if (typeof id === "string") return id;
  // pino-http assigns incrementing numeric ids by default.
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

function routePathOf(req: Request): string | undefined {
  const route = (req as unknown as { route?: { path?: unknown } }).route;
  return typeof route?.path === "string" ? route.path : undefined;
}

export function formatAccessLogLine(args: {
  finishedAt: Date;
  method: string;
  originalUrl: unknown;
  url: unknown;
  statusCode: number;
  durationMs: number;
  requestId: string | null;
  routePath?: string;
}): string {
  const line: AccessLogLine = {
    t: args.finishedAt.toISOString(),
    m: args.method,
    p: requestLogUrl({ method: args.method, originalUrl: args.originalUrl, url: args.url }),
    s: args.statusCode,
    d: Math.round(args.durationMs * 10) / 10,
    id: args.requestId,
  };
  if (args.routePath !== undefined) {
    line.r = args.routePath;
  }
  return `${JSON.stringify(line)}\n`;
}

export function createAccessLogger(
  sink: RotatingFileSink | null,
): (req: Request, res: Response, next: NextFunction) => void {
  return function accessLogger(req: Request, res: Response, next: NextFunction): void {
    if (!sink) {
      next();
      return;
    }
    // Snapshot the request line at entry: mounted routers strip req.url
    // (e.g. /api/health reads as "/" by finish time), so reading it in the
    // finish handler would log the mount-relative remainder instead of the
    // true path. Only the outcome (status, route, duration) is read late.
    const start = process.hrtime.bigint();
    const method = req.method;
    const originalUrl = req.originalUrl;
    const url = req.url;
    res.once("finish", () => {
      try {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        sink.write(
          formatAccessLogLine({
            finishedAt: new Date(),
            method,
            originalUrl,
            url,
            statusCode: res.statusCode,
            durationMs,
            requestId: requestIdOf(req),
            routePath: routePathOf(req),
          }),
        );
      } catch {
        // Access logging must never break responses.
      }
    });
    next();
  };
}

/** Default middleware writing to the process-wide access sink (no-op when disabled). */
export function accessLogger(req: Request, res: Response, next: NextFunction): void {
  createAccessLogger(getFileLogging().accessSink)(req, res, next);
}
