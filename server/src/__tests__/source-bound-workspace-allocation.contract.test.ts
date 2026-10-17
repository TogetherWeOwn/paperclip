/**
 * Contract tests for source-bound workspace ALLOCATION (Test Author, red-first).
 *
 * The Builder implements `../services/source-bound-workspace-allocation.js`
 * against this file without editing it. The wished-for module mirrors the
 * injected-deps style of `source-bound-transport-validation-operation.ts`:
 * every compared/persisted fact is server-resolved inside one company, the
 * caller supplies nothing but the target issue id, and proof `effects`
 * callbacks exist so tests can prove allocation never wakes the source
 * issue, checks out code, creates a branch/worktree, or starts a runtime.
 *
 * Contract summary (design gate: APPROVE WITH CONDITIONS):
 * - Principal: authenticated Board actor with server-resolved
 *   `runtime:manage` (`hasRuntimeManage` is resolved by the route via
 *   `assertBoard` + `access.decide("runtime:manage")`, never from the
 *   request body). Agent keys, board actors without the capability, and
 *   cross-company actors deny as `unauthorized_principal` before any
 *   mutation.
 * - Selection: derived server-side from the issue's stored selection
 *   (`executionWorkspacePreference` / `executionWorkspaceSettings` +
 *   `projectWorkspaceId`). Only `isolated_workspace` + `git_worktree`
 *   allocates; absent selection denies `selection_missing`, any other
 *   mode/strategy (or a preference/settings disagreement) denies
 *   `selection_not_isolated`. Caller-supplied cwd/branch/transport/
 *   sourceIssueId/workspace identity values are ignored.
 * - Unrealized record: durable status `unrealized`, no cwd, providerRef,
 *   branchName, openedAt, or closedAt. Allocation creates no branch ref
 *   and no worktree directory (no such effect exists on any path).
 * - Atomicity: insert + `issue.executionWorkspaceId` bind + audit entry
 *   happen inside ONE `deps.transact(...)` call; a failure inside the
 *   transaction propagates and leaves no partial state. No issue status,
 *   assignee, blocker, execution-policy, or monitor field is touched —
 *   the transaction surface below has no way to write them.
 * - Idempotency: a repeat call returns the existing open source-bound
 *   allocation (`disposition: "existing"`, audited) only when company,
 *   source issue, and selected project workspace all still match.
 *   Conflicting, archived-bound, malformed, or ambiguous bindings fail
 *   closed as `binding_conflict` — never a silent rebind. An archived
 *   source-bound record the issue is NOT bound to does not count as
 *   bound; allocation creates a fresh record.
 * - Realization adoption: `markAllocatedWorkspaceRealized` transitions the
 *   exact allocated record to `active` with cwd/providerRef/branchName/
 *   openedAt set; it never inserts a second record. Incomplete
 *   realization facts deny `realization_incomplete` and leave the record
 *   unrealized (a failed realization must not look usable). The
 *   heartbeat calls this instead of inserting when the issue is bound to
 *   an unrealized record.
 * - Rollback: Board + `runtime:manage` only; archives ONLY the allocated
 *   unrealized record and restores `issue.executionWorkspaceId` to the
 *   exact prior value recorded at allocation, refusing (as
 *   `binding_conflict`) if the binding changed in between. Audited as a
 *   separate attributed event. Existing workspaces are never mutated.
 *
 * All identifiers are synthetic.
 */
import { describe, expect, it } from "vitest";
import {
  allocateSourceBoundWorkspace,
  markAllocatedWorkspaceRealized,
  rollbackSourceBoundWorkspaceAllocation,
  SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
  type SourceBoundAllocationActor,
  type SourceBoundAllocationAuditEntry,
  type SourceBoundAllocationIssueFacts,
  type SourceBoundAllocationWorkspaceRecord,
  type SourceBoundWorkspaceAllocationDeps,
  type SourceBoundWorkspaceAllocationTx,
  UNREALIZED_EXECUTION_WORKSPACE_STATUS,
} from "../services/source-bound-workspace-allocation.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";
const SOURCE_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ISSUE_ID = "77777777-7777-4777-8777-777777777777";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_PROJECT_WORKSPACE_ID = "45454545-4545-4454-8454-454545454545";
const ALLOCATED_WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const SECOND_WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const PRIOR_WORKSPACE_ID = "56565656-5656-4565-8565-565656565656";
const BOARD_USER_ID = "board-user-1";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();

const boardActor: SourceBoundAllocationActor = {
  type: "board",
  userId: BOARD_USER_ID,
  companyId: COMPANY_ID,
  hasRuntimeManage: true,
};

function isolatedSettings(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mode: "isolated_workspace",
    workspaceStrategy: {
      type: "git_worktree",
      baseRef: "origin/main",
      branchTemplate: "TST-42-source-transport",
      worktreeParentDir: ".paperclip/worktrees",
    },
    ...overrides,
  };
}

function baseIssue(
  overrides: Partial<SourceBoundAllocationIssueFacts> = {},
): SourceBoundAllocationIssueFacts {
  return {
    id: SOURCE_ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    projectWorkspaceId: PROJECT_WORKSPACE_ID,
    status: "blocked",
    assigneeAgentId: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: "isolated_workspace",
    executionWorkspaceSettings: isolatedSettings(),
    executionPolicy: null,
    ...overrides,
  };
}

/** A pre-existing record in whatever state a test seeds. */
function workspaceRecord(
  overrides: Partial<SourceBoundAllocationWorkspaceRecord> = {},
): SourceBoundAllocationWorkspaceRecord {
  return {
    id: ALLOCATED_WORKSPACE_ID,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    projectWorkspaceId: PROJECT_WORKSPACE_ID,
    sourceIssueId: SOURCE_ISSUE_ID,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "TST-42-source-transport",
    status: UNREALIZED_EXECUTION_WORKSPACE_STATUS,
    cwd: null,
    repoUrl: null,
    baseRef: "origin/main",
    branchName: null,
    providerType: "git_worktree",
    providerRef: null,
    openedAt: null,
    closedAt: null,
    metadata: {
      sourceBoundAllocation: {
        version: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
        priorExecutionWorkspaceId: null,
        allocatedByUserId: BOARD_USER_ID,
        selection: {
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          baseRef: "origin/main",
          branchTemplate: "TST-42-source-transport",
        },
      },
    },
    ...overrides,
  };
}

type Store = {
  issues: Map<string, SourceBoundAllocationIssueFacts>;
  workspaces: Map<string, SourceBoundAllocationWorkspaceRecord>;
  audits: SourceBoundAllocationAuditEntry[];
  mutations: string[];
};

/**
 * In-memory transactional fake. `transact` snapshots the store and rolls
 * back on throw, so a test can prove the Builder's code really performs
 * all mutations inside the transaction: state written any other way
 * would survive a mid-transaction failure and fail the assertion.
 */
function makeDeps(
  seed: Partial<Store> = {},
  txOverrides: Partial<SourceBoundWorkspaceAllocationTx> = {},
): { deps: SourceBoundWorkspaceAllocationDeps; store: Store } {
  const store: Store = {
    issues: new Map([[SOURCE_ISSUE_ID, baseIssue()]]),
    workspaces: new Map(),
    audits: [],
    mutations: [],
    ...seed,
  };
  const tx: SourceBoundWorkspaceAllocationTx = {
    async loadIssue(companyId, issueId) {
      const issue = store.issues.get(issueId) ?? null;
      return issue && issue.companyId === companyId ? issue : null;
    },
    async listWorkspacesForSourceIssue(companyId, sourceIssueId) {
      return [...store.workspaces.values()].filter(
        (ws) =>
          ws.companyId === companyId && ws.sourceIssueId === sourceIssueId,
      );
    },
    async getWorkspace(companyId, workspaceId) {
      const ws = store.workspaces.get(workspaceId) ?? null;
      return ws && ws.companyId === companyId ? ws : null;
    },
    async insertWorkspace(record) {
      store.mutations.push("insertWorkspace");
      const row: SourceBoundAllocationWorkspaceRecord = {
        ...record,
        id: record.id ?? ALLOCATED_WORKSPACE_ID,
      };
      store.workspaces.set(row.id, row);
      return row;
    },
    async updateWorkspace(companyId, workspaceId, patch) {
      store.mutations.push("updateWorkspace");
      const existing = store.workspaces.get(workspaceId!)!;
      void companyId;
      const next = { ...existing, ...patch };
      store.workspaces.set(existing.id, next);
      return next;
    },
    async bindIssueExecutionWorkspace(companyId, issueId, workspaceId) {
      store.mutations.push("bindIssueExecutionWorkspace");
      const issue = store.issues.get(issueId!)!;
      void companyId;
      store.issues.set(issue.id, {
        ...issue,
        executionWorkspaceId: workspaceId,
      });
    },
    async logActivity(entry) {
      store.mutations.push("logActivity");
      store.audits.push(entry);
    },
    ...txOverrides,
  };
  const deps: SourceBoundWorkspaceAllocationDeps = {
    async transact(work) {
      const snapshot = {
        issues: structuredClone(store.issues),
        workspaces: structuredClone(store.workspaces),
        audits: structuredClone(store.audits),
        mutations: [...store.mutations],
      };
      try {
        return await work(tx);
      } catch (error) {
        store.issues = snapshot.issues;
        store.workspaces = snapshot.workspaces;
        store.audits = snapshot.audits;
        store.mutations = snapshot.mutations;
        throw error;
      }
    },
    now: () => NOW,
    newWorkspaceId: () => ALLOCATED_WORKSPACE_ID,
  };
  return { deps, store };
}

function countingEffects() {
  const counts = {
    wakeIssue: 0,
    startRun: 0,
    checkout: 0,
    createBranch: 0,
    createWorktree: 0,
    startRuntimeService: 0,
    executeProduct: 0,
    executeStaging: 0,
  };
  const effects = Object.fromEntries(
    Object.keys(counts).map((key) => [
      key,
      () => {
        counts[key as keyof typeof counts] += 1;
      },
    ]),
  );
  return { counts, effects };
}

function baseInput() {
  return {
    companyId: COMPANY_ID,
    sourceIssueId: SOURCE_ISSUE_ID,
    actor: boardActor,
  };
}

describe("source-bound workspace allocation (contract)", () => {
  it("exposes a stable operation version and unrealized status literal", () => {
    expect(SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION).toBe(
      "source-bound-workspace-allocation/v1",
    );
    expect(UNREALIZED_EXECUTION_WORKSPACE_STATUS).toBe("unrealized");
  });

  it("allocates an unrealized source-bound record derived from the stored isolated selection", async () => {
    const { deps, store } = makeDeps();
    const { counts, effects } = countingEffects();

    const result = await allocateSourceBoundWorkspace(deps, {
      ...baseInput(),
      effects,
    });

    expect(result).toMatchObject({
      ok: true,
      operationVersion: "source-bound-workspace-allocation/v1",
      disposition: "created",
      companyId: COMPANY_ID,
      sourceIssueId: SOURCE_ISSUE_ID,
      runtimeInvoked: false,
      wakeInvoked: false,
      workspace: {
        id: ALLOCATED_WORKSPACE_ID,
        companyId: COMPANY_ID,
        projectId: PROJECT_ID,
        projectWorkspaceId: PROJECT_WORKSPACE_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
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
      },
    });
    if (!result.ok) throw new Error("expected allocation to succeed");
    expect(result.workspace.name.length).toBeGreaterThan(0);
    // The issue is bound to the new record and nothing else about it moved.
    expect(store.issues.get(SOURCE_ISSUE_ID)).toMatchObject({
      executionWorkspaceId: ALLOCATED_WORKSPACE_ID,
      status: "blocked",
      assigneeAgentId: null,
      executionWorkspacePreference: "isolated_workspace",
    });
    // Provenance for rollback + audit review lives on the record.
    const allocationMeta = (
      result.workspace.metadata as {
        sourceBoundAllocation?: Record<string, unknown>;
      } | null
    )?.sourceBoundAllocation;
    expect(allocationMeta).toMatchObject({
      priorExecutionWorkspaceId: null,
      allocatedByUserId: BOARD_USER_ID,
    });
    // Exactly the three coupled mutations, no effects of any kind.
    expect(store.mutations).toEqual([
      "insertWorkspace",
      "bindIssueExecutionWorkspace",
      "logActivity",
    ]);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it("writes one audit entry carrying actor, selection inputs, prior binding, and disposition", async () => {
    const { deps, store } = makeDeps();
    await allocateSourceBoundWorkspace(deps, baseInput());
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "issue.source_bound_workspace_allocated",
      companyId: COMPANY_ID,
      sourceIssueId: SOURCE_ISSUE_ID,
      workspaceId: ALLOCATED_WORKSPACE_ID,
      actor: { type: "board", userId: BOARD_USER_ID },
      projectWorkspaceId: PROJECT_WORKSPACE_ID,
      selection: {
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        baseRef: "origin/main",
        branchTemplate: "TST-42-source-transport",
      },
      priorExecutionWorkspaceId: null,
      disposition: "created",
      allocatedAt: NOW_ISO,
    });
  });

  it("ignores caller-supplied cwd/branch/transport/source/binding values", async () => {
    const { deps, store } = makeDeps();
    const result = await allocateSourceBoundWorkspace(deps, {
      ...baseInput(),
      requested: {
        cwd: "/attacker/chosen",
        branchName: "attacker-branch",
        providerType: "remote_managed",
        providerRef: "/attacker/worktree",
        transport: "remote_managed",
        sourceIssueId: OTHER_ISSUE_ID,
        workspaceId: SECOND_WORKSPACE_ID,
        projectWorkspaceId: OTHER_PROJECT_WORKSPACE_ID,
        status: "active",
        openedAt: "2020-01-01T00:00:00.000Z",
        baseRef: "origin/attacker",
      },
    });
    expect(result).toMatchObject({
      ok: true,
      workspace: {
        id: ALLOCATED_WORKSPACE_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        projectWorkspaceId: PROJECT_WORKSPACE_ID,
        status: "unrealized",
        cwd: null,
        branchName: null,
        providerType: "git_worktree",
        providerRef: null,
        openedAt: null,
        baseRef: "origin/main",
      },
    });
    expect(store.workspaces.has(SECOND_WORKSPACE_ID)).toBe(false);
  });

  it.each([
    {
      name: "an agent-key actor",
      actor: { ...boardActor, type: "agent", userId: null },
    },
    {
      name: "a board actor without runtime:manage",
      actor: { ...boardActor, hasRuntimeManage: false },
    },
    {
      name: "a board actor with no user identity",
      actor: { ...boardActor, userId: null },
    },
    {
      name: "a board actor scoped to another company",
      actor: { ...boardActor, companyId: OTHER_COMPANY_ID },
    },
  ])("denies $name before any mutation", async ({ actor }) => {
    const { deps, store } = makeDeps();
    const { counts, effects } = countingEffects();
    const result = await allocateSourceBoundWorkspace(deps, {
      ...baseInput(),
      actor,
      effects,
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "unauthorized_principal",
      runtimeInvoked: false,
      wakeInvoked: false,
    });
    expect(store.mutations).toEqual([]);
    expect(store.workspaces.size).toBe(0);
    expect(store.audits).toEqual([]);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it("denies when the issue is missing or belongs to another company", async () => {
    for (const issues of [
      new Map<string, SourceBoundAllocationIssueFacts>(),
      new Map([[SOURCE_ISSUE_ID, baseIssue({ companyId: OTHER_COMPANY_ID })]]),
    ]) {
      const { deps, store } = makeDeps({ issues });
      const result = await allocateSourceBoundWorkspace(deps, baseInput());
      expect(result).toMatchObject({
        ok: false,
        errorCode: "unauthorized_principal",
      });
      expect(store.mutations).toEqual([]);
    }
  });

  it.each([
    {
      name: "no selection (no preference, no settings)",
      issue: baseIssue({
        executionWorkspacePreference: null,
        executionWorkspaceSettings: null,
      }),
      errorCode: "selection_missing",
    },
    {
      name: "no selected project workspace",
      issue: baseIssue({ projectWorkspaceId: null }),
      errorCode: "selection_missing",
    },
    {
      name: "shared-workspace mode",
      issue: baseIssue({
        executionWorkspacePreference: "shared_workspace",
        executionWorkspaceSettings: isolatedSettings({
          mode: "shared_workspace",
        }),
      }),
      errorCode: "selection_not_isolated",
    },
    {
      name: "project_primary strategy",
      issue: baseIssue({
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "project_primary" },
        },
      }),
      errorCode: "selection_not_isolated",
    },
    {
      name: "preference/settings mode disagreement",
      issue: baseIssue({
        executionWorkspacePreference: "shared_workspace",
        // settings still say isolated_workspace: ambiguous, fail closed
      }),
      errorCode: "selection_not_isolated",
    },
  ])("denies $name without mutating", async ({ issue, errorCode }) => {
    const { deps, store } = makeDeps({
      issues: new Map([[SOURCE_ISSUE_ID, issue]]),
    });
    const result = await allocateSourceBoundWorkspace(deps, baseInput());
    expect(result).toMatchObject({ ok: false, errorCode });
    expect(store.mutations).toEqual([]);
    expect(store.workspaces.size).toBe(0);
  });

  it("is idempotent: a repeat call returns the existing open allocation and audits the disposition", async () => {
    const existing = workspaceRecord();
    const { deps, store } = makeDeps({
      issues: new Map([
        [
          SOURCE_ISSUE_ID,
          baseIssue({ executionWorkspaceId: ALLOCATED_WORKSPACE_ID }),
        ],
      ]),
      workspaces: new Map([[ALLOCATED_WORKSPACE_ID, existing]]),
    });
    const result = await allocateSourceBoundWorkspace(deps, baseInput());
    expect(result).toMatchObject({
      ok: true,
      disposition: "existing",
      workspace: { id: ALLOCATED_WORKSPACE_ID, status: "unrealized" },
    });
    expect(store.mutations).toEqual(["logActivity"]);
    expect(store.workspaces.size).toBe(1);
    expect(store.audits[0]).toMatchObject({
      action: "issue.source_bound_workspace_allocated",
      disposition: "existing",
      priorExecutionWorkspaceId: ALLOCATED_WORKSPACE_ID,
    });
  });

  it("fails closed when the bound record belongs to another issue (no silent rebind, no mutation of it)", async () => {
    const foreign = workspaceRecord({ sourceIssueId: OTHER_ISSUE_ID });
    const before = structuredClone(foreign);
    const { deps, store } = makeDeps({
      issues: new Map([
        [
          SOURCE_ISSUE_ID,
          baseIssue({ executionWorkspaceId: ALLOCATED_WORKSPACE_ID }),
        ],
      ]),
      workspaces: new Map([[ALLOCATED_WORKSPACE_ID, foreign]]),
    });
    const result = await allocateSourceBoundWorkspace(deps, baseInput());
    expect(result).toMatchObject({ ok: false, errorCode: "binding_conflict" });
    expect(store.mutations).toEqual([]);
    expect(store.workspaces.get(ALLOCATED_WORKSPACE_ID)).toEqual(before);
  });

  it("fails closed when the issue is bound to an archived record", async () => {
    const archived = workspaceRecord({
      status: "archived",
      closedAt: NOW,
    });
    const { deps, store } = makeDeps({
      issues: new Map([
        [
          SOURCE_ISSUE_ID,
          baseIssue({ executionWorkspaceId: ALLOCATED_WORKSPACE_ID }),
        ],
      ]),
      workspaces: new Map([[ALLOCATED_WORKSPACE_ID, archived]]),
    });
    const result = await allocateSourceBoundWorkspace(deps, baseInput());
    expect(result).toMatchObject({ ok: false, errorCode: "binding_conflict" });
    expect(store.mutations).toEqual([]);
  });

  it("fails closed when the existing open allocation's selected project workspace no longer matches", async () => {
    const stale = workspaceRecord({
      projectWorkspaceId: OTHER_PROJECT_WORKSPACE_ID,
    });
    const { deps, store } = makeDeps({
      issues: new Map([
        [
          SOURCE_ISSUE_ID,
          baseIssue({ executionWorkspaceId: ALLOCATED_WORKSPACE_ID }),
        ],
      ]),
      workspaces: new Map([[ALLOCATED_WORKSPACE_ID, stale]]),
    });
    const result = await allocateSourceBoundWorkspace(deps, baseInput());
    expect(result).toMatchObject({ ok: false, errorCode: "binding_conflict" });
    expect(store.mutations).toEqual([]);
  });

  it("fails closed on ambiguous state: two open source-bound allocations", async () => {
    const { deps, store } = makeDeps({
      issues: new Map([
        [
          SOURCE_ISSUE_ID,
          baseIssue({ executionWorkspaceId: ALLOCATED_WORKSPACE_ID }),
        ],
      ]),
      workspaces: new Map([
        [ALLOCATED_WORKSPACE_ID, workspaceRecord()],
        [SECOND_WORKSPACE_ID, workspaceRecord({ id: SECOND_WORKSPACE_ID })],
      ]),
    });
    const result = await allocateSourceBoundWorkspace(deps, baseInput());
    expect(result).toMatchObject({ ok: false, errorCode: "binding_conflict" });
    expect(store.mutations).toEqual([]);
  });

  it("does not count an unbound archived prior record as bound: allocates fresh and leaves it untouched", async () => {
    const archived = workspaceRecord({
      id: PRIOR_WORKSPACE_ID,
      status: "archived",
      closedAt: NOW,
    });
    const before = structuredClone(archived);
    const { deps, store } = makeDeps({
      workspaces: new Map([[PRIOR_WORKSPACE_ID, archived]]),
    });
    const result = await allocateSourceBoundWorkspace(deps, baseInput());
    expect(result).toMatchObject({
      ok: true,
      disposition: "created",
      workspace: { id: ALLOCATED_WORKSPACE_ID, status: "unrealized" },
    });
    expect(store.workspaces.get(PRIOR_WORKSPACE_ID)).toEqual(before);
    expect(store.workspaces.size).toBe(2);
  });

  it("never mutates pre-existing workspace records, including another issue's allocation", async () => {
    const otherIssues = workspaceRecord({
      id: SECOND_WORKSPACE_ID,
      sourceIssueId: OTHER_ISSUE_ID,
    });
    const before = structuredClone(otherIssues);
    const { deps, store } = makeDeps({
      workspaces: new Map([[SECOND_WORKSPACE_ID, otherIssues]]),
    });
    const result = await allocateSourceBoundWorkspace(deps, baseInput());
    expect(result.ok).toBe(true);
    expect(store.workspaces.get(SECOND_WORKSPACE_ID)).toEqual(before);
  });

  it("is atomic: a failure mid-transaction propagates and leaves no record, binding, or audit", async () => {
    const { deps, store } = makeDeps(
      {},
      {
        bindIssueExecutionWorkspace: async () => {
          throw new Error("bind failed");
        },
      },
    );
    await expect(
      allocateSourceBoundWorkspace(deps, baseInput()),
    ).rejects.toThrow("bind failed");
    expect(store.workspaces.size).toBe(0);
    expect(store.issues.get(SOURCE_ISSUE_ID)?.executionWorkspaceId).toBeNull();
    expect(store.audits).toEqual([]);
    expect(store.mutations).toEqual([]);
  });
});

describe("source-bound workspace allocation realization adoption (contract)", () => {
  function seededAllocated() {
    return makeDeps({
      issues: new Map([
        [
          SOURCE_ISSUE_ID,
          baseIssue({ executionWorkspaceId: ALLOCATED_WORKSPACE_ID }),
        ],
      ]),
      workspaces: new Map([[ALLOCATED_WORKSPACE_ID, workspaceRecord()]]),
    });
  }

  it("adopts the allocated record: same id, no second insert, flips to active with realized facts", async () => {
    const { deps, store } = seededAllocated();
    const result = await markAllocatedWorkspaceRealized(deps, {
      companyId: COMPANY_ID,
      sourceIssueId: SOURCE_ISSUE_ID,
      workspaceId: ALLOCATED_WORKSPACE_ID,
      cwd: "/repo/.paperclip/worktrees/TST-42",
      providerRef: "/repo/.paperclip/worktrees/TST-42",
      branchName: "TST-42-source-transport",
      repoUrl: "https://example.com/repo.git",
    });
    expect(result).toMatchObject({
      ok: true,
      workspace: {
        id: ALLOCATED_WORKSPACE_ID,
        status: "active",
        cwd: "/repo/.paperclip/worktrees/TST-42",
        providerRef: "/repo/.paperclip/worktrees/TST-42",
        branchName: "TST-42-source-transport",
        sourceIssueId: SOURCE_ISSUE_ID,
        closedAt: null,
      },
    });
    if (!result.ok) throw new Error("expected realization to succeed");
    expect(result.workspace.openedAt).not.toBeNull();
    expect(store.workspaces.size).toBe(1);
    expect(store.mutations).not.toContain("insertWorkspace");
    expect(store.issues.get(SOURCE_ISSUE_ID)?.executionWorkspaceId).toBe(
      ALLOCATED_WORKSPACE_ID,
    );
  });

  it.each([
    { name: "empty cwd", patch: { cwd: "" } },
    { name: "empty providerRef", patch: { providerRef: "" } },
    { name: "empty branchName", patch: { branchName: "" } },
  ])(
    "denies incomplete realization ($name) and keeps the record unrealized",
    async ({ patch }) => {
      const { deps, store } = seededAllocated();
      const result = await markAllocatedWorkspaceRealized(deps, {
        companyId: COMPANY_ID,
        sourceIssueId: SOURCE_ISSUE_ID,
        workspaceId: ALLOCATED_WORKSPACE_ID,
        cwd: "/repo/.paperclip/worktrees/TST-42",
        providerRef: "/repo/.paperclip/worktrees/TST-42",
        branchName: "TST-42-source-transport",
        ...patch,
      });
      expect(result).toMatchObject({
        ok: false,
        errorCode: "realization_incomplete",
      });
      expect(store.workspaces.get(ALLOCATED_WORKSPACE_ID)).toMatchObject({
        status: "unrealized",
        cwd: null,
        openedAt: null,
      });
    },
  );

  it("denies realization when the issue is no longer bound to the allocated record", async () => {
    const { deps, store } = makeDeps({
      issues: new Map([
        [
          SOURCE_ISSUE_ID,
          baseIssue({ executionWorkspaceId: SECOND_WORKSPACE_ID }),
        ],
      ]),
      workspaces: new Map([[ALLOCATED_WORKSPACE_ID, workspaceRecord()]]),
    });
    const result = await markAllocatedWorkspaceRealized(deps, {
      companyId: COMPANY_ID,
      sourceIssueId: SOURCE_ISSUE_ID,
      workspaceId: ALLOCATED_WORKSPACE_ID,
      cwd: "/repo/.paperclip/worktrees/TST-42",
      providerRef: "/repo/.paperclip/worktrees/TST-42",
      branchName: "TST-42-source-transport",
    });
    expect(result).toMatchObject({ ok: false, errorCode: "binding_conflict" });
    expect(store.workspaces.get(ALLOCATED_WORKSPACE_ID)?.status).toBe(
      "unrealized",
    );
  });

  it("denies realization of a record that is not unrealized (already active)", async () => {
    const { deps } = makeDeps({
      issues: new Map([
        [
          SOURCE_ISSUE_ID,
          baseIssue({ executionWorkspaceId: ALLOCATED_WORKSPACE_ID }),
        ],
      ]),
      workspaces: new Map([
        [
          ALLOCATED_WORKSPACE_ID,
          workspaceRecord({ status: "active", cwd: "/repo/x", openedAt: NOW }),
        ],
      ]),
    });
    const result = await markAllocatedWorkspaceRealized(deps, {
      companyId: COMPANY_ID,
      sourceIssueId: SOURCE_ISSUE_ID,
      workspaceId: ALLOCATED_WORKSPACE_ID,
      cwd: "/repo/.paperclip/worktrees/TST-42",
      providerRef: "/repo/.paperclip/worktrees/TST-42",
      branchName: "TST-42-source-transport",
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "workspace_not_unrealized",
    });
  });
});
describe("source-bound workspace allocation rollback (contract)", () => {
  function seededAllocated(
    recordOverrides: Partial<SourceBoundAllocationWorkspaceRecord> = {},
    issueOverrides: Partial<SourceBoundAllocationIssueFacts> = {},
  ) {
    return makeDeps({
      issues: new Map([
        [
          SOURCE_ISSUE_ID,
          baseIssue({
            executionWorkspaceId: ALLOCATED_WORKSPACE_ID,
            ...issueOverrides,
          }),
        ],
      ]),
      workspaces: new Map([
        [ALLOCATED_WORKSPACE_ID, workspaceRecord(recordOverrides)],
      ]),
    });
  }

  function rollbackInput() {
    return {
      companyId: COMPANY_ID,
      sourceIssueId: SOURCE_ISSUE_ID,
      workspaceId: ALLOCATED_WORKSPACE_ID,
      actor: boardActor,
    };
  }

  it("archives only the allocated record and restores the exact prior binding (null)", async () => {
    const { deps, store } = seededAllocated();
    const { counts, effects } = countingEffects();
    const result = await rollbackSourceBoundWorkspaceAllocation(deps, {
      ...rollbackInput(),
      effects,
    });
    expect(result).toMatchObject({
      ok: true,
      operationVersion: "source-bound-workspace-allocation/v1",
      workspace: { id: ALLOCATED_WORKSPACE_ID, status: "archived" },
      restoredExecutionWorkspaceId: null,
      runtimeInvoked: false,
      wakeInvoked: false,
    });
    const row = store.workspaces.get(ALLOCATED_WORKSPACE_ID)!;
    expect(row.status).toBe("archived");
    expect(row.closedAt).not.toBeNull();
    // Record is archived, never deleted; binding restored; rollback audited
    // as its own attributed event.
    expect(store.workspaces.size).toBe(1);
    expect(store.issues.get(SOURCE_ISSUE_ID)?.executionWorkspaceId).toBeNull();
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "issue.source_bound_workspace_allocation_rolled_back",
      workspaceId: ALLOCATED_WORKSPACE_ID,
      actor: { type: "board", userId: BOARD_USER_ID },
      disposition: "rolled_back",
    });
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it("restores a non-null prior binding recorded at allocation", async () => {
    const { deps, store } = seededAllocated({
      metadata: {
        sourceBoundAllocation: {
          version: SOURCE_BOUND_WORKSPACE_ALLOCATION_OPERATION_VERSION,
          priorExecutionWorkspaceId: PRIOR_WORKSPACE_ID,
          allocatedByUserId: BOARD_USER_ID,
          selection: {
            mode: "isolated_workspace",
            strategyType: "git_worktree",
            baseRef: "origin/main",
            branchTemplate: "TST-42-source-transport",
          },
        },
      },
    });
    const result = await rollbackSourceBoundWorkspaceAllocation(
      deps,
      rollbackInput(),
    );
    expect(result).toMatchObject({
      ok: true,
      restoredExecutionWorkspaceId: PRIOR_WORKSPACE_ID,
    });
    expect(store.issues.get(SOURCE_ISSUE_ID)?.executionWorkspaceId).toBe(
      PRIOR_WORKSPACE_ID,
    );
  });

  it("refuses rollback when the binding changed in between (no archive, no rebind)", async () => {
    const { deps, store } = seededAllocated(
      {},
      { executionWorkspaceId: SECOND_WORKSPACE_ID },
    );
    const result = await rollbackSourceBoundWorkspaceAllocation(
      deps,
      rollbackInput(),
    );
    expect(result).toMatchObject({ ok: false, errorCode: "binding_conflict" });
    expect(store.workspaces.get(ALLOCATED_WORKSPACE_ID)?.status).toBe(
      "unrealized",
    );
    expect(store.issues.get(SOURCE_ISSUE_ID)?.executionWorkspaceId).toBe(
      SECOND_WORKSPACE_ID,
    );
    expect(store.mutations).toEqual([]);
  });

  it("refuses rollback of a realized (active) workspace through the allocation path", async () => {
    const { deps, store } = seededAllocated({
      status: "active",
      cwd: "/repo/x",
      openedAt: NOW,
    });
    const result = await rollbackSourceBoundWorkspaceAllocation(
      deps,
      rollbackInput(),
    );
    expect(result).toMatchObject({
      ok: false,
      errorCode: "workspace_not_unrealized",
    });
    expect(store.workspaces.get(ALLOCATED_WORKSPACE_ID)?.status).toBe("active");
    expect(store.mutations).toEqual([]);
  });

  it("requires Board + runtime:manage for rollback", async () => {
    const { deps, store } = seededAllocated();
    const result = await rollbackSourceBoundWorkspaceAllocation(deps, {
      ...rollbackInput(),
      actor: { ...boardActor, hasRuntimeManage: false },
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "unauthorized_principal",
    });
    expect(store.mutations).toEqual([]);
    expect(store.workspaces.get(ALLOCATED_WORKSPACE_ID)?.status).toBe(
      "unrealized",
    );
  });
});
