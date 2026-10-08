import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import {
  NATIVE_SIBLING_LIVENESS_SCHEMA,
  nativeSiblingLivenessResponseSchema,
  type NativeSiblingLivenessResponse,
} from "@paperclipai/shared";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { logger } from "../middleware/logger.js";
import { isNativeRunnerOwnershipHeld } from "./native-runtime/native-runner-ownership.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

export const NATIVE_SIBLING_LIVENESS_TTL_MS = 3_000;

/** Statuses under which the platform does not let an agent run or authenticate. */
const INELIGIBLE_AGENT_STATUSES: ReadonlySet<string> = new Set(["paused", "terminated", "pending_approval"]);

export type NativeSiblingLivenessInput = {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string;
};

export type NativeSiblingLivenessEvaluation =
  | { kind: "response"; response: NativeSiblingLivenessResponse }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "conflict" }
  | { kind: "unavailable" };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function optionalPolicyIsComplete(value: unknown): boolean {
  return value == null || asRecord(value) !== null;
}

function buildResponse(
  issueId: string,
  runId: string,
  verdict: NativeSiblingLivenessResponse["verdict"],
  observedAt: Date,
): NativeSiblingLivenessResponse {
  return nativeSiblingLivenessResponseSchema.parse({
    schema: NATIVE_SIBLING_LIVENESS_SCHEMA,
    issueId,
    runId,
    verdict,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + NATIVE_SIBLING_LIVENESS_TTL_MS).toISOString(),
  });
}

/** Marks a snapshot value that is present but unusable, so it can never match an issue id. */
const INVALID_ATTRIBUTION = "__invalid__";

/** Reads a string id from the run snapshot; present non-string values stay visible as invalid. */
function snapshotIdSql(key: "issueId" | "taskId") {
  const value = sql`(${heartbeatRuns.contextSnapshot} -> ${key})`;
  return sql<string | null>`case
    when ${value} is null or jsonb_typeof(${value}) = 'null' then null
    when jsonb_typeof(${value}) = 'string' then ${value} #>> '{}'
    else ${INVALID_ATTRIBUTION}
  end`;
}

type ActiveRunRow = {
  finishedAt: Date | null;
  issueId: string | null;
  nativeIssueId: string | null;
  snapshotIssueId: string | null;
  snapshotTaskId: string | null;
  startedAt: Date | null;
  status: string;
};

/** A row counts only when every attribution it carries names this issue and its lifecycle is coherent. */
function isCompleteActiveRun(row: ActiveRunRow, issueId: string): boolean {
  const attributions = [row.nativeIssueId, row.issueId, row.snapshotIssueId, row.snapshotTaskId];
  if (attributions.some((value) => value !== null && value !== issueId)) return false;
  if (!attributions.some((value) => value === issueId)) return false;
  if (row.status === "queued") return row.startedAt === null && row.finishedAt === null;
  if (row.status === "running") return row.startedAt !== null && row.finishedAt === null;
  return false;
}

type CallerState =
  | { kind: "not_found" | "forbidden" | "conflict" }
  | { kind: "caller"; issueId: string; companyId: string; complete: boolean };

/**
 * Reads the caller's authority: the issue, agent, run and policy rows that make it
 * the current standard-trust native owner. `complete` is false when a policy
 * document cannot be interpreted, so no verdict can be trusted.
 */
async function readCallerState(tx: Db, input: NativeSiblingLivenessInput): Promise<CallerState> {
  const [issue] = await tx
    .select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      workMode: issues.workMode,
      harnessKind: issues.harnessKind,
      projectId: issues.projectId,
      assigneeAgentId: issues.assigneeAgentId,
      executionRunId: issues.executionRunId,
      executionPolicy: issues.executionPolicy,
    })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue) return { kind: "not_found" };

  const [agent] = await tx
    .select({ companyId: agents.companyId, status: agents.status, permissions: agents.permissions })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  if (!agent) return { kind: "forbidden" };
  if (INELIGIBLE_AGENT_STATUSES.has(agent.status)) return { kind: "conflict" };

  const [run] = await tx
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      runtimeMode: heartbeatRuns.runtimeMode,
      errorCode: heartbeatRuns.errorCode,
      nativePhase: heartbeatRuns.nativePhase,
      // Only Stop markers are read; the result body never leaves the database. Native
      // Stop commits `cancellation` and `startupCancellation` while the run is still
      // `running`; adapter-owned runs use `executionCancellation`.
      cancellationState: sql<string | null>`${heartbeatRuns.resultJson} -> 'executionCancellation' ->> 'state'`,
      nativeStopRequested: sql<boolean>`(
        ${heartbeatRuns.resultJson} -> 'cancellation' is not null
        or ${heartbeatRuns.resultJson} -> 'startupCancellation' is not null
        or ${heartbeatRuns.resultJson} -> 'nativeCancellation' is not null
      )`,
      nativeIssueId: heartbeatRuns.nativeIssueId,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
    ));
  // An issue this run does not currently own is indistinguishable from an absent one.
  if (
    !run ||
    issue.assigneeAgentId !== input.agentId ||
    issue.executionRunId !== input.runId ||
    run.nativeIssueId !== issue.id
  ) {
    return { kind: "not_found" };
  }
  if (
    issue.status !== "in_progress" ||
    run.status !== "running" ||
    run.runtimeMode !== "native" ||
    !run.startedAt ||
    run.finishedAt !== null ||
    // Stop revokes a run's authority before the executor settles, and a held
    // native runner is not yet proved to be the issue's owner.
    run.nativeStopRequested ||
    agentRunWritesRevoked({
      status: run.status,
      resultJson: { executionCancellation: { state: run.cancellationState } },
    }) ||
    isNativeRunnerOwnershipHeld(run)
  ) {
    return { kind: "conflict" };
  }
  if (
    issue.workMode === "skill_test" || issue.workMode === "task_bridge" ||
    issue.harnessKind === "skill_test" || issue.harnessKind === "task_bridge"
  ) {
    return { kind: "forbidden" };
  }

  const incomplete = { kind: "caller", issueId: issue.id, companyId: issue.companyId, complete: false } as const;
  const runContext = asRecord(run.contextSnapshot);
  if (!runContext) return incomplete;
  const runPolicy = runContext.executionPolicy;
  if (
    !optionalPolicyIsComplete(agent.permissions) ||
    !optionalPolicyIsComplete(issue.executionPolicy) ||
    !optionalPolicyIsComplete(runPolicy)
  ) {
    return incomplete;
  }
  let project: { companyId: string; executionWorkspacePolicy: unknown } | null = null;
  if (issue.projectId) {
    const [projectRow] = await tx
      .select({ companyId: projects.companyId, executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects)
      .where(and(eq(projects.id, issue.projectId), eq(projects.companyId, input.companyId)));
    if (!projectRow || !optionalPolicyIsComplete(projectRow.executionWorkspacePolicy)) return incomplete;
    project = projectRow;
  }

  const trust = resolveCoreTrustPreset({
    companyId: input.companyId,
    agent,
    project,
    issue,
    run: { companyId: run.companyId, executionPolicy: runPolicy },
  });
  if (trust.kind !== "standard") return { kind: "forbidden" };
  return { kind: "caller", issueId: issue.id, companyId: issue.companyId, complete: true };
}

/** Every queued, running or retry-scheduled run that any binding attributes to the issue. */
async function readActiveRuns(tx: Db, companyId: string, issueId: string) {
  const snapshotIssueId = snapshotIdSql("issueId");
  const snapshotTaskId = snapshotIdSql("taskId");
  return tx
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      issueId: heartbeatRuns.issueId,
      nativeIssueId: heartbeatRuns.nativeIssueId,
      snapshotIssueId,
      snapshotTaskId,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      or(
        eq(heartbeatRuns.nativeIssueId, issueId),
        eq(heartbeatRuns.issueId, issueId),
        sql`${snapshotIssueId} = ${issueId}`,
        sql`${snapshotTaskId} = ${issueId}`,
      ),
    ));
}

type Verdict = NativeSiblingLivenessResponse["verdict"];

/** Clear needs the caller to be among the examined runs and every examined run to be coherent. */
function verdictFor(rows: Array<ActiveRunRow & { id: string }>, runId: string, issueId: string): Verdict {
  if (!rows.some((row) => row.id === runId) || !rows.every((row) => isCompleteActiveRun(row, issueId))) {
    return "unknown";
  }
  return rows.some((row) => row.id !== runId) ? "sibling" : "clear";
}

/** The least reassuring of two observations: sibling, then unknown, then clear. */
function leastReassuring(a: Verdict, b: Verdict): Verdict {
  const rank: Record<Verdict, number> = { clear: 0, unknown: 1, sibling: 2 };
  return rank[b] > rank[a] ? b : a;
}

const READ_ONLY_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

/** Seams for the hermetic tests; the route never supplies them. */
export type NativeSiblingLivenessTestHooks = {
  /** Runs inside the snapshot once its statement timeout is set. */
  afterTimeoutSet?: (tx: Db) => Promise<void>;
  /** Runs after the snapshot commits and before the caller's authority is rechecked. */
  afterSnapshot?: () => Promise<void>;
};

/**
 * Reads one exact-issue active-run snapshot and returns only a verdict.
 *
 * The snapshot is a read-only repeatable-read transaction that takes no row
 * locks, so it cannot block or deadlock the platform's writers. Every queued,
 * running or retry-scheduled run attributed to the issue by any durable binding
 * or snapshot id is examined. An unusable or contradictory attribution makes the
 * verdict unknown; wake requests not yet promoted to a run are not executions and
 * are not counted. The whole observation is repeated in a second fresh snapshot
 * and the less reassuring verdict wins, so a revocation committed in between never
 * yields a verdict and a peer that appeared in between is seen. A returned verdict
 * is an observation, not a lock on future execution.
 */
export async function evaluateNativeSiblingLiveness(
  db: Db,
  input: NativeSiblingLivenessInput,
  hooks: NativeSiblingLivenessTestHooks = {},
): Promise<NativeSiblingLivenessEvaluation> {
  const observe = async (tx: Db) => {
    const caller = await readCallerState(tx, input);
    if (caller.kind !== "caller") return caller;
    const verdict: Verdict = caller.complete
      ? verdictFor(await readActiveRuns(tx, caller.companyId, caller.issueId), input.runId, caller.issueId)
      : "unknown";
    return { kind: "observed" as const, caller, verdict };
  };
  try {
    const startedAt = new Date();
    const first = await db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '1000ms'`);
      await hooks.afterTimeoutSet?.(tx as unknown as Db);
      return observe(tx as unknown as Db);
    }, READ_ONLY_SNAPSHOT);
    if (first.kind !== "observed") return first;

    await hooks.afterSnapshot?.();
    const second = await db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '1000ms'`);
      return observe(tx as unknown as Db);
    }, READ_ONLY_SNAPSHOT);
    if (second.kind !== "observed") return second;

    // Never send a verdict whose validity window has already closed.
    if (Date.now() - startedAt.getTime() >= NATIVE_SIBLING_LIVENESS_TTL_MS) return { kind: "unavailable" };
    return {
      kind: "response",
      response: buildResponse(first.caller.issueId, input.runId, leastReassuring(first.verdict, second.verdict), startedAt),
    };
  } catch (err) {
    // Timeouts and failed reads are expected fail-closed outcomes; log the error
    // class only, so operators can tell them from a defect without row data.
    const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
    const code = cause?.code ?? (err as { code?: unknown } | null)?.code;
    logger.warn(
      { event: "native_sibling_liveness_unavailable", code: typeof code === "string" ? code : "unknown" },
      "native sibling liveness read failed closed",
    );
    return { kind: "unavailable" };
  }
}
