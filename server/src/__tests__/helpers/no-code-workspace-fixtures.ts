import { randomUUID } from "node:crypto";
import {
  agents,
  applyPendingMigrations,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

// Never infer a test target from DATABASE_URL or the running application.
// Agent runs supply an exclusively owned paperclip_no_code_* database.
export async function openNoCodeTestDatabase() {
  const connectionString = process.env.PAPERCLIP_NO_CODE_TEST_DATABASE_URL;
  if (connectionString) {
    const url = new URL(connectionString);
    const allowedHost =
      url.hostname === "agent-testdb" ||
      (process.env.CI === "true" &&
        ["localhost", "127.0.0.1", "postgres"].includes(url.hostname));
    if (
      !allowedHost ||
      !/^\/paperclip_no_code_[a-z0-9_]+$/.test(url.pathname)
    ) {
      throw new Error(
        "No-code acceptance tests require an exclusively owned paperclip_no_code_* database on agent-testdb (or a CI PostgreSQL service)",
      );
    }
    await applyPendingMigrations(connectionString);
    const db = createDb(connectionString);
    return { db, close: () => db.$client.end({ timeout: 5 }) };
  }
  // Ordinary CI retains the repository's disposable embedded database fixture.
  // The acceptance author uses the explicit agent-testdb path above.
  const temporary =
    await startEmbeddedPostgresTestDatabase("paperclip-no-code-");
  const db = createDb(temporary.connectionString);
  return {
    db,
    close: async () => {
      await db.$client.end({ timeout: 5 });
      await temporary.cleanup();
    },
  };
}

export type NoCodeTestDb = ReturnType<typeof createDb>;

export async function seedNoCodeWorkspaceFixture(
  db: NoCodeTestDb,
  cwd: string | null = null,
) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const executionWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const prefix = `N${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`;
  await db.insert(companies).values({
    id: companyId,
    name: "No-code acceptance company",
    issuePrefix: prefix,
    issueCounter: 1,
    status: "active",
    defaultResponsibleUserId: "no-code-test-user",
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: "no-code-test-user",
    membershipRole: "owner",
    status: "active",
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Repository project",
    status: "in_progress",
    executionWorkspacePolicy: {
      enabled: true,
      allowIssueOverride: true,
      defaultMode: "shared_workspace",
      defaultProjectWorkspaceId: projectWorkspaceId,
    },
  });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary repository",
    cwd,
    repoUrl: "https://github.com/example/no-code-fixture.git",
    repoRef: "master",
    sourceType: "git_repo",
    isPrimary: true,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Operator",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    permissions: {},
  });
  await db.insert(executionWorkspaces).values({
    id: executionWorkspaceId,
    companyId,
    projectId,
    projectWorkspaceId,
    sourceIssueId: null,
    name: "Explicit code workspace",
    mode: "shared_workspace",
    strategyType: "project_primary",
    status: "active",
    cwd,
    repoUrl: "https://github.com/example/no-code-fixture.git",
    providerType: "local_path",
    providerRef: cwd,
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    projectId,
    title: "Workspace acceptance task",
    status: "todo",
    priority: "medium",
    assigneeAgentId: agentId,
    responsibleUserId: "no-code-test-user",
    issueNumber: 1,
    identifier: `${prefix}-1`,
  });
  return {
    companyId,
    projectId,
    projectWorkspaceId,
    executionWorkspaceId,
    agentId,
    issueId,
  };
}

// The baseline's TypeScript enum predates the approved persisted JSON contract.
// Keep feature-missing RED at a behavior assertion, not a compiler suppression.
export const noCodeSettings = { mode: "no_code" } as const;
