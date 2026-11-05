import { z } from "zod";

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = {
  expectedIssueRevision: revision,
  idempotencyKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(4000),
};
const obligation = { ...base, obligationId: z.string().uuid(), expectedObligationRevision: revision.positive() };

export const codeDeliveryDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("classify_code") }).strict(),
  z.object({ ...base, kind: z.literal("classify_non_code") }).strict(),
  z.object({ ...base, kind: z.literal("no_pr") }).strict(),
  z.object({ ...obligation, kind: z.literal("accept_head"), headSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  z.object({ ...obligation, kind: z.literal("closed_unmerged") }).strict(),
  z.object({ ...obligation, kind: z.literal("withdrawn") }).strict(),
  z.object({ ...obligation, kind: z.literal("transfer"), destinationIssueId: z.string().uuid(), expectedDestinationRevision: revision }).strict(),
]);

export const codeDeliveryAuthoritySchema = z.object({
  technicalAgentId: z.string().uuid(),
  expectedRevision: revision,
}).strict();

export type CodeDeliveryDecisionInput = z.infer<typeof codeDeliveryDecisionSchema>;
export type CodeDeliveryAuthorityInput = z.infer<typeof codeDeliveryAuthoritySchema>;
