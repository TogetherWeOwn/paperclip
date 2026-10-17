import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { GitHubReviewEventContext, GitHubReviewPolicy } from "@paperclipai/shared";
import { chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals } from "./chat_channels.js";
import { chatGitHubReviewArms } from "./chat_github.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

export interface GitHubReviewEnrollmentEnvelope {
  version: 1;
  event: GitHubReviewEventContext;
  request: string;
  lowTrust: boolean;
  policy: GitHubReviewPolicy;
  authority: { guest: boolean; responsibleUserId: string | null; sponsorUserId: string | null };
  normalizedEvent: Record<string, unknown>;
  conversation: {
    resourceId: string | null;
    externalConversationId: string;
    externalThreadId: string;
    externalLabel: string;
    providerUrl: string | null;
    communicationGuidance: string | null;
  };
}

/** One immutable admitted event, independent of either arm's result. */
export const chatGitHubReviewEnrollments = pgTable("chat_github_review_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  endpointId: uuid("endpoint_id").notNull(),
  originDeliveryId: uuid("origin_delivery_id").notNull(),
  originEventId: text("origin_event_id").notNull(),
  principalId: uuid("principal_id").notNull(),
  repositoryId: text("repository_id").notNull(),
  repository: text("repository").notNull(),
  pullNumber: integer("pull_number").notNull(),
  headSha: text("head_sha").notNull(),
  baseSha: text("base_sha").notNull(),
  roundOrdinal: integer("round_ordinal").notNull(),
  configurationRevision: integer("configuration_revision").notNull(),
  pairKey: text("pair_key").notNull(),
  envelope: jsonb("envelope").$type<GitHubReviewEnrollmentEnvelope>().notNull(),
  admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("chat_github_enrollments_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("chat_github_enrollments_event_uq").on(t.endpointId, t.originEventId),
  uniqueIndex("chat_github_enrollments_delivery_uq").on(t.originDeliveryId),
  uniqueIndex("chat_github_enrollments_pair_uq").on(t.pairKey),
  uniqueIndex("chat_github_enrollments_round_uq").on(t.endpointId, t.repositoryId, t.pullNumber, t.roundOrdinal),
  foreignKey({ columns: [t.companyId, t.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id] }),
  foreignKey({ columns: [t.companyId, t.originDeliveryId], foreignColumns: [chatDeliveries.companyId, chatDeliveries.id] }),
  foreignKey({ columns: [t.companyId, t.principalId], foreignColumns: [chatExternalPrincipals.companyId, chatExternalPrincipals.id] }),
  check("chat_github_enrollments_round_check", sql`${t.roundOrdinal} > 0 and ${t.configurationRevision} > 0`),
]);

/** Local candidate outbox, never an outbound publication intent. Reserved native
 * identity survives a crash before materialization or scheduler acknowledgement. */
export const chatGitHubReviewCandidates = pgTable("chat_github_review_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  endpointId: uuid("endpoint_id").notNull(),
  enrollmentId: uuid("enrollment_id").notNull(),
  armId: uuid("arm_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  shadowLabel: text("shadow_label").notNull(),
  nativeDeliveryId: uuid("native_delivery_id").notNull().defaultRandom(),
  conversationId: uuid("conversation_id"),
  issueId: uuid("issue_id"),
  commentId: uuid("comment_id").references(() => issueComments.id),
  state: text("state").$type<"pending" | "materialized" | "dispatched" | "unavailable">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("chat_github_candidates_arm_uq").on(t.enrollmentId, t.armId),
  uniqueIndex("chat_github_candidates_delivery_uq").on(t.nativeDeliveryId),
  index("chat_github_candidates_work_idx").on(t.state, t.nextAttemptAt),
  foreignKey({ columns: [t.companyId, t.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id] }),
  foreignKey({ columns: [t.companyId, t.enrollmentId], foreignColumns: [chatGitHubReviewEnrollments.companyId, chatGitHubReviewEnrollments.id] }),
  foreignKey({ columns: [t.companyId, t.armId], foreignColumns: [chatGitHubReviewArms.companyId, chatGitHubReviewArms.id] }),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] }),
  foreignKey({ columns: [t.companyId, t.conversationId], foreignColumns: [chatConversations.companyId, chatConversations.id] }),
  foreignKey({ columns: [t.companyId, t.issueId], foreignColumns: [issues.companyId, issues.id] }),
  check("chat_github_candidates_label_check", sql`${t.shadowLabel} <> ''`),
  check("chat_github_candidates_state_check", sql`${t.state} in ('pending', 'materialized', 'dispatched', 'unavailable')`),
]);
