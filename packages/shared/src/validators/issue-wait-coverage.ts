import { z } from "zod";

export const registerIssueWaitCoverageSchema = z.object({
  serviceName: z.string().trim().min(1).max(200),
  externalRef: z.string().trim().min(1).max(2000),
  sourceKind: z.literal("github_pr"),
  eventRevision: z.string().trim().min(1).max(2000),
  armedRevision: z.string().trim().min(1).max(2000),
  observationStatus: z.enum(["ok", "error"]),
  observedAt: z.string().datetime(),
  armedAssigneeAgentId: z.string().uuid(),
  armedStatus: z.enum(["in_progress", "in_review"]),
  fallbackAt: z.string().datetime().nullable(),
}).strict();

export type RegisterIssueWaitCoverage = z.infer<typeof registerIssueWaitCoverageSchema>;

export const issueWaitCoverageSchema = registerIssueWaitCoverageSchema.extend({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  issueId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  unresolvedActionableEventAt: z.string().datetime().nullable(),
  registeredByActor: z.object({ type: z.enum(["board", "system"]), id: z.string().min(1) }).strict(),
  updatedAt: z.string().datetime(),
});

export type IssueWaitCoverage = z.infer<typeof issueWaitCoverageSchema>;
