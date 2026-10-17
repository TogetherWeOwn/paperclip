/**
 * Source-bound workspace allocation (Board-authorized, no-wake).
 *
 * Allocates a durable but UNREALIZED execution-workspace record bound to a
 * source issue, without waking the issue, checking out code, creating a
 * branch/worktree, or starting any runtime. It exists so a Board principal
 * can pre-bind the workspace identity a later heartbeat run will realize
 * into: heartbeat persistence flips that exact record to `active` (after
 * re-checking it is still unrealized and bound), and
 * `markAllocatedWorkspaceRealized` below is the same guarded transition
 * as a standalone operation. Transport validation keeps denying the
 * record as `workspace_not_realized` until realization actually happens.
 *
 * Safety shape (fail closed everywhere):
 * - Principal: an authenticated Board actor with server-resolved
 *   `runtime:manage` on the issue's company. Agent keys, board actors
 *   without the capability or a user identity, and cross-company actors
 *   deny as `unauthorized_principal` before any mutation. The route
 *   resolves the actor via `assertBoard` + `access.decide`; the values in
 *   `actor` here are that server resolution, never request-body fields.
 * - Selection: every persisted field is derived server-side from the
 *   issue's stored selection (`executionWorkspacePreference` /
 *   `executionWorkspaceSettings` + `projectWorkspaceId`). Only
 *   `isolated_workspace` + `git_worktree` allocates. Caller-supplied
 *   `requested` values (cwd, branch, transport, source, workspace
 *   identity, ...) are accepted in the input shape and ignored.
 * - Atomicity: record insert + `issue.executionWorkspaceId` bind + audit
 *   entry happen inside ONE `deps.transact(...)` call. The transaction
 *   surface has no way to write issue status, assignee, blockers,
 *   execution policy, or monitor fields, and the proof `effects`
 *   callbacks are never invoked on any path.
 * - Idempotency: a repeat call returns the existing open source-bound
 *   allocation (audited as `existing`) only when company, source issue,
 *   and selected project workspace all still match. Conflicting,
 *   archived-bound, ambiguous, or malformed bindings fail closed as
 *   `binding_conflict` — never a silent rebind, and pre-existing
 *   workspace records are never mutated by allocation.
 * - Rollback archives only the allocated unrealized record and restores
 *   the exact prior `executionWorkspaceId` recorded in its allocation
 *   metadata, refusing if the binding changed in between.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog, executionWorkspaces, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";

export const SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION =
  "source-bound-workspace-allocation/v1";

export const UNREALIZED_EXECUTION_WORKSPACE_STATUS = "unrealized";

export type SourceBoundAllocationActor = {
  type: string;
  userId: string | null;
  companyId: string;
  /** Server-resolved `runtime:manage` decision for this actor + company. */
  hasRuntimeManage: boolean;
};

export type SourceBoundAllocationSelection = {
  mode: "isolated_workspace";
  strategyType: "git_worktree";
  baseRef: string | null;
  branchTemplate: string | null;
};

export type SourceBoundAllocationIssueFacts = {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  status: string;
  assigneeAgentId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: unknown;
  executionPolicy: unknown;
};

export type SourceBoundAllocationWorkspaceRecord = {
  id: string;
  companyId: string;
  projectId: string;
  projectWorkspaceId: string | null;
  sourceIssueId: string | null;
  mode: string;
  strategyType: string;
  name: string;
  status: string;
  cwd: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
  providerType: string;
  providerRef: string | null;
  openedAt: Date | string | null;
  closedAt: Date | string | null;
  metadata: Record<string, unknown> | null;
};

export type SourceBoundAllocationAuditEntry = {
  action:
    | "issue.source_bound_workspace_allocated"
    | "issue.source_bound_workspace_allocation_rolled_back";
  companyId: string;
  sourceIssueId: string;
  workspaceId: string;
  actor: { type: "board"; userId: string };
  projectWorkspaceId: string | null;
  selection: SourceBoundAllocationSelection | null;
  priorExecutionWorkspaceId: string | null;
  disposition: "created" | "existing" | "rolled_back";
  /** Event timestamp (allocation time, or the rollback event time). */
  allocatedAt: string;
};

/** Proof sink only: accepted so callers can prove none were ever invoked. */
export type SourceBoundAllocationEffects = {
  wakeIssue?: () => unknown;
  startRun?: () => unknown;
  checkout?: () => unknown;
  createBranch?: () => unknown;
  createWorktree?: () => unknown;
  startRuntimeService?: () => unknown;
  executeProduct?: () => unknown;
  executeStaging?: () => unknown;
};

export type SourceBoundWorkspaceAllocationTx = {
  loadIssue: (
    companyId: string,
    issueId: string,
  ) => Promise<SourceBoundAllocationIssueFacts | null>;
  listWorkspacesForSourceIssue: (
    companyId: string,
    sourceIssueId: string,
  ) => Promise<SourceBoundAllocationWorkspaceRecord[]>;
  getWorkspace: (
    companyId: string,
    workspaceId: string,
  ) => Promise<SourceBoundAllocationWorkspaceRecord | null>;
  insertWorkspace: (
    record: SourceBoundAllocationWorkspaceRecord,
  ) => Promise<SourceBoundAllocationWorkspaceRecord>;
  updateWorkspace: (
    companyId: string,
    workspaceId: string,
    patch: Partial<SourceBoundAllocationWorkspaceRecord>,
  ) => Promise<SourceBoundAllocationWorkspaceRecord>;
  bindIssueExecutionWorkspace: (
    companyId: string,
    issueId: string,
    workspaceId: string | null,
  ) => Promise<void>;
  logActivity: (entry: SourceBoundAllocationAuditEntry) => Promise<void>;
};

export type SourceBoundWorkspaceAllocationDeps = {
  transact: <T>(
    work: (tx: SourceBoundWorkspaceAllocationTx) => Promise<T>,
  ) => Promise<T>;
  now?: () => Date;
  newWorkspaceId?: () => string;
};

export type AllocateSourceBoundWorkspaceInput = {
  companyId: string;
  sourceIssueId: string;
  actor: SourceBoundAllocationActor;
  /** Ignored by design: every persisted field is server-derived. */
  requested?: Record<string, unknown> | null;
  effects?: SourceBoundAllocationEffects | null;
};

export type AllocateSourceBoundWorkspaceResult =
  | {
      ok: true;
      operationVersion: string;
      disposition: "created" | "existing";
      companyId: string;
      sourceIssueId: string;
      runtimeInvoked: false;
      wakeInvoked: false;
      workspace: SourceBoundAllocationWorkspaceRecord;
    }
  | {
      ok: false;
      operationVersion: string;
      errorCode:
        | "unauthorized_principal"
        | "selection_missing"
        | "selection_not_isolated"
        | "binding_conflict";
      companyId: string;
      sourceIssueId: string;
      runtimeInvoked: false;
      wakeInvoked: false;
    };

export type MarkAllocatedWorkspaceRealizedInput = {
  companyId: string;
  sourceIssueId: string;
  workspaceId: string;
  cwd: string;
  providerRef: string;
  branchName: string;
  repoUrl?: string | null;
  /**
   * Full realized facts carried by heartbeat adoption. Optional so older
   * callers (and the contract suite) keep compiling; when provided they
   * are persisted atomically with the status flip inside the same
   * issue-locked transaction.
   */
  providerType?: string | null;
  baseRef?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type MarkAllocatedWorkspaceRealizedResult =
  | {
      ok: true;
      operationVersion: string;
      workspace: SourceBoundAllocationWorkspaceRecord;
    }
  | {
      ok: false;
      operationVersion: string;
      errorCode:
        | "binding_conflict"
        | "realization_incomplete"
        | "workspace_not_unrealized";
    };

export type RollbackSourceBoundWorkspaceAllocationInput = {
  companyId: string;
  sourceIssueId: string;
  workspaceId: string;
  actor: SourceBoundAllocationActor;
  effects?: SourceBoundAllocationEffects | null;
};

export type RollbackSourceBoundWorkspaceAllocationResult =
  | {
      ok: true;
      operationVersion: string;
      workspace: SourceBoundAllocationWorkspaceRecord;
      restoredExecutionWorkspaceId: string | null;
      runtimeInvoked: false;
      wakeInvoked: false;
    }
  | {
      ok: false;
      operationVersion: string;
      errorCode:
        | "unauthorized_principal"
        | "binding_conflict"
        | "workspace_not_unrealized";
      runtimeInvoked: false;
      wakeInvoked: false;
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readNonEmptyString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Board principal + server-resolved `runtime:manage`, scoped to the target
 * company. Checked before the transaction opens, so a denied principal
 * cannot mutate (or even transact) at all.
 */
function isAuthorizedBoardActor(
  actor: SourceBoundAllocationActor | null | undefined,
  companyId: string,
): actor is SourceBoundAllocationActor & { userId: string } {
  return (
    actor !== null &&
    actor !== undefined &&
    actor.type === "board" &&
    actor.hasRuntimeManage === true &&
    isNonEmptyString(actor.userId) &&
    isNonEmptyString(companyId) &&
    actor.companyId === companyId
  );
}

function isClosedWorkspace(
  workspace: SourceBoundAllocationWorkspaceRecord,
): boolean {
  return (
    workspace.closedAt != null ||
    workspace.status === "archived" ||
    workspace.status === "cleanup_failed"
  );
}

/**
 * Derives the allocatable selection from the issue's stored selection.
 * Returns the denial code for every non-allocatable shape.
 */
function deriveSelection(
  issue: SourceBoundAllocationIssueFacts,
):
  | { ok: true; selection: SourceBoundAllocationSelection }
  | { ok: false; errorCode: "selection_missing" | "selection_not_isolated" } {
  const settings = asRecord(issue.executionWorkspaceSettings);
  if (!settings || !issue.projectWorkspaceId || !issue.projectId) {
    return { ok: false, errorCode: "selection_missing" };
  }
  const settingsMode = settings.mode;
  const preference = issue.executionWorkspacePreference;
  const strategy = asRecord(settings.workspaceStrategy);
  if (
    settingsMode !== "isolated_workspace" ||
    (preference !== null && preference !== "isolated_workspace") ||
    strategy?.type !== "git_worktree"
  ) {
    return { ok: false, errorCode: "selection_not_isolated" };
  }
  return {
    ok: true,
    selection: {
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      baseRef: readNonEmptyString(strategy.baseRef),
      branchTemplate: readNonEmptyString(strategy.branchTemplate),
    },
  };
}

function denyAllocation(
  input: AllocateSourceBoundWorkspaceInput,
  errorCode: Extract<
    AllocateSourceBoundWorkspaceResult,
    { ok: false }
  >["errorCode"],
): AllocateSourceBoundWorkspaceResult {
  return {
    ok: false,
    operationVersion: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
    errorCode,
    companyId: isNonEmptyString(input?.companyId) ? input.companyId : "",
    sourceIssueId: isNonEmptyString(input?.sourceIssueId)
      ? input.sourceIssueId
      : "",
    runtimeInvoked: false,
    wakeInvoked: false,
  };
}

export async function allocateSourceBoundWorkspace(
  deps: SourceBoundWorkspaceAllocationDeps,
  input: AllocateSourceBoundWorkspaceInput,
): Promise<AllocateSourceBoundWorkspaceResult> {
  if (
    !isNonEmptyString(input?.sourceIssueId) ||
    !isAuthorizedBoardActor(input?.actor, input?.companyId)
  ) {
    return denyAllocation(input, "unauthorized_principal");
  }
  const actor = input.actor;
  const { companyId, sourceIssueId } = input;

  return deps.transact(async (tx) => {
    // A missing or cross-company issue denies as unauthorized without
    // revealing which, and before any mutation.
    const issue = await tx.loadIssue(companyId, sourceIssueId);
    if (!issue || issue.companyId !== companyId) {
      return denyAllocation(input, "unauthorized_principal");
    }

    const derived = deriveSelection(issue);
    if (!derived.ok) {
      return denyAllocation(input, derived.errorCode);
    }
    const { selection } = derived;
    const now = (deps.now?.() ?? new Date()).toISOString();

    const audit = (
      workspaceId: string,
      disposition: "created" | "existing",
      priorExecutionWorkspaceId: string | null,
    ): SourceBoundAllocationAuditEntry => ({
      action: "issue.source_bound_workspace_allocated",
      companyId,
      sourceIssueId: issue.id,
      workspaceId,
      actor: { type: "board", userId: actor.userId },
      projectWorkspaceId: issue.projectWorkspaceId,
      selection,
      priorExecutionWorkspaceId,
      disposition,
      allocatedAt: now,
    });

    const openSourceBound = (
      await tx.listWorkspacesForSourceIssue(companyId, issue.id)
    ).filter((workspace) => !isClosedWorkspace(workspace));

    if (issue.executionWorkspaceId) {
      const bound = await tx.getWorkspace(
        companyId,
        issue.executionWorkspaceId,
      );
      // The bound record must be this issue's own open allocation for the
      // currently selected project workspace. Anything else — missing,
      // another issue's, closed, stale selection, or ambiguous (more than
      // one open source-bound record) — fails closed with no mutation.
      if (
        !bound ||
        bound.companyId !== companyId ||
        bound.sourceIssueId !== issue.id ||
        isClosedWorkspace(bound) ||
        bound.projectWorkspaceId !== issue.projectWorkspaceId ||
        openSourceBound.length !== 1 ||
        openSourceBound[0]!.id !== bound.id
      ) {
        return denyAllocation(input, "binding_conflict");
      }
      await tx.logActivity(audit(bound.id, "existing", bound.id));
      return {
        ok: true,
        operationVersion: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
        disposition: "existing" as const,
        companyId,
        sourceIssueId: issue.id,
        runtimeInvoked: false as const,
        wakeInvoked: false as const,
        workspace: bound,
      };
    }

    // An open source-bound record the issue is not bound to is malformed
    // state (allocation binds atomically): fail closed rather than
    // silently rebinding. Closed unbound records are history and are
    // left untouched.
    if (openSourceBound.length > 0) {
      return denyAllocation(input, "binding_conflict");
    }

    const workspace = await tx.insertWorkspace({
      id: deps.newWorkspaceId?.() ?? randomUUID(),
      companyId,
      projectId: issue.projectId!,
      projectWorkspaceId: issue.projectWorkspaceId,
      sourceIssueId: issue.id,
      mode: selection.mode,
      strategyType: selection.strategyType,
      name: selection.branchTemplate ?? `source-bound-${issue.id.slice(0, 8)}`,
      status: UNREALIZED_EXECUTION_WORKSPACE_STATUS,
      cwd: null,
      repoUrl: null,
      baseRef: selection.baseRef,
      branchName: null,
      providerType: selection.strategyType,
      providerRef: null,
      openedAt: null,
      closedAt: null,
      metadata: {
        sourceBoundAllocation: {
          version: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
          priorExecutionWorkspaceId: issue.executionWorkspaceId,
          allocatedByUserId: actor.userId,
          selection,
        },
      },
    });
    await tx.bindIssueExecutionWorkspace(companyId, issue.id, workspace.id);
    await tx.logActivity(
      audit(workspace.id, "created", issue.executionWorkspaceId),
    );
    return {
      ok: true,
      operationVersion: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
      disposition: "created" as const,
      companyId,
      sourceIssueId: issue.id,
      runtimeInvoked: false as const,
      wakeInvoked: false as const,
      workspace,
    };
  });
}

/**
 * Realization adoption: flips the exact allocated record to `active` with
 * the realized facts. Never inserts. Incomplete facts deny and leave the
 * record unrealized, so a failed realization never looks usable.
 */
export async function markAllocatedWorkspaceRealized(
  deps: SourceBoundWorkspaceAllocationDeps,
  input: MarkAllocatedWorkspaceRealizedInput,
): Promise<MarkAllocatedWorkspaceRealizedResult> {
  const deny = (
    errorCode: Extract<
      MarkAllocatedWorkspaceRealizedResult,
      { ok: false }
    >["errorCode"],
  ): MarkAllocatedWorkspaceRealizedResult => ({
    ok: false,
    operationVersion: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
    errorCode,
  });

  return deps.transact(async (tx) => {
    const issue =
      isNonEmptyString(input?.companyId) &&
      isNonEmptyString(input?.sourceIssueId)
        ? await tx.loadIssue(input.companyId, input.sourceIssueId)
        : null;
    const workspace =
      issue && isNonEmptyString(input.workspaceId)
        ? await tx.getWorkspace(input.companyId, input.workspaceId)
        : null;
    if (
      !issue ||
      !workspace ||
      workspace.sourceIssueId !== issue.id ||
      issue.executionWorkspaceId !== workspace.id
    ) {
      return deny("binding_conflict");
    }
    if (workspace.status !== UNREALIZED_EXECUTION_WORKSPACE_STATUS) {
      return deny("workspace_not_unrealized");
    }
    if (
      !isNonEmptyString(input.cwd) ||
      !isNonEmptyString(input.providerRef) ||
      !isNonEmptyString(input.branchName)
    ) {
      return deny("realization_incomplete");
    }
    const realized = await tx.updateWorkspace(input.companyId, workspace.id, {
      status: "active",
      cwd: input.cwd,
      providerRef: input.providerRef,
      branchName: input.branchName,
      repoUrl: input.repoUrl ?? workspace.repoUrl,
      // Heartbeat adoption carries the remaining realized facts; each is
      // applied only when explicitly provided so older callers keep the
      // stored allocation values.
      ...(input.providerType !== undefined
        ? { providerType: input.providerType ?? workspace.providerType }
        : {}),
      ...(input.baseRef !== undefined
        ? { baseRef: input.baseRef ?? workspace.baseRef }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      openedAt: deps.now?.() ?? new Date(),
    });
    return {
      ok: true as const,
      operationVersion: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
      workspace: realized,
    };
  });
}

export async function rollbackSourceBoundWorkspaceAllocation(
  deps: SourceBoundWorkspaceAllocationDeps,
  input: RollbackSourceBoundWorkspaceAllocationInput,
): Promise<RollbackSourceBoundWorkspaceAllocationResult> {
  const deny = (
    errorCode: Extract<
      RollbackSourceBoundWorkspaceAllocationResult,
      { ok: false }
    >["errorCode"],
  ): RollbackSourceBoundWorkspaceAllocationResult => ({
    ok: false,
    operationVersion: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
    errorCode,
    runtimeInvoked: false,
    wakeInvoked: false,
  });

  if (
    !isNonEmptyString(input?.sourceIssueId) ||
    !isAuthorizedBoardActor(input?.actor, input?.companyId)
  ) {
    return deny("unauthorized_principal");
  }
  const actor = input.actor;

  return deps.transact(async (tx) => {
    const issue = await tx.loadIssue(input.companyId, input.sourceIssueId);
    if (!issue || issue.companyId !== input.companyId) {
      return deny("unauthorized_principal");
    }
    const workspace = isNonEmptyString(input.workspaceId)
      ? await tx.getWorkspace(input.companyId, input.workspaceId)
      : null;
    if (
      !workspace ||
      workspace.sourceIssueId !== issue.id ||
      issue.executionWorkspaceId !== workspace.id
    ) {
      return deny("binding_conflict");
    }
    if (workspace.status !== UNREALIZED_EXECUTION_WORKSPACE_STATUS) {
      return deny("workspace_not_unrealized");
    }
    const allocationMeta = asRecord(
      asRecord(workspace.metadata)?.sourceBoundAllocation,
    );
    const priorExecutionWorkspaceId =
      typeof allocationMeta?.priorExecutionWorkspaceId === "string" ||
      allocationMeta?.priorExecutionWorkspaceId === null
        ? (allocationMeta.priorExecutionWorkspaceId as string | null)
        : null;
    const selection = asRecord(allocationMeta?.selection);
    const now = deps.now?.() ?? new Date();

    const archived = await tx.updateWorkspace(input.companyId, workspace.id, {
      status: "archived",
      closedAt: now,
    });
    await tx.bindIssueExecutionWorkspace(
      input.companyId,
      issue.id,
      priorExecutionWorkspaceId,
    );
    await tx.logActivity({
      action: "issue.source_bound_workspace_allocation_rolled_back",
      companyId: input.companyId,
      sourceIssueId: issue.id,
      workspaceId: workspace.id,
      actor: { type: "board", userId: actor.userId },
      projectWorkspaceId: workspace.projectWorkspaceId,
      selection:
        selection?.mode === "isolated_workspace" &&
        selection?.strategyType === "git_worktree"
          ? {
              mode: "isolated_workspace",
              strategyType: "git_worktree",
              baseRef: readNonEmptyString(selection.baseRef),
              branchTemplate: readNonEmptyString(selection.branchTemplate),
            }
          : null,
      priorExecutionWorkspaceId,
      disposition: "rolled_back",
      allocatedAt: now.toISOString(),
    });
    return {
      ok: true as const,
      operationVersion: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
      workspace: archived,
      restoredExecutionWorkspaceId: priorExecutionWorkspaceId,
      runtimeInvoked: false as const,
      wakeInvoked: false as const,
    };
  });
}

// ---------------------------------------------------------------------------
// DB-backed deps (production wiring)
// ---------------------------------------------------------------------------

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;

function toAllocationWorkspaceRecord(
  row: ExecutionWorkspaceRow,
): SourceBoundAllocationWorkspaceRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    mode: row.mode,
    strategyType: row.strategyType,
    name: row.name,
    status: row.status,
    cwd: row.cwd ?? null,
    repoUrl: row.repoUrl ?? null,
    baseRef: row.baseRef ?? null,
    branchName: row.branchName ?? null,
    providerType: row.providerType,
    providerRef: row.providerRef ?? null,
    openedAt: row.openedAt ?? null,
    closedAt: row.closedAt ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * DB-backed dependency factory: the production wiring the route uses.
 * Every read/write is company-scoped, and insert + bind + audit run in
 * one database transaction (the audit row is inserted through the same
 * transaction handle, so it commits or rolls back with the mutation).
 */
export function createDbSourceBoundWorkspaceAllocationDeps(
  db: Db,
): SourceBoundWorkspaceAllocationDeps {
  return {
    transact: (work) =>
      db.transaction(async (tx) => {
        const txDeps: SourceBoundWorkspaceAllocationTx = {
          async loadIssue(companyId, issueId) {
            // Non-UUID ids deny (as unauthorized upstream) instead of
            // reaching a uuid column and surfacing as a 500.
            if (!isUuidLike(companyId) || !isUuidLike(issueId)) return null;
            const rows = await tx
              .select({
                id: issues.id,
                companyId: issues.companyId,
                projectId: issues.projectId,
                projectWorkspaceId: issues.projectWorkspaceId,
                status: issues.status,
                assigneeAgentId: issues.assigneeAgentId,
                executionWorkspaceId: issues.executionWorkspaceId,
                executionWorkspacePreference:
                  issues.executionWorkspacePreference,
                executionWorkspaceSettings: issues.executionWorkspaceSettings,
                executionPolicy: issues.executionPolicy,
              })
              .from(issues)
              .where(
                and(eq(issues.id, issueId), eq(issues.companyId, companyId)),
              )
              // Row-level lock: allocation, rollback, and realization all
              // read-modify-write this issue row inside one transaction, so
              // concurrent operations on the same issue serialize here
              // instead of inserting duplicate unrealized records or
              // interleaving with a rollback.
              .for("update")
              .limit(1);
            return rows[0] ?? null;
          },
          async listWorkspacesForSourceIssue(companyId, sourceIssueId) {
            if (!isUuidLike(companyId) || !isUuidLike(sourceIssueId)) {
              return [];
            }
            const rows = await tx
              .select()
              .from(executionWorkspaces)
              .where(
                and(
                  eq(executionWorkspaces.companyId, companyId),
                  eq(executionWorkspaces.sourceIssueId, sourceIssueId),
                ),
              );
            return rows.map(toAllocationWorkspaceRecord);
          },
          async getWorkspace(companyId, workspaceId) {
            if (!isUuidLike(companyId) || !isUuidLike(workspaceId)) {
              return null;
            }
            const rows = await tx
              .select()
              .from(executionWorkspaces)
              .where(
                and(
                  eq(executionWorkspaces.id, workspaceId),
                  eq(executionWorkspaces.companyId, companyId),
                ),
              )
              .limit(1);
            return rows[0] ? toAllocationWorkspaceRecord(rows[0]) : null;
          },
          async insertWorkspace(record) {
            const rows = await tx
              .insert(executionWorkspaces)
              .values({
                id: record.id,
                companyId: record.companyId,
                projectId: record.projectId,
                projectWorkspaceId: record.projectWorkspaceId,
                sourceIssueId: record.sourceIssueId,
                mode: record.mode,
                strategyType: record.strategyType,
                name: record.name,
                status: record.status,
                cwd: record.cwd,
                repoUrl: record.repoUrl,
                baseRef: record.baseRef,
                branchName: record.branchName,
                providerType: record.providerType,
                providerRef: record.providerRef,
                openedAt: toDateOrNull(record.openedAt),
                closedAt: toDateOrNull(record.closedAt),
                metadata: record.metadata,
              })
              .returning();
            return toAllocationWorkspaceRecord(rows[0]!);
          },
          async updateWorkspace(companyId, workspaceId, patch) {
            const rows = await tx
              .update(executionWorkspaces)
              .set({
                ...(patch.status !== undefined ? { status: patch.status } : {}),
                ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
                ...(patch.repoUrl !== undefined
                  ? { repoUrl: patch.repoUrl }
                  : {}),
                ...(patch.baseRef !== undefined
                  ? { baseRef: patch.baseRef }
                  : {}),
                ...(patch.branchName !== undefined
                  ? { branchName: patch.branchName }
                  : {}),
                ...(patch.providerType !== undefined
                  ? { providerType: patch.providerType }
                  : {}),
                ...(patch.providerRef !== undefined
                  ? { providerRef: patch.providerRef }
                  : {}),
                ...(patch.openedAt !== undefined
                  ? { openedAt: toDateOrNull(patch.openedAt) }
                  : {}),
                ...(patch.closedAt !== undefined
                  ? { closedAt: toDateOrNull(patch.closedAt) }
                  : {}),
                ...(patch.metadata !== undefined
                  ? { metadata: patch.metadata }
                  : {}),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(executionWorkspaces.id, workspaceId),
                  eq(executionWorkspaces.companyId, companyId),
                ),
              )
              .returning();
            if (!rows[0]) {
              throw new Error(
                "Source-bound workspace allocation update matched no row",
              );
            }
            return toAllocationWorkspaceRecord(rows[0]);
          },
          async bindIssueExecutionWorkspace(companyId, issueId, workspaceId) {
            // Only the execution-workspace binding changes: no status,
            // assignee, blocker, execution-policy, or monitor field is
            // reachable from this surface.
            await tx
              .update(issues)
              .set({ executionWorkspaceId: workspaceId })
              .where(
                and(eq(issues.id, issueId), eq(issues.companyId, companyId)),
              );
          },
          async logActivity(entry) {
            await tx.insert(activityLog).values({
              companyId: entry.companyId,
              actorType: "user",
              actorId: entry.actor.userId,
              action: entry.action,
              entityType: "issue",
              entityId: entry.sourceIssueId,
              details: {
                operationVersion:
                  SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
                workspaceId: entry.workspaceId,
                projectWorkspaceId: entry.projectWorkspaceId,
                selection: entry.selection,
                priorExecutionWorkspaceId: entry.priorExecutionWorkspaceId,
                disposition: entry.disposition,
                allocatedAt: entry.allocatedAt,
                runtimeInvoked: false,
                wakeInvoked: false,
              },
            });
          },
        };
        return work(txDeps);
      }),
    now: () => new Date(),
    newWorkspaceId: () => randomUUID(),
  };
}
