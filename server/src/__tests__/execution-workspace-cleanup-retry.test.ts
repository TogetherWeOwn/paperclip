import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  closeRegisteredClients,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueReferenceMentions,
  issueWorkProducts,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";

const execFileAsync = promisify(execFile);

// Optional isolated-database path for hosts without embedded Postgres
// support. Fail closed: only an agent-testdb URL whose database is
// exclusively owned by this suite may be used, and it must start empty.
const externalTestDatabaseUrl = process.env.PAPERCLIP_CLEANUP_RETRY_TEST_DATABASE_URL ?? null;
if (externalTestDatabaseUrl) {
  const parsed = new URL(externalTestDatabaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (parsed.hostname !== "agent-testdb" || !databaseName.startsWith("paperclip_cleanup_retry_")) {
    throw new Error(
      "PAPERCLIP_CLEANUP_RETRY_TEST_DATABASE_URL must target agent-testdb with a paperclip_cleanup_retry_* database",
    );
  }
}

async function assertExternalTestDatabaseEmpty(url: string): Promise<void> {
  const probe = createDb(url);
  try {
    const rows = await probe.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const count = Array.isArray(rows) ? rows[0]?.count : null;
    if (count !== "0") {
      throw new Error(
        "Refusing cleanup retry tests: the isolated database is not empty; use an exclusively owned paperclip_cleanup_retry_* database",
      );
    }
  } finally {
    await closeRegisteredClients(url);
  }
}

const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true as const, reason: null as string | null }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping execution workspace cleanup retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-retry-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

describeEmbeddedPostgres("executionWorkspaceService cleanup_failed retry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();
  const pullRequestDetailsByKey = new Map<string, {
    state: "merged" | "open" | "unknown";
    headRef: string | null;
    headSha: string | null;
  }>();

  function createService(options?: {
    beforeTerminalWorkspaceCleanup?: (workspace: { id: string }) => Promise<void>;
  }) {
    return executionWorkspaceService(db, {
      resolvePullRequestDetails: vi.fn(async (companyId, reference) =>
        pullRequestDetailsByKey.get(`${companyId}:${reference.number}`)
        ?? { state: "unknown", headRef: null, headSha: null }
      ),
      workspaceReaperCooldownDays: 0,
      ...(options?.beforeTerminalWorkspaceCleanup
        ? { beforeTerminalWorkspaceCleanup: options.beforeTerminalWorkspaceCleanup }
        : {}),
    });
  }

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await assertExternalTestDatabaseEmpty(externalTestDatabaseUrl);
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspace-cleanup-retry-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueWorkProducts);
    await db.delete(issueReferenceMentions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    pullRequestDetailsByKey.clear();

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    if (externalTestDatabaseUrl) {
      await closeRegisteredClients(externalTestDatabaseUrl);
      return;
    }
    await tempDb?.cleanup();
  });

  async function seedTerminalWorkspace() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const issuePrefix = `P${companyId.slice(0, 8).toUpperCase()}`;
    const identifier = `${issuePrefix}-1`;
    const repoRoot = await createTempRepo();
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-cleanup-retry-${randomUUID()}`);
    tempDirs.add(repoRoot);
    tempDirs.add(worktreePath);
    await runGit(repoRoot, ["branch", "PAP-16015-delivery"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "PAP-16015-delivery"]);
    await fs.writeFile(path.join(worktreePath, "delivered.txt"), "delivered\n", "utf8");
    await runGit(worktreePath, ["add", "delivered.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Delivered change"]);
    const headOutput = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { cwd: worktreePath });
    const headSha = headOutput.stdout.trim();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Terminal workspaces",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: identifier,
      status: "active",
      cwd: worktreePath,
      providerRef: worktreePath,
      providerType: "git_worktree",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      baseRef: "main",
      branchName: "PAP-16015-delivery",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      identifier,
      title: "Delivered source issue",
      status: "done",
      priority: "medium",
      executionWorkspaceId,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId, updatedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: sourceIssueId,
      executionWorkspaceId,
      type: "pull_request",
      provider: "github",
      title: "Delivered PR",
      url: "https://github.com/paperclipai/paperclip/pull/10623",
      status: "merged",
    });
    pullRequestDetailsByKey.set(`${companyId}:10623`, {
      state: "merged",
      headRef: "PAP-16015-delivery",
      headSha,
    });
    return { companyId, executionWorkspaceId, sourceIssueId, worktreePath };
  }

  async function readWorkspace(executionWorkspaceId: string) {
    const [row] = await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        cleanupReason: executionWorkspaces.cleanupReason,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return row ?? null;
  }

  async function seedActiveRun(companyId: string, sourceIssueId: string) {
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, sourceIssueId));
  }

  it("retries a failed removal on the next sweep and keeps the original closedAt", async () => {
    const seeded = await seedTerminalWorkspace();
    const failingService = createService({
      beforeTerminalWorkspaceCleanup: async () => {
        throw new Error("simulated destroy failure");
      },
    });

    const first = await failingService.sweepTerminalWorkspaces();
    expect(first).toMatchObject({ archived: 0, cleanupFailed: 1 });
    const failed = await readWorkspace(seeded.executionWorkspaceId);
    expect(failed?.status).toBe("cleanup_failed");
    expect(failed?.closedAt).not.toBeNull();
    const firstClosedAt = failed?.closedAt?.toISOString() ?? null;

    const second = await createService().sweepTerminalWorkspaces();
    expect(second).toMatchObject({ archived: 1, cleanupFailed: 0 });
    const retried = await readWorkspace(seeded.executionWorkspaceId);
    expect(retried?.status).toBe("archived");
    // The retry completes the original archive; it must not re-archive and
    // reset the lifecycle timestamps.
    expect(retried?.closedAt?.toISOString()).toBe(firstClosedAt);
    await expect(fs.access(seeded.worktreePath)).rejects.toThrow();
  }, 60_000);

  it("retains cleanup_failed across repeated failures", async () => {
    const seeded = await seedTerminalWorkspace();
    const failingService = createService({
      beforeTerminalWorkspaceCleanup: async () => {
        throw new Error("simulated destroy failure");
      },
    });

    await failingService.sweepTerminalWorkspaces();
    const second = await failingService.sweepTerminalWorkspaces();

    expect(second).toMatchObject({ cleanupFailed: 1 });
    const retained = await readWorkspace(seeded.executionWorkspaceId);
    expect(retained?.status).toBe("cleanup_failed");
    expect(retained?.cleanupReason).toContain("simulated destroy failure");
    // The worktree is untouched: nothing was half-removed.
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
  }, 60_000);

  it("keeps the active-run gate on a cleanup_failed retry", async () => {
    const seeded = await seedTerminalWorkspace();
    const failingService = createService({
      beforeTerminalWorkspaceCleanup: async () => {
        throw new Error("simulated destroy failure");
      },
    });

    await failingService.sweepTerminalWorkspaces();
    expect((await readWorkspace(seeded.executionWorkspaceId))?.status).toBe("cleanup_failed");

    await seedActiveRun(seeded.companyId, seeded.sourceIssueId);
    const second = await createService().sweepTerminalWorkspaces();

    expect(second).toMatchObject({ skippedActiveRun: 1, archived: 0, cleanupFailed: 0 });
    expect((await readWorkspace(seeded.executionWorkspaceId))?.status).toBe("cleanup_failed");
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
  }, 60_000);

  it("keeps the dirty-worktree gate on a cleanup_failed retry", async () => {
    const seeded = await seedTerminalWorkspace();
    const failingService = createService({
      beforeTerminalWorkspaceCleanup: async () => {
        throw new Error("simulated destroy failure");
      },
    });

    await failingService.sweepTerminalWorkspaces();
    expect((await readWorkspace(seeded.executionWorkspaceId))?.status).toBe("cleanup_failed");

    await fs.writeFile(path.join(seeded.worktreePath, "uncommitted.txt"), "not delivered\n", "utf8");
    const second = await createService().sweepTerminalWorkspaces();

    expect(second).toMatchObject({ skippedUndelivered: 1, archived: 0, cleanupFailed: 0 });
    expect((await readWorkspace(seeded.executionWorkspaceId))?.status).toBe("cleanup_failed");
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
  }, 60_000);
});
