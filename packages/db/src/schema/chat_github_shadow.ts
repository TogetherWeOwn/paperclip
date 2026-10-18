import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import type { GitHubReviewEventContext, GitHubReviewPolicy } from "@paperclipai/shared";
import { chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals } from "./chat_channels.js";
import { chatGitHubReviewArms } from "./chat_github.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

/** Exact pre-wake provider responses. Stored inside the immutable enrollment
 * and its durable source seed; no late recapture can rewrite an admitted view. */
export interface GitHubReviewInputSnapshot {
  /** v2 stores each response as base64 JSON; the digest covers decoded bytes. */
  version: 1 | 2;
  redactions?: { total: number; byRoute: Record<string, number>; botLogin: string; appId: string };
  startedAt: string;
  finishedAt: string;
  headSha: string;
  baseSha: string;
  diffBaseSha: string;
  responses: Record<string, unknown>;
  digest: string;
}

export interface GitHubReviewEnrollmentEnvelope {
  version: 1;
  /** Null when manual metadata was unavailable at admission; never recaptured. */
  event: GitHubReviewEventContext | null;
  unavailableEvent?: Pick<GitHubReviewEventContext, "event" | "deliveryId" | "repositoryId" | "repository" | "pullNumber" | "sender">;
  /** Missing certification on older rows is also ineligible, never implicit approval. */
  comparisonEligibility?: { certifiedClean: boolean; reasons: string[] };
  /** Admission-time protocol, including explicit deviations and their provenance. */
  protocol?: {
    version: number; primaryBlindingVersion: number; eligibilitySource: string;
    deviations: { webTools: { deniedTools: readonly string[]; reason: string; primaryChanged: boolean;
      evidence: { successfulRuns: number; lookbackDays: number; webSearchRequests: number; webFetchRequests: number;
        source: string; observedOn: string; verification: string } } };
  };
  /** Admission-time policy evidence, not a claim about ambient CLI/MCP tools. */
  primaryToolPolicy?: { adapterType: string; engine: string | null; configDigest: string; effectiveToolsVerified: false };
  request: string;
  lowTrust: boolean;
  snapshot?: GitHubReviewInputSnapshot;
  snapshotFailure?: string;
  /** Frozen by stable arm ID, never a latest-row lookup at tool execution. */
  previousAssessments?: Record<string, { headSha: string; assessment: import("@paperclipai/shared").GitHubReviewAssessment; issueId: string; runId: string | null } | null>;
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
  headSha: text("head_sha"),
  baseSha: text("base_sha"),
  roundOrdinal: integer("round_ordinal").notNull(),
  configurationRevision: integer("configuration_revision").notNull(),
  pairKey: text("pair_key").notNull(),
  envelope: jsonb("envelope").$type<GitHubReviewEnrollmentEnvelope>().notNull(),
  /** Append-only per-run self-test receipts. Admission bytes remain immutable. */
  isolationTests: jsonb("isolation_tests").$type<Record<string, {
    version: number; runId: string; candidateId: string; armId: string; environmentId: string;
    namespace: string; configurationDigest: string; certificateDigest: string; home: string; checkedAt: string;
    status: string; checks: { primaryCanariesDenied: boolean; githubDenied: boolean; configFresh: boolean; providerToolsDenied?: boolean };
    comparisonEligibility?: { certifiedClean: boolean; reasons: string[] };
    primaryBlindingVersion?: number;
    hooksDigest?: string;
    candidateRuntimeCertified?: boolean; disallowedTools?: string[];
    primaryToolPolicy?: GitHubReviewEnrollmentEnvelope["primaryToolPolicy"] | null;
  }>>().notNull().default({}),
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
  state: text("state").$type<"pending" | "materialized" | "dispatched" | "unavailable" | "voided">().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("chat_github_candidates_arm_uq").on(t.enrollmentId, t.armId),
  uniqueIndex("chat_github_candidates_delivery_uq").on(t.nativeDeliveryId),
  index("chat_github_candidates_work_idx").on(t.state, t.nextAttemptAt),
  index("chat_github_candidates_agent_idx").on(t.companyId, t.agentId),
  foreignKey({ columns: [t.companyId, t.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id] }),
  foreignKey({ columns: [t.companyId, t.enrollmentId], foreignColumns: [chatGitHubReviewEnrollments.companyId, chatGitHubReviewEnrollments.id] }),
  foreignKey({ columns: [t.companyId, t.armId], foreignColumns: [chatGitHubReviewArms.companyId, chatGitHubReviewArms.id] }),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] }),
  foreignKey({ columns: [t.companyId, t.conversationId], foreignColumns: [chatConversations.companyId, chatConversations.id] }),
  foreignKey({ columns: [t.companyId, t.issueId], foreignColumns: [issues.companyId, issues.id] }),
  check("chat_github_candidates_label_check", sql`${t.shadowLabel} <> ''`),
  check("chat_github_candidates_state_check", sql`${t.state} in ('pending', 'materialized', 'dispatched', 'unavailable', 'voided')`),
]);
