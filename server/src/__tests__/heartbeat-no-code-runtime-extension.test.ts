import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  agentTaskSessions,
  executionWorkspaces,
  issues,
  projects,
} from "@paperclipai/db";
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
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  noCodeSettings,
  openNoCodeTestDatabase,
  seedNoCodeWorkspaceFixture,
} from "./helpers/no-code-workspace-fixtures.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

type Input = {
  runId: string;
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
  };
  context: {
    issueId: string;
    paperclipWorkspace: { cwd: string; mode: string };
  };
};
const exec = promisify(execFile);

// Real persisted tasks, repositories and dispatch; only the provider call is fake.
// A directory substitution must be rejected, never "repaired" by deleting files.
describe("no-code runtime and directory-substitution extension", () => {
  let temporary: Awaited<ReturnType<typeof openNoCodeTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "no-code-extension-",
      ),
    );
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    temporary = await openNoCodeTestDatabase();
    heartbeat = heartbeatService(temporary.db, { runtimeEnv: {} });
    execute.mockImplementation(async (input: Input) => {
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
    execute.mockClear();
  });
  afterAll(async () => {
    if (temporary && heartbeat)
      await drainHeartbeatRunsToQuiescence(temporary.db, heartbeat);
    await temporary?.close();
    vi.unstubAllEnvs();
  }, 60_000);

  async function fixture(enabled = true) {
    await instanceSettingsService(temporary.db).updateExperimental({
      enableIsolatedWorkspaces: enabled,
      enableIsolatedWorkspacesByDefault: false,
      enableManagedSandboxOnly: false,
    });
    const repo = path.join(root, randomUUID(), "repository");
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", "-b", "master"], { cwd: repo });
    await writeFile(
      path.join(repo, "KEEP.txt"),
      "Repository data must survive\n",
    );
    await exec("git", ["add", "KEEP.txt"], { cwd: repo });
    await exec(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: repo },
    );
    const f = await seedNoCodeWorkspaceFixture(temporary.db, repo);
    const marker = path.join(root, `${f.issueId}-provisioned`);
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
            provisionCommand: `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`,
          },
        },
      })
      .where(eq(projects.id, f.projectId));
    await temporary.db
      .update(issues)
      .set({ executionWorkspaceSettings: noCodeSettings })
      .where(eq(issues.id, f.issueId));
    return { ...f, repo, marker };
  }

  async function dispatch(
    f: Awaited<ReturnType<typeof fixture>>,
    extra: Record<string, unknown> = {},
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
        ...extra,
      },
    });
    if (!run) throw new Error("Expected admitted fixture run");
    await heartbeat.drainActiveRunExecutions();
    return {
      run: await heartbeat.getRun(run.id),
      calls: execute.mock.calls
        .map(([input]) => input as Input)
        .filter((input) => input.runId === run.id),
    };
  }

  it("dispatches no-code with isolated-workspaces OFF rather than falling back to repository setup", async () => {
    const f = await fixture(false);
    const result = await dispatch(f);
    expect({ status: result.run?.status, error: result.run?.error }).toEqual({
      status: "succeeded",
      error: null,
    });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.context.paperclipWorkspace.mode).toBe("no_code");
    expect(result.calls[0]?.context.paperclipWorkspace.cwd).not.toBe(f.repo);
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects a raw conflict before repository provisioning/provider work without stranding disposition", async () => {
    const f = await fixture();
    await temporary.db
      .update(issues)
      .set({
        executionWorkspaceId: f.executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      })
      .where(eq(issues.id, f.issueId));
    const result = await dispatch(f);
    expect(result.run?.status).toBe("failed");
    expect(result.run?.error).toMatch(/no.code|conflict|workspace/i);
    expect(result.calls).toHaveLength(0);
    await expect(access(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      issueService(temporary.db).update(f.issueId, { status: "done" }),
    ).resolves.toMatchObject({
      status: "done",
      executionWorkspaceId: f.executionWorkspaceId,
      executionWorkspaceSettings: noCodeSettings,
    });
    expect(
      (
        await temporary.db
          .select()
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, f.executionWorkspaceId))
      )[0]?.cwd,
    ).toBe(f.repo);
  }, 30_000);

  it.each([false, true])(
    "does not resume an explicitly supplied repository session (persisted session=%s)",
    async (persisted) => {
      const f = await fixture();
      if (persisted)
        await temporary.db.insert(agentTaskSessions).values({
          companyId: f.companyId,
          agentId: f.agentId,
          adapterType: "codex_local",
          taskKey: f.issueId,
          sessionDisplayId: "repository-provider-session",
          sessionParamsJson: {
            sessionId: "repository-provider-session",
            cwd: f.repo,
            workspaceId: f.projectWorkspaceId,
          },
        });
      const result = await dispatch(f, {
        resumeSessionDisplayId: "repository-provider-session",
        resumeSessionParams: {
          sessionId: "repository-provider-session",
          cwd: f.repo,
          workspaceId: f.projectWorkspaceId,
        },
      });
      expect(result.run?.status).toBe("succeeded");
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]?.runtime.sessionId).toBeNull();
      expect(result.calls[0]?.runtime.sessionParams).toBeNull();
    },
    30_000,
  );

  it.each(["symlink", "git directory", "git file"] as const)(
    "refuses a %s substitution without deleting user data",
    async (kind) => {
      const f = await fixture();
      const first = await dispatch(f);
      expect(first.run?.status).toBe("succeeded");
      const cwd = first.calls[0]?.context.paperclipWorkspace.cwd;
      if (!cwd) throw new Error("Expected ordinary no-code task directory");
      expect(await realpath(cwd)).not.toBe(await realpath(f.repo));
      const keep = path.join(cwd, "KEEP-ORDINARY.txt");
      await writeFile(keep, "Ordinary task data must survive\n");
      let retained = keep;
      if (kind === "symlink") {
        const original = `${cwd}-preserved`;
        await rename(cwd, original);
        retained = path.join(original, "KEEP-ORDINARY.txt");
        await symlink(f.repo, cwd, "dir");
      } else if (kind === "git directory") {
        await mkdir(path.join(cwd, ".git"));
        await writeFile(
          path.join(cwd, ".git", "KEEP-GIT.txt"),
          "Git metadata must survive\n",
        );
      } else {
        await writeFile(
          path.join(cwd, ".git"),
          `gitdir: ${path.join(f.repo, ".git")}\n`,
        );
      }
      await temporary.db
        .update(issues)
        .set({ status: "todo" })
        .where(eq(issues.id, f.issueId));
      const next = await dispatch(f);
      expect(next.run?.status).toBe("failed");
      expect(next.run?.error).toMatch(
        /no.code|directory|symlink|repository|git|workspace/i,
      );
      expect(next.calls).toHaveLength(0);
      expect(await readFile(retained, "utf8")).toBe(
        "Ordinary task data must survive\n",
      );
      expect(await readFile(path.join(f.repo, "KEEP.txt"), "utf8")).toBe(
        "Repository data must survive\n",
      );
      if (kind === "symlink")
        expect((await lstat(cwd)).isSymbolicLink()).toBe(true);
      else if (kind === "git directory")
        expect(
          await readFile(path.join(cwd, ".git", "KEEP-GIT.txt"), "utf8"),
        ).toBe("Git metadata must survive\n");
      else
        expect(await readFile(path.join(cwd, ".git"), "utf8")).toBe(
          `gitdir: ${path.join(f.repo, ".git")}\n`,
        );
    },
    30_000,
  );
});
