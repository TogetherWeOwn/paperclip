import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { captureGitHubReviewSnapshot } from "./chat-github-review-snapshot.js";
import {
  agents, chatActions, chatConversations, chatDeliveries, chatEndpoints, chatGitHubConfigurations,
  chatGitHubReviewArms, chatGitHubReviewCandidates, chatGitHubReviewEnrollments,
  chatGitHubReviews, chatMessageLinks, heartbeatRuns, issues,
  type Db, type GitHubReviewEnrollmentEnvelope,
} from "@paperclipai/db";
import { githubCommitSchema, type GitHubReviewEventContext, type GitHubReviewPolicy } from "@paperclipai/shared";
import { instanceSettingsService } from "./instance-settings.js";
import { githubBotRepositoryToken, githubBotRequest } from "./chat-github-client.js";
import { issueService } from "./issues.js";
import { githubChatPrincipalAccess } from "./chat-github-access.js";
import { initializeGitHubReviewTaskTrust } from "./chat-github-task-trust.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Store = Db | Tx;
type Endpoint = typeof chatEndpoints.$inferSelect;
type Candidate = typeof chatGitHubReviewCandidates.$inferSelect;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Unknown/unreadable settings fail closed, never reset unrelated settings. */
export async function githubShadowEnabled(db: Store): Promise<boolean> {
  try { return (await instanceSettingsService(db as Db).getExperimental()).githubReviewShadowEnabled === true; }
  catch { return false; }
}

export async function prepareGitHubPairEvent(db: Db, input: {
  endpoint: Endpoint; repositoryId: string; repository: string; threadId: string;
  eventId: string; principal: { externalId: string; handle: string | null };
  automatic?: GitHubReviewEventContext; manualEvent?: "mention" | "comment";
}, fetchImpl: typeof fetch): Promise<Pick<GitHubReviewEnrollmentEnvelope, "event" | "unavailableEvent" | "snapshot" | "snapshotFailure"> | null> {
  if (!(await githubShadowEnabled(db))) return null;
  const [config] = await db.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, input.endpoint.id));
  if (!config?.configuration.shadowRoutes?.some(r => r.enabled && r.sampleRate > 0) || config.configuration.shadow?.enabled) return null;
  const captureDeadline = AbortSignal.timeout(15_000);
  const boundedFetch: typeof fetch = (url, init) => fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, captureDeadline]) : captureDeadline });
  const match = /^github:([^:]+):([1-9][0-9]*)(?::rc:[1-9][0-9]*)?$/.exec(input.threadId);
  if (!match || match[1]!.toLowerCase() !== input.repository.toLowerCase()) return null;
  const unavailableEvent: NonNullable<GitHubReviewEnrollmentEnvelope["unavailableEvent"]> = {
    event: input.manualEvent ?? "mention", deliveryId: input.eventId,
    repositoryId: input.repositoryId, repository: input.repository.toLowerCase(), pullNumber: Number(match[2]),
    sender: { id: input.principal.externalId, login: input.principal.handle ?? input.principal.externalId },
  };
  let event: GitHubReviewEventContext | null = input.automatic ?? null;
  let prepared = false;
  try {
    const token = await githubBotRepositoryToken(db, input.endpoint.companyId, input.endpoint.id, input.repositoryId, boundedFetch, "read");
    const pr = await githubBotRequest<{
      title: string; body: string | null; draft: boolean;
      head: { sha: string }; base: { sha: string; ref: string };
      user: { id: number; login: string; type?: string }; labels?: Array<{ name: string }>;
    }>(boundedFetch, token, `/repos/${input.repository}/pulls/${match[2]}`);
    event ??= {
      ...unavailableEvent,
      headSha: githubCommitSchema.parse(pr.head.sha), baseSha: githubCommitSchema.parse(pr.base.sha),
      baseBranch: pr.base.ref, title: pr.title, body: pr.body ?? "", draft: pr.draft,
      author: { id: String(pr.user.id), login: pr.user.login, isBot: pr.user.type === "Bot" },
      labels: (pr.labels ?? []).map(l => l.name),
    };
    prepared = true;
    const snapshot = await captureGitHubReviewSnapshot({ request: path => githubBotRequest(boundedFetch, token, `/repos/${input.repository}${path}`) }, event);
    return { event, snapshot };
  } catch {
    // Selection/denominator survive token and metadata failure too. Automatic
    // events keep their authenticated head; manual unknowns stay explicitly null.
    // Recovery only projects these bytes, never reconstructs a later live view.
    return { event, ...(!event ? { unavailableEvent } : {}),
      snapshotFailure: prepared ? "admission_snapshot_unavailable" : "source_preparation_failed" };
  }
}

interface Seed {
  version: 1;
  id: string;
  roundOrdinal: number;
  revision: number;
  pairKey: string;
  envelope: GitHubReviewEnrollmentEnvelope;
  arms: Array<{ id: string; agentId: string; label: string; nativeDeliveryId: string }>;
}

async function projectSeed(tx: Tx, delivery: typeof chatDeliveries.$inferSelect, seed: Seed) {
  if (!delivery.principalId) throw new Error("paired_review_principal_missing");
  const e = seed.envelope.event ?? seed.envelope.unavailableEvent;
  if (!e) throw new Error("paired_review_event_identity_missing");
  await tx.insert(chatGitHubReviewEnrollments).values({
    id: seed.id, companyId: delivery.companyId, endpointId: delivery.endpointId,
    originDeliveryId: delivery.id, originEventId: delivery.providerEventId, principalId: delivery.principalId,
    repositoryId: e.repositoryId, repository: e.repository, pullNumber: e.pullNumber,
    headSha: seed.envelope.event?.headSha ?? null, baseSha: seed.envelope.event?.baseSha ?? null, roundOrdinal: seed.roundOrdinal,
    configurationRevision: seed.revision, pairKey: seed.pairKey, envelope: seed.envelope,
  }).onConflictDoNothing();
  for (const arm of seed.arms) await tx.insert(chatGitHubReviewCandidates).values({
    companyId: delivery.companyId, endpointId: delivery.endpointId, enrollmentId: seed.id,
    armId: arm.id, agentId: arm.agentId, shadowLabel: arm.label, nativeDeliveryId: arm.nativeDeliveryId,
  }).onConflictDoNothing();
}

/** Called under the existing authenticated endpoint/task mutation lock. The seed
 * is the durable fallback outbox if optional projection fails in its savepoint. */
export async function admitGitHubPair(tx: Tx, input: {
  endpoint: Endpoint; deliveryId: string; conversation: typeof chatConversations.$inferSelect;
  event: GitHubReviewEventContext | null; unavailableEvent?: GitHubReviewEnrollmentEnvelope["unavailableEvent"];
  request: string; policy: GitHubReviewPolicy; revision: number;
  authority: GitHubReviewEnrollmentEnvelope["authority"];
  snapshot?: GitHubReviewEnrollmentEnvelope["snapshot"];
  snapshotFailure?: string;
}) {
  if (!(await githubShadowEnabled(tx))) return;
  const [delivery] = await tx.select().from(chatDeliveries).where(eq(chatDeliveries.id, input.deliveryId));
  if (!delivery || delivery.githubShadowLabel || delivery.normalizedEvent.githubPairingSeed) return;
  const [config] = await tx.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, input.endpoint.id));
  if (!config || config.configuration.shadow?.enabled) return;
  const arms = await tx.select().from(chatGitHubReviewArms).where(and(
    eq(chatGitHubReviewArms.companyId, input.endpoint.companyId), eq(chatGitHubReviewArms.endpointId, input.endpoint.id), isNull(chatGitHubReviewArms.retiredAt),
  ));
  const selected = arms.filter(arm => {
    const route = config.configuration.shadowRoutes?.find(r => r.agentId === arm.agentId && r.label === arm.label && r.enabled);
    const draw = parseInt(digest([delivery.providerEventId, arm.id, config.revision]).slice(0, 13), 16) / 0x10000000000000;
    return route && draw < route.sampleRate;
  });
  if (!selected.length) return;
  const e = input.event ?? input.unavailableEvent;
  if (!e) throw new Error("paired_review_event_identity_missing");
  // Endpoint lock serializes allocation, including seeds not yet projected.
  const [prior] = await tx.select({ ordinal: sql<number>`coalesce(max((${chatDeliveries.normalizedEvent}->'githubPairingSeed'->>'roundOrdinal')::integer), 0)` })
    .from(chatDeliveries).where(and(eq(chatDeliveries.endpointId, input.endpoint.id),
      sql`coalesce(${chatDeliveries.normalizedEvent}->'githubPairingSeed'->'envelope'->'event'->>'repositoryId', ${chatDeliveries.normalizedEvent}->'githubPairingSeed'->'envelope'->'unavailableEvent'->>'repositoryId') = ${e.repositoryId}`,
      sql`coalesce(${chatDeliveries.normalizedEvent}->'githubPairingSeed'->'envelope'->'event'->>'pullNumber', ${chatDeliveries.normalizedEvent}->'githubPairingSeed'->'envelope'->'unavailableEvent'->>'pullNumber') = ${String(e.pullNumber)}`));
  const roundOrdinal = Number(prior?.ordinal ?? 0) + 1;
  const [primaryIssue] = await tx.select({ sourceTrust: issues.sourceTrust }).from(issues).where(eq(issues.id, input.conversation.issueId));
  const previousAssessments: NonNullable<GitHubReviewEnrollmentEnvelope["previousAssessments"]> = {};
  for (const armId of ["primary", ...selected.map(a => a.id)]) {
    previousAssessments[armId] = null;
    if (roundOrdinal === 1 || !input.snapshot) continue;
    const [priorReview] = await tx.select({ review: chatGitHubReviews }).from(chatGitHubReviews)
      .innerJoin(chatGitHubReviewEnrollments, and(
        eq(chatGitHubReviewEnrollments.companyId, input.endpoint.companyId),
        eq(chatGitHubReviewEnrollments.endpointId, input.endpoint.id),
        eq(chatGitHubReviewEnrollments.repositoryId, e.repositoryId),
        eq(chatGitHubReviewEnrollments.pullNumber, e.pullNumber),
        lt(chatGitHubReviewEnrollments.roundOrdinal, roundOrdinal),
        armId === "primary"
          ? sql`${chatGitHubReviews.deliveryId} = ${chatGitHubReviewEnrollments.originDeliveryId}::text`
          : sql`exists (select 1 from chat_github_review_candidates c where c.company_id = ${input.endpoint.companyId}
              and c.enrollment_id = ${chatGitHubReviewEnrollments.id} and c.arm_id = ${armId}
              and c.native_delivery_id::text = ${chatGitHubReviews.deliveryId})`,
      )).where(and(eq(chatGitHubReviews.companyId, input.endpoint.companyId), eq(chatGitHubReviews.endpointId, input.endpoint.id),
        isNotNull(chatGitHubReviews.assessment), lte(chatGitHubReviews.updatedAt, new Date(input.snapshot.startedAt)),
        armId === "primary" ? isNull(chatGitHubReviews.shadowLabel) : isNotNull(chatGitHubReviews.shadowLabel)))
      .orderBy(desc(chatGitHubReviewEnrollments.roundOrdinal), desc(chatGitHubReviews.createdAt)).limit(1);
    if (priorReview?.review.assessment) previousAssessments[armId] = {
      headSha: priorReview.review.headSha, assessment: priorReview.review.assessment,
      issueId: priorReview.review.issueId, runId: priorReview.review.runId,
    };
  }
  const seed: Seed = {
    version: 1, id: randomUUID(), roundOrdinal, revision: input.revision,
    pairKey: digest([1, delivery.companyId, delivery.endpointId, delivery.providerEventId, e.repositoryId, e.repository, e.pullNumber, input.event?.headSha ?? null, input.event?.baseSha ?? null, roundOrdinal, input.revision, digest(input.policy)]),
    envelope: { version: 1, event: input.event, unavailableEvent: input.unavailableEvent,
      comparisonEligibility: { certifiedClean: false, reasons: ["primary_namespace_not_isolated", "candidate_runtime_not_certified",
        ...(!input.snapshot ? ["admission_snapshot_unavailable"] : []),
        ...(roundOrdinal > 1 ? ["longitudinal_arm_history"] : [])] },
      request: input.request, lowTrust: primaryIssue?.sourceTrust?.preset === "low_trust_review", policy: input.policy, authority: input.authority,
      snapshot: input.snapshot, snapshotFailure: input.snapshotFailure, previousAssessments,
      normalizedEvent: delivery.normalizedEvent,
      conversation: { resourceId: input.conversation.resourceId, externalConversationId: input.conversation.externalConversationId,
        externalThreadId: input.conversation.externalThreadId, externalLabel: input.conversation.externalLabel,
        providerUrl: input.conversation.providerUrl, communicationGuidance: input.conversation.communicationGuidance } },
    arms: selected.map(a => ({ id: a.id, agentId: a.agentId, label: a.label, nativeDeliveryId: randomUUID() })),
  };
  await tx.update(chatDeliveries).set({ normalizedEvent: sql`${chatDeliveries.normalizedEvent} || ${JSON.stringify({ githubPairingSeed: seed })}::jsonb` }).where(eq(chatDeliveries.id, delivery.id));
  try { await tx.transaction(inner => projectSeed(inner, delivery, seed)); }
  catch { /* Seed committed with the primary; recovery never needs a result. */ }
}

/** The one exact native capability resolver. Configuration alone grants nothing. */
export async function githubCandidateBinding(db: Store, input: {
  companyId: string; endpointId: string; agentId: string; issueId: string;
  deliveryId: string; conversationId: string; commentId: string;
}): Promise<Candidate | null> {
  const [row] = await db.select().from(chatGitHubReviewCandidates).where(and(
    eq(chatGitHubReviewCandidates.companyId, input.companyId), eq(chatGitHubReviewCandidates.endpointId, input.endpointId),
    eq(chatGitHubReviewCandidates.agentId, input.agentId), eq(chatGitHubReviewCandidates.issueId, input.issueId),
    eq(chatGitHubReviewCandidates.nativeDeliveryId, input.deliveryId), eq(chatGitHubReviewCandidates.conversationId, input.conversationId),
    eq(chatGitHubReviewCandidates.commentId, input.commentId),
  ));
  return row?.state === "voided" ? null : row ?? null;
}

export async function githubRunCapability(db: Store, session: {
  companyId: string; agentId: string | null; issueId: string | null; runId: string | null;
}) {
  if (!session.agentId || !session.issueId || !session.runId) return null;
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, session.companyId), eq(heartbeatRuns.agentId, session.agentId), eq(heartbeatRuns.id, session.runId)));
  if (!run || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) !== session.issueId) return null;
  const commentId = run.contextSnapshot?.wakeCommentId;
  if (typeof commentId !== "string") return null;
  const [source] = await db.select({ endpoint: chatEndpoints, delivery: chatDeliveries, conversation: chatConversations, issue: issues })
    .from(chatMessageLinks).innerJoin(chatDeliveries, eq(chatDeliveries.id, chatMessageLinks.deliveryId))
    .innerJoin(chatConversations, eq(chatConversations.id, chatMessageLinks.conversationId))
    .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatConversations.endpointId))
    .innerJoin(issues, eq(issues.id, chatConversations.issueId))
    .where(and(eq(chatMessageLinks.companyId, session.companyId), eq(chatMessageLinks.commentId, commentId),
      eq(chatMessageLinks.direction, "inbound"), eq(chatConversations.issueId, session.issueId), eq(chatEndpoints.provider, "github"), eq(issues.assigneeAgentId, session.agentId)));
  if (!source || source.delivery.companyId !== session.companyId || source.delivery.endpointId !== source.endpoint.id || source.delivery.conversationId !== source.conversation.id) return null;
  if (source.conversation.executionScope === "primary" && source.endpoint.assignedAgentId === session.agentId) {
    // The immutable source seed is authoritative even if its optional table
    // projection failed. Both arms must see the same admission-time bytes.
    const seed = source.delivery.normalizedEvent.githubPairingSeed as Seed | undefined;
    const enrollment = seed?.envelope.event ? { id: seed.id, envelope: seed.envelope, headSha: seed.envelope.event.headSha,
      baseSha: seed.envelope.event.baseSha, roundOrdinal: seed.roundOrdinal, configurationRevision: seed.revision } : null;
    return { ...source, candidate: null, enrollment };
  }
  const candidate = await githubCandidateBinding(db, { companyId: session.companyId, endpointId: source.endpoint.id,
    agentId: session.agentId, issueId: session.issueId, deliveryId: source.delivery.id, conversationId: source.conversation.id, commentId });
  if (!candidate || source.delivery.githubShadowLabel !== candidate.shadowLabel || source.conversation.githubShadowLabel !== candidate.shadowLabel) return null;
  const [enrollment] = await db.select().from(chatGitHubReviewEnrollments).where(and(eq(chatGitHubReviewEnrollments.id, candidate.enrollmentId), eq(chatGitHubReviewEnrollments.companyId, session.companyId)));
  return enrollment?.envelope.event && enrollment.headSha && enrollment.baseSha
    ? { ...source, candidate, enrollment: { ...enrollment, headSha: enrollment.headSha, baseSha: enrollment.baseSha } } : null;
}

export async function githubCandidateMayWake(db: Store, candidate: Candidate): Promise<boolean> {
  if (candidate.state === "voided" || !(await githubShadowEnabled(db))) return false;
  const [config] = await db.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, candidate.endpointId));
  const [arm] = await db.select().from(chatGitHubReviewArms).where(and(eq(chatGitHubReviewArms.id, candidate.armId), eq(chatGitHubReviewArms.companyId, candidate.companyId), isNull(chatGitHubReviewArms.retiredAt)));
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, candidate.agentId), eq(agents.companyId, candidate.companyId)));
  return !!arm && arm.endpointId === candidate.endpointId && arm.agentId === candidate.agentId && !!agent && !["paused", "terminated", "pending_approval"].includes(agent.status)
    && config?.configuration.shadowRoutes?.some(r => r.enabled && r.agentId === candidate.agentId && r.label === candidate.shadowLabel) === true;
}

export async function recoverGitHubReviewCandidates(db: Db, input: {
  limit: number;
  stage: (tx: Tx, source: { endpoint: Endpoint; deliveryId: string; conversation: typeof chatConversations.$inferSelect; commentId: string; principalId: string; actorUserId: string | null; agentId: string }) => Promise<void>;
  wake: (deliveryId: string) => Promise<boolean>;
}) {
  if (!(await githubShadowEnabled(db))) return 0;
  const seeds = await db.select().from(chatDeliveries).where(sql`${chatDeliveries.normalizedEvent} ? 'githubPairingSeed' and not exists (select 1 from chat_github_review_enrollments e where e.origin_delivery_id = ${chatDeliveries.id})`).limit(input.limit);
  for (const delivery of seeds) {
    try { await db.transaction(tx => projectSeed(tx, delivery, delivery.normalizedEvent.githubPairingSeed as Seed)); }
    catch { /* Durable seed remains pending; primary recovery is independent. */ }
  }
  const rows = await db.select().from(chatGitHubReviewCandidates).where(and(
    inArray(chatGitHubReviewCandidates.state, ["pending", "materialized"]),
    or(isNull(chatGitHubReviewCandidates.nextAttemptAt), lte(chatGitHubReviewCandidates.nextAttemptAt, new Date())),
  )).orderBy(asc(chatGitHubReviewCandidates.createdAt)).limit(input.limit);
  for (const row of rows) {
    try {
      const materialized = await db.transaction(async tx => {
        // All local materialization is one transaction; SKIP LOCKED is a crash-
        // safe claim, with no expiring lease held across provider/model I/O.
        const [candidate] = await tx.select().from(chatGitHubReviewCandidates).where(eq(chatGitHubReviewCandidates.id, row.id)).for("update", { skipLocked: true });
        if (!candidate || !["pending", "materialized"].includes(candidate.state)) return null;
        const defer = async (reason: string) => {
          await tx.update(chatGitHubReviewCandidates).set({
            lastError: reason, nextAttemptAt: new Date(Date.now() + 30_000), updatedAt: new Date(),
          }).where(eq(chatGitHubReviewCandidates.id, candidate.id));
          return null;
        };
        // A paused/disabled oldest arm must not monopolize a bounded sweep.
        // Keep the admitted denominator and retry if authority is restored.
        if (!(await githubCandidateMayWake(tx, candidate))) return defer("candidate_unavailable");
        const [enrollment] = await tx.select().from(chatGitHubReviewEnrollments).where(eq(chatGitHubReviewEnrollments.id, candidate.enrollmentId));
        if (!enrollment?.envelope.snapshot || !enrollment.envelope.event || !enrollment.headSha || !enrollment.baseSha) {
          await tx.update(chatGitHubReviewCandidates).set({ state: "unavailable", lastError: "candidate_snapshot_unavailable", nextAttemptAt: null, updatedAt: new Date() })
            .where(eq(chatGitHubReviewCandidates.id, candidate.id));
          return null;
        }
        if (candidate.state === "materialized") return candidate;
        const [endpoint] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, candidate.endpointId), eq(chatEndpoints.companyId, candidate.companyId)));
        if (!enrollment || !endpoint || !["active", "verifying"].includes(endpoint.status)) return defer("candidate_endpoint_unavailable");
        if (!(await githubChatPrincipalAccess(tx, endpoint, enrollment.principalId))?.allowed) return defer("candidate_principal_unavailable");
        const e = enrollment.envelope;
        const event = enrollment.envelope.event;
        const scope = `shadow:${candidate.armId}:${enrollment.id}`;
        const issue = await issueService(db).create(candidate.companyId, {
          title: `PR #${enrollment.pullNumber}: ${event.title}`, description: `Started from GitHub: ${e.conversation.externalLabel}`,
          status: "todo", priority: "medium", assigneeAgentId: candidate.agentId,
          createdByUserId: e.authority.responsibleUserId ?? e.authority.sponsorUserId,
          responsibleUserId: e.authority.responsibleUserId ?? e.authority.sponsorUserId,
          originKind: "chat_channel", originId: scope, idempotencyKey: scope,
        }, tx);
        const [agent] = await tx.select().from(agents).where(eq(agents.id, candidate.agentId));
        const lowTrust = e.lowTrust || e.authority.guest || agent?.permissions?.trustPreset === "low_trust_review";
        if (lowTrust) await initializeGitHubReviewTaskTrust(tx, issue, candidate.agentId);
        const [conversation] = await tx.insert(chatConversations).values({
          ...e.conversation, companyId: candidate.companyId, endpointId: endpoint.id, issueId: issue.id,
          executionScope: scope, githubShadowLabel: candidate.shadowLabel, state: "active", lastActivityAt: new Date(),
        }).returning();
        const [origin] = await tx.select().from(chatDeliveries).where(eq(chatDeliveries.id, enrollment.originDeliveryId));
        await tx.insert(chatDeliveries).values({
          id: candidate.nativeDeliveryId, companyId: candidate.companyId, endpointId: endpoint.id, conversationId: conversation!.id,
          principalId: enrollment.principalId, providerEventId: `paired:${enrollment.id}:${candidate.armId}`, deduplicationKey: scope,
          eventKind: origin!.eventKind, githubShadowLabel: candidate.shadowLabel, state: "processed", processedAt: new Date(),
          normalizedEvent: { ...e.normalizedEvent, githubAuthority: e.authority, githubPairedCandidate: candidate.id,
            // Candidate reads/review validation must use this frozen event.
            githubPairedEvent: e.event, githubPairedPolicy: e.policy, githubPairedRevision: enrollment.configurationRevision },
        });
        const comment = await issueService(db).addComment(issue.id, e.request,
          e.authority.responsibleUserId ? { userId: e.authority.responsibleUserId } : {},
          { authorType: e.authority.responsibleUserId ? "user" : "system",
            sourceTrust: e.authority.guest ? { preset: "low_trust_review", disposition: "quarantined", sourceIssueId: issue.id } : null }, tx);
        await tx.insert(chatMessageLinks).values({ companyId: candidate.companyId, endpointId: endpoint.id,
          conversationId: conversation!.id, deliveryId: candidate.nativeDeliveryId, commentId: comment.id,
          providerMessageId: `paired:${candidate.id}`, direction: "inbound" });
        const [bound] = await tx.update(chatGitHubReviewCandidates).set({ issueId: issue.id, conversationId: conversation!.id,
          commentId: comment.id, state: "materialized", attempts: candidate.attempts + 1, updatedAt: new Date() })
          .where(eq(chatGitHubReviewCandidates.id, candidate.id)).returning();
        await tx.insert(chatGitHubReviews).values({ companyId: candidate.companyId, endpointId: endpoint.id, issueId: issue.id,
          repositoryId: enrollment.repositoryId, repository: enrollment.repository, pullNumber: enrollment.pullNumber, headSha: enrollment.headSha,
          deliveryId: candidate.nativeDeliveryId, configurationRevision: enrollment.configurationRevision, policySnapshot: e.policy, event,
          state: "queued", shadowLabel: candidate.shadowLabel });
        await input.stage(tx, { endpoint, deliveryId: candidate.nativeDeliveryId, conversation: conversation!, commentId: comment.id,
          principalId: enrollment.principalId, actorUserId: e.authority.responsibleUserId, agentId: candidate.agentId });
        await tx.update(chatActions).set({ status: "issued", updatedAt: new Date() }).where(and(eq(chatActions.deliveryId, candidate.nativeDeliveryId), eq(chatActions.kind, "inbound_wakeup")));
        return bound!;
      });
      if (!materialized || !(await githubCandidateMayWake(db, materialized))) continue;
      if (await input.wake(materialized.nativeDeliveryId)) {
        const [action] = await db.select().from(chatActions).where(and(
          eq(chatActions.deliveryId, materialized.nativeDeliveryId), eq(chatActions.kind, "inbound_wakeup"),
        ));
        const dispatched = action?.status === "processed"
          && ["inbound_wakeup_durable", "inbound_wakeup_already_durable"].includes(String(action.result?.code));
        await db.update(chatGitHubReviewCandidates).set({
          state: dispatched ? "dispatched" : "unavailable", nextAttemptAt: null,
          lastError: dispatched ? null : "candidate_wake_denied", updatedAt: new Date(),
        }).where(and(eq(chatGitHubReviewCandidates.id, materialized.id), sql`${chatGitHubReviewCandidates.state} <> 'voided'`));
      } else {
        // Native wake receipt recovery owns retry/idempotency. A retrying arm
        // must yield its bounded outbox slot to other admitted events meanwhile.
        await db.update(chatGitHubReviewCandidates).set({
          lastError: "candidate_wake_pending", nextAttemptAt: new Date(Date.now() + 30_000), updatedAt: new Date(),
        }).where(and(eq(chatGitHubReviewCandidates.id, materialized.id), sql`${chatGitHubReviewCandidates.state} <> 'voided'`));
      }
    } catch {
      await db.update(chatGitHubReviewCandidates).set({ lastError: "candidate_materialization_or_wake_failed", nextAttemptAt: new Date(Date.now() + 30_000), updatedAt: new Date() }).where(and(eq(chatGitHubReviewCandidates.id, row.id), sql`${chatGitHubReviewCandidates.state} <> 'voided'`));
    }
  }
  return rows.length;
}
