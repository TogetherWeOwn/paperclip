import { and, desc, eq, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { chatDeliveries, chatGitHubReviewEnrollments, chatGitHubReviews } from "./schema/index.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Store = Db | Tx;

// Shared by the application and PostgreSQL plan tests. Keep these in the DB
// package so tests do not pull the entire server across the package rootDir.
export function githubPairPreviousAssessmentQuery(db: Store, input: {
  companyId: string; endpointId: string; repositoryId: string; pullNumber: number;
  roundOrdinal: number; snapshotStartedAt: Date; armId: string;
}) {
  return db.select({ review: chatGitHubReviews }).from(chatGitHubReviews)
    .innerJoin(chatGitHubReviewEnrollments, and(
      eq(chatGitHubReviewEnrollments.companyId, input.companyId),
      eq(chatGitHubReviewEnrollments.endpointId, input.endpointId),
      eq(chatGitHubReviewEnrollments.repositoryId, input.repositoryId),
      eq(chatGitHubReviewEnrollments.pullNumber, input.pullNumber),
      lt(chatGitHubReviewEnrollments.roundOrdinal, input.roundOrdinal),
      input.armId === "primary"
        ? sql`(${chatGitHubReviews.deliveryId} = ${chatGitHubReviewEnrollments.originDeliveryId}::text
            or ${chatGitHubReviews.admissionDeliveryId} = ${chatGitHubReviewEnrollments.originDeliveryId})`
        : sql`exists (select 1 from chat_github_review_candidates c where c.company_id = ${input.companyId}
            and c.enrollment_id = ${chatGitHubReviewEnrollments.id} and c.arm_id = ${input.armId}
            and c.native_delivery_id::text = ${chatGitHubReviews.deliveryId})`,
    )).where(and(eq(chatGitHubReviews.companyId, input.companyId), eq(chatGitHubReviews.endpointId, input.endpointId),
      isNotNull(chatGitHubReviews.assessment), lte(chatGitHubReviews.updatedAt, input.snapshotStartedAt),
      input.armId === "primary" ? isNull(chatGitHubReviews.shadowLabel) : isNotNull(chatGitHubReviews.shadowLabel)))
    .orderBy(desc(chatGitHubReviewEnrollments.roundOrdinal), desc(chatGitHubReviews.createdAt)).limit(1);
}

/** Keep seed-presence predicates literal so generic plans can prove the partial indexes apply. */
export function githubPairRoundOrdinalQuery(db: Store, input: { endpointId: string; repositoryId: string; pullNumber: number }) {
  return db.select({ ordinal: sql<number>`coalesce(max((${chatDeliveries.normalizedEvent}->'githubPairingSeed'->>'roundOrdinal')::integer), 0)` })
    .from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, input.endpointId),
      sql`${chatDeliveries.normalizedEvent} ? 'githubPairingSeed'`,
      sql`coalesce(${chatDeliveries.normalizedEvent}->'githubPairingSeed'->'envelope'->'event'->>'repositoryId', ${chatDeliveries.normalizedEvent}->'githubPairingSeed'->'envelope'->'unavailableEvent'->>'repositoryId') = ${input.repositoryId}`,
      sql`coalesce(${chatDeliveries.normalizedEvent}->'githubPairingSeed'->'envelope'->'event'->>'pullNumber', ${chatDeliveries.normalizedEvent}->'githubPairingSeed'->'envelope'->'unavailableEvent'->>'pullNumber') = ${String(input.pullNumber)}`));
}

export function githubPairSeedRecoveryQuery(db: Store, limit: number) {
  return db.select().from(chatDeliveries).where(sql`${chatDeliveries.normalizedEvent} ? 'githubPairingSeed'
    and not exists (select 1 from chat_github_review_enrollments e where e.origin_delivery_id = ${chatDeliveries.id})`).limit(limit);
}
