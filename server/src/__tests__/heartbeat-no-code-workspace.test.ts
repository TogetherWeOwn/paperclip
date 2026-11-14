import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  agents,
  agentTaskSessions,
  environments,
  executionWorkspaces,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { buildProjectMentionHref } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  noCodeSettings,
  openNoCodeTestDatabase,
  seedNoCodeWorkspaceFixture,
} from "./helpers/no-code-workspace-fixtures.js";

const adapterExecute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

const exec = promisify(execFile);
type AdapterInput = {
  runId: string;
  agent: { id: string; companyId: string };
  config: Record<string, unknown>;
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
  };
  context: Record<string, unknown> & {
    issueId: string;
    paperclipWorkspace: {
      cwd: string;
      mode: string;
      projectId?: string | null;
    };
    paperclipWorkspaces?: Array<{ cwd?: string }>;
  };
};

function onlyInput(calls: AdapterInput[]) {
  expect(calls).toHaveLength(1);
  const [input] = calls;
  if (!input) throw new Error("Expected one adapter dispatch");
  return input;
}

// Exercise real wake -> persisted issue/session -> provisioning -> adapter dispatch.
// Only the provider invocation is replaced; repositories and provision commands are real.
describe("explicit no-code heartbeat workspace dispatch", () => {
  let temporary: Awaited<ReturnType<typeof openNoCodeTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "no-code-dispatch-",
      ),
    );
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "true");
    temporary = await openNoCodeTestDatabase();
    heartbeat = heartbeatService(temporary.db, { runtimeEnv: {} });
    adapterExecute.mockImplementation(async (input: AdapterInput) => {
      // Settle the fixture so normal incomplete-task continuations don't obscure dispatch.
      await temporary.db
        .update(issues)
        .set({ status: "done" })
        .where(eq(issues.id, input.context.issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Fixture completed",
        provider: "test",
        model: "test-model",
      };
    });
  }, 120_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(temporary.db, heartbeat);
    adapterExecute.mockClear();
  });
  afterAll(async () => {
    if (temporary && heartbeat)
      await drainHeartbeatRunsToQuiescence(temporary.db, heartbeat);
    await temporary?.close();
    vi.unstubAllEnvs();
    // Run-owned scratch is retained for a failed-test inspection and removed by the harness.
  }, 60_000);

  async function repo(name: string) {
    const cwd = path.join(root, randomUUID(), name);
    await mkdir(cwd, { recursive: true });
    await exec("git", ["init", "-b", "master"], { cwd });
    await writeFile(path.join(cwd, "README.md"), `${name} repository\n`);
    await exec("git", ["add", "README.md"], { cwd });
    await exec(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "seed",
      ],
      { cwd },
    );
    return cwd;
  }

  async function fixture(
    settings: Record<string, unknown> | null,
    priorSession = false,
  ) {
    await instanceSettingsService(temporary.db).updateExperimental({
      enableIsolatedWorkspaces: true,
      enableIsolatedWorkspacesByDefault: false,
      enableManagedSandboxOnly: false,
    });
    const source = await repo("primary");
    const secondary = await repo("secondary");
    const referenced = await repo("referenced");
    const f = await seedNoCodeWorkspaceFixture(temporary.db, source);
    const marker = path.join(root, `${f.issueId}-provisioned`);
    const command = `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`;
    await temporary.db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          allowIssueOverride: true,
          defaultMode: "isolated_workspace",
          defaultProjectWorkspaceId: f.projectWorkspaceId,
          workspaceStrategy: {
            type: "git_worktree",
            baseRef: "master",
            worktreeParentDir: path.join(root, "worktrees"),
            provisionCommand: command,
          },
        },
      })
      .where(eq(projects.id, f.projectId));
    await temporary.db
      .update(projectWorkspaces)
      .set({ sourceType: "local_path", repoUrl: pathToFileURL(source).href })
      .where(eq(projectWorkspaces.id, f.projectWorkspaceId));
    const referenceProjectId = randomUUID();
    await temporary.db.insert(projects).values({
      id: referenceProjectId,
      companyId: f.companyId,
      name: "Referenced project",
    });
    await temporary.db.insert(projectWorkspaces).values([
      {
        id: randomUUID(),
        companyId: f.companyId,
        projectId: f.projectId,
        name: "Secondary",
        sourceType: "git_repo",
        cwd: secondary,
        repoUrl: pathToFileURL(secondary).href,
        isPrimary: false,
      },
      {
        id: randomUUID(),
        companyId: f.companyId,
        projectId: referenceProjectId,
        name: "Referenced",
        sourceType: "local_path",
        cwd: referenced,
        repoUrl: pathToFileURL(referenced).href,
        isPrimary: true,
      },
    ]);
    await temporary.db
      .update(issues)
      .set({
        title: "Prepare operator research, no coding required",
        description: `[Supporting project](${buildProjectMentionHref(referenceProjectId)})`,
        executionWorkspaceSettings: settings,
      })
      .where(eq(issues.id, f.issueId));
    if (priorSession) {
      await temporary.db.insert(agentTaskSessions).values({
        companyId: f.companyId,
        agentId: f.agentId,
        adapterType: "codex_local",
        taskKey: f.issueId,
        sessionParamsJson: {
          sessionId: "old-repository-session",
          cwd: source,
          workspaceId: f.projectWorkspaceId,
        },
        sessionDisplayId: "old-repository-session",
      });
    }
    return { ...f, source, secondary, referenced, marker };
  }

  async function dispatch(
    f: Omit<Awaited<ReturnType<typeof fixture>>, "projectId"> & {
      projectId: string | null;
    },
  ) {
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      contextSnapshot: {
        issueId: f.issueId,
        taskId: f.issueId,
        projectId: f.projectId,
        taskKey: f.issueId,
        wakeReason: "manual",
      },
    });
    expect(run).not.toBeNull();
    if (!run) throw new Error("Fixture wake did not create a heartbeat run");
    await heartbeat.drainActiveRunExecutions();
    const latest = await heartbeat.getRun(run.id);
    return {
      run: latest,
      calls: adapterExecute.mock.calls
        .map(([input]) => input as AdapterInput)
        .filter((input) => input.runId === run.id),
    };
  }

  it.each([false, true])(
    "dispatches explicit no-code without provisioning or repository fallback (prior session=%s)",
    async (priorSession) => {
      const f = await fixture(noCodeSettings, priorSession);
      const { run, calls } = await dispatch(f);

      expect({ status: run?.status, error: run?.error }).toEqual({
        status: "succeeded",
        error: null,
      });
      expect(calls).toHaveLength(1);
      const input = onlyInput(calls);
      expect(input.agent.companyId).toBe(f.companyId);
      expect(input.context.paperclipWorkspace.mode).toBe("no_code");
      const cwd = input.context.paperclipWorkspace.cwd;
      expect(path.isAbsolute(cwd)).toBe(true);
      expect([f.source, f.secondary, f.referenced]).not.toContain(cwd);
      await expect(access(cwd)).resolves.toBeUndefined();
      const authorizedHome = await realpath(
        resolveDefaultAgentWorkspaceDir(f.agentId),
      );
      const canonicalCwd = await realpath(cwd);
      expect(
        canonicalCwd === authorizedHome ||
          canonicalCwd.startsWith(`${authorizedHome}${path.sep}`),
      ).toBe(true);
      await expect(access(path.join(cwd, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(path.join(cwd, ".paperclip-repositories")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(input.runtime.sessionId).not.toBe("old-repository-session");
      expect(input.runtime.sessionParams?.cwd).not.toBe(f.source);
      for (const hint of input.context.paperclipWorkspaces ?? []) {
        expect([f.source, f.secondary, f.referenced]).not.toContain(hint.cwd);
        expect(hint.cwd ?? "").not.toContain(".paperclip-repositories");
      }
    },
    30_000,
  );

  it("dispatches no-code selected through ordinary issue creation, not only raw persisted fixtures", async () => {
    const f = await fixture(noCodeSettings);
    const created = await issueService(temporary.db).create(f.companyId, {
      title: "Create then dispatch a report",
      projectId: f.projectId,
      assigneeAgentId: f.agentId,
      executionWorkspaceSettings: noCodeSettings as never,
    });
    const { run, calls } = await dispatch({ ...f, issueId: created.id });

    expect({ status: run?.status, error: run?.error }).toEqual({
      status: "succeeded",
      error: null,
    });
    expect(calls).toHaveLength(1);
    expect(onlyInput(calls).context.paperclipWorkspace.mode).toBe("no_code");
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it.each([null, { mode: "isolated_workspace" }])(
    "keeps real repository setup for ordinary/unspecified tasks: %j",
    async (settings) => {
      const f = await fixture(settings);
      const { run, calls } = await dispatch(f);

      expect({ status: run?.status, error: run?.error }).toEqual({
        status: "succeeded",
        error: null,
      });
      expect(calls).toHaveLength(1);
      expect(onlyInput(calls).context.paperclipWorkspace.mode).toBe(
        "isolated_workspace",
      );
      expect(await readFile(f.marker, "utf8")).toBe("ran");
      const cwd = onlyInput(calls).context.paperclipWorkspace.cwd;
      expect(
        (
          await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd })
        ).stdout.trim(),
      ).toBe("true");
      expect(
        (onlyInput(calls).context.paperclipWorkspaces ?? []).some((hint) =>
          hint.cwd?.includes(".paperclip-repositories"),
        ),
      ).toBe(true);
    },
    30_000,
  );

  it.each([
    "ask",
    "planning",
    "missing project",
    "missing repositories",
  ] as const)(
    "does not infer no-code from %s",
    async (scenario) => {
      const f = await fixture(null);
      if (scenario === "ask" || scenario === "planning") {
        await temporary.db
          .update(issues)
          .set({ workMode: scenario })
          .where(eq(issues.id, f.issueId));
      } else {
        const emptyProjectId = randomUUID();
        if (scenario === "missing repositories") {
          await temporary.db.insert(projects).values({
            id: emptyProjectId,
            companyId: f.companyId,
            name: "Repository-free project",
          });
        }
        await temporary.db
          .update(issues)
          .set({
            projectId: scenario === "missing project" ? null : emptyProjectId,
            description: null,
          })
          .where(eq(issues.id, f.issueId));
        // Context must agree with the authoritative project-less/repository-free row.
        const runFixture = {
          ...f,
          projectId: scenario === "missing project" ? null : emptyProjectId,
        };
        const { run, calls } = await dispatch(runFixture);
        expect({ status: run?.status, error: run?.error }).toEqual({
          status: "succeeded",
          error: null,
        });
        expect(onlyInput(calls).context.paperclipWorkspace.mode).not.toBe(
          "no_code",
        );
        return;
      }
      const { run, calls } = await dispatch(f);
      expect({ status: run?.status, error: run?.error }).toEqual({
        status: "succeeded",
        error: null,
      });
      expect(onlyInput(calls).context.paperclipWorkspace.mode).not.toBe(
        "no_code",
      );
    },
    30_000,
  );

  it("agent_default alone still uses ordinary workspace dispatch with a prior repository session", async () => {
    const f = await fixture({ mode: "agent_default" }, true);
    const { run, calls } = await dispatch(f);

    expect({ status: run?.status, error: run?.error }).toEqual({
      status: "succeeded",
      error: null,
    });
    expect(calls).toHaveLength(1);
    expect(onlyInput(calls).context.paperclipWorkspace.mode).not.toBe(
      "no_code",
    );
    await expect(
      access(onlyInput(calls).context.paperclipWorkspace.cwd),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("does not silently detach an already-bound code workspace when no-code is stored", async () => {
    const f = await fixture(noCodeSettings);
    await temporary.db
      .update(issues)
      .set({
        executionWorkspaceId: f.executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      })
      .where(eq(issues.id, f.issueId));
    const { run, calls } = await dispatch(f);

    if (run?.status === "succeeded") {
      expect(calls).toHaveLength(1);
      expect(onlyInput(calls).context.paperclipWorkspace.cwd).toBe(f.source);
      expect(onlyInput(calls).context.paperclipWorkspace.mode).not.toBe(
        "no_code",
      );
    } else {
      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/workspace|conflict|no.code/i);
      expect(calls).toHaveLength(0);
    }
    expect(
      (
        await temporary.db.select().from(issues).where(eq(issues.id, f.issueId))
      )[0]?.executionWorkspaceId,
    ).toBe(f.executionWorkspaceId);
    expect(
      (
        await temporary.db
          .select()
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, f.executionWorkspaceId))
      )[0]?.cwd,
    ).toBe(f.source);
  }, 30_000);

  it.each([
    "project workspace",
    "code preference",
    "branch",
    "strategy",
    "adapter cwd",
    "adapter workspace",
  ] as const)(
    "retains the explicit %s choice or fails before dispatch, never silently choosing no-code",
    async (choice) => {
      const f = await fixture(noCodeSettings);
      const overrides =
        choice === "project workspace"
          ? { projectWorkspaceId: f.projectWorkspaceId }
          : choice === "code preference"
            ? { executionWorkspacePreference: "isolated_workspace" }
            : choice === "branch"
              ? {
                  executionWorkspaceSettings: {
                    ...noCodeSettings,
                    workspaceStrategy: {
                      type: "git_worktree",
                      existingBranch: "master",
                    },
                  },
                }
              : choice === "strategy"
                ? {
                    executionWorkspaceSettings: {
                      ...noCodeSettings,
                      workspaceStrategy: {
                        type: "git_worktree",
                        baseRef: "master",
                      },
                    },
                  }
                : choice === "adapter cwd"
                  ? {
                      assigneeAdapterOverrides: {
                        adapterConfig: { cwd: f.secondary },
                      },
                    }
                  : { assigneeAdapterOverrides: { useProjectWorkspace: true } };
      await temporary.db
        .update(issues)
        .set(overrides)
        .where(eq(issues.id, f.issueId));
      const { run, calls } = await dispatch(f);

      if (run?.status === "succeeded") {
        expect(calls).toHaveLength(1);
        expect(onlyInput(calls).context.paperclipWorkspace.mode).not.toBe(
          "no_code",
        );
        if (choice === "adapter cwd")
          expect(onlyInput(calls).config.cwd).toBe(f.secondary);
        if (choice === "branch") {
          const cwd = onlyInput(calls).context.paperclipWorkspace.cwd;
          expect(
            (
              await exec("git", ["branch", "--show-current"], { cwd })
            ).stdout.trim(),
          ).toBe("master");
        }
      } else {
        expect(run?.status).toBe("failed");
        expect(run?.error).toMatch(/workspace|conflict|branch|no.code|cwd/i);
        expect(calls).toHaveLength(0);
      }
    },
    30_000,
  );

  it("managed-sandbox-only no-code fails closed when no managed sandbox is available", async () => {
    const f = await fixture(noCodeSettings);
    await instanceSettingsService(temporary.db).updateExperimental({
      enableManagedSandboxOnly: true,
    });
    const { run, calls } = await dispatch(f);

    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/sandbox|environment/i);
    expect(calls).toHaveLength(0);
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("an invalid explicitly selected SSH environment fails closed instead of using local for no-code", async () => {
    const f = await fixture(noCodeSettings);
    const environmentId = randomUUID();
    await temporary.db.insert(environments).values({
      id: environmentId,
      name: `Invalid selected SSH ${environmentId}`,
      driver: "ssh",
      status: "active",
      config: {},
    });
    await temporary.db
      .update(agents)
      .set({ defaultEnvironmentId: environmentId })
      .where(eq(agents.id, f.agentId));
    const { run, calls } = await dispatch(f);

    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/environment|ssh|host|config/i);
    expect(calls).toHaveLength(0);
  }, 30_000);

  it("an archived selected environment cannot become a local no-code fallback", async () => {
    const f = await fixture(noCodeSettings);
    const environmentId = randomUUID();
    await temporary.db.insert(environments).values({
      id: environmentId,
      name: `Archived environment ${environmentId}`,
      driver: "ssh",
      status: "archived",
      config: {},
    });
    await temporary.db
      .update(agents)
      .set({ defaultEnvironmentId: environmentId })
      .where(eq(agents.id, f.agentId));
    const { run, calls } = await dispatch(f);

    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/environment|company|access/i);
    expect(calls).toHaveLength(0);
  }, 30_000);

  it("no-code does not bypass a missing explicitly selected managed credential", async () => {
    const f = await fixture(noCodeSettings);
    await temporary.db
      .update(agents)
      .set({
        runtimeConfig: {
          aiConnection: {
            provider: "openai",
            method: "api_key",
            mode: "responsible_user",
          },
        },
      })
      .where(eq(agents.id, f.agentId));
    const { run, calls } = await dispatch(f);

    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("configuration_incomplete");
    expect(run?.error).toMatch(/account|connection|credential/i);
    expect(calls).toHaveLength(0);
  }, 30_000);

  it("low-trust no-code cannot bypass required sandbox isolation or run host provisioning", async () => {
    const f = await fixture(noCodeSettings);
    await temporary.db
      .update(agents)
      .set({
        permissions: {
          authorizationPolicy: {
            trustPreset: "low_trust_review",
            trustBoundary: {
              mode: "low_trust_review",
              companyId: f.companyId,
              rootIssueId: f.issueId,
            },
          },
        },
      })
      .where(eq(agents.id, f.agentId));
    const { run, calls } = await dispatch(f);

    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/sandbox|low.trust/i);
    expect(calls).toHaveLength(0);
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
