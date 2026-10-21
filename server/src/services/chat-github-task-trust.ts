export { githubReviewExecutionTrustDecision } from "./chat-github-review-trust.js";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { activityLog, companySecretBindings, issues, type Db } from "@paperclipai/db";
import {
  LOW_TRUST_REVIEW_PRESET, LOW_TRUST_REVIEW_PRESET_VERSION, LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  sourceTrustMetadataSchema, lowTrustReviewPresetPolicySchema, trustAuthorizationPolicySchema, issueExecutionPolicySchema,
  type IssueExecutionPolicy, type SourceTrustMetadata,
} from "@paperclipai/shared";
type Store = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
type TrustIssue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "executionPolicy"> & { sourceTrust?: SourceTrustMetadata | null };
const STAMP_ACTION = "github.review_trust_stamped";

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

function trustFields(issue: TrustIssue) {
  return {
    sourceTrust: issue.sourceTrust ?? null,
    reviewPreset: issue.executionPolicy?.reviewPreset ?? null,
    authorizationPolicy: issue.executionPolicy?.authorizationPolicy ?? null,
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function stampDigest(issue: TrustIssue): string {
  return createHash("sha256").update(JSON.stringify(canonical(trustFields(issue)))).digest("hex");
}

/** Only a matching, immutable connector receipt can undo a generated stamp. */
export function githubGeneratedTrustRestoration(issue: TrustIssue, receipt: unknown): {
  sourceTrust: SourceTrustMetadata | null; executionPolicy: Record<string, unknown>;
} | null {
  const r = record(receipt);
  if (r.version !== 1 || r.issueId !== issue.id || r.stampDigest !== stampDigest(issue)) return null;
  const original = record(r.original);
  const sourceTrust = sourceTrustMetadataSchema.nullable().safeParse(original.sourceTrust);
  const reviewPreset = lowTrustReviewPresetPolicySchema.nullable().safeParse(original.reviewPreset);
  const authorization = trustAuthorizationPolicySchema.nullable().safeParse(original.authorizationPolicy);
  if (!sourceTrust.success || !reviewPreset.success || !authorization.success) return null;
  const { reviewPreset: _preset, authorizationPolicy: _authorization, ...policy } = issue.executionPolicy ?? { mode: "normal", commentRequired: true, stages: [] };
  return { sourceTrust: sourceTrust.data, executionPolicy: {
    ...policy,
    ...(reviewPreset.data ? { reviewPreset: reviewPreset.data } : {}),
    ...(authorization.data ? { authorizationPolicy: authorization.data } : {}),
  } };
}

export function githubReviewTaskIsLowTrust(issue: Pick<TrustIssue, "executionPolicy" | "sourceTrust">): boolean {
  const policy = record(issue.executionPolicy);
  const authorization = record(policy.authorizationPolicy);
  return issue.sourceTrust?.preset === LOW_TRUST_REVIEW_PRESET ||
    record(policy.reviewPreset).id === LOW_TRUST_REVIEW_PRESET ||
    authorization.trustPreset === LOW_TRUST_REVIEW_PRESET || !!authorization.trustBoundary;
}

export function githubReviewDeliveryTrust(value: unknown): {
  lowTrust: boolean; executionPolicy: Record<string, unknown> | null;
  denied?: "invalid_admitted_policy";
} | null {
  const input = record(value);
  if (input.version !== 1 || typeof input.lowTrust !== "boolean") return null;
  const policy = issueExecutionPolicySchema.nullable().safeParse(input.executionPolicy);
  if (!policy.success) return { lowTrust: true, executionPolicy: null, denied: "invalid_admitted_policy" };
  const executionPolicy = policy.data ? { ...policy.data } : null;
  const policyIsLowTrust = githubReviewTaskIsLowTrust({ executionPolicy });
  if (input.lowTrust && !policyIsLowTrust) {
    // A permanent policy error is not a transient chat failure. Retain a low
    // marker WITHOUT a boundary: dispatch denies missing scope, never runs at
    // normal trust, and acceptance does not poison its durable retry outbox.
    return { lowTrust: true, executionPolicy: {
      ...executionPolicy,
      reviewPreset: { id: LOW_TRUST_REVIEW_PRESET, version: LOW_TRUST_REVIEW_PRESET_VERSION,
        rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION },
    } };
  }
  return { lowTrust: input.lowTrust || policyIsLowTrust, executionPolicy };
}

async function latestStamp(db: Store, issue: TrustIssue) {
  const [row] = await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, issue.companyId), eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, issue.id), eq(activityLog.action, STAMP_ACTION),
    eq(activityLog.actorType, "system"), eq(activityLog.actorId, "chat:github"),
  )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
  return row?.details ?? null;
}

/** Used by both native arms; never copy a primary issue's boundary to a clone. */
export async function initializeGitHubReviewTaskTrust(db: Store, issue: TrustIssue, agentId: string) {
  const bindings = await db.select().from(companySecretBindings).where(and(
    eq(companySecretBindings.companyId, issue.companyId), eq(companySecretBindings.targetType, "agent"),
    eq(companySecretBindings.targetId, agentId), inArray(companySecretBindings.configPath, lowTrustModelCredentialConfigPaths()),
  ));
  const authorization = record(issue.executionPolicy?.authorizationPolicy);
  const boundary = record(authorization.trustBoundary);
  const existing = Array.isArray(boundary.allowedSecretBindingIds) ? boundary.allowedSecretBindingIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  const reviewPreset = { id: LOW_TRUST_REVIEW_PRESET, version: LOW_TRUST_REVIEW_PRESET_VERSION, rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION } as const;
  const patch = {
    sourceTrust: { preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined", sourceIssueId: issue.id } as const,
    executionPolicy: {
      mode: "normal", commentRequired: true, stages: [], ...issue.executionPolicy, reviewPreset,
      authorizationPolicy: { ...authorization, trustPreset: LOW_TRUST_REVIEW_PRESET, reviewPreset,
        trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET, companyId: issue.companyId, rootIssueId: issue.id, issueIds: [issue.id],
          allowedAgentIds: [agentId], allowedToolClasses: ["git.read", "github.pr.read", "tests.local"], ...boundary,
          allowedSecretBindingIds: [...new Set([...existing, ...filterLowTrustModelBindingIds(bindings, agentId)])].sort(),
        },
      },
    } satisfies IssueExecutionPolicy,
  };
  const next = { ...issue, ...patch };
  const prior = await latestStamp(db, issue);
  // Repeated untrusted triggers retain the original pre-stamp restrictions.
  const restoration = githubGeneratedTrustRestoration(issue, prior);
  const original = restoration ? trustFields({ ...issue, ...restoration }) : trustFields(issue);
  if (stampDigest(next) !== stampDigest(issue)) {
    await db.update(issues).set({ ...patch, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
    await db.insert(activityLog).values({ companyId: issue.companyId, actorType: "system", actorId: "chat:github",
      action: STAMP_ACTION, entityType: "issue", entityId: issue.id,
      details: { version: 1, issueId: issue.id, original, stampDigest: stampDigest(next) } });
  }
  return next;
}

/** Caller owns the transaction. Row-lock serialization keeps undo/stamp atomic. */
export async function reconcileGitHubReviewTaskTrust(db: Store, input: {
  companyId: string; issueId: string; agentId: string; lowTrust: boolean;
}) {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
  if (!issue) throw new Error("GitHub review task is unavailable");
  if (input.lowTrust) return { ...issue, ...await initializeGitHubReviewTaskTrust(db, issue, input.agentId) };
  const restoration = githubGeneratedTrustRestoration(issue, await latestStamp(db, issue));
  if (!restoration) return issue; // Legacy or edited/operator restrictions are not ours to clear.
  await db.update(issues).set({ ...restoration, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
  await db.insert(activityLog).values({ companyId: issue.companyId, actorType: "system", actorId: "chat:github",
    action: "github.review_trust_restored", entityType: "issue", entityId: issue.id,
    details: { stampDigest: stampDigest(issue), reason: "trusted_pr_provenance" } });
  return { ...issue, ...restoration };
}
