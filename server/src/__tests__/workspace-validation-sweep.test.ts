import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueRecoveryActions,
  issues,
  projects,
  projectWorkspaces,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { sweepWorkspaceValidationRecoveries } from "../services/workspace-validation-sweep.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace validation sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const INCOHERENCE_REASON = "git_worktree_branch_incoherence";

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
}

async function createTempRepo() {
  const repoRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-validation-sweep-")),
  );
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await commitFile(repoRoot, "README.md", "Initial commit");
  await runGit(repoRoot, ["checkout", "-B", "main"]);
  return repoRoot;
}

/** Recorded branch at main; the worktree was checked out on a different, drifted branch. */
async function createDriftedWorktree(
  tempDirs: Set<string>,
  input: { recordedBranch: string; driftedBranch: string },
) {
  const repoRoot = await createTempRepo();
  tempDirs.add(repoRoot);
  await runGit(repoRoot, ["branch", input.recordedBranch]);
  const worktreePath = path.join(
    path.dirname(repoRoot),
    `paperclip-validation-sweep-wt-${randomUUID()}`,
  );
  tempDirs.add(worktreePath);
  await runGit(repoRoot, [
    "worktree",
    "add",
    "-b",
    input.driftedBranch,
    worktreePath,
    "main",
  ]);
  await commitFile(worktreePath, "drifted.txt", "Drifted branch work");
  return { repoRoot, worktreePath };
}

describeEmbeddedPostgres("workspace validation recovery sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const tempDirs = new Set<string>();
  let issueCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-workspace-validation-sweep-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  /** A parked card: blocked source issue, its workspace row, and an active workspace_validation action. */
  async function parkCard(input: {
    repoRoot: string;
    worktreePath: string;
    recordedBranch: string;
    reason?: string;
    evidenceKey?: "persistedExecutionWorkspaceId" | "executionWorkspaceId";
  }) {
    issueCounter += 1;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const actionId = randomUUID();
    const prefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const fingerprint = `source_scoped_recovery:${companyId}:${issueId}:workspace_validation_failed:workspace_finalize_branch_mismatch:v1:sha256:${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Sweep Test Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Sweep",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: input.repoRoot,
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parked source task",
      identifier: `${prefix}-${issueCounter}`,
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: input.recordedBranch,
      status: "idle",
      providerType: "git_worktree",
      cwd: input.worktreePath,
      providerRef: input.worktreePath,
      branchName: input.recordedBranch,
      baseRef: "main",
    });
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId: issueId,
      kind: "workspace_validation",
      status: "active",
      ownerType: "board",
      cause: "workspace_validation_failed",
      fingerprint,
      evidence: {
        workspaceValidation: {
          reason: input.reason ?? INCOHERENCE_REASON,
          fingerprint,
          [input.evidenceKey ?? "persistedExecutionWorkspaceId"]: workspaceId,
        },
      },
      nextAction: "Repair the source task git worktree branch incoherence.",
    });
    return {
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
      issueId,
      workspaceId,
      actionId,
      fingerprint,
    };
  }

  async function runningRunInWorktree(
    parked: Awaited<ReturnType<typeof parkCard>>,
  ) {
    const siblingIssueId = randomUUID();
    const siblingRunId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: siblingRunId,
      companyId: parked.companyId,
      agentId: parked.agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: siblingIssueId,
      companyId: parked.companyId,
      projectId: parked.projectId,
      projectWorkspaceId: parked.projectWorkspaceId,
      title: "Sibling run on the shared worktree",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: parked.agentId,
      executionWorkspaceId: parked.workspaceId,
      executionRunId: siblingRunId,
    });
  }

  async function loadAction(actionId: string) {
    const [row] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    if (!row) throw new Error(`recovery action ${actionId} not found`);
    return row;
  }

  async function loadIssueStatus(issueId: string) {
    const [row] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    if (!row) throw new Error(`issue ${issueId} not found`);
    return row.status;
  }

  function wakeupRecorder() {
    const calls: Array<{ agentId: string; reason: string | null | undefined }> =
      [];
    const wakeup = async (
      agentId: string,
      options: { reason?: string | null },
    ) => {
      calls.push({ agentId, reason: options.reason });
      return null;
    };
    return { calls, wakeup };
  }

  it("restores a parked card's recorded branch, resolves its recovery action, and wakes the assignee", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    const { calls, wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      enabled: true,
      dryRun: false,
      scanned: 1,
      restored: 1,
      refused: 0,
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        recoveryActionId: parked.actionId,
        decision: "restored",
        reason: null,
      }),
    ]);
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/recorded");
    await expect(
      readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"]),
    ).resolves.toBe("");
    await expect(
      readGit(repoRoot, ["rev-parse", "--verify", "refs/heads/feature/live"]),
    ).resolves.toMatch(/^[0-9a-f]{40}$/);

    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "resolved",
      outcome: "restored",
    });
    expect(await loadIssueStatus(parked.issueId)).toBe("todo");
    expect(calls).toEqual([
      { agentId: parked.agentId, reason: "issue_recovery_action_restored" },
    ]);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, parked.issueId));
    expect(comments.map((comment) => comment.body).join("\n")).toContain(
      "- Mode: `restore`",
    );
  }, 30_000);

  it("skips a dirty worktree and leaves its recovery action and issue untouched", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    await fs.writeFile(
      path.join(worktreePath, "scratch.txt"),
      "uncommitted work\n",
      "utf8",
    );
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    const { calls, wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      restored: 0,
      skipped: expect.objectContaining({ dirty: 1 }),
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        recoveryActionId: parked.actionId,
        decision: "skipped",
        reason: "dirty",
      }),
    ]);
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
    expect(await loadIssueStatus(parked.issueId)).toBe("blocked");
    expect(calls).toEqual([]);
  }, 30_000);

  it("skips a worktree while a run is running in it", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    await runningRunInWorktree(parked);
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      restored: 0,
      skipped: expect.objectContaining({ busy: 1 }),
    });
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
  }, 30_000);

  it("skips a card whose recorded branch no longer exists", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/deleted",
    });
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      restored: 0,
      skipped: expect.objectContaining({ branch_missing: 1 }),
    });
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
  }, 30_000);

  it("skips a path that git does not register as a worktree", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const nestedPath = path.join(worktreePath, "nested");
    await fs.mkdir(nestedPath);
    const parked = await parkCard({
      repoRoot,
      worktreePath: nestedPath,
      recordedBranch: "feature/recorded",
    });
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      restored: 0,
      skipped: expect.objectContaining({ not_registered: 1 }),
    });
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
  }, 30_000);

  it("does nothing while the dirty quarantine repair flag is off", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    await instanceSettingsService(db).updateExperimental({
      enableWorkspaceDirtyQuarantineRepair: false,
    });
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({ enabled: false, scanned: 0, restored: 0 });
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
  }, 30_000);

  it("is idempotent: a second tick over a repaired card changes nothing", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    const { calls, wakeup } = wakeupRecorder();

    await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });
    const second = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(second).toMatchObject({ scanned: 0, restored: 0, refused: 0 });
    expect(calls).toHaveLength(1);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, parked.issueId));
    expect(comments).toHaveLength(1);
  }, 30_000);

  it("attempts at most limit candidates per tick and defers the rest", async () => {
    const parkedCards = [];
    for (let index = 0; index < 3; index += 1) {
      const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
        recordedBranch: `feature/recorded-${index}`,
        driftedBranch: `feature/live-${index}`,
      });
      parkedCards.push(
        await parkCard({
          repoRoot,
          worktreePath,
          recordedBranch: `feature/recorded-${index}`,
        }),
      );
    }
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 2,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({ scanned: 3, restored: 2, deferred: 1 });
    const statuses = await Promise.all(
      parkedCards.map((card) => loadAction(card.actionId)),
    );
    expect(statuses.map((row) => row.status).sort()).toEqual([
      "active",
      "resolved",
      "resolved",
    ]);
  }, 60_000);

  it("ignores workspace_validation actions that carry a different reason", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
      reason: "git_worktree_base_materialization_failed",
    });
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({ scanned: 0, restored: 0 });
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
  }, 30_000);

  it("waits out the minimum age between attempts on a card that was just skipped", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    await fs.writeFile(
      path.join(worktreePath, "scratch.txt"),
      "uncommitted work\n",
      "utf8",
    );
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    const { wakeup } = wakeupRecorder();

    const first = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 60_000,
    });
    const second = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 60_000,
    });

    expect(first.skipped.dirty).toBe(1);
    expect(second.skipped.cooldown).toBe(1);
    expect(second.skipped.dirty).toBe(0);
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
  }, 30_000);

  it("dry run reports the decision for each card without changing git or the issue", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    const other = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/other",
      driftedBranch: "feature/other-live",
    });
    await parkCard({
      repoRoot: other.repoRoot,
      worktreePath: other.worktreePath,
      recordedBranch: "feature/other",
    });
    const { wakeup, calls } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      dryRun: true,
      companyId: parked.companyId,
    });

    expect(result).toMatchObject({
      dryRun: true,
      scanned: 1,
      wouldRestore: 1,
      restored: 0,
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        recoveryActionId: parked.actionId,
        decision: "would_restore",
      }),
    ]);
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
    expect(calls).toEqual([]);
  }, 30_000);

  it("skips a worktree whose recorded branch is not checked out as a branch (detached HEAD)", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    await runGit(worktreePath, ["checkout", "--detach"]);
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      restored: 0,
      skipped: expect.objectContaining({ inspection_failed: 1 }),
    });
    expect(result.items[0]?.message).toContain("detached");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
  }, 30_000);

  it("skips a worktree while a runtime service of the workspace is still running", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId: parked.companyId,
      projectId: parked.projectId,
      projectWorkspaceId: parked.projectWorkspaceId,
      executionWorkspaceId: parked.workspaceId,
      scopeType: "execution_workspace",
      scopeId: parked.workspaceId,
      serviceName: "dev-server",
      status: "running",
      lifecycle: "shared",
      reuseKey: "dev-server",
      command: "node server.js",
      cwd: worktreePath,
      provider: "local_process",
      startedAt: new Date(),
    });
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      restored: 0,
      skipped: expect.objectContaining({ busy: 1 }),
    });
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
  }, 30_000);

  it("skips a card whose source issue is already done", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, parked.issueId));
    const { calls, wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      restored: 0,
      skipped: expect.objectContaining({ source_issue_closed: 1 }),
    });
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadIssueStatus(parked.issueId)).toBe("done");
    expect(calls).toEqual([]);
  }, 30_000);

  it("reads the workspace from the executionWorkspaceId evidence key as well", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
      evidenceKey: "executionWorkspaceId",
    });
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({ restored: 1 });
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "resolved",
      outcome: "restored",
    });
  }, 30_000);

  it("skips a recovery action whose evidence names no execution workspace", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    await db
      .update(issueRecoveryActions)
      .set({
        evidence: {
          workspaceValidation: {
            reason: INCOHERENCE_REASON,
            fingerprint: parked.fingerprint,
          },
        },
      })
      .where(eq(issueRecoveryActions.id, parked.actionId));
    const { wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      restored: 0,
      skipped: expect.objectContaining({ workspace_unlinked: 1 }),
    });
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
  }, 30_000);

  it("refuses a direct restore of a dirty worktree and leaves its recovery action active", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    await fs.writeFile(
      path.join(worktreePath, "scratch.txt"),
      "uncommitted work\n",
      "utf8",
    );
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });

    await expect(
      executionWorkspaceService(db).reconcileExecutionWorkspaceBranch(
        parked.workspaceId,
        {
          mode: "restore",
          alternateRecoveryFingerprints: [parked.fingerprint],
          actor: {
            actorType: "system",
            actorId: "test",
            agentId: null,
            runId: null,
          },
        },
      ),
    ).rejects.toThrow("Recorded branch restore requires a clean worktree");
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
    expect(await loadIssueStatus(parked.issueId)).toBe("blocked");
  }, 30_000);

  it("skips a recovery action filed on an issue other than the workspace's source issue", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });
    await db
      .update(issueRecoveryActions)
      .set({ status: "resolved", outcome: "restored" })
      .where(eq(issueRecoveryActions.id, parked.actionId));
    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId,
      companyId: parked.companyId,
      projectId: parked.projectId,
      projectWorkspaceId: parked.projectWorkspaceId,
      title: "Child task that inherits the parent's workspace",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: parked.agentId,
    });
    const childActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: childActionId,
      companyId: parked.companyId,
      sourceIssueId: childIssueId,
      kind: "workspace_validation",
      status: "active",
      ownerType: "board",
      cause: "workspace_validation_failed",
      fingerprint: parked.fingerprint,
      evidence: {
        workspaceValidation: {
          reason: INCOHERENCE_REASON,
          fingerprint: parked.fingerprint,
          persistedExecutionWorkspaceId: parked.workspaceId,
        },
      },
      nextAction: "Repair the child task workspace branch.",
    });
    const { calls, wakeup } = wakeupRecorder();

    const result = await sweepWorkspaceValidationRecoveries(db, {
      limit: 10,
      wakeup,
      minAttemptIntervalMs: 0,
    });

    expect(result).toMatchObject({
      restored: 0,
      skipped: expect.objectContaining({ source_issue_mismatch: 1 }),
    });
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(childActionId)).toMatchObject({ status: "active" });
    expect(await loadIssueStatus(childIssueId)).toBe("blocked");
    expect(await loadIssueStatus(parked.issueId)).toBe("blocked");
    expect(calls).toEqual([]);
  }, 30_000);

  it("refuses a direct restore when no active recovery action matches and changes nothing", async () => {
    const { repoRoot, worktreePath } = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/recorded",
      driftedBranch: "feature/live",
    });
    const parked = await parkCard({
      repoRoot,
      worktreePath,
      recordedBranch: "feature/recorded",
    });

    await expect(
      executionWorkspaceService(db).reconcileExecutionWorkspaceBranch(
        parked.workspaceId,
        {
          mode: "restore",
          alternateRecoveryFingerprints: ["no-such-recovery-fingerprint"],
          actor: {
            actorType: "system",
            actorId: "test",
            agentId: null,
            runId: null,
          },
        },
      ),
    ).rejects.toThrow(
      "No active workspace validation recovery action matches this worktree state",
    );
    await expect(
      readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).resolves.toBe("feature/live");
    expect(await loadAction(parked.actionId)).toMatchObject({
      status: "active",
    });
    expect(await loadIssueStatus(parked.issueId)).toBe("blocked");
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, parked.issueId));
    expect(comments).toHaveLength(0);
  }, 30_000);

  it("tries a never-attempted card before one that was tried and whose cooldown has lapsed", async () => {
    const first = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/first",
      driftedBranch: "feature/first-live",
    });
    await fs.writeFile(
      path.join(first.worktreePath, "scratch.txt"),
      "uncommitted work\n",
      "utf8",
    );
    const firstCard = await parkCard({
      repoRoot: first.repoRoot,
      worktreePath: first.worktreePath,
      recordedBranch: "feature/first",
    });
    const second = await createDriftedWorktree(tempDirs, {
      recordedBranch: "feature/second",
      driftedBranch: "feature/second-live",
    });
    await fs.writeFile(
      path.join(second.worktreePath, "scratch.txt"),
      "uncommitted work\n",
      "utf8",
    );
    const secondCard = await parkCard({
      repoRoot: second.repoRoot,
      worktreePath: second.worktreePath,
      recordedBranch: "feature/second",
    });
    const { wakeup } = wakeupRecorder();

    const firstTick = await sweepWorkspaceValidationRecoveries(db, {
      limit: 1,
      wakeup,
      minAttemptIntervalMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondTick = await sweepWorkspaceValidationRecoveries(db, {
      limit: 1,
      wakeup,
      minAttemptIntervalMs: 1,
    });

    expect(firstTick.items.map((item) => item.recoveryActionId)).toEqual([
      firstCard.actionId,
    ]);
    expect(secondTick.items.map((item) => item.recoveryActionId)).toEqual([
      secondCard.actionId,
    ]);
  }, 30_000);

  it("rotates through every card when each cooldown lapses between ticks", async () => {
    const cards = [];
    for (const name of ["alpha", "bravo", "charlie"]) {
      const worktree = await createDriftedWorktree(tempDirs, {
        recordedBranch: `feature/${name}`,
        driftedBranch: `feature/${name}-live`,
      });
      await fs.writeFile(
        path.join(worktree.worktreePath, "scratch.txt"),
        "uncommitted work\n",
        "utf8",
      );
      cards.push(
        await parkCard({
          repoRoot: worktree.repoRoot,
          worktreePath: worktree.worktreePath,
          recordedBranch: `feature/${name}`,
        }),
      );
    }
    const { wakeup } = wakeupRecorder();

    const attempted: string[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const result = await sweepWorkspaceValidationRecoveries(db, {
        limit: 1,
        wakeup,
        minAttemptIntervalMs: 1,
      });
      attempted.push(...result.items.map((item) => item.recoveryActionId));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(attempted).toEqual(cards.map((card) => card.actionId));
  }, 30_000);
});
