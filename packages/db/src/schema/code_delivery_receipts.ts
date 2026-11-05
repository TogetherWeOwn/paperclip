import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const codeDeliveryReadinessReceipts = pgTable("code_delivery_readiness_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  issueRevision: bigint("issue_revision", { mode: "number" }).notNull(),
  terminalStatus: text("terminal_status").$type<"done" | "cancelled">().notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  transactionId: text("transaction_id").notNull().default(sql`pg_current_xact_id()::text`),
  actorType: text("actor_type").$type<"agent" | "user">().notNull(),
  actorId: text("actor_id").notNull(),
  runId: uuid("run_id"),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
  preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  issue: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id] }),
  revision: unique("code_delivery_readiness_receipts_revision_uq").on(table.companyId, table.issueId, table.issueRevision),
  issueIndex: index("code_delivery_readiness_receipts_issue_idx").on(table.companyId, table.issueId),
  status: check("code_delivery_readiness_receipts_status_ck", sql`${table.terminalStatus} in ('done', 'cancelled')`),
  validRevision: check("code_delivery_readiness_receipts_revision_ck", sql`${table.issueRevision} >= 0`),
  validSnapshot: check("code_delivery_readiness_receipts_snapshot_ck", sql`${table.snapshotHash} ~ '^[a-f0-9]{64}$' and ${table.transactionId} ~ '^[0-9]+$'`),
  validTime: check("code_delivery_readiness_receipts_time_ck", sql`${table.expiresAt} > ${table.preparedAt} and ${table.expiresAt} <= ${table.preparedAt} + interval '30 seconds'`),
  validActor: check("code_delivery_readiness_receipts_actor_ck", sql`${table.actorType} in ('agent', 'user') and length(${table.actorId}) > 0 and (${table.actorType} <> 'agent' or ${table.runId} is not null)`),
}));
