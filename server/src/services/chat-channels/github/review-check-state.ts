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
  // An assessed sibling may still own this head's provider check even when a
  // newer unassessed row exists. Ownership is only viable while the assessment
  // actually has a remote check (checkId) or a publication attempt that is
  // still pending or retryable; a permanently unpublished assessment owns
  // nothing and must not suppress the replacement lifecycle.
  let assessmentOwner:
    | { id: string; viable: boolean }
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
      // The assessment owns while it has a remote check or while its terminal
      // review state has no proof that publication is dead: a publication
      // action that is still received or retryable may yet produce the check,
      // and the absence of any publication record means the stored result is
      // the standing lifecycle. Only an assessment whose publication failed
      // permanently (or a non-terminal assessed row, such as a superseded or
      // abandoned one) cannot consume the replacement check.
      let viable = owner.checkId != null;
      if (!viable && ["completed", "incomplete"].includes(owner.state)) {
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
        viable =
          publications.length === 0 ||
          publications.some(
            (publication) =>
              publication.status === "received" ||
              (publication.status === "failed" &&
                publication.result?.retryable === true),
          );
      }
      assessmentOwner = { id: owner.id, viable };
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
  if (review && !run) {
    const [sourceRun] = await db
      .select({ run: { id: heartbeatRuns.id, status: heartbeatRuns.status } })
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
          eq(chatDeliveries.endpointId, action.endpointId),
          sql`${chatDeliveries.normalizedEvent}->'githubAutomatic'->'context'->>'deliveryId' = ${event.deliveryId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1);
    run = sourceRun?.run;
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
  return { disposition: "publish" as const, source, review, run, terminal, state, status, assessmentOwner };
}
