import { and, eq } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  resolveManagedGitHubCredential,
  type GitCredential,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  source?: "personal" | "dedicated";
  login?: string;
  reason?: string;
  connectionId?: string;
  grantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
};

/**
 * Nonsecret stage breakdown for POST /runtime-tools/github/credentials.
 * Buckets isolate local route/auth and DB work from downstream credential work
 * so a slow wrapper (10s launcher deadline) can be attributed without secrets:
 * - identityMs: captureRunIdentity transaction (pool acquisition + issues/
 *   heartbeat_runs row-lock wait + pending-identity reconciliation).
 * - policyMs: allowsGitHubCredentialExport policy re-reads (agent/issue/project).
 * - credentialMs: managed identity selection + secret-store resolution +
 *   GitHub OAuth refresh network when due (downstream of local DB/policy).
 * - persistMs: nonsecret summary write to run_identity_contexts.
 * Queue/file transfer and response delivery outside this resolver are NOT
 * included; compare totalMs against the end-to-end launcher elapsed to
 * isolate transport vs resolver latency. All values are integers >= 0.
 */
export type GitHubCredentialStageTiming = {
  identityMs: number;
  policyMs: number;
  credentialMs: number;
  persistMs: number;
  totalMs: number;
};

/** A raw GitHub token cannot enforce the low-trust read-only tool boundary. */
async function allowsGitHubCredentialExport(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const issueId =
    run.contextSnapshot?.issueId ??
    run.contextSnapshot?.taskId ??
    run.nativeIssueId;
  if (
    issueId !== undefined &&
    issueId !== null &&
    (typeof issueId !== "string" || !isUuidLike(issueId))
  )
    return false;
  const [agent] = await db
    .select({ companyId: agents.companyId, permissions: agents.permissions })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)),
    );
  if (!agent) return false;
  const [issue] =
    typeof issueId === "string"
      ? await db
          .select({
            companyId: issues.companyId,
            projectId: issues.projectId,
            executionPolicy: issues.executionPolicy,
            sourceTrust: issues.sourceTrust,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
      : [];
  if (issueId !== undefined && issueId !== null && !issue) return false;
  if (isLowTrustQuarantined(issue?.sourceTrust)) return false;
  const projectId = issue?.projectId ?? run.contextSnapshot?.projectId;
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "string" || !isUuidLike(projectId))
  )
    return false;
  const [project] =
    typeof projectId === "string"
      ? await db
          .select({
            companyId: projects.companyId,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.companyId, run.companyId),
            ),
          )
      : [];
  if (projectId !== undefined && projectId !== null && !project) return false;
  return (
    resolveCoreTrustPreset({
      companyId: run.companyId,
      agent,
      project,
      issue,
      run: {
        companyId: run.companyId,
        executionPolicy: run.contextSnapshot?.executionPolicy,
      },
    }).kind === "standard"
  );
}

/** No company secrets or ambient credentials are consulted by this path. */
export async function resolveGitHubOperationCredentials(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
  },
) {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Math.round(Date.now() - startedAt));
  let identityMs = 0;
  let policyMs = 0;
  let credentialMs = 0;
  let persistMs = 0;
  const timingMs = (): GitHubCredentialStageTiming => ({
    identityMs,
    policyMs,
    credentialMs,
    persistMs,
    totalMs: elapsed(),
  });
  const identityStartedAt = Date.now();
  const { run, context } = await captureRunIdentity(db, input);
  identityMs = Math.max(0, Math.round(Date.now() - identityStartedAt));
  if (!context) throw forbidden("This run predates managed GitHub credentials");
  let summary: GitHubCredentialSummary;
  let env: Record<string, string> = {};
  // A sponsored guest's responsible person is an internal accountability field,
  // not authorization to export that person's (or a dedicated bot's) token.
  // Re-read every policy source for each operation, including a run's retained
  // boundary after task policy edits. Deny before touching the credential store.
  const policyStartedAt = Date.now();
  const allowed = await allowsGitHubCredentialExport(db, run);
  policyMs = Math.max(0, Math.round(Date.now() - policyStartedAt));
  if (!allowed) {
    summary = {
      status: "unavailable",
      reason:
        "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
    };
    const persistStartedAt = Date.now();
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
    persistMs = Math.max(0, Math.round(Date.now() - persistStartedAt));
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...summary,
      env,
      timingMs: timingMs(),
    };
  }
  const credentialStartedAt = Date.now();
  try {
    const resolved = await resolveManagedGitHubCredential(
      db,
      secretService(db),
      input.companyId,
      {
        agentId: input.agentId,
        heartbeatRunId: input.runId,
        allowStandingDelegation: false,
        responsibleUserId:
          context?.cause === "company_default"
            ? null
            : (context?.responsibleUserId ?? null),
        issueId:
          typeof run.contextSnapshot?.issueId === "string"
            ? run.contextSnapshot.issueId
            : null,
      },
    );
    if (resolved.credential) {
      summary = {
        status: "available",
        source: resolved.credential.identitySource,
        login: resolved.credential.githubIdentity?.login,
        connectionId: resolved.credential.connectionId,
        grantId: resolved.credential.grantId,
        authenticationMode: "managed",
      };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else {
      summary = {
        status: resolved.configured ? "unavailable" : "absent",
        source: resolved.identitySource ?? "personal",
        reason: resolved.error ?? "No GitHub identity connected",
      };
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = {
      status: "unavailable",
      reason: "GitHub credentials are temporarily unavailable",
    };
  } finally {
    credentialMs = Math.max(0, Math.round(Date.now() - credentialStartedAt));
  }
  if (context) {
    const persistStartedAt = Date.now();
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
    persistMs = Math.max(0, Math.round(Date.now() - persistStartedAt));
  }
  return {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    env,
    timingMs: timingMs(),
  };
}

/** Use a managed credential inside trusted server code without returning it to the caller. */
export async function withGitHubOperationCredential<T>(
  db: Db,
  input: { companyId: string; agentId: string; runId: string },
  operation: (credential: GitCredential) => Promise<T>,
): Promise<T> {
  const { run, context } = await captureRunIdentity(db, input);
  if (!context) throw forbidden("This run predates managed GitHub credentials");

  const saveSummary = async (summary: GitHubCredentialSummary) => {
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
  };

  if (!(await allowsGitHubCredentialExport(db, run))) {
    await saveSummary({
      status: "unavailable",
      reason: "GitHub diagnostics are not available to low-trust or unverified executions",
    });
    throw forbidden("GitHub diagnostics are not available to low-trust or unverified executions");
  }

  let resolved: Awaited<ReturnType<typeof resolveManagedGitHubCredential>> | null = null;
  try {
    resolved = await resolveManagedGitHubCredential(
      db,
      secretService(db),
      input.companyId,
      {
        agentId: input.agentId,
        heartbeatRunId: input.runId,
        allowStandingDelegation: false,
        allowRefresh: false,
        allowAlternate: false,
        responsibleUserId:
          context.cause === "company_default"
            ? null
            : (context.responsibleUserId ?? null),
        issueId:
          typeof run.contextSnapshot?.issueId === "string"
            ? run.contextSnapshot.issueId
            : null,
      },
    );
  } catch {
    // Credential-store details can contain sensitive values. Keep the caller error generic.
  }

  if (!resolved?.credential) {
    await saveSummary({
      status: resolved?.configured ? "unavailable" : "absent",
      source: resolved?.identitySource ?? "personal",
      reason: "A managed GitHub identity is not available for this run",
    });
    throw forbidden("A managed GitHub identity is not available for this run");
  }

  await saveSummary({
    status: "available",
    source: resolved.credential.identitySource,
    login: resolved.credential.githubIdentity?.login,
    connectionId: resolved.credential.connectionId,
    grantId: resolved.credential.grantId,
    authenticationMode: "managed",
  });

  return operation(resolved.credential);
}
