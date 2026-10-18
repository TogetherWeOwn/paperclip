import { and, eq, inArray } from "drizzle-orm";
import { companySecretBindings, issues, type Db } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, LOW_TRUST_REVIEW_PRESET_VERSION, LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION } from "@paperclipai/shared";
type Store = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const LOW_TRUST_MODEL_CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY",
  "CODEX_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "GROK_API_KEY",
] as const;
export function lowTrustModelCredentialConfigPaths(): string[] {
  return LOW_TRUST_MODEL_CREDENTIAL_ENV_KEYS.map(key => `env.${key}`);
}
export function filterLowTrustModelBindingIds(bindings: readonly { id: string; targetType: string; targetId: string; configPath: string }[], agentId: string): string[] {
  if (!agentId) return [];
  const paths = new Set(lowTrustModelCredentialConfigPaths());
  return [...new Set(bindings.filter(b => b.targetType === "agent" && b.targetId === agentId && paths.has(b.configPath) && b.id).map(b => b.id))].sort();
}

/** Used by both native arms; never copy a primary issue's boundary to a clone. */
export async function initializeGitHubReviewTaskTrust(db: Store, issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "executionPolicy">, agentId: string) {
  const bindings = await db.select().from(companySecretBindings).where(and(
    eq(companySecretBindings.companyId, issue.companyId), eq(companySecretBindings.targetType, "agent"),
    eq(companySecretBindings.targetId, agentId), inArray(companySecretBindings.configPath, lowTrustModelCredentialConfigPaths()),
  ));
  const authorization = record(issue.executionPolicy?.authorizationPolicy);
  const boundary = record(authorization.trustBoundary);
  const existing = Array.isArray(boundary.allowedSecretBindingIds) ? boundary.allowedSecretBindingIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  const reviewPreset = { id: LOW_TRUST_REVIEW_PRESET, version: LOW_TRUST_REVIEW_PRESET_VERSION, rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION } as const;
  await db.update(issues).set({
    sourceTrust: { preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined", sourceIssueId: issue.id },
    executionPolicy: {
      mode: "normal", commentRequired: true, stages: [], ...issue.executionPolicy, reviewPreset,
      authorizationPolicy: { ...authorization, trustPreset: LOW_TRUST_REVIEW_PRESET, reviewPreset,
        trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET, companyId: issue.companyId, rootIssueId: issue.id, issueIds: [issue.id],
          allowedAgentIds: [agentId], allowedToolClasses: ["git.read", "github.pr.read", "tests.local"], ...boundary,
          allowedSecretBindingIds: [...new Set([...existing, ...filterLowTrustModelBindingIds(bindings, agentId)])].sort(),
        },
      },
    }, updatedAt: new Date(),
  }).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
}
