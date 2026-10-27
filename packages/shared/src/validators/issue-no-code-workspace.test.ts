import { describe, expect, it } from "vitest";
import { createIssueSchema, updateIssueSchema } from "./issue.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";

// These are request-contract tests, not a declaration that no_code exists yet.
// Only persisted task settings opt in; names, work mode and legacy preferences do not.
describe("explicit per-task no-code workspace API contract", () => {
  it("accepts no_code on ordinary task creation without dropping project or environment", () => {
    const result = createIssueSchema.safeParse({
      title: "Prepare a report",
      projectId,
      executionWorkspaceSettings: { mode: "no_code", environmentId },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.projectId).toBe(projectId);
    expect(result.data.executionWorkspaceSettings).toEqual({
      mode: "no_code",
      environmentId,
    });
  });

  it("accepts no_code in an ordinary task update without injecting unrelated workspace fields", () => {
    const result = updateIssueSchema.safeParse({
      executionWorkspaceSettings: { mode: "no_code" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      executionWorkspaceSettings: { mode: "no_code" },
    });
  });

  it.each(["standard", "ask", "planning"])(
    "does not opt an unspecified %s task into no-code",
    (workMode) => {
      const result = createIssueSchema.parse({
        title: "No code: operator research only",
        description: "No repository work is necessary.",
        workMode,
      });

      expect(result.executionWorkspaceSettings).toBeUndefined();
      expect(result.executionWorkspacePreference).toBeUndefined();
    },
  );

  it.each([
    "inherit",
    "shared_workspace",
    "isolated_workspace",
    "operator_branch",
    "reuse_existing",
    "agent_default",
  ])(
    "preserves existing %s selection rather than promoting it to no-code",
    (mode) => {
      const created = createIssueSchema.parse({
        title: "Ordinary task",
        executionWorkspacePreference: mode,
        executionWorkspaceSettings: { mode },
      });
      const updated = updateIssueSchema.parse({
        executionWorkspaceSettings: { mode },
      });

      expect(created.executionWorkspacePreference).toBe(mode);
      expect(created.executionWorkspaceSettings).toEqual({ mode });
      expect(updated.executionWorkspaceSettings).toEqual({ mode });
    },
  );

  it("does not create a second no-code opt-in via executionWorkspacePreference alone", () => {
    expect(
      createIssueSchema.safeParse({
        title: "Report",
        executionWorkspacePreference: "no_code",
      }).success,
    ).toBe(false);
    expect(
      updateIssueSchema.safeParse({ executionWorkspacePreference: "no_code" })
        .success,
    ).toBe(false);
  });

  it.each(["no-code", "NO_CODE", "none", "operator"])(
    "rejects unrecognized mode %s",
    (mode) => {
      expect(
        createIssueSchema.safeParse({
          title: "Report",
          executionWorkspaceSettings: { mode },
        }).success,
      ).toBe(false);
      expect(
        updateIssueSchema.safeParse({ executionWorkspaceSettings: { mode } })
          .success,
      ).toBe(false);
    },
  );

  it("retains task-scoped egress restrictions alongside explicit no-code", () => {
    const result = updateIssueSchema.safeParse({
      executionWorkspaceSettings: {
        mode: "no_code",
        environmentId,
        networkEgress: { allowFqdns: ["docs.example.test"] },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.executionWorkspaceSettings).toEqual({
      mode: "no_code",
      environmentId,
      networkEgress: { allowFqdns: ["docs.example.test"] },
    });
  });

  it("still rejects private-network egress in a no-code request", () => {
    const result = updateIssueSchema.safeParse({
      executionWorkspaceSettings: {
        mode: "no_code",
        networkEgress: { allowCidrs: ["127.0.0.0/8"] },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) => issue.path.includes("allowCidrs")),
    ).toBe(true);
  });
});
