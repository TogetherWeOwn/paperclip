import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { captureGitHubReviewSnapshot } from "./chat-github-review-snapshot.js";
import {
  agents, chatActions, chatConversations, chatDeliveries, chatEndpoints, chatGitHubConfigurations,
  chatGitHubReviewArms, chatGitHubReviewCandidates, chatGitHubReviewEnrollments,
  chatGitHubReviews, chatMessageLinks, chatEndpointResources, issueComments, heartbeatRuns, issues,
  githubPairPreviousAssessmentQuery, githubPairRoundOrdinalQuery, githubPairSeedRecoveryQuery,
  type Db, type GitHubReviewEnrollmentEnvelope,
} from "@paperclipai/db";
import { githubCommitSchema, type GitHubReviewEventContext, type GitHubReviewPolicy } from "@paperclipai/shared";
import { instanceSettingsService } from "./instance-settings.js";
import { githubBotRepositoryToken, githubBotRequest } from "./chat-github-client.js";
import { issueService } from "./issues.js";
import { githubChatPrincipalAccess } from "./chat-github-access.js";
import { initializeGitHubReviewTaskTrust } from "./chat-github-task-trust.js";
import { githubComparisonEligibility, githubPrimaryInputSource, githubRunComparisonEligibility, GITHUB_SHADOW_PROTOCOL } from "./chat-github-comparison.js";

// Re-export the exact application builders; their implementation lives in the
// DB package so its EXPLAIN tests remain within that package's TypeScript root.
export { githubPairPreviousAssessmentQuery, githubPairRoundOrdinalQuery, githubPairSeedRecoveryQuery };

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

async function selectedGitHubPairArms(db: Store, endpoint: Endpoint,
  config: typeof chatGitHubConfigurations.$inferSelect, eventId: string, repository: string,
) {
  const arms = await db.select().from(chatGitHubReviewArms).where(and(
    eq(chatGitHubReviewArms.companyId, endpoint.companyId), eq(chatGitHubReviewArms.endpointId, endpoint.id), isNull(chatGitHubReviewArms.retiredAt),
  ));
  return arms.filter(arm => {
    const route = config.configuration.shadowRoutes?.find(r => r.agentId === arm.agentId && r.label === arm.label && r.enabled);
    const draw = parseInt(digest([eventId, arm.id, config.revision]).slice(0, 13), 16) / 0x10000000000000;
    return route && draw < route.sampleRate
      && (route.repos === undefined || route.repos.some(repo => repo.toLowerCase() === repository.toLowerCase()));
  });
}

interface PendingPair {
  version: 1;
  admittedAt: string;
  settingsEpoch: string;
  disabled?: boolean;
  revision: number;
  providerEventId: string;
  arms: Array<{ id: string; agentId: string; label: string }>;
}

/** Primary admission records selection only. No provider I/O or snapshot work is
 * allowed on the primary task/comment/wake transaction's critical path. */
export async function stageGitHubPair(tx: Tx, input: {
  endpoint: Endpoint; deliveryId: string; repository: string; revision: number;
}) {
  if (!(await githubShadowEnabled(tx))) return;
  const [delivery] = await tx.select().from(chatDeliveries).where(eq(chatDeliveries.id, input.deliveryId));
  if (!delivery || delivery.githubShadowLabel || delivery.normalizedEvent.githubPairingSeed
    || delivery.normalizedEvent.githubPairingPending || delivery.normalizedEvent.githubPairingFailure) return;
  const [config] = await tx.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, input.endpoint.id));
  if (!config || config.configuration.shadow?.enabled) return;
  const arms = await selectedGitHubPairArms(tx, input.endpoint, config, delivery.providerEventId, input.repository);
  if (!arms.length) return;
  const [settings] = await tx.execute(sql`select xmin::text as epoch from instance_settings where singleton_key = 'default'`);
  if (!settings?.epoch) return;
  const pending: PendingPair = { version: 1, admittedAt: new Date().toISOString(), settingsEpoch: String(settings.epoch), revision: input.revision, providerEventId: delivery.providerEventId,
    arms: arms.map(({ id, agentId, label }) => ({ id, agentId, label })) };
  await tx.update(chatDeliveries).set({ normalizedEvent: sql`${chatDeliveries.normalizedEvent} || ${JSON.stringify({ githubPairingPending: pending })}::jsonb` })
    .where(eq(chatDeliveries.id, delivery.id));
}

export async function prepareGitHubPairEvent(db: Db, input: {
  endpoint: Endpoint; repositoryId: string; repository: string; threadId: string;
  eventId: string; principal: { externalId: string; handle: string | null };
  automatic?: GitHubReviewEventContext; manualEvent?: "mention" | "comment";
  pending?: PendingPair;
}, fetchImpl: typeof fetch): Promise<Pick<GitHubReviewEnrollmentEnvelope, "event" | "unavailableEvent" | "snapshot" | "snapshotFailure"> | null> {
  if (!(await githubShadowEnabled(db))) return null;
  if (!input.pending) {
    const [config] = await db.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, input.endpoint.id));
    if (!config?.configuration.shadowRoutes?.some(r => r.enabled && r.sampleRate > 0) || config.configuration.shadow?.enabled) return null;
    if (!(await selectedGitHubPairArms(db, input.endpoint, config, input.eventId, input.repository)).length) return null;
  }
  const captureDeadline = AbortSignal.timeout(15_000);
  // Also bound transports that ignore AbortSignal. Never let one candidate's
  // stalled read hold the recovery sweep forever; late responses are discarded.
  const boundedFetch: typeof fetch = async (url, init) => {
    const signal = init?.signal ? AbortSignal.any([init.signal, captureDeadline]) : captureDeadline;
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([fetchImpl(url, { ...init, signal }), cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
  };
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
    // jsonb cannot represent NUL. Preserve the sampled denominator rather than
    // dropping the enrollment or silently changing the review's input bytes.
    const containsNul = (value: unknown): boolean => typeof value === "string" ? value.includes("\u0000")
      : !!value && typeof value === "object" && Object.values(value).some(containsNul);
    if (containsNul(event)) return {
      event: null, unavailableEvent, snapshotFailure: "admission_event_not_jsonb_safe",
    };
    prepared = true;
    if (!input.endpoint.botUsername || !input.endpoint.botExternalId) throw new Error("snapshot_bot_identity_missing");
    const snapshot = await captureGitHubReviewSnapshot({ request: path => githubBotRequest(boundedFetch, token, `/repos/${input.repository}${path}`) }, event,
      { login: input.endpoint.botUsername, appId: input.endpoint.botExternalId });
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
  admittedAt: string;
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

/** Candidate recovery holds the endpoint lock only after capture. The seed is
 * the durable fallback outbox if optional projection fails in its savepoint. */
export async function admitGitHubPair(tx: Tx, input: {
  endpoint: Endpoint; deliveryId: string; conversation: typeof chatConversations.$inferSelect;
  event: GitHubReviewEventContext | null; unavailableEvent?: GitHubReviewEnrollmentEnvelope["unavailableEvent"];
  request: string; policy: GitHubReviewPolicy; revision: number;
  authority: GitHubReviewEnrollmentEnvelope["authority"];
  snapshot?: GitHubReviewEnrollmentEnvelope["snapshot"];
  snapshotFailure?: string;
}) {
  // A failed observation still belongs in the denominator after disable. It
  // cannot carry snapshot bytes or materialize/wake a candidate.
  if (!(await githubShadowEnabled(tx)) && (!input.snapshotFailure || input.snapshot)) return;
  const [delivery] = await tx.select().from(chatDeliveries).where(eq(chatDeliveries.id, input.deliveryId));
  if (!delivery || delivery.githubShadowLabel || delivery.normalizedEvent.githubPairingSeed) return;
  const pending = delivery.normalizedEvent.githubPairingPending as PendingPair | undefined;
  if (!pending || pending.providerEventId !== delivery.providerEventId) return;
  // Selection is frozen with primary admission, never redrawn after a config
  // change. Retired/disabled arms remain in the denominator but cannot wake.
  const selected = pending.arms;
  if (!selected.length) return;
  const e = input.event ?? input.unavailableEvent;
  if (!e) throw new Error("paired_review_event_identity_missing");
  // Endpoint lock serializes allocation, including seeds not yet projected.
  const [prior] = await githubPairRoundOrdinalQuery(tx, {
    endpointId: input.endpoint.id, repositoryId: e.repositoryId, pullNumber: e.pullNumber,
  });
  const roundOrdinal = Number(prior?.ordinal ?? 0) + 1;
  const [primaryIssue] = await tx.select({ sourceTrust: issues.sourceTrust }).from(issues).where(eq(issues.id, input.conversation.issueId));
  const previousAssessments: NonNullable<GitHubReviewEnrollmentEnvelope["previousAssessments"]> = {};
  for (const armId of ["primary", ...selected.map(a => a.id)]) {
    previousAssessments[armId] = null;
    if (roundOrdinal === 1 || !input.snapshot) continue;
    const [priorReview] = await githubPairPreviousAssessmentQuery(tx, { companyId: input.endpoint.companyId,
      endpointId: input.endpoint.id, repositoryId: e.repositoryId, pullNumber: e.pullNumber,
      roundOrdinal, snapshotStartedAt: new Date(input.snapshot.startedAt), armId });
    if (priorReview?.review.assessment) previousAssessments[armId] = {
      headSha: priorReview.review.headSha, assessment: priorReview.review.assessment,
      issueId: priorReview.review.issueId, runId: priorReview.review.runId,
    };
  }
  const [primaryAgent] = await tx.select().from(agents).where(and(eq(agents.id, input.endpoint.assignedAgentId!), eq(agents.companyId, input.endpoint.companyId)));
  const { githubPairingPending: _pending, githubPairingCapture: _capture, ...normalizedEvent } = delivery.normalizedEvent;
  const seed: Seed = {
    version: 1, id: randomUUID(), admittedAt: new Date().toISOString(), roundOrdinal, revision: input.revision,
    pairKey: digest([1, delivery.companyId, delivery.endpointId, delivery.providerEventId, e.repositoryId, e.repository, e.pullNumber, input.event?.headSha ?? null, input.event?.baseSha ?? null, roundOrdinal, input.revision, digest(input.policy)]),
    envelope: { version: 1, event: input.event, unavailableEvent: input.unavailableEvent,
      protocol: GITHUB_SHADOW_PROTOCOL,
      comparisonEligibility: githubComparisonEligibility({ environmentCertified: false, selfTestRecorded: false,
        selfTestPassed: false, primaryBlindingActive: true, snapshotAvailable: !!input.snapshot, roundOrdinal }),
      primaryToolPolicy: primaryAgent ? { adapterType: primaryAgent.adapterType,
        engine: typeof primaryAgent.adapterConfig.engine === "string" ? primaryAgent.adapterConfig.engine : null,
        configDigest: digest(primaryAgent.adapterConfig), effectiveToolsVerified: false } : undefined,
      request: input.request, lowTrust: primaryIssue?.sourceTrust?.preset === "low_trust_review", policy: input.policy, authority: input.authority,
      snapshot: input.snapshot, snapshotFailure: input.snapshotFailure, previousAssessments,
      normalizedEvent,
      conversation: { resourceId: input.conversation.resourceId, externalConversationId: input.conversation.externalConversationId,
        externalThreadId: input.conversation.externalThreadId, externalLabel: input.conversation.externalLabel,
        providerUrl: input.conversation.providerUrl, communicationGuidance: input.conversation.communicationGuidance } },
    arms: selected.map(a => ({ id: a.id, agentId: a.agentId, label: a.label, nativeDeliveryId: randomUUID() })),
  };
  await tx.update(chatDeliveries).set({ normalizedEvent: sql`(${chatDeliveries.normalizedEvent} - 'githubPairingPending' - 'githubPairingCapture') || ${JSON.stringify({ githubPairingSeed: seed })}::jsonb` }).where(eq(chatDeliveries.id, delivery.id));
  try { await tx.transaction(inner => projectSeed(inner, delivery, seed)); }
  catch { /* Seed committed independently; projection recovery needs no live reads. */ }
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
  return row && row.state !== "voided" && await githubCandidateHeadMatchesPrimary(db, row) ? row : null;
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
    // A seed captured after this run began must never change its reader or its
    // previous-assessment source mid-turn. Missing/legacy timestamps fail closed.
    const seed = source.delivery.normalizedEvent.githubPairingSeed as Seed | undefined;
    const admittedBeforeRun = !!seed?.admittedAt
      && Date.parse(seed.admittedAt) <= (run.startedAt ?? run.createdAt).getTime();
    const enrollment = admittedBeforeRun && seed?.envelope.event ? { id: seed.id, envelope: seed.envelope, headSha: seed.envelope.event.headSha,
      baseSha: seed.envelope.event.baseSha, roundOrdinal: seed.roundOrdinal, configurationRevision: seed.revision } : null;
    return { ...source, candidate: null, enrollment };
  }
  const candidate = await githubCandidateBinding(db, { companyId: session.companyId, endpointId: source.endpoint.id,
    agentId: session.agentId, issueId: session.issueId, deliveryId: source.delivery.id, conversationId: source.conversation.id, commentId });
  if (!candidate || source.delivery.githubShadowLabel !== candidate.shadowLabel || source.conversation.githubShadowLabel !== candidate.shadowLabel) return null;
  const [enrollment] = await db.select().from(chatGitHubReviewEnrollments).where(and(eq(chatGitHubReviewEnrollments.id, candidate.enrollmentId), eq(chatGitHubReviewEnrollments.companyId, session.companyId)));
  return enrollment?.envelope.event && enrollment.headSha && enrollment.baseSha
    ? { ...source, candidate, enrollment: { ...enrollment, headSha: enrollment.headSha, baseSha: enrollment.baseSha,
        envelope: { ...enrollment.envelope, comparisonEligibility: githubRunComparisonEligibility(enrollment, candidate, session.runId,
          await githubPrimaryInputSource(db, enrollment)) } } } : null;
}

async function githubCandidateHeadMatchesPrimary(db: Store, candidate: Candidate): Promise<boolean> {
  const [mismatch] = await db.select({ id: chatGitHubReviews.id }).from(chatGitHubReviewEnrollments)
    .innerJoin(chatGitHubReviews, and(
      eq(chatGitHubReviews.companyId, chatGitHubReviewEnrollments.companyId),
      eq(chatGitHubReviews.endpointId, chatGitHubReviewEnrollments.endpointId),
      or(sql`${chatGitHubReviews.deliveryId} = ${chatGitHubReviewEnrollments.originDeliveryId}::text`,
        eq(chatGitHubReviews.admissionDeliveryId, chatGitHubReviewEnrollments.originDeliveryId)),
      isNull(chatGitHubReviews.shadowLabel), sql`${chatGitHubReviews.runId} is not null`,
      sql`${chatGitHubReviews.headSha} is distinct from ${chatGitHubReviewEnrollments.headSha}`,
    )).where(and(eq(chatGitHubReviewEnrollments.id, candidate.enrollmentId),
      eq(chatGitHubReviewEnrollments.companyId, candidate.companyId))).limit(1);
  if (!mismatch) return true;
  // The actual primary begin/submit receipt owns the head. Never retarget an
  // immutable candidate; invalidate it at wake, dispatch and every tool read.
  await db.update(chatGitHubReviewCandidates).set({ state: "voided", lastError: "head_mismatch", nextAttemptAt: null, updatedAt: new Date() })
    .where(and(eq(chatGitHubReviewCandidates.id, candidate.id), eq(chatGitHubReviewCandidates.companyId, candidate.companyId),
      sql`${chatGitHubReviewCandidates.state} <> 'voided'`));
  return false;
}

export async function githubCandidateMayWake(db: Store, candidate: Candidate): Promise<boolean> {
  if (candidate.state === "voided" || !(await githubShadowEnabled(db)) || !(await githubCandidateHeadMatchesPrimary(db, candidate))) return false;
  const [config] = await db.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, candidate.endpointId));
  const [arm] = await db.select().from(chatGitHubReviewArms).where(and(eq(chatGitHubReviewArms.id, candidate.armId), eq(chatGitHubReviewArms.companyId, candidate.companyId), isNull(chatGitHubReviewArms.retiredAt)));
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, candidate.agentId), eq(agents.companyId, candidate.companyId)));
  return !!arm && arm.endpointId === candidate.endpointId && arm.agentId === candidate.agentId && !!agent && !["paused", "terminated", "pending_approval"].includes(agent.status)
    && config?.configuration.shadowRoutes?.some(r => r.enabled && r.agentId === candidate.agentId && r.label === candidate.shadowLabel) === true;
}

interface PairCapture { id: string; startedAt: string; attempts: number; lastError?: string }
const MAX_PAIR_CAPTURE_ATTEMPTS = 3;

async function failGitHubPairCapture(db: Store, deliveryId: string, capture: PairCapture, reason: string) {
  // Preserve the selected arms for ALL_ASSIGNED/missing-pair accounting even
  // when no enrollment could be projected. Fence late workers by capture id.
  const normalizedEvent = capture.attempts >= MAX_PAIR_CAPTURE_ATTEMPTS
    ? sql`(${chatDeliveries.normalizedEvent} - 'githubPairingPending' - 'githubPairingCapture') ||
        jsonb_build_object('githubPairingFailure', (${chatDeliveries.normalizedEvent}->'githubPairingPending') ||
          ${JSON.stringify({ reason, attempts: capture.attempts })}::jsonb)`
    : sql`jsonb_set(${chatDeliveries.normalizedEvent}, '{githubPairingCapture,lastError}', to_jsonb(${reason}::text))`;
  await db.update(chatDeliveries).set({ normalizedEvent }).where(and(eq(chatDeliveries.id, deliveryId),
    sql`${chatDeliveries.normalizedEvent} ? 'githubPairingPending'`,
    sql`not (${chatDeliveries.normalizedEvent} ? 'githubPairingSeed')`,
    sql`${chatDeliveries.normalizedEvent}->'githubPairingCapture'->>'id' = ${capture.id}`));
}

const PAIR_CAPTURE_WINDOW_MS = 15_000;

async function pairCaptureFailure(db: Store, delivery: typeof chatDeliveries.$inferSelect, pending: PendingPair) {
  if (pending.disabled || !(await githubShadowEnabled(db))) return "admission_snapshot_disabled";
  // xmin changes on every committed settings rewrite, including an off/on pair
  // between recovery sweeps. Conservatively invalidate on unrelated changes too;
  // a stale selected event is never recaptured into a newer experimental window.
  const [settings] = await db.execute(sql`select xmin::text as epoch from instance_settings where singleton_key = 'default'`);
  if (!pending.settingsEpoch || pending.settingsEpoch !== settings?.epoch) return "admission_snapshot_disabled";
  const admittedAt = Date.parse(pending.admittedAt);
  if (!Number.isFinite(admittedAt) || admittedAt > Date.now() || Date.now() - admittedAt > PAIR_CAPTURE_WINDOW_MS)
    return "admission_snapshot_late";
  const [evidence] = await db.execute<{ started: boolean }>(sql`select (
    exists (select 1 from chat_github_reviews r where r.company_id = ${delivery.companyId}
      and r.endpoint_id = ${delivery.endpointId} and r.shadow_label is null
      and (r.delivery_id = ${delivery.id} or r.admission_delivery_id = ${delivery.id})
      and (r.run_id is not null or r.assessment is not null or r.state <> 'queued'))
    or exists (select 1 from chat_message_links l join heartbeat_runs r
      on r.company_id = l.company_id and r.context_snapshot->>'wakeCommentId' = l.comment_id::text
      where l.delivery_id = ${delivery.id} and l.direction = 'inbound'
        and (r.started_at is not null or r.status not in ('queued', 'pending')))
    or exists (select 1 from chat_publications p where p.company_id = ${delivery.companyId}
      and p.conversation_id = ${delivery.conversationId} and p.created_at >= ${new Date(admittedAt).toISOString()}::timestamptz)
  ) as started`);
  return evidence?.started ? "admission_snapshot_late" : undefined;
}

async function capturePendingGitHubPairs(db: Db, limit: number, fetchImpl: typeof fetch) {
  const pendingRows = await db.select().from(chatDeliveries).where(sql`${chatDeliveries.normalizedEvent} ? 'githubPairingPending'
    and not (${chatDeliveries.normalizedEvent} ? 'githubPairingSeed')
    and ${chatDeliveries.githubShadowLabel} is null
    and exists (select 1 from chat_actions a where a.delivery_id = ${chatDeliveries.id}
      and a.kind = 'inbound_wakeup' and a.status = 'processed'
      and a.result->>'code' in ('inbound_wakeup_durable', 'inbound_wakeup_already_durable'))
    and (not (${chatDeliveries.normalizedEvent} ? 'githubPairingCapture')
      or (${chatDeliveries.normalizedEvent}->'githubPairingCapture'->>'startedAt')::timestamptz <= ${new Date(Date.now() - 30_000).toISOString()}::timestamptz)`)
    .orderBy(asc(chatDeliveries.receivedAt), asc(chatDeliveries.id)).limit(limit);
  for (const row of pendingRows) {
    let capture: PairCapture | undefined;
    try {
      const claim = await db.transaction(async tx => {
        const [delivery] = await tx.select().from(chatDeliveries).where(eq(chatDeliveries.id, row.id)).for("update", { skipLocked: true });
        if (!delivery || delivery.normalizedEvent.githubPairingSeed || !delivery.normalizedEvent.githubPairingPending) return null;
        const previous = delivery.normalizedEvent.githubPairingCapture as PairCapture | undefined;
        if (previous && Date.now() - Date.parse(previous.startedAt) < 30_000) return null;
        if (previous && previous.attempts >= MAX_PAIR_CAPTURE_ATTEMPTS) {
          await failGitHubPairCapture(tx, delivery.id, previous, previous.lastError ?? "pair_capture_interrupted");
          return null;
        }
        const capture: PairCapture = { id: randomUUID(), startedAt: new Date().toISOString(),
          attempts: (previous ? previous.attempts ?? 1 : 0) + 1 };
        await tx.update(chatDeliveries).set({ normalizedEvent: sql`${chatDeliveries.normalizedEvent} || ${JSON.stringify({ githubPairingCapture: capture })}::jsonb` })
          .where(eq(chatDeliveries.id, delivery.id));
        return { delivery, capture, interrupted: !!previous };
      });
      if (!claim) continue;
      capture = claim.capture;
      const { delivery } = claim;
      const pending = delivery.normalizedEvent.githubPairingPending as PendingPair;
      const [source] = await db.select({ endpoint: chatEndpoints, conversation: chatConversations, resource: chatEndpointResources, comment: issueComments })
        .from(chatMessageLinks).innerJoin(chatEndpoints, eq(chatEndpoints.id, chatMessageLinks.endpointId))
        .innerJoin(chatConversations, eq(chatConversations.id, chatMessageLinks.conversationId))
        .innerJoin(chatEndpointResources, eq(chatEndpointResources.id, chatConversations.resourceId))
        .innerJoin(issueComments, eq(issueComments.id, chatMessageLinks.commentId))
        .where(and(eq(chatMessageLinks.deliveryId, delivery.id), eq(chatMessageLinks.direction, "inbound"), eq(chatMessageLinks.companyId, delivery.companyId))).limit(1);
      if (!source) {
        await failGitHubPairCapture(db, delivery.id, capture, "pair_source_missing");
        continue;
      }
      const automatic = delivery.normalizedEvent.githubAutomatic as { context: GitHubReviewEventContext; policy: GitHubReviewPolicy } | undefined;
      const manual = delivery.normalizedEvent.githubManual as { event: "mention" | "comment"; policy: GitHubReviewPolicy } | undefined;
      const policy = (manual ?? automatic)?.policy;
      const principal = delivery.normalizedEvent.principal as { externalId: string; handle: string | null };
      const authority = delivery.normalizedEvent.githubAuthority as GitHubReviewEnrollmentEnvelope["authority"];
      const threadId = source.conversation.externalThreadId;
      const match = /^github:([^:]+):([1-9][0-9]*)(?::rc:[1-9][0-9]*)?$/.exec(threadId);
      if (!policy || !authority || !match) {
        await failGitHubPairCapture(db, delivery.id, capture, "pair_context_invalid");
        continue;
      }
      const repositoryId = String(source.resource.metadata?.providerRepositoryId ?? "");
      // Never capture post-primary signals or revive an observation across a
      // disable window. Recheck after I/O too: the primary never waits for us.
      const unavailable = (snapshotFailure: string) => ({
        event: automatic?.context ?? null,
        unavailableEvent: { event: manual?.event ?? "mention" as const, deliveryId: pending.providerEventId,
          repositoryId, repository: source.resource.providerResourceId.toLowerCase(), pullNumber: Number(match[2]),
          sender: { id: principal.externalId, login: principal.handle ?? principal.externalId } },
        snapshotFailure,
      });
      const failure = await pairCaptureFailure(db, delivery, pending);
      const prepared = failure || claim.interrupted
        ? unavailable(failure ?? "admission_snapshot_interrupted")
        : await prepareGitHubPairEvent(db, { endpoint: source.endpoint, repositoryId, repository: source.resource.providerResourceId,
          threadId, eventId: pending.providerEventId, principal, automatic: automatic?.context, manualEvent: manual?.event, pending }, fetchImpl);
      await db.transaction(async tx => {
        const [endpoint] = await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, delivery.endpointId)).for("update");
        const [current] = await tx.select().from(chatDeliveries).where(eq(chatDeliveries.id, delivery.id)).for("update");
        if (!endpoint || !current || (current.normalizedEvent.githubPairingCapture as { id?: string } | undefined)?.id !== claim.capture.id) return;
        const finalFailure = await pairCaptureFailure(tx, current, current.normalizedEvent.githubPairingPending as PendingPair);
        const sealed = finalFailure ? unavailable(finalFailure) : prepared ?? unavailable("admission_snapshot_disabled");
        await admitGitHubPair(tx, { endpoint, deliveryId: delivery.id, conversation: source.conversation, ...sealed,
          request: source.comment.body, policy, revision: pending.revision, authority });
      });
    } catch {
      if (capture) await failGitHubPairCapture(db, row.id, capture, "pair_admission_failed");
    }
  }
}

export async function recoverGitHubReviewCandidates(db: Db, input: {
  limit: number;
  fetch?: typeof fetch;
  stage: (tx: Tx, source: { endpoint: Endpoint; deliveryId: string; conversation: typeof chatConversations.$inferSelect; commentId: string; principalId: string; actorUserId: string | null; agentId: string }) => Promise<void>;
  wake: (deliveryId: string) => Promise<boolean>;
}) {
  const enabled = await githubShadowEnabled(db);
  if (!enabled) {
    // Tombstone every pending selection, including in-flight captures and rows
    // beyond this sweep's limit. Re-enabling never makes those bytes timely.
    await db.update(chatDeliveries).set({ normalizedEvent: sql`jsonb_set(${chatDeliveries.normalizedEvent}, '{githubPairingPending,disabled}', 'true'::jsonb)` })
      .where(sql`${chatDeliveries.normalizedEvent} ? 'githubPairingPending' and not (${chatDeliveries.normalizedEvent} ? 'githubPairingSeed')`);
  }
  await capturePendingGitHubPairs(db, input.limit, input.fetch ?? fetch);
  const seeds = await githubPairSeedRecoveryQuery(db, input.limit);
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
          }).where(and(eq(chatGitHubReviewCandidates.id, candidate.id),
            sql`${chatGitHubReviewCandidates.state} <> 'voided'`));
          return null;
        };
        // A paused/disabled oldest arm must not monopolize a bounded sweep.
        // Keep the admitted denominator and retry if authority is restored.
        const [enrollment] = await tx.select().from(chatGitHubReviewEnrollments).where(eq(chatGitHubReviewEnrollments.id, candidate.enrollmentId));
        if (!enrollment?.envelope.snapshot || !enrollment.envelope.event || !enrollment.headSha || !enrollment.baseSha) {
          await tx.update(chatGitHubReviewCandidates).set({ state: "unavailable", lastError: "candidate_snapshot_unavailable", nextAttemptAt: null, updatedAt: new Date() })
            .where(eq(chatGitHubReviewCandidates.id, candidate.id));
          return null;
        }
        if (!(await githubCandidateMayWake(tx, candidate))) return defer("candidate_unavailable");
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
