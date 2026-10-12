import { readFileSync } from "node:fs";
import type { Db } from "@paperclipai/db";
import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

import { persistActivity } from "../services/activity-log.js";
import type { RequestAuditContext } from "../services/audit-context.js";
import {
  buildRequestAuditContext,
  getRequestAuditContext,
  hashJsonValue,
  runOutsideRequestAuditContext,
  runWithRequestAuditContext,
  withRequestAuditDetails,
} from "../services/audit-context.js";

function fakeReq(
  actor: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    actor,
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

function mustBuildContext(req: Request): RequestAuditContext {
  const ctx = buildRequestAuditContext(req);
  if (!ctx) throw new Error("expected audit context");
  return ctx;
}

function auditOf(row: Record<string, unknown>): unknown {
  return (row.details as Record<string, unknown>).audit;
}

function configHashAfterOf(row: Record<string, unknown>): unknown {
  return (row.details as Record<string, unknown>).configHashAfter;
}

function fakeDb(captured: Array<Record<string, unknown>>): Db {
  return {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        captured.push(row);
        return { returning: async () => [{ id: "activity-1" }] };
      },
    }),
    // resolveResponsibleUserIdForActivity queries run/issue/key/company
    // lookups via db.select(...).from(...).where(...); the unit fake has no
    // such rows, so return an empty set (no responsible user found).
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
  } as unknown as Db;
}

const baseInput = {
  companyId: "00000000-0000-4000-8000-000000000001",
  actorType: "user" as const,
  actorId: "board-user",
  action: "plugin.config.updated",
  entityType: "plugin",
  entityId: "plugin-1",
};

describe("request audit context on activity rows", () => {
  it("distinguishes a host producer (board_key) from a browser session on the same identity", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const db = fakeDb(rows);
    const producer = mustBuildContext(
      fakeReq(
        {
          type: "board",
          userId: "board-user",
          source: "board_key",
          keyId: "key-row-7",
        },
        {
          "X-Paperclip-Change-Reason": "cap timer: weekly window",
          "X-Paperclip-Correlation-Id": "cap-timer/2026-10-11",
        },
      ),
    );
    const browser = mustBuildContext(
      fakeReq({ type: "board", userId: "board-user", source: "session" }),
    );

    await runWithRequestAuditContext(producer, () =>
      persistActivity(db, { ...baseInput, details: { configHashAfter: "x" } }),
    );
    await runWithRequestAuditContext(browser, () =>
      persistActivity(db, { ...baseInput }),
    );

    expect(auditOf(rows[0])).toEqual({
      actorSource: "board_key",
      keyId: "key-row-7",
      reason: "cap timer: weekly window",
      correlationId: "cap-timer/2026-10-11",
    });
    expect(configHashAfterOf(rows[0])).toBe("x");
    expect(auditOf(rows[1])).toEqual({ actorSource: "session" });
  });

  it("writes no audit block outside a request", async () => {
    const rows: Array<Record<string, unknown>> = [];
    await persistActivity(fakeDb(rows), { ...baseInput, details: { a: 1 } });
    expect(rows[0].details).toEqual({ a: 1 });
  });

  it("overwrites a caller-supplied audit key with the real provenance", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const ctx = mustBuildContext(
      fakeReq({ type: "board", userId: "board-user", source: "session" }),
    );
    await runWithRequestAuditContext(ctx, () =>
      persistActivity(fakeDb(rows), {
        ...baseInput,
        details: { audit: { actorSource: "forged" } },
      }),
    );
    expect(auditOf(rows[0])).toEqual({ actorSource: "session" });
  });

  it("strips a caller-supplied audit key when outside a request", async () => {
    const rows: Array<Record<string, unknown>> = [];
    await persistActivity(fakeDb(rows), {
      ...baseInput,
      details: { note: "hello", audit: { actorSource: "forged" } },
    });
    expect(rows[0].details).toEqual({ note: "hello" });
  });

  it("redacts secrets in the change reason together with details", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const secret = "mysecrettoken123";
    const ctx = mustBuildContext(
      fakeReq(
        {
          type: "board",
          userId: "board-user",
          source: "board_key",
          keyId: "key-1",
        },
        {
          "X-Paperclip-Change-Reason": `rotate Authorization: Bearer ${secret}`,
        },
      ),
    );
    await runWithRequestAuditContext(ctx, () =>
      persistActivity(fakeDb(rows), {
        ...baseInput,
        details: { note: `deploy Bearer ${secret}` },
      }),
    );
    const stored = JSON.stringify(rows[0].details);
    expect(stored).not.toContain(secret);
  });

  it("does not stamp rows written by detached work outside the request context", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const ctx = mustBuildContext(
      fakeReq(
        { type: "board", source: "board_key", keyId: "key-7" },
        { "X-Paperclip-Change-Reason": "wake agent" },
      ),
    );
    await runWithRequestAuditContext(ctx, async () => {
      await runOutsideRequestAuditContext(() =>
        persistActivity(fakeDb(rows), {
          ...baseInput,
          actorType: "agent",
          actorId: "agent-1",
          details: { a: 1 },
        }),
      );
    });
    expect(rows[0].details).toEqual({ a: 1 });
  });

  it("does not stamp plugin or agent rows with the requesting human's provenance", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const ctx = mustBuildContext(
      fakeReq(
        {
          type: "board",
          userId: "board-user",
          source: "board_key",
          keyId: "key-7",
        },
        { "X-Paperclip-Change-Reason": "enable plugin" },
      ),
    );
    await runWithRequestAuditContext(ctx, async () => {
      await persistActivity(fakeDb(rows), {
        ...baseInput,
        actorType: "plugin",
        actorId: "plugin-1",
        details: { a: 1 },
      });
      await persistActivity(fakeDb(rows), {
        ...baseInput,
        actorType: "agent",
        actorId: "agent-1",
        details: { b: 2 },
      });
    });
    expect(rows[0].details).toEqual({ a: 1 });
    expect(rows[1].details).toEqual({ b: 2 });
  });

  it("redacts a secret-bearing reason at the source for direct inserts", async () => {
    const secret = "mysecrettoken123";
    const ctx = mustBuildContext(
      fakeReq(
        {
          type: "board",
          userId: "board-user",
          source: "board_key",
          keyId: "key-1",
        },
        {
          "X-Paperclip-Change-Reason": `rotate Authorization: Bearer ${secret}`,
        },
      ),
    );
    expect(ctx.reason ?? "").not.toContain(secret);
    await runWithRequestAuditContext(ctx, async () => {
      const stamped = withRequestAuditDetails(
        { source: "manual_routine_run" },
        { actorType: "user", actorId: "board-user" },
      );
      expect(JSON.stringify(stamped)).not.toContain(secret);
    });
  });

  it("worker handlers registered outside the request see no audit context", async () => {
    const ctx = mustBuildContext(
      fakeReq({
        type: "board",
        userId: "board-user",
        source: "board_key",
        keyId: "key-7",
      }),
    );
    await runWithRequestAuditContext(ctx, async () => {
      const seen = runOutsideRequestAuditContext(() =>
        getRequestAuditContext(),
      );
      expect(seen).toBeUndefined();
      const rows: Array<Record<string, unknown>> = [];
      await runOutsideRequestAuditContext(() =>
        persistActivity(fakeDb(rows), {
          ...baseInput,
          actorType: "plugin",
          actorId: "plugin-1",
          details: { a: 1 },
        }),
      );
      expect(rows[0].details).toEqual({ a: 1 });
    });
  });

  it("keeps every heartbeat executeRun launch outside the request audit context", () => {
    const source = readFileSync(
      new URL("../services/heartbeat.ts", import.meta.url),
      "utf8",
    );
    const launches = source.match(/executeRun\(/g) ?? [];
    const wrapped =
      source.match(/runOutsideRequestAuditContext\(\(\) => executeRun\(/g) ??
      [];
    // One occurrence is the `async function executeRun(` definition; every
    // other call site must be wrapped so detached agent rows never inherit the
    // waking human's provenance.
    expect(launches.length - 1).toBeGreaterThan(0);
    expect(wrapped.length).toBe(launches.length - 1);
  });

  it("bounds and sanitizes caller-supplied reason and correlation id", () => {
    const ctx = mustBuildContext(
      fakeReq(
        { type: "board", source: "board_key", keyId: "k" },
        {
          "x-paperclip-change-reason": `a\nb${"x".repeat(400)}`,
          "x-paperclip-correlation-id": "bad id with spaces",
        },
      ),
    );
    expect(ctx.reason).toHaveLength(256);
    expect(ctx.reason).not.toContain("\n");
    expect(ctx.correlationId).toBeNull();
  });

  it("returns no context for unauthenticated requests", () => {
    expect(buildRequestAuditContext(fakeReq({ type: "none" }))).toBeNull();
  });

  it("hashes config independent of key order and detects change", () => {
    expect(hashJsonValue({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashJsonValue({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(hashJsonValue({ a: 1 })).not.toBe(hashJsonValue({ a: 2 }));
  });
});
