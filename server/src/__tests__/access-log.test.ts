import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createAccessLogger, formatAccessLogLine } from "../middleware/access-log.js";
import { RotatingFileSink } from "../middleware/rotating-file-sink.js";

const dirs: string[] = [];
const sinks: RotatingFileSink[] = [];

afterEach(() => {
  while (sinks.length > 0) sinks.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function accessSink(): { sink: RotatingFileSink; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "access-log-test-"));
  dirs.push(dir);
  const sink = new RotatingFileSink({
    dir,
    filename: "access.log",
    maxBytes: 1024 * 1024,
    maxFiles: 2,
  });
  sinks.push(sink);
  return { sink, dir };
}

function fakeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    method: "GET",
    originalUrl: "/api/health",
    url: "/api/health",
    ...overrides,
  } as unknown as Request;
}

function fakeRes(statusCode = 200): Response {
  const res = new EventEmitter() as unknown as Record<string, unknown>;
  res.statusCode = statusCode;
  return res as unknown as Response;
}

function runThrough(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
  res: Response,
): void {
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  expect(nextCalled).toBe(true);
  (res as unknown as EventEmitter).emit("finish");
}

function readLines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(dir, "access.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("formatAccessLogLine", () => {
  it("emits the minimal forensics shape", () => {
    const line = JSON.parse(
      formatAccessLogLine({
        finishedAt: new Date("2026-10-20T01:56:00.000Z"),
        method: "POST",
        originalUrl: "/api/companies/acme/issues",
        url: "/api/companies/acme/issues",
        statusCode: 201,
        durationMs: 12.34,
        requestId: "req-1",
        routePath: "/api/companies/:id/issues",
      }),
    );
    expect(line).toEqual({
      t: "2026-10-20T01:56:00.000Z",
      m: "POST",
      p: "/api/companies/acme/issues",
      s: 201,
      d: 12.3,
      id: "req-1",
      r: "/api/companies/:id/issues",
    });
  });

  it("drops query strings and collapses webhook ids like the pino lines", () => {
    const withQuery = JSON.parse(
      formatAccessLogLine({
        finishedAt: new Date("2026-10-20T01:56:00.000Z"),
        method: "GET",
        originalUrl: "/api/issues?token=secret",
        url: "/api/issues?token=secret",
        statusCode: 200,
        durationMs: 1,
        requestId: null,
      }),
    );
    expect(withQuery.p).not.toContain("secret");
    const webhook = JSON.parse(
      formatAccessLogLine({
        finishedAt: new Date("2026-10-20T01:56:00.000Z"),
        method: "POST",
        originalUrl: "/api/chat-webhooks/endpoint-9/slack",
        url: "/api/chat-webhooks/endpoint-9/slack",
        statusCode: 200,
        durationMs: 1,
        requestId: null,
      }),
    );
    expect(webhook.p).toBe("/api/chat-webhooks/:publicId/:provider");
  });

  it("never persists raw invite or board-claim bearer tokens", () => {
    for (const originalUrl of [
      "/api/invites/pcp_invite_SECRETTOKEN123",
      "/api/invites/pcp_invite_SECRETTOKEN123/accept",
      "/api/board-claim/rawtoken456/claim",
    ]) {
      const raw = formatAccessLogLine({
        finishedAt: new Date("2026-10-20T01:56:00.000Z"),
        method: "GET",
        originalUrl,
        url: originalUrl,
        statusCode: 200,
        durationMs: 1,
        requestId: null,
      });
      expect(raw).not.toContain("SECRETTOKEN123");
      expect(raw).not.toContain("rawtoken456");
      expect(JSON.parse(raw).p).toContain(":token");
    }
  });
});

describe("createAccessLogger", () => {
  it("logs every request including routes pino-http silences", () => {
    const { sink, dir } = accessSink();
    const middleware = createAccessLogger(sink);
    // /api/health and /api/companies/*/issues successes are silenced in the
    // pino-http stream; the access log must still count them.
    runThrough(middleware, fakeReq({ originalUrl: "/api/health", url: "/api/health" }), fakeRes(200));
    runThrough(
      middleware,
      fakeReq({ originalUrl: "/api/companies/acme/issues", url: "/api/companies/acme/issues" }),
      fakeRes(200),
    );
    runThrough(
      middleware,
      fakeReq({ method: "POST", originalUrl: "/api/runs", url: "/api/runs" }),
      fakeRes(500),
    );
    const lines = readLines(dir);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => [line.m, line.p, line.s])).toEqual([
      ["GET", "/api/health", 200],
      ["GET", "/api/companies/acme/issues", 200],
      ["POST", "/api/runs", 500],
    ]);
    for (const line of lines) {
      expect(typeof line.t).toBe("string");
      expect(typeof line.d).toBe("number");
    }
  });

  it("records the pino request id and matched route for correlation", () => {
    const { sink, dir } = accessSink();
    const middleware = createAccessLogger(sink);
    runThrough(
      middleware,
      fakeReq({ id: "req-42", route: { path: "/api/health" } }),
      fakeRes(200),
    );
    const [line] = readLines(dir);
    expect(line?.id).toBe("req-42");
    expect(line?.r).toBe("/api/health");
  });

  it("logs the entry-time path even when a mounted router strips req.url", () => {
    const { sink, dir } = accessSink();
    const middleware = createAccessLogger(sink);
    const req = fakeReq({ originalUrl: "/api/health", url: "/api/health" });
    const res = fakeRes(200);
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    // Simulate Express mount stripping before the response finishes.
    (req as unknown as Record<string, unknown>).url = "/";
    (req as unknown as Record<string, unknown>).route = { path: "/" };
    (res as unknown as EventEmitter).emit("finish");
    const [line] = readLines(dir);
    expect(line?.p).toBe("/api/health");
    expect(line?.r).toBe("/");
  });

  it("records numeric pino request ids as strings", () => {
    const { sink, dir } = accessSink();
    const middleware = createAccessLogger(sink);
    runThrough(middleware, fakeReq({ id: 42 }), fakeRes(200));
    const [line] = readLines(dir);
    expect(line?.id).toBe("42");
  });

  it("is a no-op passthrough when the sink is unavailable", () => {
    const middleware = createAccessLogger(null);
    let nextCalled = false;
    middleware(fakeReq(), fakeRes(), () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
