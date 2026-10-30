import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { chatActions, chatDeliveries, chatEndpoints, chatEndpointResources,
  chatGitHubConfigurations, chatGitHubReviews, chatMessageLinks, companies,
  heartbeatRuns, type Db } from "@paperclipai/db";
import type { GitHubReviewEventContext } from "@paperclipai/shared";

export async function githubReviewCheckState(db: Db, action: typeof chatActions.$inferSelect) {
  const event = action.payload.event as GitHubReviewEventContext;
  const [source] = await db
    .select({
      endpoint: chatEndpoints,
      resource: chatEndpointResources,
      configuration: chatGitHubConfigurations.configuration,
      companyPrefix: companies.issuePrefix,
    })
    .from(chatEndpoints)
    .innerJoin(companies, eq(companies.id, chatEndpoints.companyId))
    .innerJoin(
      chatGitHubConfigurations,
      eq(chatGitHubConfigurations.endpointId, chatEndpoints.id),
    )
    .innerJoin(
      chatEndpointResources,
      eq(chatEndpointResources.endpointId, chatEndpoints.id),
    )
    .where(
      and(
        eq(chatEndpoints.id, action.endpointId),
        eq(chatEndpoints.companyId, action.companyId),
        eq(chatEndpointResources.providerResourceId, event.repository),
      ),
    );
  if (
    !source ||
    !source.configuration.toolsEnabled ||
    !["active", "verifying"].includes(source.endpoint.status) ||
    !source.resource.enabled ||
    source.resource.availability !== "available" ||
    String(source.resource.metadata?.providerRepositoryId) !==
      event.repositoryId ||
    ((source.endpoint.setup as { runtimeGeneration?: number })
      .runtimeGeneration ?? 0) !== action.payload.runtimeGeneration
  ) {
    return { disposition: "connection_changed" as const };
  }
  const [review] = await db
    .select()
    .from(chatGitHubReviews)
    .where(
      and(
        eq(chatGitHubReviews.endpointId, action.endpointId),
        eq(chatGitHubReviews.repositoryId, event.repositoryId),
        eq(chatGitHubReviews.pullNumber, event.pullNumber),
        eq(chatGitHubReviews.headSha, event.headSha),
      ),
    )
    .orderBy(desc(chatGitHubReviews.createdAt))
    .limit(1);
  if (review?.assessment) return { disposition: "assessment_owns_check" as const, reviewId: review.id };
  // A pending lifecycle also stores checkId, so that ID alone cannot prove
  // assessment publication. Keep recoverable publications in charge, but let a
  // replacement lifecycle proceed after permanent publication failure.
  let assessmentOwner:
    | { id: string; viable: boolean; publicationPending: boolean }
    | undefined;
  if (review) {
    const [owner] = await db
      .select()
      .from(chatGitHubReviews)
      .where(
        and(
          eq(chatGitHubReviews.endpointId, action.endpointId),
          eq(chatGitHubReviews.repositoryId, event.repositoryId),
          eq(chatGitHubReviews.pullNumber, event.pullNumber),
          eq(chatGitHubReviews.headSha, event.headSha),
          isNotNull(chatGitHubReviews.assessment),
        ),
      )
      .orderBy(desc(chatGitHubReviews.createdAt))
      .limit(1);
    if (owner) {
      const publications = await db
        .select({ status: chatActions.status, result: chatActions.result })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, action.companyId),
            eq(chatActions.endpointId, action.endpointId),
            eq(chatActions.kind, "github_review_publication"),
            sql`${chatActions.payload}->>'reviewId' = ${owner.id}`,
          ),
        );
      const publicationPending = publications.some(
        (publication) => publication.status === "received" ||
          (publication.status === "failed" && publication.result?.retryable === true),
      );
      const viable = publications.some((publication) => publication.status === "processed") ||
        (["completed", "incomplete"].includes(owner.state) &&
          (publications.length === 0 || publicationPending));
      assessmentOwner = { id: owner.id, viable, publicationPending };
    }
  }
  let run = review?.runId
    ? (
        await db
          .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, review.runId))
      )[0]
    : undefined;
  const manualAttempt = !!review?.runId && review.deliveryId === `run:${review.runId}:${review.headSha}`;
  let automaticAttempt = false;
  if (review && (!run || !manualAttempt)) {
    const [sourceRun] = await db
      .select({ run: { id: heartbeatRuns.id, status: heartbeatRuns.status },
        deliveryId: chatDeliveries.id, deliveryState: chatDeliveries.state })
      .from(chatDeliveries)
      .innerJoin(
        chatMessageLinks,
        eq(chatMessageLinks.deliveryId, chatDeliveries.id),
      )
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.companyId, action.companyId),
          eq(heartbeatRuns.agentId, source.endpoint.assignedAgentId),
          sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${chatMessageLinks.commentId}::text`,
        ),
      )
      .where(
        and(
          eq(chatDeliveries.companyId, action.companyId),
          eq(chatDeliveries.endpointId, action.endpointId),
          sql`${chatDeliveries.normalizedEvent}->'githubAutomatic'->'context'->>'deliveryId' = ${event.deliveryId}`,
          review.runId ? eq(heartbeatRuns.id, review.runId) : undefined,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1);
    run ??= sourceRun?.run;
    automaticAttempt = !!review.runId && action.payload.admitted === true &&
      sourceRun?.run.id === review.runId && sourceRun.deliveryId === review.deliveryId &&
      sourceRun.deliveryState === "processed";
  }
  const [delivery] = await db
    .select({ state: chatDeliveries.state })
    .from(chatDeliveries)
    .where(
      and(
        eq(chatDeliveries.endpointId, action.endpointId),
        sql`${chatDeliveries.normalizedEvent}->'githubAutomatic'->'context'->>'deliveryId' = ${event.deliveryId}`,
      ),
    )
    .limit(1);
  const admissionEnded =
    !review &&
    (delivery?.state === "filtered" || delivery?.state === "failed");
  const terminal =
    !!run &&
    [
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
      "interrupted",
    ].includes(run.status);
  const state: (typeof chatGitHubReviews.$inferSelect)["state"] =
    (!action.payload.admitted && !review) || admissionEnded
      ? "manual_required"
      : terminal
        ? run!.status === "succeeded"
          ? "incomplete"
          : "error"
        : run?.status === "running"
          ? "running"
          : "queued";
  const status =
    state === "running"
      ? "in_progress"
      : state === "queued"
        ? "queued"
        : "completed";
  const awaitingRun = !!review && !terminal && ["queued", "running"].includes(review.state) &&
    delivery?.state !== "filtered" && delivery?.state !== "failed";
  return { disposition: "publish" as const, source, review, run, terminal, state, status, assessmentOwner,
    authorizedAttempt: manualAttempt || automaticAttempt, awaitingRun };
}
