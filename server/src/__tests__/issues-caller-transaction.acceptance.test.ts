import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  executionWorkspaces,
  instanceSettings,
  issues,
  projects,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  callerTransactionTestUrl,
  createCallerTransactionDatabase,
  withinTransactionDeadline,
} from "./helpers/caller-transaction-database.js";

// Opt in with PAPERCLIP_CALLER_TRANSACTION_TEST_DATABASE_URL and an independently
// selected PAPERCLIP_TEST_DATABASE_HOST. No embedded server or instance bootstrap.
const testUrl = callerTransactionTestUrl(process.env);

describe("caller-transaction database containment", () => {
  it("does not use an ambient application database", () => {
    expect(callerTransactionTestUrl({ DATABASE_URL: "postgres://production.invalid/app" })).toBeNull();
  });

  it.each([
    { PAPERCLIP_TEST_DATABASE_HOST: "different.test" },
    { PAPERCLIP_CALLER_TRANSACTION_TEST_DATABASE_URL: "postgres://agent_test@db.test/application" },
    { PAPERCLIP_CALLER_TRANSACTION_TEST_DATABASE_URL: "postgres://admin@db.test/agent_test" },
    { PAPERCLIP_CALLER_TRANSACTION_TEST_DATABASE_URL: "postgres://agent_test@db.test/agent_test?options=unsafe" },
  ])("rejects a mismatched or non-test connection before constructing a client: %j", (override) => {
    expect(() => callerTransactionTestUrl({
      PAPERCLIP_CALLER_TRANSACTION_TEST_DATABASE_URL: "postgres://agent_test@db.test/agent_test",
      PAPERCLIP_TEST_DATABASE_HOST: "db.test",
      ...override,
    })).toThrow("disposable test database");
  });
});

describe.skipIf(!testUrl)("issue create/update caller-transaction acceptance", () => {
  let fixture: Awaited<ReturnType<typeof createCallerTransactionDatabase>>;
  let db: Db;
  let svc: ReturnType<typeof issueService>;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let foreignAgentId: string;
  let terminatedAgentId: string;
  let userId: string;
  let projectId: string;
  let projectWorkspaceId: string;
  let executionWorkspaceId: string;
  let issueId: string;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    fixture = await createCallerTransactionDatabase(testUrl!);
  }, 30_000);

  beforeEach(async () => {
    db = fixture.open();
    svc = issueService(db);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    foreignAgentId = randomUUID();
    terminatedAgentId = randomUUID();
    userId = randomUUID();
    projectId = randomUUID();
    projectWorkspaceId = randomUUID();
    executionWorkspaceId = randomUUID();
    issueId = randomUUID();
    await db.insert(instanceSettings).values({
      singletonKey: "default", experimental: { enableIsolatedWorkspaces: false },
    }).onConflictDoUpdate({
      target: instanceSettings.singletonKey,
      set: { experimental: { enableIsolatedWorkspaces: false } },
    });
    await db.insert(companies).values([companyId, otherCompanyId].map((id) => ({
      id, name: "Transaction acceptance", issuePrefix: `TX${id.replaceAll("-", "").slice(0, 10)}`,
    })));
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Assignable", role: "engineer", adapterType: "process", status: "idle" },
      { id: foreignAgentId, companyId: otherCompanyId, name: "Other company", role: "engineer", adapterType: "process", status: "idle" },
      { id: terminatedAgentId, companyId, name: "Terminated", role: "engineer", adapterType: "process", status: "terminated" },
    ]);
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture project" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Fixture workspace", isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId, companyId, projectId, projectWorkspaceId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Fixture execution workspace",
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Before update", status: "backlog" });
  });

  afterEach(async () => { await fixture?.close(); });
  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
  });

  it("keeps ordinary nontransaction calls working on one connection", async () => {
    const [agentIssue, userIssue] = await withinTransactionDeadline(Promise.all([
      svc.create(companyId, { title: "Ordinary agent assignment", assigneeAgentId: agentId }),
      svc.create(companyId, { title: "Ordinary user assignment", assigneeUserId: userId }),
    ]));
    expect(agentIssue.assigneeAgentId).toBe(agentId);
    expect(userIssue.assigneeUserId).toBe(userId);
    const updated = await withinTransactionDeadline(svc.update(agentIssue.id, { title: "Ordinary update" }));
    expect(updated?.title).toBe("Ordinary update");
    expect((await instanceSettingsService(db, { runtimeEnv: {} }).getExperimental()).enableIsolatedWorkspaces).toBe(false);
  });

  it("settles concurrent outer-transaction creates and an update with a single pooled connection", async () => {
    const results = await withinTransactionDeadline(Promise.all([
      db.transaction((tx) => svc.create(companyId, { title: "Concurrent first", assigneeAgentId: agentId }, tx)),
      db.transaction((tx) => svc.create(companyId, { title: "Concurrent second", assigneeUserId: userId }, tx)),
      db.transaction((tx) => svc.update(issueId, { title: "Concurrent update" }, tx)),
    ]));
    expect(results.map((row) => row?.title)).toEqual(["Concurrent first", "Concurrent second", "Concurrent update"]);
    expect(new Set(results.map((row) => row?.id)).size).toBe(3);
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.issueCounter).toBe(2);
  });

  it.each(["agent", "user"] as const)("create sees an uncommitted %s assignee and rolls back the issue and counter", async (kind) => {
    const uncommittedId = randomUUID();
    const rollback = new Error("intentional caller rollback");
    await expect(withinTransactionDeadline(db.transaction(async (tx) => {
      if (kind === "agent") {
        await tx.insert(agents).values({
          id: uncommittedId, companyId, name: "Uncommitted", role: "engineer", adapterType: "process", status: "idle",
        });
      } else {
        await tx.insert(companyMemberships).values({
          companyId, principalType: "user", principalId: uncommittedId, status: "active", membershipRole: "member",
        });
      }
      const created = await svc.create(companyId, {
        title: "Uncommitted assignment",
        ...(kind === "agent" ? { assigneeAgentId: uncommittedId } : { assigneeUserId: uncommittedId }),
      }, tx);
      expect(created[kind === "agent" ? "assigneeAgentId" : "assigneeUserId"]).toBe(uncommittedId);
      expect(await tx.select().from(issues).where(eq(issues.id, created.id))).toHaveLength(1);
      throw rollback;
    }))).rejects.toBe(rollback);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.issueCounter).toBe(0);
    expect(await db.select().from(agents).where(eq(agents.id, uncommittedId))).toHaveLength(0);
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, uncommittedId))).toHaveLength(0);
  });

  it("create uses the caller's uncommitted experimental settings and restores them on rollback", async () => {
    const rollback = new Error("intentional settings rollback");
    await expect(withinTransactionDeadline(db.transaction(async (tx) => {
      await tx.update(instanceSettings).set({ experimental: { enableIsolatedWorkspaces: true } });
      const created = await svc.create(companyId, {
        title: "Transaction-gated workspace", projectId,
        executionWorkspaceId, executionWorkspacePreference: "reuse_existing",
      }, tx);
      expect(created.executionWorkspaceId).toBe(executionWorkspaceId);
      expect(created.executionWorkspacePreference).toBe("reuse_existing");
      throw rollback;
    }))).rejects.toBe(rollback);
    expect((await instanceSettingsService(db, { runtimeEnv: {} }).getExperimental()).enableIsolatedWorkspaces).toBe(false);
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.issueCounter).toBe(0);
  });

  it.each(["user", "project_workspace", "execution_workspace"] as const)("update sees an uncommitted %s and rolls back", async (kind) => {
    await db.update(instanceSettings).set({ experimental: { enableIsolatedWorkspaces: true } });
    const uncommittedId = randomUUID();
    const rollback = new Error("intentional update rollback");
    await expect(withinTransactionDeadline(db.transaction(async (tx) => {
      let patch: Parameters<typeof svc.update>[1] = { title: "Inside transaction" };
      if (kind === "user") {
        await tx.insert(companyMemberships).values({
          companyId, principalType: "user", principalId: uncommittedId, status: "active", membershipRole: "member",
        });
        patch = { ...patch, assigneeUserId: uncommittedId };
      } else if (kind === "project_workspace") {
        await tx.insert(projectWorkspaces).values({ id: uncommittedId, companyId, projectId, name: "Uncommitted" });
        patch = { ...patch, projectWorkspaceId: uncommittedId };
      } else {
        await tx.insert(executionWorkspaces).values({
          id: uncommittedId, companyId, projectId,
          mode: "shared_workspace", strategyType: "project_primary", name: "Uncommitted",
        });
        patch = { ...patch, executionWorkspaceId: uncommittedId, executionWorkspacePreference: "reuse_existing" };
      }
      const updated = await svc.update(issueId, patch, tx);
      expect(updated?.title).toBe("Inside transaction");
      if (kind === "user") expect(updated?.assigneeUserId).toBe(uncommittedId);
      if (kind === "project_workspace") expect(updated?.projectWorkspaceId).toBe(uncommittedId);
      if (kind === "execution_workspace") expect(updated?.executionWorkspaceId).toBe(uncommittedId);
      if (kind !== "user") expect(updated?.projectId).toBe(projectId);
      throw rollback;
    }))).rejects.toBe(rollback);
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(unchanged.title).toBe("Before update");
    expect(unchanged.assigneeUserId).toBeNull();
    expect(unchanged.projectWorkspaceId).toBeNull();
    expect(unchanged.executionWorkspaceId).toBeNull();
  });

  it("update honors a flag disabled inside the caller transaction instead of the committed flag", async () => {
    await db.update(instanceSettings).set({ experimental: { enableIsolatedWorkspaces: true } });
    const updated = await withinTransactionDeadline(db.transaction(async (tx) => {
      await tx.update(instanceSettings).set({ experimental: { enableIsolatedWorkspaces: false } });
      return svc.update(issueId, { title: "Flag disabled", projectId, executionWorkspaceId }, tx);
    }));
    expect(updated?.title).toBe("Flag disabled");
    expect(updated?.executionWorkspaceId).toBeNull();
  });

  it.each(["create", "update"] as const)("%s retains company, lifecycle and single-assignee checks outside a transaction", async (operation) => {
    const mutate = async (patch: Parameters<typeof svc.update>[1]) => {
      if (operation === "create") await svc.create(companyId, { ...patch, title: "Rejected assignment" });
      else await svc.update(issueId, patch);
    };
    await expect(withinTransactionDeadline(mutate({ assigneeAgentId: foreignAgentId }))).rejects.toMatchObject({ status: 422 });
    await expect(withinTransactionDeadline(mutate({ assigneeAgentId: terminatedAgentId }))).rejects.toMatchObject({ status: 409 });
    await expect(withinTransactionDeadline(mutate({ assigneeUserId: randomUUID() }))).rejects.toMatchObject({ status: 404 });
    await expect(withinTransactionDeadline(mutate({ assigneeAgentId: agentId, assigneeUserId: userId }))).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
  });

  it.each(["create", "update"] as const)("%s does not bypass assignee company checks in a caller transaction", async (operation) => {
    await expect(withinTransactionDeadline(db.transaction(async (tx) => {
      if (operation === "create") {
        await svc.create(companyId, { title: "Rejected transaction assignment", assigneeAgentId: foreignAgentId }, tx);
      } else {
        await svc.update(issueId, { assigneeAgentId: foreignAgentId }, tx);
      }
    }))).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(unchanged.assigneeAgentId).toBeNull();
  });

  it("update keeps companyGuard scoped when given a caller transaction", async () => {
    const result = await withinTransactionDeadline(db.transaction((tx) =>
      svc.update(issueId, { title: "Must not change", companyGuard: otherCompanyId }, tx),
    ));
    expect(result).toBeNull();
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(unchanged.title).toBe("Before update");
  });

  it("update rejects a membership deactivated in the caller transaction", async () => {
    await expect(withinTransactionDeadline(db.transaction(async (tx) => {
      await tx.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, userId));
      return svc.update(issueId, { assigneeUserId: userId }, tx);
    }))).rejects.toMatchObject({ status: 404 });
    const [membership] = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, userId));
    expect(membership.status).toBe("active");
  });
});
