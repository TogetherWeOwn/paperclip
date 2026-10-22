import { describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@paperclipai/db";

function coverageTable() {
  const table = (schema as unknown as Record<string, PgTable>).issueEventWaitCoverage;
  expect(table, "DB package must export issueEventWaitCoverage").toBeDefined();
  return table!;
}

describe("additive wait-coverage schema contract (metadata only, not live PostgreSQL)", () => {
  it("exposes the company-scoped registry columns without reusing issue state", () => {
    const config = getTableConfig(coverageTable());
    expect(config.name).toBe("issue_event_wait_coverage");
    const names = config.columns.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining([
      "id", "company_id", "issue_id", "service_name", "external_ref", "source_kind",
      "event_revision", "observation_status", "observed_at", "armed_revision",
      "armed_assignee_agent_id", "armed_status", "fallback_at", "expires_at",
      "unresolved_actionable_event_at", "registered_by_actor", "updated_at",
    ]));
    for (const name of ["company_id", "issue_id", "service_name", "external_ref", "observed_at", "expires_at", "registered_by_actor"]) {
      expect(config.columns.find((column) => column.name === name)?.notNull, name).toBe(true);
    }
    expect(config.columns.find((column) => column.name === "unresolved_actionable_event_at")?.notNull).toBe(false);
  });

  it("declares a unique active natural key, not merely a nonunique lookup index", () => {
    const config = getTableConfig(coverageTable());
    const keys = config.indexes.filter((index) => index.config.unique).map((index) => index.config.columns.map((column) => "name" in column ? column.name : "expression"));
    keys.push(...config.uniqueConstraints.map((key) => key.columns.map((column) => column.name)));
    expect(keys.some((key) => key.join(",") === "issue_id,service_name,external_ref" || key.join(",") === "company_id,issue_id,service_name,external_ref")).toBe(true);
  });

  it("retains references to both the owning company and issue", () => {
    const config = getTableConfig(coverageTable());
    const referenced = config.foreignKeys.flatMap((key) => key.reference().columns.map((column) => column.name));
    expect(referenced).toEqual(expect.arrayContaining(["company_id", "issue_id"]));
  });
});
