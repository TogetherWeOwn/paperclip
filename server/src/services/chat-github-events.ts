import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  chatConversations,
  chatEndpoints,
  chatEndpointResources,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatGitHubReviews,
  chatIdentityLinks,
  companyMemberships,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  githubCommitSchema,
  githubIdSchema,
  type GitHubReviewEventContext,
} from "@paperclipai/shared";
import {
  effectiveGitHubReviewPolicy,
  githubReviewSchedulingDecision,
} from "./chat-github-review-policy.js";

const id = z.union([
  githubIdSchema,
  z.number().int().positive().safe().transform(String),
]);
const person = z.object({
  id,
  login: z.string().min(1).max(100),
  type: z.string().optional(),
});
const payloadSchema = z.object({
  action: z.enum(["opened", "synchronize", "reopened", "ready_for_review"]),
  repository: z.object({
    id,
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  }),
  sender: person,
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().max(1000),
    body: z.string().nullable(),
    draft: z.boolean(),
    base: z.object({ sha: githubCommitSchema, ref: z.string() }),
    head: z.object({ sha: githubCommitSchema }),
    user: person,
    labels: z.array(z.object({ name: z.string() })).default([]),
  }),
  before: githubCommitSchema.optional(),
});

/** Called only after signature and installed-repository admission. */
export function githubAutomaticReviewEvent(
  payload: unknown,
  deliveryId: string,
): GitHubReviewEventContext | null {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { data } = parsed;
  const pr = data.pull_request;
  return {
    event: data.action,
    deliveryId,
    repositoryId: data.repository.id,
    repository: data.repository.full_name.toLowerCase(),
    pullNumber: pr.number,
    title: pr.title,
    body: (pr.body ?? "").slice(0, 24000),
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
    author: {
      id: pr.user.id,
      login: pr.user.login,
      isBot: pr.user.type === "Bot",
    },
    sender: { id: data.sender.id, login: data.sender.login },
    draft: pr.draft,
    labels: pr.labels.map((label) => label.name),
    previousHeadSha: data.before,
  };
}

export async function githubAutomaticAdmission(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
  endpoint: typeof chatEndpoints.$inferSelect,
  context: GitHubReviewEventContext,
) {
  const [saved] = await db
    .select()
    .from(chatGitHubConfigurations)
    .where(
      and(
        eq(chatGitHubConfigurations.companyId, endpoint.companyId),
        eq(chatGitHubConfigurations.endpointId, endpoint.id),
      ),
    );
  if (!saved) return null;
  const [resource] = await db
    .select()
    .from(chatEndpointResources)
    .where(
      and(
        eq(chatEndpointResources.companyId, endpoint.companyId),
        eq(chatEndpointResources.endpointId, endpoint.id),
        eq(
          chatEndpointResources.providerResourceId,
          context.repository.toLowerCase(),
        ),
      ),
    );
  const [link] = await db
    .select({
      userId: chatIdentityLinks.paperclipUserId,
      status: chatIdentityLinks.status,
    })
    .from(chatExternalPrincipals)
    .innerJoin(
      chatIdentityLinks,
      eq(chatIdentityLinks.principalId, chatExternalPrincipals.id),
    )
    .where(
      and(
        eq(chatExternalPrincipals.companyId, endpoint.companyId),
        eq(chatExternalPrincipals.provider, "github"),
        eq(chatExternalPrincipals.externalId, context.author.id),
        eq(chatIdentityLinks.endpointId, endpoint.id),
      ),
    );
  const members = await db
    .select()
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, endpoint.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );
  const active = new Set(
    members
      .filter((member) => member.membershipRole !== "viewer")
      .map((member) => member.principalId),
  );
  const decision = githubReviewSchedulingDecision({
    configuration: saved.configuration,
    context,
    repositoryEnabled:
      !!resource?.enabled &&
      resource.availability === "available" &&
      String(resource.metadata?.providerRepositoryId) === context.repositoryId,
    linkedMemberUserId:
      link?.status === "linked" && link.userId && active.has(link.userId)
        ? link.userId
        : null,
    activeSponsorUserIds: active,
    manual: false,
  });
  // An explicitly revoked link must not regain authority through guest fallback.
  if (link?.status === "revoked")
    return {
      ...decision,
      allowed: false,
      reason: "identity_revoked",
      revision: saved.revision,
      policy: effectiveGitHubReviewPolicy(
        saved.configuration,
        context.repositoryId,
      ),
    };
  return {
    ...decision,
    revision: saved.revision,
    policy: effectiveGitHubReviewPolicy(
      saved.configuration,
      context.repositoryId,
    ),
  };
}

export async function githubPreviousAssessment(
  db: Db,
  endpoint: typeof chatEndpoints.$inferSelect,
  repositoryId: string,
  pullNumber: number,
) {
  const [review] = await db
    .select()
    .from(chatGitHubReviews)
    .where(
      and(
        eq(chatGitHubReviews.companyId, endpoint.companyId),
        eq(chatGitHubReviews.endpointId, endpoint.id),
        eq(chatGitHubReviews.repositoryId, repositoryId),
        eq(chatGitHubReviews.pullNumber, pullNumber),
        isNotNull(chatGitHubReviews.assessment),
      ),
    )
    .orderBy(desc(chatGitHubReviews.createdAt))
    .limit(1);
  return review ?? null;
}

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const GITHUB_PULL_THREAD_PATTERN = /^github:([^/:]+\/[^/:]+):([1-9][0-9]*)$/;

/**
 * Normalized key for a PR-level GitHub thread (`github:<owner>/<repo>:<pr>`),
 * or null for review-comment (`:rc:`), issue (`:issue:`), and non-GitHub threads.
 *
 * Repository matching is case-insensitive: GitHub owner/repo names are
 * case-preserving but not case-significant, while inbound webhook payloads
 * vary (`Acme/app` vs `acme/app`). Without this, the same
 * PR binds one card per casing and the reviewer queue fills with duplicates.
 */
export function githubPullThreadKey(threadId: string): string | null {
  const match = GITHUB_PULL_THREAD_PATTERN.exec(threadId);
  if (!match) return null;
  return `github:${match[1]!.toLowerCase()}:${match[2]!}`;
}

/**
 * Every non-terminal card is reusable: a blocked or in-review card is still
 * the PR's one card, and a new event must land on it rather than beside it.
 */
export const GITHUB_PULL_REUSABLE_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
] as const;

/**
 * One live card per repo:PR. When a PR-level thread has no bound conversation
 * (e.g. an earlier card was opened under a differently-cased thread id),
 * reuse the newest active conversation whose issue is not done or cancelled instead of
 * spawning a duplicate card. Returns null when no open card exists.
 */
export async function reuseOpenGitHubPullConversation(
  database: DbOrTransaction,
  input: { companyId: string; endpointId: string; threadId: string },
): Promise<{
  conversation: typeof chatConversations.$inferSelect;
  issue: typeof issues.$inferSelect;
} | null> {
  const key = githubPullThreadKey(input.threadId);
  if (!key) return null;
  const [match] = await database
    .select({ conversation: chatConversations, issue: issues })
    .from(chatConversations)
    .innerJoin(
      issues,
      and(
        eq(issues.id, chatConversations.issueId),
        eq(issues.companyId, chatConversations.companyId),
      ),
    )
    .where(
      and(
        eq(chatConversations.companyId, input.companyId),
        eq(chatConversations.endpointId, input.endpointId),
        sql`lower(${chatConversations.externalThreadId}) = ${key}`,
        inArray(chatConversations.state, ["active", "waiting"]),
        inArray(issues.status, [...GITHUB_PULL_REUSABLE_ISSUE_STATUSES]),
      ),
    )
    .orderBy(desc(chatConversations.createdAt))
    .limit(1);
  return match ?? null;
}
