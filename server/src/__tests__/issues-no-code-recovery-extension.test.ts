import { executionWorkspaces, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import {
  noCodeSettings,
  openNoCodeTestDatabase,
  seedNoCodeWorkspaceFixture,
} from "./helpers/no-code-workspace-fixtures.js";

// Revalidating untouched legacy workspace choices strands status recovery;
// inheriting/defaulting code bindings silently defeats an explicit no-code opt-in.
describe("no-code recovery and inheritance acceptance extension", () => {
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

  it.each(["status", "comment", "title"] as const)(
    "a raw conflicting no-code row still permits a %s-only recovery write",
    async (kind) => {
      const f = await fixture();
      await temporary.db
        .update(issues)
        .set({
          executionWorkspaceSettings: noCodeSettings,
          executionWorkspaceId: f.executionWorkspaceId,
          executionWorkspacePreference: "reuse_existing",
        })
        .where(eq(issues.id, f.issueId));
      const before = await svc.getById(f.issueId);

      if (kind === "comment") {
        const comment = await svc.addComment(
          f.issueId,
          "Recovery evidence retained",
          {
            userId: "no-code-test-user",
          },
        );
        expect(comment.body).toBe("Recovery evidence retained");
      } else {
        const update =
          kind === "status"
            ? { status: "done" }
            : { title: "Legacy dispatch failed; recovery is still writable" };
        await expect(svc.update(f.issueId, update)).resolves.toMatchObject(
          update,
        );
      }
      const after = await svc.getById(f.issueId);
      expect(after).toMatchObject({
        executionWorkspaceSettings: before?.executionWorkspaceSettings,
        executionWorkspaceId: f.executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      });
      expect(
        (
          await temporary.db
            .select()
            .from(executionWorkspaces)
            .where(eq(executionWorkspaces.id, f.executionWorkspaceId))
        )[0],
      ).toBeDefined();
    },
  );

  it.each([true, false])(
    "clears explicit no-code with the feature flag enabled=%s",
    async (enabled) => {
      const f = await fixture(enabled);
      await temporary.db
        .update(issues)
        .set({ executionWorkspaceSettings: noCodeSettings })
        .where(eq(issues.id, f.issueId));

      const updated = await svc.update(f.issueId, {
        executionWorkspaceSettings: null,
      });
      expect(updated?.executionWorkspaceSettings?.mode).not.toBe("no_code");
      expect(
        (await svc.getById(f.issueId))?.executionWorkspaceSettings?.mode,
      ).not.toBe("no_code");
    },
  );

  it.each([true, false])(
    "fresh no-code has no implicit code binding (feature enabled=%s)",
    async (enabled) => {
      const f = await fixture(enabled);
      const created = await svc.create(f.companyId, {
        title: "Repository project report only",
        projectId: f.projectId,
        executionWorkspaceSettings: noCodeSettings as never,
      });
      expect(created).toMatchObject({
        projectId: f.projectId,
        projectWorkspaceId: null,
        executionWorkspaceId: null,
        executionWorkspaceSettings: noCodeSettings,
      });
    },
  );

  it.each([true, false])(
    "explicit no-code child does not inherit a parent's code binding (feature enabled=%s)",
    async (enabled) => {
      const f = await fixture(enabled);
      await temporary.db
        .update(issues)
        .set({
          projectWorkspaceId: f.projectWorkspaceId,
          executionWorkspaceId: f.executionWorkspaceId,
          executionWorkspacePreference: "reuse_existing",
          executionWorkspaceSettings: { mode: "shared_workspace" },
        })
        .where(eq(issues.id, f.issueId));

      const child = await svc.create(f.companyId, {
        title: "Report child of code task",
        parentId: f.issueId,
        executionWorkspaceSettings: noCodeSettings as never,
      });
      expect(child).toMatchObject({
        parentId: f.issueId,
        projectId: f.projectId,
        projectWorkspaceId: null,
        executionWorkspaceId: null,
        executionWorkspaceSettings: noCodeSettings,
      });
      expect((await svc.getById(f.issueId))?.executionWorkspaceId).toBe(
        f.executionWorkspaceId,
      );
    },
  );

  it("strategy-only accepted-plan decomposition does not implicitly opt its child into no-code", async () => {
    const f = await fixture();
    await temporary.db
      .update(issues)
      .set({ executionWorkspaceSettings: noCodeSettings })
      .where(eq(issues.id, f.issueId));
    const { issue: child } = await svc.createChild(f.issueId, {
      title: "Unspecified accepted-plan child",
      status: "todo",
      priority: "medium",
      executionWorkspaceInheritanceMode: "strategy_only",
    });
    expect(child.parentId).toBe(f.issueId);
    expect(child.projectId).toBe(f.projectId);
    expect(child.executionWorkspaceSettings?.mode).not.toBe("no_code");
  });

  it.each([true, false])(
    "ordinary children do not inherit no-code (feature enabled=%s)",
    async (enabled) => {
      const f = await fixture(enabled);
      await temporary.db
        .update(issues)
        .set({ executionWorkspaceSettings: noCodeSettings })
        .where(eq(issues.id, f.issueId));
      const child = await svc.create(f.companyId, {
        title: "Code child",
        parentId: f.issueId,
      });
      expect(child.projectId).toBe(f.projectId);
      expect(child.executionWorkspaceSettings?.mode).not.toBe("no_code");
    },
  );
});
