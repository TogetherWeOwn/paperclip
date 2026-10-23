import { DatabaseSync } from "node:sqlite";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { decisionRetention, type Db } from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { decisionRetentionService } from "../services/decision-retention.js";

const audit = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("../services/activity-log.js", () => ({
  logActivity: async (_db: unknown, event: { entityId: string }) => { audit.ids.push(event.entityId); },
}));

const now = new Date("2026-07-09T12:00:00.000Z");
const cutoff = new Date("2026-04-10T12:00:00.000Z"); // Exactly 90 days.
const fresh = new Date("2026-04-10T12:00:00.001Z");
const old = new Date("2026-01-01T00:00:00.000Z");

// Execute the real PostgreSQL-shaped retention DML in private, in-memory SQL.
// No connection string, application DB, migration, cluster or service is used.
// PostgreSQL transaction locking and notification delivery remain integration
// responsibilities of the existing decision-retention-service.test.ts suite.
function setup() {
  audit.ids = [];
  const sql = new DatabaseSync(":memory:");
  const columns = Object.values(getTableColumns(decisionRetention)).map((column) => column.name);
  sql.exec(`create table decision_retention (${columns.map((name) => `"${name}"`).join(", ")})`);
  const client = drizzle(async (query, params) => {
    const statement = sql.prepare(query);
    statement.setReturnArrays(true);
    const bindings = Object.fromEntries(params.map((value, index) => [
      String(index + 1), typeof value === "boolean" ? Number(value) : value,
    ]));
    return { rows: statement.all(bindings) };
  });
  const db = Object.assign(client, {
    transaction: async <T>(callback: (tx: Db) => Promise<T>) => {
      sql.exec("begin");
      try {
        const result = await callback(client as unknown as Db);
        sql.exec("commit");
        return result;
      } catch (error) {
        sql.exec("rollback");
        throw error;
      }
    },
  }) as unknown as Db;
  function row(id: string, options: {
    companyId?: string; keep?: boolean; archivedAt?: Date; activityAt?: Date; version?: number;
  } = {}) {
    sql.prepare(`insert into decision_retention (
      id, company_id, source_kind, source_id, source_activity_at,
      keep, archived_at, version, archive_version, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, options.companyId ?? "company-a", "join_request", id,
      (options.activityAt ?? old).toISOString(), Number(options.keep ?? false),
      options.archivedAt?.toISOString() ?? null, options.version ?? 4, 2,
      old.toISOString(), old.toISOString(),
    );
  }
  function item(id: string, options: Partial<AttentionItem> = {}): AttentionItem {
    return {
      companyId: "company-a", sourceKind: "join_request", subject: { id },
      activityAt: old.toISOString(), keep: false, archivedAt: null,
      retentionVersion: 4, retentionDays: 1, shelf: true, ...options,
    } as AttentionItem;
  }
  function stored(id: string) {
    return sql.prepare("select archived_at, version, archive_version from decision_retention where id = ?").get(id);
  }
  return { service: decisionRetentionService(db), row, item, stored, close: () => sql.close() };
}

describe("decision retention stable-boundary acceptance", () => {
  it("archives at 90 days, not at the queue shelf threshold, and is idempotent", async () => {
    const fixture = setup();
    try {
      fixture.row("boundary", { activityAt: cutoff });
      fixture.row("one-ms-younger", { activityAt: fresh });
      const items = [
        fixture.item("boundary", { activityAt: cutoff.toISOString() }),
        fixture.item("one-ms-younger", { activityAt: fresh.toISOString() }),
      ];
      expect(await fixture.service.autoArchive({ companyId: "company-a", items, now })).toBe(1);
      expect(fixture.stored("boundary")).toEqual({ archived_at: now.toISOString(), version: 5, archive_version: 3 });
      expect(fixture.stored("one-ms-younger")).toEqual({ archived_at: null, version: 4, archive_version: 2 });
      expect(await fixture.service.autoArchive({ companyId: "company-a", items, now })).toBe(0);
      expect(audit.ids).toEqual(["boundary"]);
    } finally { fixture.close(); }
  });

  it("does not hide Keep, already archived, changed, foreign-company or foreign-kind work", async () => {
    const fixture = setup();
    try {
      fixture.row("keep-snapshot");
      fixture.row("keep-raced", { keep: true });
      fixture.row("archived-snapshot");
      fixture.row("archived-raced", { archivedAt: old });
      fixture.row("version-raced", { version: 5 });
      fixture.row("activity-raced", { activityAt: now });
      fixture.row("company-b", { companyId: "company-b" });
      fixture.row("different-kind");
      const items = [
        fixture.item("keep-snapshot", { keep: true }),
        fixture.item("keep-raced"),
        fixture.item("archived-snapshot", { archivedAt: old.toISOString() }),
        fixture.item("archived-raced"),
        fixture.item("version-raced"),
        fixture.item("activity-raced"),
        fixture.item("company-b"),
        fixture.item("different-kind", { sourceKind: "approval" }),
      ];
      expect(await fixture.service.autoArchive({ companyId: "company-a", items, now })).toBe(0);
      for (const id of ["keep-snapshot", "keep-raced", "archived-snapshot", "activity-raced", "company-b", "different-kind"]) {
        expect(fixture.stored(id), id).toEqual({ archived_at: null, version: 4, archive_version: 2 });
      }
      expect(fixture.stored("version-raced")).toEqual({ archived_at: null, version: 5, archive_version: 2 });
      expect(fixture.stored("archived-raced")).toEqual({ archived_at: old.toISOString(), version: 4, archive_version: 2 });
      expect(audit.ids).toEqual([]);
    } finally { fixture.close(); }
  });
});
