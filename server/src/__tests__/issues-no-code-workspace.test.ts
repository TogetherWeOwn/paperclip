import { randomUUID } from "node:crypto";
import { environments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import {
  noCodeSettings,
  openNoCodeTestDatabase,
  seedNoCodeWorkspaceFixture,
} from "./helpers/no-code-workspace-fixtures.js";

// Production mutations which silently normalize away explicit task settings,
// copy a parent's no-code opt-in, or skip binding validation must fail here.
describe("no-code task persistence and preserved workspace boundaries", () => {
  let temporary: Awaited<ReturnType<typeof openNoCodeTestDatabase>>;
  let svc: ReturnType<typeof issueService>;

  beforeAll(async () => {
    temporary = await openNoCodeTestDatabase();
    svc = issueService(temporary.db);
  }, 120_000);

  afterAll(async () => {
    await temporary?.close();
  });

  async function fixture(enabled = true) {
    await instanceSettingsService(temporary.db).updateExperimental({
      enableIsolatedWorkspaces: enabled,
    });
    return seedNoCodeWorkspaceFixture(temporary.db);
  }

  it.each([true, false])(
    "create/read retains explicit no-code with isolated-workspaces feature enabled=%s",
    async (enabled) => {
      const f = await fixture(enabled);
      const created = await svc.create(f.companyId, {
        title: "Report for a repository project",
        projectId: f.projectId,
        executionWorkspaceSettings: noCodeSettings as never,
      });

      expect(created.projectId).toBe(f.projectId);
      expect(created.executionWorkspaceSettings).toMatchObject(noCodeSettings);
      expect(
        (await svc.getById(created.id))?.executionWorkspaceSettings,
      ).toMatchObject(noCodeSettings);
    },
  );

  it.each([true, false])(
    "update/read retains explicit no-code with isolated-workspaces feature enabled=%s",
    async (enabled) => {
      const f = await fixture(enabled);
      const updated = await svc.update(f.issueId, {
        executionWorkspaceSettings: noCodeSettings as never,
      });

      expect(updated?.executionWorkspaceSettings).toMatchObject(noCodeSettings);
      expect(
        (await svc.getById(f.issueId))?.executionWorkspaceSettings,
      ).toMatchObject(noCodeSettings);
    },
  );

  it("does not inherit a parent's no-code selection into an unspecified child", async () => {
    const f = await fixture();
    await temporary.db
      .update(issues)
      .set({ executionWorkspaceSettings: noCodeSettings })
      .where(eq(issues.id, f.issueId));

    const child = await svc.create(f.companyId, {
      parentId: f.issueId,
      title: "Child code task",
    });

    expect(child.parentId).toBe(f.issueId);
    expect(child.projectId).toBe(f.projectId);
    expect(child.executionWorkspaceSettings?.mode).not.toBe("no_code");
    expect(child.executionWorkspacePreference).not.toBe("agent_default");
  });

  it("allows a descendant to opt in explicitly without losing its inherited project", async () => {
    const f = await fixture();
    const child = await svc.create(f.companyId, {
      parentId: f.issueId,
      title: "Explicit report child",
      executionWorkspaceSettings: noCodeSettings as never,
    });

    expect(child.projectId).toBe(f.projectId);
    expect(child.executionWorkspaceSettings).toMatchObject(noCodeSettings);
  });

  it("does not inherit no-code through an explicitly named workspace-source issue", async () => {
    const f = await fixture();
    await temporary.db
      .update(issues)
      .set({ executionWorkspaceSettings: noCodeSettings })
      .where(eq(issues.id, f.issueId));

    const child = await svc.create(f.companyId, {
      title: "Unspecified follow-up",
      inheritExecutionWorkspaceFromIssueId: f.issueId,
    });

    expect(child.executionWorkspaceSettings?.mode).not.toBe("no_code");
  });

  it("preserves the ordinary default for an unspecified repository task", async () => {
    const f = await fixture();
    const task = await svc.create(f.companyId, {
      projectId: f.projectId,
      title: "Ordinary code task",
    });

    expect(task.projectWorkspaceId).toBe(f.projectWorkspaceId);
    expect(task.executionWorkspaceSettings?.mode).toBe("shared_workspace");
  });

  it("retains selected environment and egress policy through create, update and read", async () => {
    const f = await fixture();
    const environmentId = randomUUID();
    await temporary.db.insert(environments).values({
      id: environmentId,
      name: `Selected isolated environment ${environmentId}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "daytona" },
    });
    const settings = {
      ...noCodeSettings,
      environmentId,
      networkEgress: { allowFqdns: ["docs.example.test"] },
    };
    const created = await svc.create(f.companyId, {
      projectId: f.projectId,
      title: "Environment-constrained report",
      executionWorkspaceSettings: settings as never,
    });

    expect(created.executionWorkspaceSettings).toMatchObject(settings);
    const updated = await svc.update(created.id, {
      title: "Still constrained",
    });
    expect(updated?.executionWorkspaceSettings).toMatchObject(settings);
    expect(
      (await svc.getById(created.id))?.executionWorkspaceSettings,
    ).toMatchObject(settings);
  });

  const selections = [
    "execution binding",
    "project workspace",
    "explicit code preference",
    "pinned branch",
    "strategy",
    "runtime",
    "adapter cwd",
    "adapter workspace",
  ] as const;
  function selection(
    name: (typeof selections)[number],
    f: Awaited<ReturnType<typeof fixture>>,
  ) {
    switch (name) {
      case "execution binding":
        return {
          executionWorkspaceId: f.executionWorkspaceId,
          executionWorkspacePreference: "reuse_existing",
        };
      case "project workspace":
        return { projectWorkspaceId: f.projectWorkspaceId };
      case "explicit code preference":
        return { executionWorkspacePreference: "isolated_workspace" };
      case "pinned branch":
        return {
          executionWorkspaceSettings: {
            ...noCodeSettings,
            workspaceStrategy: {
              type: "git_worktree",
              existingBranch: "feature/preserved",
            },
          },
        };
      case "strategy":
        return {
          executionWorkspaceSettings: {
            ...noCodeSettings,
            workspaceStrategy: {
              type: "git_worktree",
              baseRef: "origin/master",
              branchTemplate: "feature/preserved",
            },
          },
        };
      case "runtime":
        return {
          executionWorkspaceSettings: {
            ...noCodeSettings,
            workspaceRuntime: {
              services: [
                { name: "explicit-service", command: "node server.js" },
              ],
            },
          },
        };
      case "adapter cwd":
        return {
          assigneeAdapterOverrides: {
            adapterConfig: { cwd: "/explicit/workspace" },
          },
        };
      case "adapter workspace":
        return { assigneeAdapterOverrides: { useProjectWorkspace: true } };
    }
  }

  for (const action of ["create", "update"] as const) {
    it.each(selections)(
      `${action} preserves or clearly rejects a no-code conflict with %s`,
      async (name) => {
        const f = await fixture();
        const explicit = selection(name, f);
        const input = {
          executionWorkspaceSettings: noCodeSettings,
          ...explicit,
        };
        const before = await svc.getById(f.issueId);
        let result: Awaited<ReturnType<typeof svc.getById>>;
        try {
          result =
            action === "create"
              ? await svc.create(f.companyId, {
                  title: "Conflicting workspace request",
                  projectId: f.projectId,
                  ...input,
                } as never)
              : await svc.update(f.issueId, input as never);
        } catch (error) {
          expect(error).toMatchObject({
            status: expect.any(Number),
            message: expect.stringMatching(
              /workspace|no.code|conflict|branch|runtime|cwd/i,
            ),
          });
          expect([400, 409, 422]).toContain(
            (error as { status: number }).status,
          );
          expect(await svc.getById(f.issueId)).toMatchObject({
            executionWorkspaceId: before?.executionWorkspaceId,
            executionWorkspaceSettings: before?.executionWorkspaceSettings,
            assigneeAdapterOverrides: before?.assigneeAdapterOverrides,
          });
          return;
        }
        // Preservation is allowed; silently discarding either explicit choice isn't.
        expect(result).toMatchObject(input);
      },
    );
  }

  for (const action of ["create", "update"] as const) {
    it.each(["projectWorkspaceId", "executionWorkspaceId"] as const)(
      `${action} denies foreign-company %s even with explicit no-code`,
      async (field) => {
        const local = await fixture();
        const foreign = await seedNoCodeWorkspaceFixture(temporary.db);
        const input = {
          executionWorkspaceSettings: noCodeSettings,
          [field]: foreign[field],
        };
        await expect(
          action === "create"
            ? svc.create(local.companyId, {
                title: "Foreign workspace",
                ...input,
              } as never)
            : svc.update(local.issueId, input as never),
        ).rejects.toMatchObject({ status: expect.any(Number) });
        const unchanged = await svc.getById(local.issueId);
        expect(unchanged).toMatchObject({
          projectId: local.projectId,
          executionWorkspaceId: null,
          executionWorkspaceSettings: null,
        });
      },
    );
  }
});
