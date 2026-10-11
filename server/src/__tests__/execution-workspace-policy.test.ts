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

  describe("low-trust sandbox designation", () => {
    const base = {
      agentDefaultEnvironmentId: null,
      instanceDefaultEnvironmentId: null,
      localDefaultEnvironmentId: "local-env",
      lowTrustSandboxEnvironmentId: "low-trust-env",
    };

    it("redirects a low-trust run that would land on local to the designated sandbox", () => {
      expect(
        resolveExecutionWorkspaceEnvironmentId({ ...base, lowTrustReview: true }),
      ).toEqual({ environmentId: "low-trust-env", source: "low_trust_sandbox" });
      // An explicit local binding on the agent lands on local too.
      expect(
        resolveExecutionWorkspaceEnvironmentId({
          ...base,
          agentDefaultEnvironmentId: "local-env",
          lowTrustReview: true,
        }),
      ).toEqual({ environmentId: "low-trust-env", source: "low_trust_sandbox" });
    });

    it("leaves the selection on local without a designation so the low-trust gate fails closed", () => {
      expect(
        resolveExecutionWorkspaceEnvironmentId({
          ...base,
          lowTrustReview: true,
          lowTrustSandboxEnvironmentId: null,
        }),
      ).toEqual({ environmentId: "local-env", source: "default" });
      expect(
        resolveExecutionWorkspaceEnvironmentId({
          ...base,
          lowTrustReview: true,
          lowTrustSandboxEnvironmentId: undefined,
        }),
      ).toEqual({ environmentId: "local-env", source: "default" });
    });

    it("never moves a trusted run, whatever the designation", () => {
      expect(
        resolveExecutionWorkspaceEnvironmentId({ ...base, lowTrustReview: false }),
      ).toEqual({ environmentId: "local-env", source: "default" });
      expect(resolveExecutionWorkspaceEnvironmentId(base)).toEqual({
        environmentId: "local-env",
        source: "default",
      });
      expect(
        resolveExecutionWorkspaceEnvironmentId({
          ...base,
          agentDefaultEnvironmentId: "agent-env",
          instanceDefaultEnvironmentId: "instance-env",
        }),
      ).toEqual({ environmentId: "agent-env", source: "agent" });
    });

    it("keeps an explicit non-local binding on the low-trust run (the designation is a local-landing fallback)", () => {
      expect(
        resolveExecutionWorkspaceEnvironmentId({
          ...base,
          agentDefaultEnvironmentId: "agent-sandbox-env",
          lowTrustReview: true,
        }),
      ).toEqual({ environmentId: "agent-sandbox-env", source: "agent" });
      expect(
        resolveExecutionWorkspaceEnvironmentId({
          ...base,
          instanceDefaultEnvironmentId: "instance-env",
          lowTrustReview: true,
        }),
      ).toEqual({ environmentId: "instance-env", source: "instance" });
    });

    it("takes precedence over the managed-sandbox redirect, and leaves it in force when undesignated", () => {
      expect(
        resolveExecutionWorkspaceEnvironmentId({
          ...base,
          lowTrustReview: true,
          managedSandboxOnly: true,
          managedSandboxEnvironmentId: "managed-env",
        }),
      ).toEqual({ environmentId: "low-trust-env", source: "low_trust_sandbox" });
      expect(
        resolveExecutionWorkspaceEnvironmentId({
          ...base,
          lowTrustReview: true,
          lowTrustSandboxEnvironmentId: null,
          managedSandboxOnly: true,
          managedSandboxEnvironmentId: "managed-env",
        }),
      ).toEqual({ environmentId: "managed-env", source: "managed" });
      // A trusted run keeps the managed redirect, never the low-trust env.
      expect(
        resolveExecutionWorkspaceEnvironmentId({
          ...base,
          lowTrustReview: false,
          managedSandboxOnly: true,
          managedSandboxEnvironmentId: "managed-env",
        }),
      ).toEqual({ environmentId: "managed-env", source: "managed" });
    });
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

  it("merges issue override env per key over the base agent env (TOG-11791)", () => {
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

  it("restoring the shallow merge drops base env (mutation guard, TOG-11791)", () => {
    const secretRef = { type: "secret_ref", secretId: "sec-1" };
    const base = { env: { KEEP_ME: secretRef } };
    const override = { env: { ADDED: "new" } };
    // This is the old behaviour: a whole-object spread replaces env.
    const shallow = { ...base, ...override };
    expect((shallow.env as Record<string, unknown>).KEEP_ME).toBeUndefined();
    // The helper must not share that behaviour.
    const merged = mergeIssueAdapterConfigOverrides(base, override);
    expect((merged.env as Record<string, unknown>).KEEP_ME).toEqual(secretRef);
  });

  it("leaves env alone when the override carries none (TOG-11791)", () => {
    const merged = mergeIssueAdapterConfigOverrides(
      { model: "base", env: { A: "1" } },
      { model: "override" },
    );
    expect(merged.env).toEqual({ A: "1" });
    expect(mergeIssueAdapterConfigOverrides({ model: "base" }, null)).toEqual({
      model: "base",
    });
  });
});
