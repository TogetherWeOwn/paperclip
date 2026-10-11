import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: async () => ({ censorUsernameInLogs: false }) }),
}));

import { persistActivity } from "../services/activity-log.js";
import {
  buildRequestAuditContext,
  hashJsonValue,
  runWithRequestAuditContext,
} from "../services/audit-context.js";

function fakeReq(actor: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { actor, header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

function fakeDb(captured: Array<Record<string, unknown>>): Db {
  return {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        captured.push(row);
        return { returning: async () => [{ id: "activity-1" }] };
      },
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
    const producer = buildRequestAuditContext(
      fakeReq(
        { type: "board", userId: "board-user", source: "board_key", keyId: "key-row-7" },
        { "X-Paperclip-Change-Reason": "cap timer: weekly window", "X-Paperclip-Correlation-Id": "cap-timer/2026-10-11" },
      ),
    )!;
    const browser = buildRequestAuditContext(
      fakeReq({ type: "board", userId: "board-user", source: "session" }),
    )!;

    await runWithRequestAuditContext(producer, () => persistActivity(db, { ...baseInput, details: { configHashAfter: "x" } }));
    await runWithRequestAuditContext(browser, () => persistActivity(db, { ...baseInput }));

    expect((rows[0].details as any).audit).toEqual({
      actorSource: "board_key",
      keyId: "key-row-7",
      reason: "cap timer: weekly window",
      correlationId: "cap-timer/2026-10-11",
    });
    expect((rows[0].details as any).configHashAfter).toBe("x");
    expect((rows[1].details as any).audit).toEqual({ actorSource: "session" });
  });

  it("writes no audit block outside a request", async () => {
    const rows: Array<Record<string, unknown>> = [];
    await persistActivity(fakeDb(rows), { ...baseInput, details: { a: 1 } });
    expect(rows[0].details).toEqual({ a: 1 });
  });

  it("does not overwrite an explicit audit key set by the caller", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const ctx = buildRequestAuditContext(fakeReq({ type: "board", source: "session" }))!;
    await runWithRequestAuditContext(ctx, () =>
      persistActivity(fakeDb(rows), { ...baseInput, details: { audit: { custom: true } } }));
    expect((rows[0].details as any).audit).toEqual({ custom: true });
  });

  it("bounds and sanitizes caller-supplied reason and correlation id", () => {
    const ctx = buildRequestAuditContext(
      fakeReq(
        { type: "board", source: "board_key", keyId: "k" },
        { "x-paperclip-change-reason": `a\nb${"x".repeat(400)}`, "x-paperclip-correlation-id": "bad id with spaces" },
      ),
    )!;
    expect(ctx.reason).toHaveLength(256);
    expect(ctx.reason).not.toMatch(/[\n]/);
    expect(ctx.correlationId).toBeNull();
  });

  it("returns no context for unauthenticated requests", () => {
    expect(buildRequestAuditContext(fakeReq({ type: "none" }))).toBeNull();
  });

  it("hashes config independent of key order and detects change", () => {
    expect(hashJsonValue({ a: 1, b: { c: 2, d: 3 } })).toBe(hashJsonValue({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashJsonValue({ a: 1 })).not.toBe(hashJsonValue({ a: 2 }));
  });
});
