import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { chatActions, chatDeliveries, chatEndpoints, chatEndpointResources,
  chatGitHubConfigurations, chatGitHubReviews, chatMessageLinks, companies,
  heartbeatRuns, type Db } from "@paperclipai/db";
import type { GitHubReviewEventContext } from "@paperclipai/shared";

type Review = typeof chatGitHubReviews.$inferSelect;

type Check = { id: number; external_id?: string; app?: { id?: number }; status?: string };

export function githubAssessmentCheckDigest(review: Review) {
  return createHash("sha256").update(JSON.stringify({ reviewId: review.id,
    runId: review.runId, headSha: review.headSha, assessment: review.assessment })).digest("hex");
}

export async function githubReviewAttemptIsAuthorized(db: Db, review: Review, agentId: string) {
  if (!review.runId) return false;
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, review.runId), eq(heartbeatRuns.companyId, review.companyId),
    eq(heartbeatRuns.agentId, agentId),
  ));
  if (!run) return false;
  if (review.deliveryId === `run:${review.runId}:${review.headSha}`) return true;
  const [claimed] = await db.select({ id: chatDeliveries.id }).from(chatDeliveries)
    .innerJoin(chatMessageLinks, and(eq(chatMessageLinks.deliveryId, chatDeliveries.id),
      eq(chatMessageLinks.companyId, review.companyId), eq(chatMessageLinks.endpointId, review.endpointId)))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, review.runId),
      sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${chatMessageLinks.commentId}::text`))
    .where(and(eq(chatDeliveries.id, review.deliveryId), eq(chatDeliveries.companyId, review.companyId),
      eq(chatDeliveries.endpointId, review.endpointId), eq(chatDeliveries.state, "processed"),
      sql`${chatDeliveries.normalizedEvent}->'githubAutomatic'->'context'->>'deliveryId' = ${review.event.deliveryId}`))
    .limit(1);
  return !!claimed;
}

export async function githubNewerReviewAttempt(db: Db, review: Review, agentId: string) {
  const newer = await db.select().from(chatGitHubReviews).where(and(
    eq(chatGitHubReviews.companyId, review.companyId), eq(chatGitHubReviews.endpointId, review.endpointId),
    eq(chatGitHubReviews.repositoryId, review.repositoryId), eq(chatGitHubReviews.pullNumber, review.pullNumber),
    eq(chatGitHubReviews.headSha, review.headSha),
    gt(chatGitHubReviews.createdAt, sql`(select r.created_at from chat_github_reviews r where r.id = ${review.id})`),
  )).orderBy(desc(chatGitHubReviews.createdAt));
  for (const candidate of newer) {
    if (candidate.assessment || await githubReviewAttemptIsAuthorized(db, candidate, agentId)) return candidate;
  }
  return undefined;
}

export async function githubReviewCheckTarget(db: Db, checks: Check[], review: Review | undefined,
  externalId: string, appId: string | null, result: Record<string, unknown> | null, requireBinding: boolean) {
  const matching = checks.filter(item => item.external_id === externalId && String(item.app?.id) === appId);
  const checkId = review?.checkId ?? (result?.checkReviewId === review?.id ? result?.checkId : undefined);
  if (checkId) {
    const bound = matching.find(item => String(item.id) === checkId);
    if (!bound) throw new Error("GitHub attempt check receipt is unavailable");
    return bound;
  }
  const intent = result?.checkIntent as { reviewId?: string; beforeIds?: number[] } | undefined;
  if (intent) {
    if (intent.reviewId !== review?.id || !Array.isArray(intent.beforeIds))
      throw new Error("GitHub check creation binding changed");
    const recovered = matching.filter(item => !intent.beforeIds!.includes(item.id));
    if (recovered.length !== 1) throw new Error("GitHub check creation is unresolved");
    return recovered[0];
  }
  const siblings = matching.length && review ? await db.select({ checkId: chatGitHubReviews.checkId }).from(chatGitHubReviews).where(and(
    eq(chatGitHubReviews.companyId, review.companyId), eq(chatGitHubReviews.endpointId, review.endpointId),
    eq(chatGitHubReviews.repositoryId, review.repositoryId), eq(chatGitHubReviews.pullNumber, review.pullNumber),
    eq(chatGitHubReviews.headSha, review.headSha),
  )) : [];
  const owned = new Set(siblings.map(item => item.checkId));
  const unbound = matching.filter(item => !owned.has(String(item.id)));
  if (requireBinding && unbound.length) throw new Error("GitHub attempt check binding is unresolved");
  if (unbound.length > 1) throw new Error("GitHub check binding is ambiguous");
  return unbound[0];
}

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
        eq(chatGitHubReviews.companyId, action.companyId),
        eq(chatGitHubReviews.endpointId, action.endpointId),
        eq(chatGitHubReviews.repositoryId, event.repositoryId),
        eq(chatGitHubReviews.pullNumber, event.pullNumber),
        eq(chatGitHubReviews.headSha, event.headSha),
        or(eq(chatGitHubReviews.deliveryId, event.deliveryId),
          sql`${chatGitHubReviews.event}->>'deliveryId' = ${event.deliveryId}`),
      ),
    )
    .orderBy(desc(chatGitHubReviews.createdAt))
    .limit(1);
  if (review?.assessment) return { disposition: "assessment_owns_check" as const, reviewId: review.id };
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
      const confirmed = owner.publicationReceipts.check;
      const viable = (!!owner.checkId && confirmed?.id === owner.checkId &&
          confirmed.digest === githubAssessmentCheckDigest(owner)) ||
        publications.some((publication) => publication.status === "processed") ||
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
          .where(and(eq(heartbeatRuns.id, review.runId), eq(heartbeatRuns.companyId, action.companyId),
            eq(heartbeatRuns.agentId, source.endpoint.assignedAgentId!)))
      )[0]
    : undefined;
  const authorizedAttempt = !!review && await githubReviewAttemptIsAuthorized(db, review, source.endpoint.assignedAgentId!);
  const newerAttempt = review ? await githubNewerReviewAttempt(db, review, source.endpoint.assignedAgentId!) : undefined;
  if (review && !run && !review.runId) {
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
    authorizedAttempt, awaitingRun, newerAttempt };
}
