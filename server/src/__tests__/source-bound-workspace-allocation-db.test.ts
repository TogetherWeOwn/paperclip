/**
 * DB-backed contract tests for source-bound workspace allocation
 * (Test Author, red-first).
 *
 * These go through the wished-for production wiring
 * `createDbSourceBoundWorkspaceAllocationDeps(db)` from
 * `../services/source-bound-workspace-allocation.js` against embedded
 * Postgres, mirroring `source-bound-transport-validation-db.test.ts`.
 * The DB deps must:
 * - resolve the issue's stored selection from the real columns
 *   (`executionWorkspacePreference`, `executionWorkspaceSettings`,
 *   `projectWorkspaceId`, `projectId`) inside the actor's company;
 * - run insert + bind + activity audit in ONE database transaction
 *   (`deps.transact`), persisting the audit entry as an `activity_log`
 *   row with action `issue.source_bound_workspace_allocated`, entity =
 *   the issue, actor = the board user, and entry fields (workspaceId,
 *   projectWorkspaceId, selection, priorExecutionWorkspaceId,
 *   disposition) in `details`;
 * - persist the unrealized record with `openedAt` NULL. That requires
 *   the Builder's migration making `execution_workspaces.opened_at`
 *   nullable (today it is `NOT NULL DEFAULT now()`), which is part of
 *   this contract: an allocated record must be distinguishable from a
 *   realized one at the row level.
 *
 * Lifecycle pinned end to end at the row level: allocate → transport
 * validation denies `workspace_not_realized` through the real DB
 * resolvers → `markAllocatedWorkspaceRealized` flips the SAME row to
 * active (no second row) → transport validation passes. Allocation
 * itself creates no heartbeat run and no runtime service row, and does
 * not move issue status/assignee/monitor fields. The terminal-workspace
 * reaper must never sweep an unrealized record (its candidate filter is
 * status-based; this pins `unrealized` outside it even after the source
 * issue goes terminal).
 *
 * All identifiers are synthetic.
 */
import { randomUUID } from "node:crypto";
import {
  activityLog,
  agents,
  companies,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import {
  allocateSourceBoundWorkspace,
  createDbSourceBoundWorkspaceAllocationDeps,
  markAllocatedWorkspaceRealized,
  type SourceBoundAllocationActor,
} from "../services/source-bound-workspace-allocation.js";
import {
  createDbSourceBoundTransportValidationDeps,
  runSourceBoundTransportValidation,
} from "../services/source-bound-transport-validation-operation.js";
import {
  describeEmbeddedPostgres,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const BOARD_USER_ID = "board-user-1";
const DIGEST = `sha256:${"b".repeat(64)}`;
const ATTESTATION_ENV = {
  PAPERCLIP_SOURCE_REVISION: "a".repeat(40),
  PAPERCLIP_DEPLOYED_IMAGE_REFERENCE: `registry.example.com/paperclip-server@${DIGEST}`,
  PAPERCLIP_EXPECTED_IMAGE_DIGEST: DIGEST,
};

describeEmbeddedPostgres("source-bound workspace allocation (DB-backed deps)", () => {
  const ctx = useEmbeddedPostgres("paperclip-source-bound-alloc-");

  afterEach(async () => {
    await ctx.db.delete(workspaceRuntimeServices);
    await ctx.db.delete(activityLog);
    await ctx.db.delete(issues);
    await ctx.db.delete(executionWorkspaces);
    await ctx.db.delete(heartbeatRuns);
    await ctx.db.delete(agents);
    await ctx.db.delete(projectWorkspaces);
    await ctx.db.delete(projects);
    await ctx.db.delete(companies);
  });

  async function seed(
    opts: {
      issueStatus?: string;
      executionWorkspaceSettings?: Record<string, unknown> | null;
      executionWorkspacePreference?: string | null;
    } = {},
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const identifier = `TST-${Math.floor(Math.random() * 900_000) + 100_000}`;
    await ctx.db.insert(companies).values({
      id: companyId,
      name: "Source-bound allocation test",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await ctx.db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Source-bound allocation project",
      status: "in_progress",
    });
    await ctx.db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: "git_repo",
      repoUrl: "https://example.com/repo.git",
      repoRef: "origin/main",
      isPrimary: true,
    });
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      identifier,
      issueNumber: Number(identifier.split("-")[1]),
      title: "Allocate my transport",
      status: opts.issueStatus ?? "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      executionWorkspacePreference:
        opts.executionWorkspacePreference ?? "isolated_workspace",
      executionWorkspaceSettings: opts.executionWorkspaceSettings ?? {
        mode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/main",
          branchTemplate: `${identifier}-host-transport`,
          worktreeParentDir: ".paperclip/worktrees",
        },
      },
    });
    return { companyId, agentId, projectId, projectWorkspaceId, issueId, identifier };
  }

  function boardActor(companyId: string): SourceBoundAllocationActor {
    return {
      type: "board",
      userId: BOARD_USER_ID,
      companyId,
      hasRuntimeManage: true,
    };
  }

  async function allocate(
    seeded: Awaited<ReturnType<typeof seed>>,
    actor: SourceBoundAllocationActor | null = null,
  ) {
    return allocateSourceBoundWorkspace(
      createDbSourceBoundWorkspaceAllocationDeps(ctx.db),
      {
        companyId: seeded.companyId,
        sourceIssueId: seeded.issueId,
        actor: actor ?? boardActor(seeded.companyId),
      },
    );
  }

  async function workspaceRows(companyId: string) {
    return ctx.db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.companyId, companyId));
  }

  it("persists an unrealized row, binds the issue, and writes the audit activity — with no wake or runtime rows", async () => {
    const seeded = await seed();
    const result = await allocate(seeded);
    expect(result).toMatchObject({ ok: true, disposition: "created" });
    if (!result.ok) throw new Error("expected allocation to succeed");

    const rows = await workspaceRows(seeded.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.workspace.id,
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      projectWorkspaceId: seeded.projectWorkspaceId,
      sourceIssueId: seeded.issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      status: "unrealized",
      cwd: null,
      providerRef: null,
      branchName: null,
      openedAt: null,
      closedAt: null,
      baseRef: "origin/main",
      providerType: "git_worktree",
    });

    const issue = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((r) => r[0]!);
    expect(issue.executionWorkspaceId).toBe(result.workspace.id);
    // No other issue field moved: still blocked, same assignee, same
    // selection, no monitor armed.
    expect(issue.status).toBe("blocked");
    expect(issue.assigneeAgentId).toBe(seeded.agentId);
    expect(issue.executionWorkspacePreference).toBe("isolated_workspace");
    expect(issue.monitorNextCheckAt).toBeNull();

    const audits = await ctx.db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, seeded.companyId),
          eq(activityLog.action, "issue.source_bound_workspace_allocated"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityId).toBe(seeded.issueId);
    expect(audits[0]!.actorId).toBe(BOARD_USER_ID);
    expect(audits[0]!.details).toMatchObject({
      workspaceId: result.workspace.id,
      projectWorkspaceId: seeded.projectWorkspaceId,
      priorExecutionWorkspaceId: null,
      disposition: "created",
      selection: {
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        baseRef: "origin/main",
        branchTemplate: `${seeded.identifier}-host-transport`,
      },
    });

    // No wake, no run, no runtime service, no branch/worktree provisioning
    // is reachable from allocation.
    const runs = await ctx.db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, seeded.companyId));
    expect(runs).toEqual([]);
    const services = await ctx.db
      .select()
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.companyId, seeded.companyId));
    expect(services).toEqual([]);
  });

  it("leaves zero residue (no row, no binding, no audit) on denied allocations", async () => {
    const seeded = await seed();
    const results = [
      // agent principal
      await allocate(seeded, {
        type: "agent",
        userId: null,
        companyId: seeded.companyId,
        hasRuntimeManage: true,
      }),
      // board principal without runtime:manage
      await allocate(seeded, {
        ...boardActor(seeded.companyId),
        hasRuntimeManage: false,
      }),
      // cross-company actor scope
      await allocate(seeded, {
        ...boardActor(seeded.companyId),
        companyId: randomUUID(),
      }),
    ];
    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        errorCode: "unauthorized_principal",
      });
    }
    expect(await workspaceRows(seeded.companyId)).toEqual([]);
    const issue = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((r) => r[0]!);
    expect(issue.executionWorkspaceId).toBeNull();
    const audits = await ctx.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, seeded.companyId));
    expect(audits).toEqual([]);
  });

  it("denies a non-isolated stored selection read from the real columns", async () => {
    const seeded = await seed({
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
        workspaceStrategy: { type: "project_primary" },
      },
    });
    const result = await allocate(seeded);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "selection_not_isolated",
    });
    expect(await workspaceRows(seeded.companyId)).toEqual([]);
  });

  it("denies unrealized records in transport validation through the real resolvers, then passes after realization of the same row", async () => {
    // Validation needs an unblocked, assignee-principal issue.
    const seeded = await seed({ issueStatus: "todo" });
    const allocated = await allocate(seeded);
    expect(allocated.ok).toBe(true);
    if (!allocated.ok) throw new Error("expected allocation to succeed");
    const workspaceId = allocated.workspace.id;

    const validate = () =>
      runSourceBoundTransportValidation(
        createDbSourceBoundTransportValidationDeps(ctx.db, {
          env: ATTESTATION_ENV,
        }),
        {
          companyId: seeded.companyId,
          sourceIssueId: seeded.issueId,
          principalAgentId: seeded.agentId,
          workspaceId,
          transport: "git_worktree",
        },
      );

    const beforeRealization = await validate();
    expect(beforeRealization.ok).toBe(false);
    expect(beforeRealization.transport).toMatchObject({
      ok: false,
      errorCode: "workspace_not_realized",
    });

    const realized = await markAllocatedWorkspaceRealized(
      createDbSourceBoundWorkspaceAllocationDeps(ctx.db),
      {
        companyId: seeded.companyId,
        sourceIssueId: seeded.issueId,
        workspaceId,
        cwd: "/tmp/paperclip-source-bound-alloc/worktree",
        providerRef: "/tmp/paperclip-source-bound-alloc/worktree",
        branchName: `${seeded.identifier}-host-transport`,
      },
    );
    expect(realized).toMatchObject({
      ok: true,
      workspace: { id: workspaceId, status: "active" },
    });

    // Adoption reused the allocated row — still exactly one row, now
    // realized with openedAt set.
    const rows = await workspaceRows(seeded.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: workspaceId,
      status: "active",
      cwd: "/tmp/paperclip-source-bound-alloc/worktree",
      branchName: `${seeded.identifier}-host-transport`,
    });
    expect(rows[0]!.openedAt).not.toBeNull();

    const afterRealization = await validate();
    expect(afterRealization.ok).toBe(true);
    expect(afterRealization.transport).toMatchObject({
      ok: true,
      validatedWorkspaceId: workspaceId,
    });
  });

  it("is idempotent through the DB wiring: repeat allocation inserts no second row", async () => {
    const seeded = await seed();
    const first = await allocate(seeded);
    const second = await allocate(seeded);
    expect(first).toMatchObject({ ok: true, disposition: "created" });
    expect(second).toMatchObject({ ok: true, disposition: "existing" });
    if (!first.ok || !second.ok) throw new Error("expected allocations to succeed");
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(await workspaceRows(seeded.companyId)).toHaveLength(1);
  });

  it("terminal-workspace reaper never sweeps an unrealized allocation, even for a terminal source issue", async () => {
    const seeded = await seed({ issueStatus: "done" });
    const workspaceId = randomUUID();
    await ctx.db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      projectWorkspaceId: seeded.projectWorkspaceId,
      sourceIssueId: seeded.issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "unrealized-allocation",
      status: "unrealized",
      providerType: "git_worktree",
      cwd: null,
      providerRef: null,
      branchName: null,
      // Requires the Builder's nullable-opened_at migration.
      openedAt: null as unknown as Date,
    });

    const svc = executionWorkspaceService(ctx.db, {
      workspaceReaperCooldownDays: 0,
    });
    await svc.sweepTerminalWorkspaces();

    const row = await ctx.db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId))
      .then((r) => r[0]!);
    expect(row.status).toBe("unrealized");
    expect(row.closedAt).toBeNull();
  });
});
