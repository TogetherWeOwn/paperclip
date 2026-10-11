import { type Db, issueRecoveryActions } from "@paperclipai/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  type ExecutionWorkspaceBranchReconcileResult,
  executionWorkspaceService,
} from "./execution-workspaces.js";
import type { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";
import { ACTIVE_RECOVERY_ACTION_STATUSES } from "./issue-recovery-actions.js";

const INCOHERENCE_REASON = "git_worktree_branch_incoherence";
const SWEEP_ACTOR_ID = "workspace_validation_sweep";
const DEFAULT_MIN_ATTEMPT_INTERVAL_MS = 10 * 60 * 1000;

export const WORKSPACE_VALIDATION_SKIP_REASONS = [
  "cooldown",
  "workspace_unlinked",
  "workspace_missing",
  "source_issue_mismatch",
  "source_issue_closed",
  "inspection_failed",
  "no_active_recovery",
  "dirty",
  "busy",
  "branch_missing",
  "not_registered",
] as const;
export type WorkspaceValidationSkipReason =
  (typeof WORKSPACE_VALIDATION_SKIP_REASONS)[number];

type HeartbeatWakeup = ReturnType<typeof heartbeatService>["wakeup"];
export type WorkspaceValidationWakeup = (
  agentId: string,
  options: Parameters<HeartbeatWakeup>[1],
) => Promise<unknown>;

export type WorkspaceValidationSweepItem = {
  recoveryActionId: string;
  companyId: string;
  sourceIssueId: string;
  executionWorkspaceId: string | null;
  decision: "restored" | "would_restore" | "skipped" | "refused";
  reason: WorkspaceValidationSkipReason | null;
  message: string | null;
};

export type WorkspaceValidationSweepResult = {
  enabled: boolean;
  dryRun: boolean;
  scanned: number;
  deferred: number;
  restored: number;
  wouldRestore: number;
  refused: number;
  skipped: Record<WorkspaceValidationSkipReason, number>;
  items: WorkspaceValidationSweepItem[];
};

export type WorkspaceValidationSweepOptions = {
  limit: number;
  companyId?: string | null;
  dryRun?: boolean;
  wakeup?: WorkspaceValidationWakeup | null;
  minAttemptIntervalMs?: number;
};

type Candidate = {
  id: string;
  companyId: string;
  sourceIssueId: string;
  fingerprint: string;
  executionWorkspaceId: string | null;
};

// Process-local: a restart forgets the cooldown, which at worst retries a
// candidate once sooner than its interval.
const lastAttemptAt = new Map<string, number>();

function emptySkipCounts(): Record<WorkspaceValidationSkipReason, number> {
  return Object.fromEntries(
    WORKSPACE_VALIDATION_SKIP_REASONS.map((reason) => [reason, 0]),
  ) as Record<WorkspaceValidationSkipReason, number>;
}

async function listIncoherenceCandidates(
  db: Db,
  companyId: string | null,
): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: issueRecoveryActions.id,
      companyId: issueRecoveryActions.companyId,
      sourceIssueId: issueRecoveryActions.sourceIssueId,
      fingerprint: issueRecoveryActions.fingerprint,
      evidence: issueRecoveryActions.evidence,
    })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.kind, "workspace_validation"),
        eq(issueRecoveryActions.cause, "workspace_validation_failed"),
        inArray(issueRecoveryActions.status, [
          ...ACTIVE_RECOVERY_ACTION_STATUSES,
        ]),
        companyId ? eq(issueRecoveryActions.companyId, companyId) : undefined,
        sql`${issueRecoveryActions.evidence} #>> '{workspaceValidation,reason}' = ${INCOHERENCE_REASON}`,
      ),
    )
    .orderBy(asc(issueRecoveryActions.createdAt));
  return rows.map((row) => {
    const validation = (row.evidence.workspaceValidation ?? {}) as Record<
      string,
      unknown
    >;
    const workspaceId =
      validation.persistedExecutionWorkspaceId ??
      validation.executionWorkspaceId;
    return {
      id: row.id,
      companyId: row.companyId,
      sourceIssueId: row.sourceIssueId,
      fingerprint: row.fingerprint,
      executionWorkspaceId:
        typeof workspaceId === "string" && workspaceId.length > 0
          ? workspaceId
          : null,
    };
  });
}

function recordSkip(
  result: WorkspaceValidationSweepResult,
  base: Omit<WorkspaceValidationSweepItem, "decision" | "reason" | "message">,
  reason: WorkspaceValidationSkipReason,
  message: string | null,
) {
  result.skipped[reason] += 1;
  result.items.push({ ...base, decision: "skipped", reason, message });
}

async function wakeRestoredSourceIssue(input: {
  wakeup: WorkspaceValidationWakeup;
  restored: ExecutionWorkspaceBranchReconcileResult;
  executionWorkspaceId: string;
  recoveryActionId: string;
}) {
  const issue = input.restored.restoredSourceIssue;
  if (!issue?.assigneeAgentId || !input.restored.sourceIssueStatusChanged)
    return;
  if (issue.status !== "todo" && issue.status !== "in_review") return;
  await input
    .wakeup(issue.assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_recovery_action_restored",
      payload: {
        issueId: issue.id,
        recoveryActionId: input.recoveryActionId,
        executionWorkspaceId: input.executionWorkspaceId,
        mutation: "execution_workspace_branch_restore",
      },
      requestedByActorType: "system",
      requestedByActorId: SWEEP_ACTOR_ID,
      contextSnapshot: {
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "issue_recovery_action_restored",
        source: "workspace_validation_sweep",
        recoveryActionId: input.recoveryActionId,
        executionWorkspaceId: input.executionWorkspaceId,
      },
    })
    .catch((err) =>
      logger.warn(
        { err, issueId: issue.id, agentId: issue.assigneeAgentId },
        "failed to wake agent after workspace validation recovery sweep",
      ),
    );
}

async function sweepCandidate(input: {
  db: Db;
  options: WorkspaceValidationSweepOptions;
  candidate: Candidate;
  base: Omit<WorkspaceValidationSweepItem, "decision" | "reason" | "message">;
  result: WorkspaceValidationSweepResult;
}) {
  const { db, options, candidate, base, result } = input;
  if (!candidate.executionWorkspaceId) {
    recordSkip(
      result,
      base,
      "workspace_unlinked",
      "Recovery action evidence names no execution workspace",
    );
    return;
  }
  const workspaceId = candidate.executionWorkspaceId;
  const service = executionWorkspaceService(db);
  const classification = await service.classifyRecordedBranchRestore(
    workspaceId,
    {
      companyId: candidate.companyId,
      sourceIssueId: candidate.sourceIssueId,
      recoveryFingerprint: candidate.fingerprint,
    },
  );
  if (!classification.eligible) {
    recordSkip(result, base, classification.reason, classification.message);
    return;
  }
  if (options.dryRun) {
    result.wouldRestore += 1;
    result.items.push({
      ...base,
      decision: "would_restore",
      reason: null,
      message: null,
    });
    return;
  }

  let restored: ExecutionWorkspaceBranchReconcileResult;
  try {
    restored = await service.reconcileExecutionWorkspaceBranch(workspaceId, {
      mode: "restore",
      reason:
        "Workspace validation sweep checked the recorded branch out in a clean worktree.",
      alternateRecoveryFingerprints: [candidate.fingerprint],
      actor: {
        actorType: "system",
        actorId: SWEEP_ACTOR_ID,
        agentId: null,
        runId: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.refused += 1;
    result.items.push({ ...base, decision: "refused", reason: null, message });
    logger.warn(
      {
        recoveryActionId: candidate.id,
        executionWorkspaceId: workspaceId,
        message,
      },
      "workspace validation recovery sweep refused a restore",
    );
    return;
  }

  result.restored += 1;
  result.items.push({
    ...base,
    decision: "restored",
    reason: null,
    message: null,
  });
  await logActivity(db, {
    companyId: restored.workspace.companyId,
    actorType: "system",
    actorId: SWEEP_ACTOR_ID,
    action: "execution_workspace.branch_reconciled",
    entityType: "execution_workspace",
    entityId: restored.workspace.id,
    details: {
      mode: "restore",
      fromBranch: restored.inspection.fromBranch,
      toBranch: restored.inspection.toBranch,
      fromSha: restored.inspection.fromSha,
      toSha: restored.inspection.toSha,
      fingerprint: restored.inspection.fingerprint,
      sourceIssueId: restored.workspace.sourceIssueId,
      auditCommentId: restored.auditCommentId,
      recoveryActionId: candidate.id,
      sourceIssueStatus: restored.restoredSourceIssue?.status ?? null,
    },
  });
  if (options.wakeup) {
    await wakeRestoredSourceIssue({
      wakeup: options.wakeup,
      restored,
      executionWorkspaceId: workspaceId,
      recoveryActionId: candidate.id,
    });
  }
}

function pruneAttemptLedger(candidateIds: Set<string>) {
  for (const id of lastAttemptAt.keys()) {
    if (!candidateIds.has(id)) lastAttemptAt.delete(id);
  }
}

export async function sweepWorkspaceValidationRecoveries(
  db: Db,
  options: WorkspaceValidationSweepOptions,
): Promise<WorkspaceValidationSweepResult> {
  const dryRun = options.dryRun === true;
  const enabled =
    (await instanceSettingsService(db).getExperimental())
      .enableWorkspaceDirtyQuarantineRepair === true;
  const result: WorkspaceValidationSweepResult = {
    enabled,
    dryRun,
    scanned: 0,
    deferred: 0,
    restored: 0,
    wouldRestore: 0,
    refused: 0,
    skipped: emptySkipCounts(),
    items: [],
  };
  if (!enabled && !dryRun) return result;

  const now = Date.now();
  const minIntervalMs =
    options.minAttemptIntervalMs ?? DEFAULT_MIN_ATTEMPT_INTERVAL_MS;
  const candidates = await listIncoherenceCandidates(
    db,
    options.companyId ?? null,
  );
  result.scanned = candidates.length;
  // Never-tried cards first, then least recently tried, so a long backlog of
  // ineligible cards cannot starve the rest.
  const lastTriedRank = (id: string) => lastAttemptAt.get(id) ?? -1;
  candidates.sort((a, b) => lastTriedRank(a.id) - lastTriedRank(b.id));

  let attempts = 0;
  for (const candidate of candidates) {
    const base = {
      recoveryActionId: candidate.id,
      companyId: candidate.companyId,
      sourceIssueId: candidate.sourceIssueId,
      executionWorkspaceId: candidate.executionWorkspaceId,
    };
    if (!dryRun) {
      const attemptedAt = lastAttemptAt.get(candidate.id);
      if (attemptedAt !== undefined && now - attemptedAt < minIntervalMs) {
        recordSkip(result, base, "cooldown", null);
        continue;
      }
    }
    if (attempts >= options.limit) {
      result.deferred += 1;
      continue;
    }
    attempts += 1;
    if (!dryRun) lastAttemptAt.set(candidate.id, now);
    await sweepCandidate({ db, options, candidate, base, result });
  }

  if (!dryRun)
    pruneAttemptLedger(new Set(candidates.map((candidate) => candidate.id)));
  return result;
}
