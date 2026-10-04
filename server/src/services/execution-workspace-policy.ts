import type {
  ExecutionWorkspaceMode,
  ExecutionWorkspaceStrategy,
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspaceDefaultMode,
  ProjectExecutionWorkspacePolicy,
  SharedWorkspaceConcurrency,
} from "@paperclipai/shared";
import { asString, parseObject } from "../adapters/utils.js";

export type ParsedExecutionWorkspaceMode = Exclude<ExecutionWorkspaceMode, "inherit" | "reuse_existing">;

export const WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE = "workspace_worktree_requires_project";
export const WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION =
  "Attach a project to the task, or bind a reusable execution workspace, then retry.";
export const WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE =
  `This task is set to run in an isolated git worktree, but it has no project and no reusable execution workspace to create the worktree from. ${WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION}`;

type WorkspaceStrategyType = ExecutionWorkspaceStrategy["type"];

export type UnrunnableWorktreeIssueRef = {
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
};

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  return { ...value };
}

function parseExecutionWorkspaceStrategy(raw: unknown): ExecutionWorkspaceStrategy | null {
  const parsed = parseObject(raw);
  const type = asString(parsed.type, "");
  if (type !== "project_primary" && type !== "git_worktree" && type !== "adapter_managed" && type !== "cloud_sandbox") {
    return null;
  }
  return {
    type,
    ...(typeof parsed.baseRef === "string" || parsed.baseRef === null ? { baseRef: parsed.baseRef } : {}),
    ...(typeof parsed.branchTemplate === "string" || parsed.branchTemplate === null ? { branchTemplate: parsed.branchTemplate } : {}),
    ...(typeof parsed.existingBranch === "string" && parsed.existingBranch.trim().length > 0
      ? { existingBranch: parsed.existingBranch.trim() }
      : {}),
    ...(typeof parsed.worktreeParentDir === "string" || parsed.worktreeParentDir === null ? { worktreeParentDir: parsed.worktreeParentDir } : {}),
    ...(typeof parsed.provisionCommand === "string" || parsed.provisionCommand === null ? { provisionCommand: parsed.provisionCommand } : {}),
    ...(typeof parsed.runtimeProvisionCommand === "string" || parsed.runtimeProvisionCommand === null
      ? { runtimeProvisionCommand: parsed.runtimeProvisionCommand }
      : {}),
    ...(typeof parsed.teardownCommand === "string" || parsed.teardownCommand === null ? { teardownCommand: parsed.teardownCommand } : {}),
  };
}

export function resolveEffectiveWorkspaceStrategyType(
  mode: ParsedExecutionWorkspaceMode,
  config: Record<string, unknown> | null | undefined,
): WorkspaceStrategyType {
  const workspaceStrategy = parseObject(config?.workspaceStrategy);
  const type = asString(workspaceStrategy.type, "");
  if (type === "project_primary" || type === "git_worktree" || type === "adapter_managed" || type === "cloud_sandbox") {
    return type;
  }
  // Default mirrors workspace-runtime.ts realizeExecutionWorkspace: missing type -> "project_primary".
  // agent_default is a metadata-only mode that never creates a worktree, so it keeps "adapter_managed".
  return mode === "agent_default" ? "adapter_managed" : "project_primary";
}

export function resolvePinnedIssueWorkspaceStrategyType(input: {
  mode: ParsedExecutionWorkspaceMode;
  issueSettings: IssueExecutionWorkspaceSettings | null;
}): WorkspaceStrategyType {
  const strategyType = input.issueSettings?.workspaceStrategy?.type;
  if (
    strategyType === "project_primary" ||
    strategyType === "git_worktree" ||
    strategyType === "adapter_managed" ||
    strategyType === "cloud_sandbox"
  ) {
    return strategyType;
  }
  // When no explicit strategy type is set, mirror the runtime default (project_primary for most
  // modes; adapter_managed for agent_default). Mode alone never implies git_worktree.
  return input.mode === "agent_default" ? "adapter_managed" : "project_primary";
}

export function hasReusableExecutionWorkspaceBinding(issue: UnrunnableWorktreeIssueRef): boolean {
  return Boolean(issue.executionWorkspaceId && issue.executionWorkspacePreference === "reuse_existing");
}

export function isUnrunnableWorktreeCombo(input: {
  issue: UnrunnableWorktreeIssueRef;
  resolvedMode: ParsedExecutionWorkspaceMode;
  resolvedStrategy: string | null | undefined;
  reusableExecutionWorkspaceAvailable?: boolean | null;
  hasResolvablePriorSessionWorkspace?: boolean | null;
}): boolean {
  if (input.resolvedMode !== "isolated_workspace" && input.resolvedMode !== "operator_branch") return false;
  if (input.resolvedStrategy !== "git_worktree") return false;
  if (input.issue.projectId || input.issue.projectWorkspaceId) return false;
  const hasReusableWorkspace =
    input.reusableExecutionWorkspaceAvailable ?? hasReusableExecutionWorkspaceBinding(input.issue);
  if (hasReusableWorkspace) return false;
  return input.hasResolvablePriorSessionWorkspace !== true;
}

export function parseProjectExecutionWorkspacePolicy(raw: unknown): ProjectExecutionWorkspacePolicy | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : false;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const defaultMode = asString(parsed.defaultMode, "");
  const defaultProjectWorkspaceId =
    typeof parsed.defaultProjectWorkspaceId === "string" ? parsed.defaultProjectWorkspaceId : undefined;
  const allowIssueOverride =
    typeof parsed.allowIssueOverride === "boolean" ? parsed.allowIssueOverride : undefined;
  const sharedWorkspaceConcurrency = parseSharedWorkspaceConcurrency(parsed.sharedWorkspaceConcurrency);
  const normalizedDefaultMode = (() => {
    if (
      defaultMode === "shared_workspace" ||
      defaultMode === "isolated_workspace" ||
      defaultMode === "operator_branch" ||
      defaultMode === "adapter_default"
    ) {
      return defaultMode as ProjectExecutionWorkspaceDefaultMode;
    }
    if (defaultMode === "project_primary") return "shared_workspace";
    if (defaultMode === "isolated") return "isolated_workspace";
    return undefined;
  })();
  return {
    enabled,
    ...(sharedWorkspaceConcurrency ? { sharedWorkspaceConcurrency } : {}),
    ...(normalizedDefaultMode ? { defaultMode: normalizedDefaultMode } : {}),
    ...(allowIssueOverride !== undefined ? { allowIssueOverride } : {}),
    ...(defaultProjectWorkspaceId ? { defaultProjectWorkspaceId } : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
    ...(parsed.branchPolicy && typeof parsed.branchPolicy === "object" && !Array.isArray(parsed.branchPolicy)
      ? { branchPolicy: { ...(parsed.branchPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.pullRequestPolicy && typeof parsed.pullRequestPolicy === "object" && !Array.isArray(parsed.pullRequestPolicy)
      ? { pullRequestPolicy: { ...(parsed.pullRequestPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.runtimePolicy && typeof parsed.runtimePolicy === "object" && !Array.isArray(parsed.runtimePolicy)
      ? { runtimePolicy: { ...(parsed.runtimePolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.cleanupPolicy && typeof parsed.cleanupPolicy === "object" && !Array.isArray(parsed.cleanupPolicy)
      ? { cleanupPolicy: { ...(parsed.cleanupPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.authorizationPolicy && typeof parsed.authorizationPolicy === "object" && !Array.isArray(parsed.authorizationPolicy)
      ? { authorizationPolicy: { ...(parsed.authorizationPolicy as Record<string, unknown>) } }
      : {}),
  };
}

export function gateProjectExecutionWorkspacePolicy(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
  isolatedWorkspacesEnabled: boolean,
): ProjectExecutionWorkspacePolicy | null {
  if (!isolatedWorkspacesEnabled) return null;
  return projectPolicy;
}

/**
 * Operator default: a project with a configured workspace and no policy of its
 * own runs its tasks in an isolated per-task worktree.
 *
 * This substitutes a policy rather than moving the terminal fallback in
 * `resolveExecutionWorkspaceMode`, and the distinction is load-bearing:
 *
 * - A task with no project must keep its existing behavior. Isolation needs a
 *   repository to cut a worktree from, and `isUnrunnableWorktreeCombo` blocks
 *   an isolated + `git_worktree` task that has neither `projectId` nor
 *   `projectWorkspaceId`. Moving the terminal fallback would resolve isolated
 *   for project-less tasks (agent chat, for example) and strand them before
 *   dispatch. A project without a configured workspace also uses a plain
 *   managed directory, not a Git checkout. `hasProjectWorkspace` keeps both
 *   cases on their existing path; configured checkouts are still validated
 *   before a worktree is created.
 * - `buildExecutionWorkspaceAdapterConfig` only supplies the default
 *   `git_worktree` strategy when some layer actually asserts workspace
 *   control. A moved fallback would leave `hasWorkspaceControl` false and
 *   produce isolated mode carrying a `project_primary` strategy — a
 *   combination no caller expects. Substituting a real policy makes
 *   `projectHasPolicy` true, so mode and strategy stay coherent.
 *
 * A stored project policy always wins, including one that is explicitly
 * disabled: `parseProjectExecutionWorkspacePolicy` returns `enabled: false`
 * for a blob that never opted in, and that is a tenant decision to stay on the
 * shared checkout, not an absent one to fill in.
 */
export function applyDefaultIsolatedExecutionWorkspacePolicy(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  defaultIsolatedWorkspacesEnabled: boolean;
  hasProjectWorkspace: boolean;
}): ProjectExecutionWorkspacePolicy | null {
  if (!input.defaultIsolatedWorkspacesEnabled) return input.projectPolicy;
  if (!input.hasProjectWorkspace) return input.projectPolicy;
  if (input.projectPolicy) return input.projectPolicy;
  return { enabled: true, defaultMode: "isolated_workspace" };
}

type ParseIssueExecutionWorkspaceSettingsOptions = {
  includeEnvironmentId?: boolean;
};

export function parseIssueExecutionWorkspaceSettings(
  raw: unknown,
  options: ParseIssueExecutionWorkspaceSettingsOptions = {},
): IssueExecutionWorkspaceSettings | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const sharedWorkspaceConcurrency = parseSharedWorkspaceConcurrency(parsed.sharedWorkspaceConcurrency);
  const mode = asString(parsed.mode, "");
  const normalizedMode = (() => {
    if (
      mode === "inherit" ||
      mode === "shared_workspace" ||
      mode === "isolated_workspace" ||
      mode === "operator_branch" ||
      mode === "reuse_existing" ||
      mode === "agent_default"
    ) {
      return mode;
    }
    if (mode === "project_primary") return "shared_workspace";
    if (mode === "isolated") return "isolated_workspace";
    return "";
  })();
  const networkEgress = parseObject(parsed.networkEgress);
  const allowFqdns = Array.isArray(networkEgress.allowFqdns)
    ? networkEgress.allowFqdns
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase())
    : [];
  const allowCidrs = Array.isArray(networkEgress.allowCidrs)
    ? networkEgress.allowCidrs
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  return {
    ...(normalizedMode
      ? { mode: normalizedMode as IssueExecutionWorkspaceSettings["mode"] }
      : {}),
    ...(sharedWorkspaceConcurrency ? { sharedWorkspaceConcurrency } : {}),
    ...(options.includeEnvironmentId && (typeof parsed.environmentId === "string" || parsed.environmentId === null)
      ? { environmentId: parsed.environmentId }
      : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
    ...(allowFqdns.length > 0 || allowCidrs.length > 0
      ? { networkEgress: { allowFqdns, allowCidrs } }
      : {}),
  };
}

export function selectEnvironmentExecutionWorkspaceSettings(
  parsedSettings: IssueExecutionWorkspaceSettings | null,
  isolatedWorkspacesEnabled: boolean,
): IssueExecutionWorkspaceSettings | null {
  if (!parsedSettings) return null;
  if (isolatedWorkspacesEnabled) return parsedSettings;
  return parsedSettings.networkEgress
    ? { networkEgress: parsedSettings.networkEgress }
    : null;
}

export type ExecutionWorkspaceEnvironmentSource =
  | "agent"
  | "instance"
  | "default"
  | "managed";

export type ExecutionWorkspaceEnvironmentResolution = {
  environmentId: string;
  source: ExecutionWorkspaceEnvironmentSource;
};

export class ManagedSandboxUnavailableError extends Error {
  constructor() {
    super(
      "This instance runs agents only in its platform-managed sandbox environment " +
        "(managed sandbox only), but no active managed sandbox environment exists — " +
        "its provider plugin may be unavailable. Refusing to fall back to local execution.",
    );
    this.name = "ManagedSandboxUnavailableError";
  }
}

export function resolveExecutionWorkspaceEnvironmentId(input: {
  agentDefaultEnvironmentId: string | null;
  instanceDefaultEnvironmentId: string | null;
  localDefaultEnvironmentId: string;
  /**
   * Managed-sandbox-only policy (`enableManagedSandboxOnly`): any selection
   * that lands on the local environment is redirected to the managed
   * sandbox environment instead, and with no managed environment available
   * the resolution fails closed — never local. Non-local selections (ssh,
   * user-created sandboxes) are untouched: the policy hides local, it does
   * not forbid other environments.
   */
  managedSandboxOnly?: boolean;
  managedSandboxEnvironmentId?: string | null;
}): ExecutionWorkspaceEnvironmentResolution {
  const resolved = ((): ExecutionWorkspaceEnvironmentResolution => {
    if (input.agentDefaultEnvironmentId) {
      return {
        environmentId: input.agentDefaultEnvironmentId,
        source: "agent",
      };
    }
    if (input.instanceDefaultEnvironmentId) {
      return {
        environmentId: input.instanceDefaultEnvironmentId,
        source: "instance",
      };
    }
    return {
      environmentId: input.localDefaultEnvironmentId,
      source: "default",
    };
  })();
  if (input.managedSandboxOnly !== true || resolved.environmentId !== input.localDefaultEnvironmentId) {
    return resolved;
  }
  if (!input.managedSandboxEnvironmentId) {
    throw new ManagedSandboxUnavailableError();
  }
  return { environmentId: input.managedSandboxEnvironmentId, source: "managed" };
}

export function defaultIssueExecutionWorkspaceSettingsForProject(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
): IssueExecutionWorkspaceSettings | null {
  if (!projectPolicy?.enabled) return null;
  return {
    mode:
      projectPolicy.defaultMode === "isolated_workspace"
        ? "isolated_workspace"
        : projectPolicy.defaultMode === "operator_branch"
          ? "operator_branch"
          : projectPolicy.defaultMode === "adapter_default"
            ? "agent_default"
            : "shared_workspace",
  };
}

export function issueExecutionWorkspaceModeForPersistedWorkspace(
  mode: string | null | undefined,
): IssueExecutionWorkspaceSettings["mode"] {
  if (mode === null || mode === undefined) {
    return "agent_default";
  }
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") {
    return mode;
  }
  if (mode === "adapter_managed" || mode === "cloud_sandbox") {
    return "agent_default";
  }
  return "shared_workspace";
}

export function resolveExecutionWorkspaceMode(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  legacyUseProjectWorkspace: boolean | null;
}): ParsedExecutionWorkspaceMode {
  const issueMode = input.issueSettings?.mode;
  if (issueMode && issueMode !== "inherit" && issueMode !== "reuse_existing") {
    return issueMode;
  }
  if (input.projectPolicy?.enabled) {
    if (input.projectPolicy.defaultMode === "isolated_workspace") return "isolated_workspace";
    if (input.projectPolicy.defaultMode === "operator_branch") return "operator_branch";
    if (input.projectPolicy.defaultMode === "adapter_default") return "agent_default";
    return "shared_workspace";
  }
  if (input.legacyUseProjectWorkspace === false) {
    return "agent_default";
  }
  return "shared_workspace";
}

function parseSharedWorkspaceConcurrency(raw: unknown): SharedWorkspaceConcurrency | undefined {
  return raw === "auto" || raw === "serialize" || raw === "allow" ? raw : undefined;
}

export function resolveSharedWorkspaceConcurrency(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
}): SharedWorkspaceConcurrency {
  return input.issueSettings?.sharedWorkspaceConcurrency
    ?? (input.projectPolicy?.enabled ? input.projectPolicy.sharedWorkspaceConcurrency : undefined)
    ?? "auto";
}

export function buildExecutionWorkspaceAdapterConfig(input: {
  agentConfig: Record<string, unknown>;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  mode: ParsedExecutionWorkspaceMode;
  legacyUseProjectWorkspace: boolean | null;
}): Record<string, unknown> {
  const nextConfig = { ...input.agentConfig };
  const projectHasPolicy = Boolean(input.projectPolicy?.enabled);
  const issueHasWorkspaceOverrides = Boolean(
    input.issueSettings?.mode ||
    input.issueSettings?.workspaceStrategy ||
    input.issueSettings?.workspaceRuntime,
  );
  const hasWorkspaceControl = projectHasPolicy || issueHasWorkspaceOverrides || input.legacyUseProjectWorkspace === false;

  if (hasWorkspaceControl) {
    if (input.mode === "isolated_workspace") {
      const projectStrategy = projectHasPolicy ? input.projectPolicy?.workspaceStrategy : undefined;
      const issueStrategy = input.issueSettings?.workspaceStrategy;
      // An issue that changes its branch still needs the project's setup hooks.
      // Do not carry those defaults into a different execution strategy.
      const strategy = issueStrategy && projectStrategy?.type === issueStrategy.type
        ? { ...projectStrategy, ...issueStrategy }
        : issueStrategy ?? projectStrategy ??
        parseExecutionWorkspaceStrategy(nextConfig.workspaceStrategy) ??
        ({ type: "git_worktree" } satisfies ExecutionWorkspaceStrategy);
      if (issueStrategy?.existingBranch && issueStrategy.branchTemplate === undefined && strategy !== issueStrategy) {
        delete strategy.branchTemplate;
      }
      nextConfig.workspaceStrategy = strategy as unknown as Record<string, unknown>;
    } else {
      delete nextConfig.workspaceStrategy;
    }

    if (input.mode === "agent_default") {
      delete nextConfig.workspaceRuntime;
    } else if (input.issueSettings?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(input.issueSettings.workspaceRuntime) ?? undefined;
    } else if (input.projectPolicy?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(input.projectPolicy.workspaceRuntime) ?? undefined;
    }
  }

  return nextConfig;
}

/**
 * Merge an issue's `assigneeAdapterOverrides.adapterConfig` over a base agent
 * config. Every key keeps shallow replace semantics except `env`, which merges
 * per key (`{ ...base.env, ...override.env }`) when the override carries an
 * env object.
 *
 * A shallow spread replaces the whole `env` object, so an override that sets
 * one env key drops every other key of the agent config, secret references
 * included. Merging `env` per key keeps the base keys that the override omits.
 * An override key still shadows the base key.
 *
 * Two edge cases keep the previous replace behavior instead of merging:
 *
 * - An explicit non-object `env` (including `null`) clears the agent env,
 *   exactly as the previous spread did. Downstream resolution maps a
 *   non-object env to `{}`, so `env: null` removes every agent environment
 *   key. There is no per-key removal: an `env` entry set to `null` is not a
 *   valid binding and is rejected at secret resolution.
 * - An override env key that shares a case-insensitive name with any base
 *   env key is rejected unless the base carries exactly that one spelling.
 *   Environment names are case-sensitive on Linux but case-insensitive on
 *   Windows targets, so `api_token` over `API_TOKEN` would keep a shadowed
 *   secret binding that secret resolution must resolve before the launch
 *   layer folds the names. Rename the override key to the exact base
 *   spelling to replace it, or pick a non-conflicting name. When the base
 *   already carries several spellings of one name (for example both
 *   `API_TOKEN` and `api_token`), every override of that name is rejected:
 *   no single spelling can replace them all, and letting another inherited
 *   alias survive would shadow the replacement through resolution (or
 *   through Windows folding afterwards). This rejection runs on every
 *   target, so a conflicting override also fails on Linux even though the
 *   process variables would be distinct there.
 */
export function mergeIssueAdapterConfigOverrides(
  base: Record<string, unknown>,
  override: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...base, ...(override ?? {}) };
  if (override && "env" in override) {
    const overrideEnv = override.env;
    if (!isEnvRecord(overrideEnv)) {
      // Preserve an explicit clearing value (`null`, an array, a primitive)
      // instead of merging the base env back over it.
      next.env = overrideEnv;
    } else {
      rejectCaseVariantEnvAliases(parseObject(base.env), overrideEnv);
      next.env = { ...parseObject(base.env), ...overrideEnv };
    }
  }
  return next;
}

function isEnvRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectCaseVariantEnvAliases(
  baseEnv: Record<string, unknown>,
  overrideEnv: Record<string, unknown>,
): void {
  const baseKeys = Object.keys(baseEnv);
  if (baseKeys.length === 0) return;
  // Every inherited spelling of each case-insensitive name. A base env may
  // already carry several spellings of one name; remembering only the first
  // one lets another inherited alias survive the merge and shadow the
  // replacement through secret resolution (or through Windows folding).
  // Sets keep this independent of base input order.
  const baseSpellings = new Map<string, Set<string>>();
  for (const key of baseKeys) {
    const canonical = key.toUpperCase();
    let spellings = baseSpellings.get(canonical);
    if (!spellings) {
      spellings = new Set<string>();
      baseSpellings.set(canonical, spellings);
    }
    spellings.add(key);
  }
  for (const key of Object.keys(overrideEnv)) {
    const spellings = baseSpellings.get(key.toUpperCase());
    if (!spellings || (spellings.size === 1 && spellings.has(key))) continue;
    // Deterministic message: sort the inherited spellings so base input
    // order never changes the error.
    const inherited = [...spellings].sort();
    const quoted = inherited.map((spelling) => `"${spelling}"`).join(", ");
    throw new Error(
      `Issue override env key "${key}" conflicts with agent env key${inherited.length === 1 ? "" : "s"} ${quoted}: ` +
        `environment names are case-insensitive on some targets (Windows). ` +
        (inherited.length === 1
          ? `Use the exact key ${quoted} to replace it, or choose a non-conflicting name.`
          : `The agent env already carries several spellings of this name, so no single spelling can replace them all; ` +
            `remove the inherited aliases instead of overriding this name.`),
    );
  }
}
