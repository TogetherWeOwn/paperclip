import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { codeDeliveryObligations } from "./code_delivery.js";

export const codeDeliveryAuthorities = pgTable("code_delivery_authorities", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id),
  technicalAgentId: uuid("technical_agent_id").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  configuredByUserId: text("configured_by_user_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  agent: foreignKey({ columns: [table.companyId, table.technicalAgentId], foreignColumns: [agents.companyId, agents.id] }),
  validRevision: check("code_delivery_authorities_revision_ck", sql`${table.revision} > 0`),
}));

export const codeDeliveryDecisions = pgTable("code_delivery_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  obligationId: uuid("obligation_id"),
  kind: text("kind").$type<"classify_code" | "classify_non_code" | "accept_head" | "no_pr" | "closed_unmerged" | "withdrawn" | "transfer">().notNull(),
  issueRevision: bigint("issue_revision", { mode: "number" }).notNull(),
  obligationRevision: bigint("obligation_revision", { mode: "number" }),
  actorType: text("actor_type").$type<"agent" | "user">().notNull(),
  actorId: text("actor_id").notNull(),
  runId: uuid("run_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  reason: text("reason").notNull(),
  authority: jsonb("authority").$type<Record<string, unknown>>().notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  issue: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id] }),
  obligation: foreignKey({ columns: [table.companyId, table.obligationId], foreignColumns: [codeDeliveryObligations.companyId, codeDeliveryObligations.id] }),
  request: unique("code_delivery_decisions_request_uq").on(table.companyId, table.issueId, table.idempotencyKey),
  issueIndex: index("code_delivery_decisions_issue_idx").on(table.companyId, table.issueId),
  obligationIndex: index("code_delivery_decisions_obligation_idx").on(table.companyId, table.obligationId),
  validKind: check("code_delivery_decisions_kind_ck", sql`${table.kind} in ('classify_code', 'classify_non_code', 'accept_head', 'no_pr', 'closed_unmerged', 'withdrawn', 'transfer')`),
  validScope: check("code_delivery_decisions_scope_ck", sql`(${table.kind} in ('classify_code', 'classify_non_code', 'no_pr') and ${table.obligationId} is null and ${table.obligationRevision} is null) or (${table.kind} in ('accept_head', 'closed_unmerged', 'withdrawn', 'transfer') and ${table.obligationId} is not null and ${table.obligationRevision} > 0)`),
  validRevision: check("code_delivery_decisions_revision_ck", sql`${table.issueRevision} >= 0`),
  validActor: check("code_delivery_decisions_actor_ck", sql`${table.actorType} in ('agent', 'user') and length(${table.actorId}) > 0 and (${table.actorType} <> 'agent' or ${table.runId} is not null)`),
  validRequest: check("code_delivery_decisions_request_ck", sql`length(${table.idempotencyKey}) between 1 and 200 and ${table.requestHash} ~ '^[a-f0-9]{64}$' and length(${table.reason}) between 1 and 4000`),
}));
