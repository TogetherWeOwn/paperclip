import { z } from "zod";

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = {
  expectedIssueRevision: revision,
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(4000),
};
const obligation = { ...base, obligationId: z.string().uuid(), expectedObligationRevision: revision.positive() };
const discoveryIds = z.array(z.string().uuid()).max(128).refine(ids => new Set(ids).size === ids.length).optional();

export const codeDeliveryDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("classify_code") }).strict(),
  z.object({ ...base, kind: z.literal("classify_non_code") }).strict(),
  z.object({ ...base, kind: z.literal("no_pr"), discoveryIds }).strict(),
  z.object({ ...obligation, kind: z.literal("accept_head"), headSha: z.string().regex(/^[a-f0-9]{40}$/), discoveryIds }).strict(),
  z.object({ ...obligation, kind: z.literal("closed_unmerged") }).strict(),
  z.object({ ...obligation, kind: z.literal("withdrawn") }).strict(),
  z.object({ ...obligation, kind: z.literal("transfer"), destinationIssueId: z.string().uuid(), expectedDestinationRevision: revision }).strict(),
]);

export const codeDeliveryRegistrationSchema = z.object({
  expectedIssueRevision: revision,
  workspaceId: z.string().uuid(),
  repository: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/)
    .refine(value => ![".", ".."].includes(value.split("/")[1]!)),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  pullRequestNumber: z.number().int().positive().max(2_147_483_647),
  baseRef: z.string().min(1).max(255).regex(/^[^\x00-\x20\x7f]+$/),
  proposedHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

export type CodeDeliveryRegistrationInput = z.infer<typeof codeDeliveryRegistrationSchema>;

export const codeDeliveryAuthoritySchema = z.object({
  technicalAgentId: z.string().uuid(),
  expectedRevision: revision,
}).strict();

export type CodeDeliveryDecisionInput = z.infer<typeof codeDeliveryDecisionSchema>;
export type CodeDeliveryAuthorityInput = z.infer<typeof codeDeliveryAuthoritySchema>;
