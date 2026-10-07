import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import {
  ensureGitWorktreeBranchCoherent,
  ensurePersistedExecutionWorkspaceAvailable,
} from "../services/workspace-runtime.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres clean branch restore tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const RUNTIME_OWNED = { createdByRuntime: true, gitBranchOwnershipVersion: 1 } as const;
const OPERATOR_OWNED = { createdByRuntime: false, gitBranchOwnershipVersion: 1 } as const;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function readGit(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function commitFile(cwd: string, name: string, message: string) {
  await fs.writeFile(path.join(cwd, name), `${message}\n`, "utf8");
  await runGit(cwd, ["add", name]);
  await runGit(cwd, ["commit", "-m", message]);
  return readGit(cwd, ["rev-parse", "HEAD"]);
}

async function createRepo() {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-clean-restore-repo-")));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", "main"]);
  return repoRoot;
}

/** A recorded branch with one commit of its own, checked out in a linked worktree. */
async function createWorktreeOnRecordedBranch(expectedBranch: string) {
  const repoRoot = await createRepo();
  const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(repoRoot, ["worktree", "add", "-b", expectedBranch, worktreePath, "main"]);
  const expectedHead = await commitFile(worktreePath, "recorded.txt", "Recorded branch work");
  return { repoRoot, worktreePath, expectedHead };
}

describeEmbeddedPostgres("clean worktree branch restore", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-clean-restore-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed(input: {
    repoRoot: string;
    worktreePath: string;
    expectedBranch: string;
    identifier?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const workspaceId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "App", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: input.repoRoot,
      isPrimary: true,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Restore the recorded branch",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: input.identifier ?? "PAP-470",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: input.expectedBranch,
      status: "active",
      cwd: input.worktreePath,
      providerRef: input.worktreePath,
      baseRef: "HEAD",
      branchName: input.expectedBranch,
      providerType: "git_worktree",
      lastUsedAt: now,
      updatedAt: now,
    });
    await db
      .update(issues)
      .set({ executionWorkspaceId: workspaceId, executionRunId: runId, updatedAt: now })
      .where(eq(issues.id, sourceIssueId));
    return {
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
      sourceIssueId,
      workspaceId,
      runId,
      identifier: input.identifier ?? "PAP-470",
    };
  }

  /** A second issue that reuses the workspace row, as children of a shared parent do. */
  async function seedSiblingRun(
    ids: Awaited<ReturnType<typeof seed>>,
    status: "running" | "queued",
  ) {
    const siblingIssueId = randomUUID();
    const siblingRunId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: siblingRunId,
      companyId: ids.companyId,
      agentId: ids.agentId,
      invocationSource: "manual",
      status,
      startedAt: status === "running" ? now : null,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: siblingIssueId,
      companyId: ids.companyId,
      projectId: ids.projectId,
      projectWorkspaceId: ids.projectWorkspaceId,
      title: "Sibling child on the shared workspace",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ids.agentId,
      identifier: "PAP-471",
      executionWorkspaceId: ids.workspaceId,
      executionRunId: siblingRunId,
    });
    return siblingRunId;
  }

  async function prepare(input: {
    repoRoot: string;
    worktreePath: string;
    expectedBranch: string;
    ids: Awaited<ReturnType<typeof seed>>;
    metadata?: Record<string, unknown>;
    repairEnabled?: boolean;
  }) {
    return ensurePersistedExecutionWorkspaceAvailable({
      db,
      base: {
        baseCwd: input.repoRoot,
        source: "project_primary",
        projectId: input.ids.projectId,
        workspaceId: input.ids.projectWorkspaceId,
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: input.ids.workspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: input.worktreePath,
        providerRef: input.worktreePath,
        projectId: input.ids.projectId,
        projectWorkspaceId: input.ids.projectWorkspaceId,
        repoUrl: null,
        baseRef: "HEAD",
        branchName: input.expectedBranch,
        metadata: input.metadata ?? RUNTIME_OWNED,
      },
      issue: {
        id: input.ids.sourceIssueId,
        identifier: input.ids.identifier,
        title: "Restore the recorded branch",
      },
      agent: { id: input.ids.agentId, name: "Codex Coder", companyId: input.ids.companyId },
      heartbeatRunId: input.ids.runId,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: input.repairEnabled ?? true,
    });
  }

  async function expectRefused(promise: Promise<unknown>) {
    let error: unknown = null;
    try {
      await promise;
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: "workspace_validation_failed" });
    return (error as { resultJson: { workspaceValidation: { safeRepair: { reason: string } } } })
      .resultJson.workspaceValidation.safeRepair.reason;
  }

  async function restoreActivity(companyId: string) {
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    return rows.filter((row) => row.action === "execution_workspace.branch_restored");
  }

  it("checks the recorded branch out of a detached HEAD that another ref already reaches", async () => {
    const expectedBranch = "PAP-470-recorded-detached";
    const { repoRoot, worktreePath, expectedHead } = await createWorktreeOnRecordedBranch(expectedBranch);
    const mainHead = await readGit(repoRoot, ["rev-parse", "main"]);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    const restored = await prepare({ repoRoot, worktreePath, expectedBranch, ids });

    expect(restored?.branchName).toBe(expectedBranch);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(expectedHead);
    // main still reaches the old HEAD, so nothing needs a rescue branch.
    await expect(readGit(repoRoot, ["branch", "--list", "paperclip/rescue/*"])).resolves.toBe("");
    await expect(readGit(repoRoot, ["rev-parse", "main"])).resolves.toBe(mainHead);
    expect(restored?.warnings.join("\n")).toContain(`off recorded branch "${expectedBranch}"`);
    expect(await restoreActivity(ids.companyId)).toEqual([
      expect.objectContaining({
        entityType: "execution_workspace",
        entityId: ids.workspaceId,
        details: expect.objectContaining({
          expectedBranch,
          displacedBranch: null,
          displacedSha: mainHead,
          rescueBranch: null,
        }),
      }),
    ]);
    await expect(db.select().from(issueComments).where(eq(issueComments.companyId, ids.companyId))).resolves.toEqual([]);
  }, 20_000);

  it("pins a detached commit that no ref reaches on a rescue branch before restoring", async () => {
    const expectedBranch = "PAP-470-recorded-unreachable";
    const { repoRoot, worktreePath, expectedHead } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const orphanHead = await commitFile(worktreePath, "orphan.txt", "Review scratch commit");
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    const restored = await prepare({ repoRoot, worktreePath, expectedBranch, ids });

    expect(restored?.branchName).toBe(expectedBranch);
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(expectedHead);
    const rescueBranch = await readGit(repoRoot, ["branch", "--list", "paperclip/rescue/*", "--format=%(refname:short)"]);
    expect(rescueBranch).toMatch(/^paperclip\/rescue\/PAP-470\/detached-\d{8}T\d{6}Z$/);
    await expect(readGit(repoRoot, ["rev-parse", rescueBranch])).resolves.toBe(orphanHead);
    expect(restored?.warnings.join("\n")).toContain(`rescue branch "${rescueBranch}"`);
    const comments = await db.select().from(issueComments).where(eq(issueComments.companyId, ids.companyId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.issueId).toBe(ids.sourceIssueId);
    expect(comments[0]?.body).toContain(`Rescue branch: \`${rescueBranch}\``);
    expect(comments[0]?.body).toContain(`Detached HEAD: \`${orphanHead}\``);
    expect(await restoreActivity(ids.companyId)).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ rescueBranch, displacedSha: orphanHead }) }),
    ]);
  }, 20_000);

  it("restores the recorded branch from a diverged branch and keeps that branch", async () => {
    const expectedBranch = "PAP-470-recorded-diverged";
    const actualBranch = "test/pap-999-sibling";
    const { repoRoot, worktreePath, expectedHead } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", actualBranch, "main"]);
    const actualHead = await commitFile(worktreePath, "sibling.txt", "Sibling work");
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    const restored = await prepare({ repoRoot, worktreePath, expectedBranch, ids });

    expect(restored?.branchName).toBe(expectedBranch);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(expectedHead);
    await expect(readGit(repoRoot, ["rev-parse", actualBranch])).resolves.toBe(actualHead);
    await expect(readGit(repoRoot, ["branch", "--list", "paperclip/rescue/*"])).resolves.toBe("");
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.toBe("");
  }, 20_000);

  it("restores the recorded branch when the checked-out branch is behind it", async () => {
    const expectedBranch = "PAP-470-recorded-ahead";
    const actualBranch = "PAP-470-live-behind";
    const { repoRoot, worktreePath, expectedHead } = await createWorktreeOnRecordedBranch(expectedBranch);
    // The live branch sits at the commit the recorded branch started from.
    await runGit(worktreePath, ["checkout", "-b", actualBranch, "main"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    const restored = await prepare({ repoRoot, worktreePath, expectedBranch, ids });

    expect(restored?.branchName).toBe(expectedBranch);
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(expectedHead);
    await expect(readGit(repoRoot, ["rev-parse", actualBranch])).resolves.toBe(
      await readGit(repoRoot, ["rev-parse", "main"]),
    );
  }, 20_000);

  it("refuses while a sibling run is running in the same worktree", async () => {
    const expectedBranch = "PAP-470-recorded-busy";
    const actualBranch = "test/pap-999-busy";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "-b", actualBranch, "main"]);
    const actualHead = await commitFile(worktreePath, "sibling.txt", "Sibling work");
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });
    const siblingRunId = await seedSiblingRun(ids, "running");

    const reason = await expectRefused(prepare({ repoRoot, worktreePath, expectedBranch, ids }));

    expect(reason).toContain(`run ${siblingRunId} on PAP-471 is running in this worktree`);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(actualHead);
    expect(await restoreActivity(ids.companyId)).toEqual([]);
  }, 20_000);

  it("does not let a queued sibling run block the restore", async () => {
    const expectedBranch = "PAP-470-recorded-queued";
    const { repoRoot, worktreePath, expectedHead } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });
    await seedSiblingRun(ids, "queued");

    const restored = await prepare({ repoRoot, worktreePath, expectedBranch, ids });

    expect(restored?.branchName).toBe(expectedBranch);
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(expectedHead);
  }, 20_000);

  it("restores an operator-owned branch by checkout without adopting or moving any ref", async () => {
    const expectedBranch = "PAP-470-operator-branch";
    const actualBranch = "PAP-470-operator-forward";
    const { repoRoot, worktreePath, expectedHead } = await createWorktreeOnRecordedBranch(expectedBranch);
    // Forward of the recorded branch: a runtime-owned branch would be adopted here.
    await runGit(worktreePath, ["checkout", "-b", actualBranch]);
    const actualHead = await commitFile(worktreePath, "forward.txt", "Forward work");
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    const restored = await prepare({ repoRoot, worktreePath, expectedBranch, ids, metadata: OPERATOR_OWNED });

    expect(restored?.branchName).toBe(expectedBranch);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    await expect(readGit(repoRoot, ["rev-parse", expectedBranch])).resolves.toBe(expectedHead);
    await expect(readGit(repoRoot, ["rev-parse", actualBranch])).resolves.toBe(actualHead);
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, ids.workspaceId));
    expect(workspace?.branchName).toBe(expectedBranch);
  }, 20_000);

  it("keeps the old fail-closed result when the repair flag is off", async () => {
    const expectedBranch = "PAP-470-recorded-flag-off";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    const reason = await expectRefused(
      prepare({ repoRoot, worktreePath, expectedBranch, ids, repairEnabled: false }),
    );

    expect(reason).toBe("expected branch and current HEAD differ");
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("");
  }, 20_000);

  it("fails closed with the git reason when the recorded branch is checked out in another worktree", async () => {
    const expectedBranch = "PAP-470-recorded-elsewhere";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    // Free the branch from this worktree, then check it out somewhere else.
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const elsewhere = path.join(repoRoot, ".paperclip", "worktrees", "elsewhere");
    await runGit(repoRoot, ["worktree", "add", elsewhere, expectedBranch]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    const reason = await expectRefused(prepare({ repoRoot, worktreePath, expectedBranch, ids }));

    expect(reason).toContain("clean branch restore failed");
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("");
    expect(await restoreActivity(ids.companyId)).toEqual([]);
  }, 20_000);

  it("is blocked by a sibling run that is linked through its checkout run", async () => {
    const expectedBranch = "PAP-470-recorded-checkout-link";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });
    const siblingRunId = await seedSiblingRun(ids, "running");
    await db
      .update(issues)
      .set({ executionRunId: null, checkoutRunId: siblingRunId })
      .where(eq(issues.identifier, "PAP-471"));

    const reason = await expectRefused(prepare({ repoRoot, worktreePath, expectedBranch, ids }));

    expect(reason).toContain(`run ${siblingRunId} on PAP-471 is running in this worktree`);
  }, 20_000);

  it("is blocked by a running run on another workspace row that points at the same path", async () => {
    const expectedBranch = "PAP-470-recorded-other-row";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });
    const otherWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: otherWorkspaceId,
      companyId: ids.companyId,
      projectId: ids.projectId,
      projectWorkspaceId: ids.projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "same path, other row",
      status: "active",
      cwd: worktreePath,
      providerRef: null,
      baseRef: "HEAD",
      branchName: "other-row-branch",
      providerType: "git_worktree",
    });
    const siblingRunId = await seedSiblingRun(ids, "running");
    await db
      .update(issues)
      .set({ executionWorkspaceId: otherWorkspaceId })
      .where(eq(issues.identifier, "PAP-471"));

    const reason = await expectRefused(prepare({ repoRoot, worktreePath, expectedBranch, ids }));

    expect(reason).toContain(`run ${siblingRunId} on PAP-471 is running in this worktree`);
  }, 20_000);

  it("ignores a running run that belongs to an archived workspace row", async () => {
    const expectedBranch = "PAP-470-recorded-archived-row";
    const { repoRoot, worktreePath, expectedHead } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });
    const archivedWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: archivedWorkspaceId,
      companyId: ids.companyId,
      projectId: ids.projectId,
      projectWorkspaceId: ids.projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "archived row",
      status: "archived",
      cwd: worktreePath,
      providerRef: worktreePath,
      baseRef: "HEAD",
      branchName: "archived-branch",
      providerType: "git_worktree",
    });
    await seedSiblingRun(ids, "running");
    await db
      .update(issues)
      .set({ executionWorkspaceId: archivedWorkspaceId })
      .where(eq(issues.identifier, "PAP-471"));

    const restored = await prepare({ repoRoot, worktreePath, expectedBranch, ids });

    expect(restored?.branchName).toBe(expectedBranch);
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(expectedHead);
  }, 20_000);

  it("creates no rescue branch when it refuses a detached commit", async () => {
    const expectedBranch = "PAP-470-recorded-busy-detached";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const orphanHead = await commitFile(worktreePath, "orphan.txt", "Unpinned review commit");
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });
    await seedSiblingRun(ids, "running");

    await expectRefused(prepare({ repoRoot, worktreePath, expectedBranch, ids }));

    await expect(readGit(repoRoot, ["branch", "--list", "paperclip/rescue/*"])).resolves.toBe("");
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(orphanHead);
  }, 20_000);

  it("refuses while an interrupted git operation is in progress", async () => {
    const expectedBranch = "PAP-470-recorded-bisect";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    await runGit(worktreePath, ["bisect", "start"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    const reason = await expectRefused(prepare({ repoRoot, worktreePath, expectedBranch, ids }));

    expect(reason).toBe("clean branch restore refused because an interrupted git bisect is in progress");
  }, 20_000);

  it("refuses while a runtime service of the workspace is still running", async () => {
    const expectedBranch = "PAP-470-recorded-service";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId: ids.companyId,
      projectId: ids.projectId,
      projectWorkspaceId: ids.projectWorkspaceId,
      executionWorkspaceId: ids.workspaceId,
      scopeType: "execution_workspace",
      scopeId: ids.workspaceId,
      serviceName: "dev-server",
      status: "running",
      lifecycle: "shared",
      reuseKey: "dev-server",
      command: "node server.js",
      cwd: worktreePath,
      provider: "local_process",
      startedAt: new Date(),
    });

    const reason = await expectRefused(prepare({ repoRoot, worktreePath, expectedBranch, ids }));

    expect(reason).toContain('clean branch restore requires runtime service "dev-server"');
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("");
  }, 20_000);

  describe("fresh realization, which has no execution workspace id yet", () => {
    async function realizeFresh(ids: Awaited<ReturnType<typeof seed>>, input: {
      repoRoot: string;
      worktreePath: string;
      expectedBranch: string;
    }) {
      return ensureGitWorktreeBranchCoherent({
        db,
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        expectedBranchName: input.expectedBranch,
        sourceIssue: { id: ids.sourceIssueId, identifier: ids.identifier, title: "Restore the recorded branch" },
        executionWorkspaceId: null,
        heartbeatRunId: ids.runId,
        enableWorkspaceDirtyQuarantineRepair: true,
      });
    }

    async function seedService(
      ids: Awaited<ReturnType<typeof seed>>,
      input: { cwd: string; executionWorkspaceId: string | null; status?: string },
    ) {
      await db.insert(workspaceRuntimeServices).values({
        id: randomUUID(),
        companyId: ids.companyId,
        projectId: ids.projectId,
        projectWorkspaceId: null,
        executionWorkspaceId: input.executionWorkspaceId,
        scopeType: input.executionWorkspaceId ? "execution_workspace" : "run",
        scopeId: input.executionWorkspaceId,
        serviceName: "dev-server",
        status: input.status ?? "running",
        lifecycle: "shared",
        reuseKey: `dev-server-${randomUUID()}`,
        command: "node server.js",
        cwd: input.cwd,
        provider: "local_process",
        startedAt: new Date(),
      });
    }

    async function closeWorkspaceRow(workspaceId: string) {
      await db
        .update(executionWorkspaces)
        .set({ status: "archived", closedAt: new Date() })
        .where(eq(executionWorkspaces.id, workspaceId));
    }

    it("refuses while a service of an open workspace row at the path is running", async () => {
      const expectedBranch = "PAP-470-fresh-row-service";
      const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
      await runGit(worktreePath, ["checkout", "--detach", "main"]);
      const ids = await seed({ repoRoot, worktreePath, expectedBranch });
      await seedService(ids, { cwd: worktreePath, executionWorkspaceId: ids.workspaceId });

      const reason = await expectRefused(realizeFresh(ids, { repoRoot, worktreePath, expectedBranch }));

      expect(reason).toContain('clean branch restore requires runtime service "dev-server"');
      await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("");
    }, 20_000);

    it("refuses while a service runs in the worktree and no workspace row points at it", async () => {
      const expectedBranch = "PAP-470-fresh-cwd-service";
      const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
      await runGit(worktreePath, ["checkout", "--detach", "main"]);
      const ids = await seed({ repoRoot, worktreePath, expectedBranch });
      await closeWorkspaceRow(ids.workspaceId);
      await seedService(ids, { cwd: worktreePath, executionWorkspaceId: null });

      const reason = await expectRefused(realizeFresh(ids, { repoRoot, worktreePath, expectedBranch }));

      expect(reason).toContain('clean branch restore requires runtime service "dev-server"');
      await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("");
    }, 20_000);

    it("refuses while a service runs in a subdirectory of the worktree", async () => {
      const expectedBranch = "PAP-470-fresh-subdir-service";
      const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
      await runGit(worktreePath, ["checkout", "--detach", "main"]);
      const ids = await seed({ repoRoot, worktreePath, expectedBranch });
      await closeWorkspaceRow(ids.workspaceId);
      await seedService(ids, { cwd: path.join(worktreePath, "packages", "web"), executionWorkspaceId: null });

      const reason = await expectRefused(realizeFresh(ids, { repoRoot, worktreePath, expectedBranch }));

      expect(reason).toContain('clean branch restore requires runtime service "dev-server"');
    }, 20_000);

    it("restores when the only services are stopped, elsewhere, or in a sibling directory", async () => {
      const expectedBranch = "PAP-470-fresh-no-service";
      const { repoRoot, worktreePath, expectedHead } = await createWorktreeOnRecordedBranch(expectedBranch);
      await runGit(worktreePath, ["checkout", "--detach", "main"]);
      const ids = await seed({ repoRoot, worktreePath, expectedBranch });
      await closeWorkspaceRow(ids.workspaceId);
      await seedService(ids, { cwd: worktreePath, executionWorkspaceId: null, status: "stopped" });
      await seedService(ids, { cwd: path.join(path.dirname(worktreePath), "unrelated"), executionWorkspaceId: null });
      // A name that only shares the worktree path as a prefix is another directory.
      await seedService(ids, { cwd: `${worktreePath}-other`, executionWorkspaceId: null });

      const result = await realizeFresh(ids, { repoRoot, worktreePath, expectedBranch });

      expect(result.branchName).toBe(expectedBranch);
      await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
      await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(expectedHead);
    }, 20_000);
  });

  it("does not repair a dirty operator-owned worktree", async () => {
    const expectedBranch = "PAP-470-operator-dirty";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    await fs.writeFile(path.join(worktreePath, "scratch.txt"), "uncommitted\n", "utf8");
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    let error: unknown = null;
    try {
      await prepare({ repoRoot, worktreePath, expectedBranch, ids, metadata: OPERATOR_OWNED });
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      code: "workspace_validation_failed",
      message: expect.stringContaining("is not reusable"),
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("");
    await expect(fs.readFile(path.join(worktreePath, "scratch.txt"), "utf8")).resolves.toBe("uncommitted\n");
    await expect(readGit(repoRoot, ["branch", "--list", "paperclip/rescue/*"])).resolves.toBe("");
  }, 20_000);

  it("keeps the dirty-only quarantine restore route from switching a clean worktree", async () => {
    const expectedBranch = "PAP-470-recorded-route";
    const actualBranch = "test/pap-999-route";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    // The route cannot reconcile a detached worktree, so use a named branch.
    await runGit(worktreePath, ["checkout", "-b", actualBranch, "main"]);
    await commitFile(worktreePath, "route.txt", "Route work");
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });
    // The route has no run of its own. Finish the seeded run so that the
    // running-run guard cannot be what stops the switch.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, ids.runId));

    await expect(
      executionWorkspaceService(db).reconcileExecutionWorkspaceBranch(ids.workspaceId, {
        mode: "quarantine_restore",
        actor: { actorType: "user", actorId: "board-user", agentId: null, runId: null },
      }),
    ).rejects.toMatchObject({ status: 422 });

    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    expect(await restoreActivity(ids.companyId)).toEqual([]);
  }, 20_000);

  it("refuses when HEAD is not the one that was inspected", async () => {
    const expectedBranch = "PAP-470-recorded-moved";
    const { repoRoot, worktreePath } = await createWorktreeOnRecordedBranch(expectedBranch);
    await runGit(worktreePath, ["checkout", "--detach", "main"]);
    const ids = await seed({ repoRoot, worktreePath, expectedBranch });

    let error: unknown = null;
    try {
      // The caller inspected another branch, so HEAD moved since that read.
      await ensureGitWorktreeBranchCoherent({
        db,
        repoRoot,
        worktreePath,
        expectedBranchName: expectedBranch,
        actualBranchName: "test/moved-since-inspection",
        sourceIssue: { id: ids.sourceIssueId, identifier: ids.identifier, title: "Restore the recorded branch" },
        executionWorkspaceId: ids.workspaceId,
        heartbeatRunId: ids.runId,
        enableWorkspaceDirtyQuarantineRepair: true,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      resultJson: {
        workspaceValidation: expect.objectContaining({
          safeRepair: expect.objectContaining({
            reason: "clean branch restore refused because HEAD moved after the worktree was inspected",
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("");
  }, 20_000);
});
