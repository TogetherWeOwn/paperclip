import { randomUUID } from "node:crypto";
import { companies, environments, issues } from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportIssueRow } from "../services/import-write-types.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import {
  noCodeSettings,
  openNoCodeTestDatabase,
  seedNoCodeWorkspaceFixture,
} from "./helpers/no-code-workspace-fixtures.js";

// Catch import normalization silently dropping the task opt-in or treating an
// implicit project default as an explicit code-workspace selection.
describe("no-code imports preserve task-local authority in the database", () => {
  let temporary: Awaited<ReturnType<typeof openNoCodeTestDatabase>>;
  let svc: ReturnType<typeof issueService>;

  beforeAll(async () => {
    temporary = await openNoCodeTestDatabase();
    svc = issueService(temporary.db);
  }, 120_000);
  afterAll(async () => {
    await temporary?.close();
  });

  async function fixture(enabled: boolean) {
    await instanceSettingsService(temporary.db).updateExperimental({
      enableIsolatedWorkspaces: enabled,
    });
    return seedNoCodeWorkspaceFixture(temporary.db);
  }

  function row(
    f: Awaited<ReturnType<typeof fixture>>,
    overrides: Partial<ImportIssueRow> = {},
  ): ImportIssueRow {
    return {
      id: randomUUID(),
      ref: randomUUID(),
      projectId: f.projectId,
      projectWorkspaceId: null,
      title: "Imported operator report",
      description: null,
      assigneeAgentId: null,
      status: "backlog",
      priority: "medium",
      billingCode: null,
      assigneeAdapterOverrides: null,
      executionWorkspaceSettings: noCodeSettings,
      labelIds: [],
      monitorNotes: null,
      monitorScheduledBy: null,
      ...overrides,
    };
  }

  async function persisted(id: string) {
    const [result] = await temporary.db
      .select()
      .from(issues)
      .where(eq(issues.id, id));
    return result;
  }

  it.each([false, true])(
    "keeps explicit no-code independent of the isolated-workspaces flag (enabled=%s)",
    async (enabled) => {
      const f = await fixture(enabled);
      const imported = row(f);
      await svc.importIssues(f.companyId, [imported]);
      const stored = await persisted(imported.id);
      expect
        .soft(
          stored?.executionWorkspaceSettings,
          "The import writer must persist the explicit opt-in under either flag state",
        )
        .toMatchObject(noCodeSettings);
      expect
        .soft(
          stored?.projectWorkspaceId,
          "A project default is implicit: no-code must not acquire a code-workspace binding",
        )
        .toBeNull();
      expect(stored).toMatchObject({
        companyId: f.companyId,
        projectId: f.projectId,
        executionWorkspaceId: null,
      });
      expect(
        (await svc.getById(imported.id))?.executionWorkspaceSettings,
      ).toMatchObject(noCodeSettings);
    },
  );

  it.each([false, true])(
    "preserves environment and egress restrictions on the no-code import (enabled=%s)",
    async (enabled) => {
      const f = await fixture(enabled);
      const environmentId = randomUUID();
      await temporary.db.insert(environments).values({
        id: environmentId,
        name: `Import environment ${environmentId}`,
        driver: "sandbox",
        status: "active",
        config: { provider: "daytona" },
      });
      const settings = {
        ...noCodeSettings,
        environmentId,
        networkEgress: { allowFqdns: ["docs.example.test"] },
      };
      const imported = row(f, { executionWorkspaceSettings: settings });
      await svc.importIssues(f.companyId, [imported]);
      expect(
        (await persisted(imported.id))?.executionWorkspaceSettings,
      ).toMatchObject(settings);
    },
  );

  for (const enabled of [false, true]) {
    it.each([
      "project workspace",
      "strategy",
      "runtime",
      "adapter cwd",
      "adapter workspace",
    ] as const)(
      `rejects an explicit %s conflict atomically (isolated-workspaces=${enabled})`,
      async (selection) => {
        const f = await fixture(enabled);
        const invalid = row(f);
        if (selection === "project workspace")
          invalid.projectWorkspaceId = f.projectWorkspaceId;
        if (selection === "strategy")
          invalid.executionWorkspaceSettings = {
            ...noCodeSettings,
            workspaceStrategy: {
              type: "git_worktree",
              existingBranch: "preserved-code",
            },
          };
        if (selection === "runtime")
          invalid.executionWorkspaceSettings = {
            ...noCodeSettings,
            workspaceRuntime: {
              services: [
                { name: "explicit-service", command: "node server.js" },
              ],
            },
          };
        if (selection === "adapter cwd")
          invalid.assigneeAdapterOverrides = {
            adapterConfig: { cwd: "/explicit/code-workspace" },
          };
        if (selection === "adapter workspace")
          invalid.assigneeAdapterOverrides = { useProjectWorkspace: true };
        const valid = row(f, { executionWorkspaceSettings: null });
        const before = await temporary.db
          .select({ counter: companies.issueCounter })
          .from(companies)
          .where(eq(companies.id, f.companyId));
        let error: unknown;
        try {
          await svc.importIssues(f.companyId, [valid, invalid]);
        } catch (caught) {
          error = caught;
        }
        expect
          .soft(
            error,
            "Import must reject rather than discard either explicit workspace choice",
          )
          .toMatchObject({
            status: expect.any(Number),
            message: expect.stringMatching(
              /no.code|workspace|conflict|runtime|cwd/i,
            ),
          });
        if (error)
          expect([400, 409, 422]).toContain(
            (error as { status: number }).status,
          );
        expect
          .soft(
            await temporary.db
              .select({ id: issues.id })
              .from(issues)
              .where(inArray(issues.id, [valid.id, invalid.id])),
            "Neither the preceding valid row nor conflicting row may be partially inserted",
          )
          .toEqual([]);
        expect
          .soft(
            await temporary.db
              .select({ counter: companies.issueCounter })
              .from(companies)
              .where(eq(companies.id, f.companyId)),
            "Rejected imports must not consume issue numbers",
          )
          .toEqual(before);
      },
    );
  }

  it.each([false, true])(
    "retains ordinary unspecified and explicit code import defaults (enabled=%s)",
    async (enabled) => {
      const f = await fixture(enabled);
      const ordinary = row(f, { executionWorkspaceSettings: null });
      const code = row(f, {
        executionWorkspaceSettings: { mode: "shared_workspace" },
      });
      await svc.importIssues(f.companyId, [ordinary, code]);
      for (const input of [ordinary, code]) {
        const stored = await persisted(input.id);
        expect(stored?.projectWorkspaceId).toBe(f.projectWorkspaceId);
        expect(stored?.executionWorkspaceSettings?.mode).toBe(
          enabled ? "shared_workspace" : undefined,
        );
        expect(stored?.companyId).toBe(f.companyId);
      }
    },
  );

  it.each([false, true])(
    "supports projectless explicit no-code without inventing a workspace (enabled=%s)",
    async (enabled) => {
      const f = await fixture(enabled);
      const imported = row(f, { projectId: null });
      await svc.importIssues(f.companyId, [imported]);
      expect(await persisted(imported.id)).toMatchObject({
        companyId: f.companyId,
        projectId: null,
        projectWorkspaceId: null,
        executionWorkspaceId: null,
        executionWorkspaceSettings: noCodeSettings,
      });
    },
  );

  for (const enabled of [false, true]) {
    it.each(["project", "workspace", "assignee"] as const)(
      `rejects foreign-company %s atomically (isolated-workspaces=${enabled})`,
      async (field) => {
        const f = await fixture(enabled);
        const foreign = await seedNoCodeWorkspaceFixture(temporary.db);
        const valid = row(f, { executionWorkspaceSettings: null });
        const invalid = row(
          f,
          field === "project"
            ? { projectId: foreign.projectId }
            : field === "workspace"
              ? { projectWorkspaceId: foreign.projectWorkspaceId }
              : { assigneeAgentId: foreign.agentId },
        );
        await expect(
          svc.importIssues(f.companyId, [valid, invalid]),
        ).rejects.toMatchObject({ status: expect.any(Number) });
        expect(
          await temporary.db
            .select({ id: issues.id })
            .from(issues)
            .where(inArray(issues.id, [valid.id, invalid.id])),
        ).toEqual([]);
        expect(await persisted(f.issueId)).toMatchObject({
          companyId: f.companyId,
          executionWorkspaceSettings: null,
        });
      },
    );
  }
});
