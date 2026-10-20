import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import {
  chatExternalPrincipals, chatGitHubConfigurations, chatIdentityLinks,
  companyMemberships, type Db,
} from "@paperclipai/db";
import { githubCommitSchema, githubIdSchema } from "@paperclipai/shared";
import { githubBotRepositoryToken, githubBotRequest } from "./chat-github-client.js";

type Store = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const providerId = z.union([githubIdSchema, z.number().int().positive().safe().transform(String)]);
const repository = z.object({ id: providerId }).nullable();
const pullProvenanceSchema = z.object({
  number: z.number().int().positive().safe(),
  base: z.object({ repo: repository }),
  head: z.object({ repo: repository, sha: githubCommitSchema }),
  user: z.object({ id: providerId, type: z.string() }),
});

/** Narrow API evidence only. Webhook authors, names and PR prose never fill gaps. */
export interface GitHubReviewProvenance {
  baseRepositoryId: string | null;
  headRepositoryId: string | null;
  authorId: string;
  authorIsBot: boolean;
  headSha: string;
}
export interface GitHubReviewExecutionTrustDecision {
  lowTrust: boolean;
  reason: "provenance_unavailable" | "cross_repository" | "linked_member_author" | "trusted_bot_author" | "outside_author";
}

export function githubReviewExecutionTrustDecision(input: {
  provenance: GitHubReviewProvenance | null;
  repositoryId: string;
  authorIsLinkedMember: boolean;
  trustedBotAuthorIds: readonly string[];
}): GitHubReviewExecutionTrustDecision {
  const p = input.provenance;
  if (!p || !githubIdSchema.safeParse(input.repositoryId).success ||
      !githubIdSchema.safeParse(p.baseRepositoryId).success ||
      !githubIdSchema.safeParse(p.headRepositoryId).success ||
      !githubIdSchema.safeParse(p.authorId).success || !githubCommitSchema.safeParse(p.headSha).success) {
    return { lowTrust: true, reason: "provenance_unavailable" };
  }
  if (p.baseRepositoryId !== input.repositoryId || p.headRepositoryId !== p.baseRepositoryId) {
    return { lowTrust: true, reason: "cross_repository" };
  }
  if (input.authorIsLinkedMember) return { lowTrust: false, reason: "linked_member_author" };
  if (p.authorIsBot === true && input.trustedBotAuthorIds.includes(p.authorId)) {
    return { lowTrust: false, reason: "trusted_bot_author" };
  }
  return { lowTrust: true, reason: "outside_author" };
}

/** Fetch before task/endpoint locks; token scope and fixed-origin client stay unchanged. */
export async function readGitHubReviewProvenance(db: Db, input: {
  companyId: string; endpointId: string; repositoryId: string; repository: string;
  threadId: string; expectedHeadSha?: string;
}, fetchImpl: typeof fetch): Promise<GitHubReviewProvenance | null> {
  const match = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):([1-9][0-9]*)(?::rc:[1-9][0-9]*)?$/.exec(input.threadId);
  if (!match || match[1]!.toLowerCase() !== input.repository.toLowerCase() ||
      !githubIdSchema.safeParse(input.repositoryId).success || !Number.isSafeInteger(Number(match[2]))) return null;
  try {
    const token = await githubBotRepositoryToken(db, input.companyId, input.endpointId, input.repositoryId, fetchImpl, "read");
    const raw = await githubBotRequest<unknown>(fetchImpl, token, `/repos/${input.repository}/pulls/${match[2]}`);
    const parsed = pullProvenanceSchema.safeParse(raw);
    if (!parsed.success || parsed.data.number !== Number(match[2])) return null;
    const pr = parsed.data;
    if (input.expectedHeadSha && pr.head.sha !== input.expectedHeadSha.toLowerCase()) return null;
    return {
      baseRepositoryId: pr.base.repo?.id ?? null, headRepositoryId: pr.head.repo?.id ?? null,
      authorId: pr.user.id, authorIsBot: pr.user.type === "Bot", headSha: pr.head.sha,
    };
  } catch {
    // No alternate credential, webhook fallback, or credential-bearing provider error.
    return null;
  }
}

/** Current endpoint links and company membership, not the sender's sponsor. */
export async function resolveGitHubReviewExecutionTrust(db: Store, input: {
  companyId: string; endpointId: string; repositoryId: string;
  provenance: GitHubReviewProvenance | null;
}): Promise<GitHubReviewExecutionTrustDecision> {
  const [saved] = await db.select().from(chatGitHubConfigurations).where(and(
    eq(chatGitHubConfigurations.companyId, input.companyId), eq(chatGitHubConfigurations.endpointId, input.endpointId),
  ));
  if (!saved || !input.provenance) return { lowTrust: true, reason: "provenance_unavailable" };
  const [link] = await db.select({ userId: chatIdentityLinks.paperclipUserId, status: chatIdentityLinks.status })
    .from(chatExternalPrincipals).innerJoin(chatIdentityLinks, and(
      eq(chatIdentityLinks.principalId, chatExternalPrincipals.id),
      eq(chatIdentityLinks.companyId, input.companyId), eq(chatIdentityLinks.endpointId, input.endpointId),
    )).where(and(
      eq(chatExternalPrincipals.companyId, input.companyId), eq(chatExternalPrincipals.provider, "github"),
      eq(chatExternalPrincipals.externalId, input.provenance.authorId),
    ));
  const [member] = link?.status === "linked" && link.userId ? await db.select({ userId: companyMemberships.principalId })
    .from(companyMemberships).where(and(
      eq(companyMemberships.companyId, input.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, link.userId), eq(companyMemberships.status, "active"),
      ne(companyMemberships.membershipRole, "viewer"),
    )) : [];
  const person = saved.configuration.people.find(p => p.githubUserId === input.provenance!.authorId);
  const authorIsLinkedMember = !!member && (saved.configuration.memberAccess === "all_linked" ||
    (person?.kind === "member" && person.userId === link?.userId));
  return githubReviewExecutionTrustDecision({ ...input, authorIsLinkedMember,
    trustedBotAuthorIds: link?.status === "revoked" ? [] : saved.configuration.trustedBotAuthorIds ?? [] });
}
