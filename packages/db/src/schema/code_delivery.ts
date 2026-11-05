import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";

export const issueCodeDeliveryIntents = pgTable("issue_code_delivery_intents", {
  issueId: uuid("issue_id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  intent: text("intent").$type<"code" | "non_code" | "ambiguous">().notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  companyIssue: unique("issue_code_delivery_intents_company_issue_uq").on(table.companyId, table.issueId),
  issue: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id] }).onDelete("cascade"),
  validIntent: check("issue_code_delivery_intents_kind_ck", sql`${table.intent} in ('code', 'non_code', 'ambiguous')`),
  validRevision: check("issue_code_delivery_intents_revision_ck", sql`${table.revision} > 0`),
}));

export const codeDeliveryDiscoveries = pgTable("code_delivery_discoveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  sourceWorkProductId: uuid("source_work_product_id").notNull(),
  sourceRevision: text("source_revision").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  issue: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id] }),
  sourceRevision: unique("code_delivery_discoveries_source_revision_uq").on(table.sourceWorkProductId, table.issueId, table.sourceRevision),
  companyIssue: index("code_delivery_discoveries_company_issue_idx").on(table.companyId, table.issueId),
}));

export const codeDeliveryObligations = pgTable("code_delivery_obligations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  ownerIssueId: uuid("owner_issue_id").notNull(),
  sourceIssueId: uuid("source_issue_id").notNull(),
  sourceProjectId: uuid("source_project_id").notNull(),
  sourceWorkspaceId: uuid("source_workspace_id").notNull(),
  provider: text("provider").$type<"github">().notNull().default("github"),
  repositoryId: text("repository_id").notNull(),
  repository: text("repository").notNull(),
  pullRequestNumber: integer("pull_request_number").notNull(),
  baseRef: text("base_ref").notNull(),
  proposedHeadSha: text("proposed_head_sha").notNull(),
  reviewedHeadSha: text("reviewed_head_sha"),
  headDecisionId: uuid("head_decision_id"),
  transferDecisionId: uuid("transfer_decision_id"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  companyId: unique("code_delivery_obligations_company_id_uq").on(table.companyId, table.id),
  canonicalIdentity: unique("code_delivery_obligations_identity_uq").on(table.companyId, table.provider, table.repositoryId, table.pullRequestNumber),
  owner: foreignKey({ columns: [table.companyId, table.ownerIssueId], foreignColumns: [issues.companyId, issues.id] }),
  source: foreignKey({ columns: [table.companyId, table.sourceIssueId], foreignColumns: [issues.companyId, issues.id] }),
  project: foreignKey({ columns: [table.companyId, table.sourceProjectId], foreignColumns: [projects.companyId, projects.id] }),
  workspace: foreignKey({ columns: [table.companyId, table.sourceProjectId, table.sourceWorkspaceId], foreignColumns: [projectWorkspaces.companyId, projectWorkspaces.projectId, projectWorkspaces.id] }),
  companyOwner: index("code_delivery_obligations_company_owner_idx").on(table.companyId, table.ownerIssueId),
  validProvider: check("code_delivery_obligations_provider_ck", sql`${table.provider} = 'github'`),
  validRepository: check("code_delivery_obligations_repository_ck", sql`${table.repositoryId} ~ '^[1-9][0-9]{0,19}$' and ${table.repository} ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}$' and split_part(${table.repository}, '/', 2) not in ('.', '..')`),
  validPullRequest: check("code_delivery_obligations_pr_ck", sql`${table.pullRequestNumber} > 0 and length(${table.baseRef}) between 1 and 255 and ${table.baseRef} !~ '[[:space:][:cntrl:]]'`),
  validHeads: check("code_delivery_obligations_heads_ck", sql`${table.proposedHeadSha} ~ '^[a-f0-9]{40}$' and (${table.reviewedHeadSha} is null or ${table.reviewedHeadSha} ~ '^[a-f0-9]{40}$')`),
  validRevision: check("code_delivery_obligations_revision_ck", sql`${table.revision} > 0`),
}));

export const codeDeliveryOwnershipEvents = pgTable("code_delivery_ownership_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  obligationId: uuid("obligation_id").notNull(),
  fromIssueId: uuid("from_issue_id"),
  toIssueId: uuid("to_issue_id").notNull(),
  obligationRevision: bigint("obligation_revision", { mode: "number" }).notNull(),
  provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  obligation: foreignKey({ columns: [table.companyId, table.obligationId], foreignColumns: [codeDeliveryObligations.companyId, codeDeliveryObligations.id] }),
  fromIssue: foreignKey({ columns: [table.companyId, table.fromIssueId], foreignColumns: [issues.companyId, issues.id] }),
  toIssue: foreignKey({ columns: [table.companyId, table.toIssueId], foreignColumns: [issues.companyId, issues.id] }),
  revision: unique("code_delivery_ownership_events_revision_uq").on(table.obligationId, table.obligationRevision),
  validRevision: check("code_delivery_ownership_events_revision_ck", sql`${table.obligationRevision} > 0`),
  distinctOwner: check("code_delivery_ownership_events_owner_ck", sql`${table.fromIssueId} is null or ${table.fromIssueId} <> ${table.toIssueId}`),
}));
