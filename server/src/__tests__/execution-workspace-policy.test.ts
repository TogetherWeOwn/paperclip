import { describe, expect, it } from "vitest";
import {
  issueExecutionWorkspaceSettingsSchema,
  projectExecutionWorkspacePolicySchema,
} from "@paperclipai/shared";
import {
  applyDefaultIsolatedExecutionWorkspacePolicy,
  buildExecutionWorkspaceAdapterConfig,
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  isUnrunnableWorktreeCombo,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  ManagedSandboxUnavailableError,
  mergeIssueAdapterConfigOverrides,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceEnvironmentId,
  resolvePinnedIssueWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
  resolveSharedWorkspaceConcurrency,
  selectEnvironmentExecutionWorkspaceSettings,
} from "../services/execution-workspace-policy.ts";

describe("execution workspace policy helpers", () => {
  it("defaults new issue settings from enabled project policy", () => {
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "isolated_workspace",
      }),
    ).toEqual({ mode: "isolated_workspace" });
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "shared_workspace",
      }),
    ).toEqual({ mode: "shared_workspace" });
    expect(defaultIssueExecutionWorkspaceSettingsForProject(null)).toBeNull();
  });

  it("prefers explicit issue mode over project policy and legacy overrides", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
        issueSettings: { mode: "isolated_workspace" },
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
  });

  it("resolves shared-workspace concurrency from issue override, project policy, then auto", () => {
    expect(
      resolveSharedWorkspaceConcurrency({
        projectPolicy: { enabled: true, sharedWorkspaceConcurrency: "serialize" },
        issueSettings: { sharedWorkspaceConcurrency: "allow" },
      }),
    ).toBe("allow");
    expect(
      resolveSharedWorkspaceConcurrency({
        projectPolicy: { enabled: true, sharedWorkspaceConcurrency: "serialize" },
        issueSettings: null,
      }),
    ).toBe("serialize");
    expect(
      resolveSharedWorkspaceConcurrency({
        projectPolicy: { enabled: false, sharedWorkspaceConcurrency: "serialize" },
        issueSettings: null,
      }),
    ).toBe("auto");
    expect(resolveSharedWorkspaceConcurrency({ projectPolicy: null, issueSettings: null })).toBe("auto");
  });

  it("validates the shared-workspace concurrency enum on project and issue settings", () => {
    expect(projectExecutionWorkspacePolicySchema.parse({
      enabled: true,
      sharedWorkspaceConcurrency: "auto",
    }).sharedWorkspaceConcurrency).toBe("auto");
    expect(issueExecutionWorkspaceSettingsSchema.parse({
      sharedWorkspaceConcurrency: "allow",
    }).sharedWorkspaceConcurrency).toBe("allow");
    expect(projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      sharedWorkspaceConcurrency: "parallel",
    }).success).toBe(false);
  });

  it("accepts an existing-branch pin only with isolated mode and a git_worktree strategy", () => {
    expect(issueExecutionWorkspaceSettingsSchema.parse({
      mode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        existingBranch: "PAP-14380-salvage-pap-9514",
      },
    }).workspaceStrategy?.existingBranch).toBe("PAP-14380-salvage-pap-9514");

    // Fail closed at the contract layer: an exact-branch pin outside an
    // isolated git worktree could silently land in the shared checkout.
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      workspaceStrategy: { type: "git_worktree", existingBranch: "some-branch" },
    }).success).toBe(false);
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      mode: "shared_workspace",
      workspaceStrategy: { type: "git_worktree", existingBranch: "some-branch" },
    }).success).toBe(false);
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "project_primary", existingBranch: "some-branch" },
    }).success).toBe(false);
    expect(issueExecutionWorkspaceSettingsSchema.safeParse({
      mode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        existingBranch: "some-branch",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    }).success).toBe(false);

    for (const invalidBranch of ["-leading-dash", "a..b", "has space", "ends/", "back\\slash", "a.lock", "../escape"]) {
      expect(issueExecutionWorkspaceSettingsSchema.safeParse({
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree", existingBranch: invalidBranch },
      }).success).toBe(false);
    }
  });

  it("carries the existing-branch pin through issue settings parsing", () => {
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree", existingBranch: " PAP-14754-run-redaction " },
      })?.workspaceStrategy,
    ).toEqual({ type: "git_worktree", existingBranch: "PAP-14754-run-redaction" });
  });

  it("centralizes unrunnable isolated worktree detection", () => {
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(true);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: "project-1",
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: "workspace-1",
          executionWorkspacePreference: "reuse_existing",
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "shared_workspace",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "agent_default",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(false);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "operator_branch",
        resolvedStrategy: "git_worktree",
      }),
    ).toBe(true);
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: "isolated_workspace",
        resolvedStrategy: "git_worktree",
        hasResolvablePriorSessionWorkspace: true,
      }),
    ).toBe(false);
  });

  it("mirrors runtime default (project_primary) when pinned settings omit strategy type", () => {
    // Mode-only pin without explicit workspaceStrategy.type → same project_primary default as runtime.
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: { mode: "isolated_workspace" },
      }),
    ).toBe("project_primary");
    // Explicit strategy type is always respected.
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
      }),
    ).toBe("git_worktree");
    expect(
      resolvePinnedIssueWorkspaceStrategyType({
        mode: "isolated_workspace",
        issueSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "project_primary" },
        },
      }),
    ).toBe("project_primary");
  });

  it("falls back to project policy before legacy project-workspace compatibility flag", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: null,
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("agent_default");
  });

  it("applies project policy strategy and runtime defaults when isolation is enabled", () => {
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: { type: "project_primary" },
      },
      projectPolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/main",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
        },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
      issueSettings: null,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });

    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "origin/main",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
      runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "web", command: "pnpm dev" }],
    });
  });

  describe("partial issue workspace strategies", () => {
    const projectStrategy = {
      type: "git_worktree" as const,
      baseRef: "origin/main",
      branchTemplate: "{{issue.identifier}}-{{slug}}",
      worktreeParentDir: ".paperclip/worktrees",
      provisionCommand: "true",
      runtimeProvisionCommand: "npm run setup:runtime",
      teardownCommand: "npm run teardown",
    };

    function resolveStrategy(
      strategy: Record<string, unknown>,
      enabled = true,
    ) {
      return buildExecutionWorkspaceAdapterConfig({
        agentConfig: { workspaceStrategy: { type: "git_worktree", provisionCommand: "agent-setup" } },
        projectPolicy: parseProjectExecutionWorkspacePolicy({
          enabled,
          defaultMode: "isolated_workspace",
          workspaceStrategy: projectStrategy,
        }),
        issueSettings: parseIssueExecutionWorkspaceSettings({
          mode: "isolated_workspace",
          workspaceStrategy: strategy,
        }),
        mode: "isolated_workspace",
        legacyUseProjectWorkspace: null,
      }).workspaceStrategy;
    }

    it("retains project hooks when an issue changes only its base branch", () => {
      expect(resolveStrategy({ type: "git_worktree", baseRef: "origin/release" })).toEqual({
        ...projectStrategy,
        baseRef: "origin/release",
      });
    });

    it.each(["npm run issue-setup", "", null])("honors an explicit provisioning override of %j", (provisionCommand) => {
      expect(resolveStrategy({ type: "git_worktree", provisionCommand })).toEqual({
        ...projectStrategy,
        provisionCommand,
      });
    });

    it("preserves explicit null clears through persisted JSON parsing", () => {
      const strategy = {
        type: "git_worktree",
        baseRef: null,
        branchTemplate: null,
        worktreeParentDir: null,
        provisionCommand: null,
        runtimeProvisionCommand: null,
        teardownCommand: null,
      };
      expect(resolveStrategy(strategy)).toEqual(strategy);
    });

    it.each(["cloud_sandbox", "adapter_managed", "project_primary"])("does not carry project hooks into %s", (type) => {
      expect(resolveStrategy({ type })).toEqual({ type });
    });

    it("does not inherit a disabled project strategy", () => {
      expect(resolveStrategy({ type: "git_worktree", baseRef: "origin/release" }, false)).toEqual({
        type: "git_worktree",
        baseRef: "origin/release",
      });
      expect(resolveStrategy({}, false)).toEqual({
        type: "git_worktree",
        provisionCommand: "agent-setup",
      });
    });

    it("keeps project hooks for an exact branch pin without inheriting a branch template", () => {
      const resolved = resolveStrategy({ type: "git_worktree", existingBranch: "fix/existing" });
      expect(resolved).toEqual({
        ...projectStrategy,
        branchTemplate: undefined,
        existingBranch: "fix/existing",
      });
      expect(issueExecutionWorkspaceSettingsSchema.safeParse({
        mode: "isolated_workspace",
        workspaceStrategy: resolved,
      }).success).toBe(true);
    });

    it("does not mutate the project or issue strategy", () => {
      const issueStrategy = { type: "git_worktree" as const, baseRef: "origin/release" };
      const result = buildExecutionWorkspaceAdapterConfig({
        agentConfig: {},
        projectPolicy: { enabled: true, workspaceStrategy: Object.freeze({ ...projectStrategy }) },
        issueSettings: { workspaceStrategy: Object.freeze(issueStrategy) },
        mode: "isolated_workspace",
        legacyUseProjectWorkspace: null,
      });
      expect(result.workspaceStrategy).not.toBe(issueStrategy);
      expect(issueStrategy).toEqual({ type: "git_worktree", baseRef: "origin/release" });
      expect(projectStrategy.baseRef).toBe("origin/main");
    });
  });

  it("preserves project authorization policy for trust-preset resolution", () => {
    expect(parseProjectExecutionWorkspacePolicy({
      enabled: true,
      authorizationPolicy: {
        trustBoundary: {
          mode: "low_trust_review",
          projectIds: ["33333333-3333-4333-8333-333333333333"],
        },
      },
    })?.authorizationPolicy).toEqual({
      trustBoundary: {
        mode: "low_trust_review",
        projectIds: ["33333333-3333-4333-8333-333333333333"],
      },
    });
  });

  it("clears managed workspace strategy when issue opts out to project primary or agent default", () => {
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" },
      workspaceRuntime: { services: [{ name: "web" }] },
    };

    expect(
      buildExecutionWorkspaceAdapterConfig({
        agentConfig: baseConfig,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: { mode: "shared_workspace" },
        mode: "shared_workspace",
        legacyUseProjectWorkspace: null,
      }).workspaceStrategy,
    ).toBeUndefined();

    const agentDefault = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: { mode: "agent_default" },
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });
    expect(agentDefault.workspaceStrategy).toBeUndefined();
    expect(agentDefault.workspaceRuntime).toBeUndefined();
  });

  it("parses persisted JSON payloads into typed project and issue workspace settings", () => {
    expect(
      parseProjectExecutionWorkspacePolicy({
        enabled: true,
        sharedWorkspaceConcurrency: "serialize",
        defaultMode: "isolated",
        workspaceStrategy: {
          type: "git_worktree",
          worktreeParentDir: ".paperclip/worktrees",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
          teardownCommand: "bash ./scripts/teardown-worktree.sh",
        },
      }),
    ).toEqual({
      enabled: true,
      sharedWorkspaceConcurrency: "serialize",
      defaultMode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        worktreeParentDir: ".paperclip/worktrees",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
      },
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "project_primary",
        environmentId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      mode: "shared_workspace",
    });
    expect(
      parseIssueExecutionWorkspaceSettings(
        {
          mode: "project_primary",
          environmentId: "11111111-1111-4111-8111-111111111111",
        },
        { includeEnvironmentId: true },
      ),
    ).toEqual({
      mode: "shared_workspace",
      environmentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "isolated_workspace",
        sharedWorkspaceConcurrency: "allow",
        networkEgress: {
          allowFqdns: ["github.com", "pypi.org"],
          allowCidrs: ["203.0.113.0/24"],
        },
      }),
    ).toEqual({
      mode: "isolated_workspace",
      sharedWorkspaceConcurrency: "allow",
      networkEgress: {
        allowFqdns: ["github.com", "pypi.org"],
        allowCidrs: ["203.0.113.0/24"],
      },
    });
  });

  it("keeps egress grants independent from isolated workspace mode", () => {
    const parsedSettings = {
      mode: "isolated_workspace" as const,
      workspaceRuntime: { image: "example/image" },
      networkEgress: {
        allowFqdns: ["github.com"],
        allowCidrs: ["203.0.113.0/24"],
      },
    };

    expect(selectEnvironmentExecutionWorkspaceSettings(parsedSettings, false)).toEqual({
      networkEgress: parsedSettings.networkEgress,
    });
    expect(selectEnvironmentExecutionWorkspaceSettings(parsedSettings, true)).toEqual(parsedSettings);
    expect(selectEnvironmentExecutionWorkspaceSettings({ mode: "isolated_workspace" }, false)).toBeNull();
  });

  it("prefers the agent default environment", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "agent-env",
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "agent-env",
      source: "agent",
    });
  });

  it("falls back to the instance default environment when the agent has none", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: "instance-env",
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "instance-env",
      source: "instance",
    });
  });

  it("falls back to the built-in local environment when neither agent nor instance selects one", () => {
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
      }),
    ).toEqual({
      environmentId: "local-env",
      source: "default",
    });
  });

  it("redirects local-landing selections to the managed sandbox under managed-sandbox-only", () => {
    // The default fallback and an explicit local selection both land on the
    // managed environment; a non-local selection stays untouched.
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toEqual({ environmentId: "managed-env", source: "managed" });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "local-env",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toEqual({ environmentId: "managed-env", source: "managed" });
    expect(
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: "ssh-env",
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: "managed-env",
      }),
    ).toEqual({ environmentId: "ssh-env", source: "agent" });
  });

  it("fails closed — never local — when managed-sandbox-only has no managed environment", () => {
    expect(() =>
      resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: null,
        localDefaultEnvironmentId: "local-env",
        managedSandboxOnly: true,
        managedSandboxEnvironmentId: null,
      }),
    ).toThrow(ManagedSandboxUnavailableError);
  });

  it("maps persisted execution workspace modes back to issue settings", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("isolated_workspace")).toBe("isolated_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("operator_branch")).toBe("operator_branch");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("shared_workspace")).toBe("shared_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("adapter_managed")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("cloud_sandbox")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(null)).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(undefined)).toBe("agent_default");
  });

  it("disables project execution workspace policy when the instance flag is off", () => {
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        false,
      ),
    ).toBeNull();
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        true,
      ),
    ).toEqual({ enabled: true, defaultMode: "isolated_workspace" });
  });
});

describe("operator default isolated execution workspaces", () => {
  const withDefault = (
    projectPolicy: Parameters<
      typeof applyDefaultIsolatedExecutionWorkspacePolicy
    >[0]["projectPolicy"],
    hasProjectWorkspace = true,
    defaultIsolatedWorkspacesEnabled = true,
  ) =>
    applyDefaultIsolatedExecutionWorkspacePolicy({
      projectPolicy,
      defaultIsolatedWorkspacesEnabled,
      hasProjectWorkspace,
    });

  it("substitutes an isolated policy for a project that stores none", () => {
    expect(withDefault(null)).toEqual({
      enabled: true,
      defaultMode: "isolated_workspace",
    });
  });

  it("leaves everything alone while the operator default is off", () => {
    expect(withDefault(null, true, false)).toBeNull();
  });

  it("keeps a task that has no project on its existing behavior", () => {
    // Isolation needs a repository to cut a worktree from. A project-less task
    // (agent chat, for example) must not be pulled into worktree mode.
    expect(withDefault(null, false)).toBeNull();
  });

  it("keeps a project without a configured workspace on its existing behavior", () => {
    const projectPolicy = withDefault(null, false);
    expect(projectPolicy).toBeNull();
    expect(resolveExecutionWorkspaceMode({
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    })).toBe("shared_workspace");
    expect(withDefault({ enabled: true, defaultMode: "isolated_workspace" }, false))
      .toEqual({ enabled: true, defaultMode: "isolated_workspace" });
  });

  it("never overrides a policy the project already stores", () => {
    expect(withDefault({ enabled: true, defaultMode: "shared_workspace" })).toEqual({
      enabled: true,
      defaultMode: "shared_workspace",
    });
    // `enabled: false` is a tenant decision to stay on the shared checkout,
    // not an absent policy to fill in.
    expect(withDefault({ enabled: false })).toEqual({ enabled: false });
  });

  it("resolves an unpolicied project's tasks to an isolated workspace", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: withDefault(null),
        issueSettings: null,
        legacyUseProjectWorkspace: null,
      }),
    ).toBe("isolated_workspace");
  });

  it("still lets an explicit issue setting win over the operator default", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: withDefault(null),
        issueSettings: { mode: "shared_workspace" },
        legacyUseProjectWorkspace: null,
      }),
    ).toBe("shared_workspace");
  });

  it("keeps mode and strategy coherent for the substituted policy", () => {
    // Substituting a policy (rather than moving the terminal fallback) is what
    // makes `hasWorkspaceControl` true, so the default git_worktree strategy is
    // supplied instead of leaving isolated mode on a project_primary strategy.
    const projectPolicy = withDefault(null);
    const mode = resolveExecutionWorkspaceMode({
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });
    const config = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy,
      issueSettings: null,
      mode,
      legacyUseProjectWorkspace: null,
    });
    expect(resolveEffectiveWorkspaceStrategyType(mode, config)).toBe("git_worktree");
  });

  it("does not strand a project-less task as an unrunnable worktree", () => {
    const projectPolicy = withDefault(null, false);
    const mode = resolveExecutionWorkspaceMode({
      projectPolicy,
      issueSettings: null,
      legacyUseProjectWorkspace: null,
    });
    const config = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy,
      issueSettings: null,
      mode,
      legacyUseProjectWorkspace: null,
    });
    expect(
      isUnrunnableWorktreeCombo({
        issue: {
          projectId: null,
          projectWorkspaceId: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
        },
        resolvedMode: mode,
        resolvedStrategy: resolveEffectiveWorkspaceStrategyType(mode, config),
      }),
    ).toBe(false);
  });

  it("merges issue override env per key over the base agent env", () => {
    const secretRef = { type: "secret_ref", secretId: "sec-1" };
    const merged = mergeIssueAdapterConfigOverrides(
      {
        model: "base-model",
        env: { KEEP_ME: secretRef, SHARED: "base" },
      },
      {
        model: "override-model",
        env: { ADDED: "new", SHARED: "override" },
      },
    );
    // 1. override env adds a key
    expect((merged.env as Record<string, unknown>).ADDED).toBe("new");
    // 2. override env shadows a base key
    expect((merged.env as Record<string, unknown>).SHARED).toBe("override");
    // 3. a base secret_ref survives an override that omits it
    expect((merged.env as Record<string, unknown>).KEEP_ME).toEqual(secretRef);
    // other keys keep shallow replace semantics
    expect(merged.model).toBe("override-model");
  });

  it("does not mutate the base or override config", () => {
    const base = { env: { A: "1" } };
    const override = { env: { B: "2" } };
    const merged = mergeIssueAdapterConfigOverrides(base, override);
    expect(merged.env).toEqual({ A: "1", B: "2" });
    expect(base.env).toEqual({ A: "1" });
    expect(override.env).toEqual({ B: "2" });
  });

  it("leaves env alone when the override carries none", () => {
    const merged = mergeIssueAdapterConfigOverrides(
      { model: "base", env: { A: "1" } },
      { model: "override" },
    );
    expect(merged.env).toEqual({ A: "1" });
    expect(mergeIssueAdapterConfigOverrides({ model: "base" }, null)).toEqual({
      model: "base",
    });
  });

  it("preserves an explicit null env as a clearing operation", () => {
    const merged = mergeIssueAdapterConfigOverrides(
      {
        model: "base",
        env: { API_TOKEN: { type: "secret_ref", secretId: "sec-1" } },
      },
      { model: "override", env: null },
    );
    // The clearing value survives the merge instead of gaining every base key
    // back. Downstream resolution maps a non-object env to `{}` with zero
    // inherited bindings, matching the previous spread behavior.
    expect("env" in merged).toBe(true);
    expect(merged.env).toBeNull();
    expect(merged.model).toBe("override");
  });

  it("preserves a non-object env instead of merging the base back over it", () => {
    expect(
      mergeIssueAdapterConfigOverrides({ env: { A: "1" } }, { env: "not-an-object" }).env,
    ).toBe("not-an-object");
    expect(
      mergeIssueAdapterConfigOverrides({ env: { A: "1" } }, { env: ["A"] }).env,
    ).toEqual(["A"]);
  });

  it("rejects an override key that differs only by case from a base key", () => {
    expect(() =>
      mergeIssueAdapterConfigOverrides(
        { env: { API_TOKEN: { type: "secret_ref", secretId: "old" } } },
        { env: { api_token: "replacement" } },
      ),
    ).toThrow(/conflicts with agent env key "API_TOKEN"/);
  });

  it("keeps exact-match shadowing and unrelated keys case-sensitive", () => {
    const merged = mergeIssueAdapterConfigOverrides(
      { env: { API_TOKEN: "base", OTHER: "x" } },
      { env: { API_TOKEN: "override", UNRELATED: "y" } },
    );
    expect(merged.env).toEqual({
      API_TOKEN: "override",
      OTHER: "x",
      UNRELATED: "y",
    });
  });

  it("fails a case-variant alias at the merge boundary before secret resolution", () => {
    // Mirrors the secret resolver: every merged entry is validated and an
    // unavailable secret_ref fails the run. The launch layer would fold the
    // alias pair on case-insensitive targets (Windows), so the shadowed
    // binding must never reach resolution.
    const resolveEnvForTest = (env: unknown): Record<string, string> => {
      const record =
        typeof env === "object" && env !== null && !Array.isArray(env)
          ? (env as Record<string, unknown>)
          : null;
      if (!record) return {};
      const out: Record<string, string> = {};
      for (const [key, binding] of Object.entries(record)) {
        if (typeof binding === "object" && binding !== null && "secretId" in binding) {
          throw new Error(`unavailable secret for ${key}`);
        }
        out[key] = String(binding);
      }
      return out;
    };
    const base = {
      env: { API_TOKEN: { type: "secret_ref", secretId: "unavailable" } },
    };
    const override = { env: { api_token: "replacement" } };
    // The merge rejects the ambiguous alias before any binding is resolved.
    expect(() => mergeIssueAdapterConfigOverrides(base, override)).toThrow(
      /conflicts with agent env key "API_TOKEN"/,
    );
    // Without the guard, the shadowed binding would reach resolution and fail
    // the run there with an unavailable-secret error instead of the alias error.
    const unguarded = { ...(base.env as Record<string, unknown>), ...(override.env as Record<string, unknown>) };
    expect(() => resolveEnvForTest(unguarded)).toThrow(
      /unavailable secret for API_TOKEN/,
    );
  });

  it("rejects an override when the base carries several spellings, in either base order", () => {
    const override = { env: { API_TOKEN: "replacement" } };
    const firstOrder = {
      env: {
        API_TOKEN: "base",
        api_token: { type: "secret_ref", secretId: "old" },
      },
    };
    const secondOrder = {
      env: {
        api_token: { type: "secret_ref", secretId: "old" },
        API_TOKEN: "base",
      },
    };
    // The first spelling matches exactly, but the second inherited alias
    // would survive the merge and shadow the replacement. Both base orders
    // reject with the same deterministic error.
    for (const base of [firstOrder, secondOrder]) {
      expect(() => mergeIssueAdapterConfigOverrides(base, override)).toThrow(
        /conflicts with agent env keys "API_TOKEN", "api_token"/,
      );
    }
  });

  it("rejects an exact override when the base carries another spelling", () => {
    const base = { env: { API_TOKEN: "one", api_token: "two" } };
    // Overriding the second spelling exactly still leaves the first alias
    // behind, so the contract rejects instead of replacing half the group.
    expect(() => mergeIssueAdapterConfigOverrides(base, { env: { api_token: "x" } })).toThrow(
      /conflicts with agent env keys "API_TOKEN", "api_token"/,
    );
  });

  it("rejects before resolution when another spelling holds an unavailable reference", () => {
    const resolveEnvForTest = (env: unknown): Record<string, string> => {
      const record =
        typeof env === "object" && env !== null && !Array.isArray(env)
          ? (env as Record<string, unknown>)
          : null;
      if (!record) return {};
      const out: Record<string, string> = {};
      for (const [key, binding] of Object.entries(record)) {
        if (typeof binding === "object" && binding !== null && "secretId" in binding) {
          throw new Error(`unavailable secret for ${key}`);
        }
        out[key] = String(binding);
      }
      return out;
    };
    const base = {
      env: {
        API_TOKEN: "base",
        api_token: { type: "secret_ref", secretId: "unavailable" },
      },
    };
    const override = { env: { API_TOKEN: "replacement" } };
    // The merge rejects the ambiguous group before any binding is resolved.
    expect(() => mergeIssueAdapterConfigOverrides(base, override)).toThrow(
      /conflicts with agent env keys "API_TOKEN", "api_token"/,
    );
    // Without the guard, the retained lowercase reference reaches resolution
    // and fails the run there instead of at the merge boundary.
    const unguarded = { ...(base.env as Record<string, unknown>), ...(override.env as Record<string, unknown>) };
    expect(() => resolveEnvForTest(unguarded)).toThrow(
      /unavailable secret for api_token/,
    );
  });

  it("never lets an inherited alias win the Windows fold over a replacement", () => {
    // Test-local mirror of case-insensitive targets: later entries win the
    // fold, so an inherited lowercase alias overwrites the replacement.
    const foldForWindowsForTest = (env: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(env)) out[key.toUpperCase()] = value;
      return out;
    };
    const base = { env: { API_TOKEN: "base", api_token: "shadow" } };
    const override = { env: { API_TOKEN: "replacement" } };
    const unguarded = { ...(base.env as Record<string, unknown>), ...(override.env as Record<string, unknown>) };
    expect(foldForWindowsForTest(unguarded)).toEqual({ API_TOKEN: "shadow" });
    // The guard rejects the ambiguous group, so the losing fold is
    // unreachable through the merge.
    expect(() => mergeIssueAdapterConfigOverrides(base, override)).toThrow(
      /conflicts with agent env keys "API_TOKEN", "api_token"/,
    );
  });
});
