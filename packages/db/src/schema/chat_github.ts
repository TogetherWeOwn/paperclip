import { sql } from "drizzle-orm";
import {
  boolean,
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
  MergeGroupCarryProofFingerprint,
  MergeGroupCarryPublicationAttempt,
} from "@paperclipai/shared";
import { chatEndpoints } from "./chat_channels.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

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
    configurationRevision: integer("configuration_revision").notNull(),
    policySnapshot: jsonb("policy_snapshot")
      .$type<GitHubReviewPolicy>()
      .notNull(),
    event: jsonb("event").$type<GitHubReviewEventContext>().notNull(),
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
    index("chat_github_reviews_pull_idx").on(
      t.endpointId,
      t.repositoryId,
      t.pullNumber,
      t.createdAt,
    ),
    index("chat_github_reviews_task_idx").on(t.companyId, t.issueId, t.runId),
    check("chat_github_review_pull_number_check", sql`${t.pullNumber} > 0`),
    check(
      "chat_github_review_state_check",
      sql`${t.state} in ('queued', 'running', 'completed', 'incomplete', 'error', 'superseded', 'manual_required')`,
    ),
  ],
);

/** One verdict per merge-queue group key (endpoint + repository + group
 * SHA). Git object IDs are not repository identities, so the repository is
 * part of the durable key and every claim/read/update predicate. The insert
 * claim serializes concurrent deliveries; a processed row answers redelivery
 * only when its stored proof fingerprint still matches, and any group change
 * is a new key. */
export const chatGithubCarryRuns = pgTable(
  "chat_github_carry_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    repository: text("repository").notNull(),
    groupSha: text("group_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    heads: jsonb("heads")
      .$type<Array<{ pullNumber: number; headSha: string }>>()
      .notNull()
      .default([]),
    deliveryId: text("delivery_id").notNull(),
    configurationRevision: integer("configuration_revision").notNull(),
    status: text("status")
      .$type<"processing" | "processed" | "failed" | "cancelled">()
      .notNull()
      .default("processing"),
    verdictOk: boolean("verdict_ok"),
    code: text("code"),
    detail: text("detail"),
    checkId: text("check_id"),
    externalId: text("external_id").notNull(),
    proofFingerprint: jsonb("proof_fingerprint").$type<MergeGroupCarryProofFingerprint>(),
    publicationAttempt: jsonb("publication_attempt").$type<MergeGroupCarryPublicationAttempt>(),
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
    uniqueIndex("chat_github_carry_runs_group_uq").on(
      t.endpointId,
      t.repositoryId,
      t.groupSha,
    ),
    index("chat_github_carry_runs_endpoint_idx").on(
      t.endpointId,
      t.status,
      t.createdAt,
    ),
    check(
      "chat_github_carry_runs_status_check",
      sql`${t.status} in ('processing', 'processed', 'failed', 'cancelled')`,
    ),
  ],
);
