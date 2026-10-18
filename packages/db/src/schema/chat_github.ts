import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  GitHubChatConfiguration,
  GitHubReviewAssessment,
  GitHubReviewEventContext,
  GitHubReviewPolicy,
  GitHubTaskReview,
} from "@paperclipai/shared";
import { chatEndpoints } from "./chat_channels.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";

/** Stable candidate identity. Removing configuration retires, never rebinds, an arm. */
export const chatGitHubReviewArms = pgTable(
  "chat_github_review_arms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    label: text("label").notNull(),
    agentId: uuid("agent_id").notNull(),
    configurationRevision: integer("configuration_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [
    unique("chat_github_review_arms_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("chat_github_review_arms_label_uq").on(t.endpointId, t.label),
    uniqueIndex("chat_github_review_arms_active_agent_uq")
      .on(t.endpointId, t.agentId).where(sql`${t.retiredAt} is null`),
    foreignKey({
      columns: [t.companyId, t.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.companyId, t.agentId],
      foreignColumns: [agents.companyId, agents.id],
    }).onDelete("restrict"),
    check("chat_github_review_arm_revision_check", sql`${t.configurationRevision} > 0`),
    check("chat_github_review_arm_label_check", sql`${t.label} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
  ],
);

/** The endpoint owns the immutable agent/connection binding. Config is opt-in. */
export const chatGitHubConfigurations = pgTable(
  "chat_github_configurations",
  {
    endpointId: uuid("endpoint_id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    revision: integer("revision").notNull().default(1),
    configuration: jsonb("configuration")
      .$type<GitHubChatConfiguration>()
      .notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.companyId, t.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
    }).onDelete("cascade"),
    check("chat_github_config_revision_check", sql`${t.revision} > 0`),
  ],
);

/** Single-use server-side state; contains no App credential material. */
export const chatGitHubRegistrations = pgTable(
  "chat_github_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    userId: text("user_id").notNull(),
    stateHash: text("state_hash").notNull(),
    trustedOrigin: text("trusted_origin").notNull(),
    ownerType: text("owner_type")
      .$type<"personal" | "organization">()
      .notNull()
      .default("personal"),
    ownerLogin: text("owner_login"),
    appName: text("app_name"),
    handoff: jsonb("handoff").$type<{
      cloudId: string;
      redemptionId: string;
      returnState: string;
      webhookSecretHash?: string;
      renewalOf?: string;
      manifestClaimId?: string;
      identityLeaseId?: string;
      identityLeaseExpiresAt?: string;
      identityStateHash?: string;
      identityExpiresAt?: string;
      identityRedemptionId?: string;
      identity?: {
        githubUserId: string;
        login: string;
        avatarUrl: string | null;
        expiresAt: string;
      };
    }>(),
    status: text("status")
      .$type<"pending" | "exchanging" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.companyId, t.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
    }).onDelete("cascade"),
    uniqueIndex("chat_github_registration_state_uq").on(t.stateHash),
    index("chat_github_registration_endpoint_idx").on(
      t.endpointId,
      t.expiresAt,
    ),
    check(
      "chat_github_registration_status_check",
      sql`${t.status} in ('pending', 'exchanging', 'completed', 'failed')`,
    ),
  ],
);

/** Result/history projection of an ordinary task execution; no queue or worker. */
export const chatGitHubReviews = pgTable(
  "chat_github_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    runId: uuid("run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    repositoryId: text("repository_id").notNull(),
    repository: text("repository").notNull(),
    pullNumber: integer("pull_number").notNull(),
    headSha: text("head_sha").notNull(),
    deliveryId: text("delivery_id").notNull(),
    // Native admission identity survives per-run retry rows without changing
    // the provider delivery id used to deduplicate GitHub check intents.
    admissionDeliveryId: uuid("admission_delivery_id"),
    configurationRevision: integer("configuration_revision").notNull(),
    policySnapshot: jsonb("policy_snapshot")
      .$type<GitHubReviewPolicy>()
      .notNull(),
    event: jsonb("event").$type<GitHubReviewEventContext & {
      /** Native admission identity, distinct from the provider's delivery ID. */
      admissionDeliveryId?: string;
      /** Reader actually selected for this run at begin/submit, not admission. */
      inputSource?: "snapshot" | "live";
    }>().notNull(),
    state: text("state")
      .$type<GitHubTaskReview["state"]>()
      .notNull()
      .default("queued"),
    assessment: jsonb("assessment").$type<GitHubReviewAssessment>(),
    conclusion: text("conclusion").$type<GitHubTaskReview["conclusion"]>(),
    checkId: text("check_id"),
    checkUrl: text("check_url"),
    summaryId: text("summary_id"),
    summaryUrl: text("summary_url"),
    /** Receipts are also recovered from provider markers before retrying writes. */
    publicationReceipts: jsonb("publication_receipts")
      .$type<Record<string, { id: string; url: string; digest: string }>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("chat_github_reviews_company_id_uq").on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.endpointId],
      foreignColumns: [chatEndpoints.companyId, chatEndpoints.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.companyId, t.issueId],
      foreignColumns: [issues.companyId, issues.id],
    }).onDelete("restrict"),
    uniqueIndex("chat_github_reviews_delivery_uq").on(
      t.endpointId,
      t.deliveryId,
    ),
    index("chat_github_reviews_admission_idx").on(t.endpointId, t.admissionDeliveryId)
      .where(sql`${t.shadowLabel} is null and ${t.admissionDeliveryId} is not null`),
    index("chat_github_reviews_pull_idx").on(
      t.endpointId,
      t.repositoryId,
      t.pullNumber,
      t.createdAt,
    ),
    index("chat_github_reviews_task_idx").on(t.companyId, t.issueId, t.runId),
    // Every OR branch in chat_outbound_is_capture_only must be a bounded lookup.
    // Keep cross-provider fencing: a candidate may emit through any provider.
    index("chat_github_reviews_capture_issue_idx").on(t.companyId, t.issueId)
      .where(sql`${t.shadowLabel} is not null`),
    index("chat_github_reviews_capture_run_idx").on(t.companyId, t.runId)
      .where(sql`${t.shadowLabel} is not null`),
    index("chat_github_reviews_capture_delivery_idx").on(t.companyId, t.deliveryId)
      .where(sql`${t.shadowLabel} is not null`),
    check("chat_github_review_pull_number_check", sql`${t.pullNumber} > 0`),
    check(
      "chat_github_review_state_check",
      sql`${t.state} in ('queued', 'running', 'completed', 'incomplete', 'error', 'superseded', 'manual_required')`,
    ),
  ],
);
