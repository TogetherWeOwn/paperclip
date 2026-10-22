import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueEventWaitCoverage = pgTable(
  "issue_event_wait_coverage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    serviceName: text("service_name").notNull(),
    externalRef: text("external_ref").notNull(),
    sourceKind: text("source_kind").$type<"github_pr">().notNull(),
    eventRevision: text("event_revision").notNull(),
    observationStatus: text("observation_status").$type<"ok" | "error">().notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    armedRevision: text("armed_revision").notNull(),
    armedAssigneeAgentId: uuid("armed_assignee_agent_id").notNull(),
    armedStatus: text("armed_status").$type<"in_progress" | "in_review">().notNull(),
    fallbackAt: timestamp("fallback_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    unresolvedActionableEventAt: timestamp("unresolved_actionable_event_at", { withTimezone: true }),
    registeredByActor: jsonb("registered_by_actor").$type<{ type: "board" | "system"; id: string }>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    naturalKey: uniqueIndex("issue_event_wait_coverage_natural_uq").on(table.issueId, table.serviceName, table.externalRef),
    companyExpiryIdx: index("issue_event_wait_coverage_company_expiry_idx").on(table.companyId, table.expiresAt),
    issueFk: foreignKey({
      name: "issue_event_wait_coverage_company_issue_fk",
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
    }).onDelete("cascade"),
    agentFk: foreignKey({
      name: "issue_event_wait_coverage_company_agent_fk",
      columns: [table.companyId, table.armedAssigneeAgentId],
      foreignColumns: [agents.companyId, agents.id],
    }).onDelete("cascade"),
    sourceCheck: check("issue_event_wait_coverage_source_check", sql`${table.sourceKind} = 'github_pr'`),
    observationCheck: check("issue_event_wait_coverage_observation_check", sql`${table.observationStatus} in ('ok', 'error')`),
    statusCheck: check("issue_event_wait_coverage_status_check", sql`${table.armedStatus} in ('in_progress', 'in_review')`),
  }),
);
