import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { issues } from "@paperclipai/db";
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
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  noCodeSettings,
  openNoCodeTestDatabase,
  seedNoCodeWorkspaceFixture,
} from "./helpers/no-code-workspace-fixtures.js";

const providerExecute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: providerExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: providerExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

const exec = promisify(execFile);
type DispatchInput = {
  runId: string;
  config: Record<string, unknown>;
  context: {
    issueId: string;
    paperclipWorkspace: { cwd: string; mode: string };
  };
};

// Catch an ancestor-only Git check or realpath adoption turning a substituted
// configured home into authority. Only the external provider is replaced.
describe("no-code local authority through real heartbeat dispatch", () => {
  let temporary: Awaited<ReturnType<typeof openNoCodeTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "local-authority-",
      ),
    );
    temporary = await openNoCodeTestDatabase();
    await instanceSettingsService(temporary.db).updateExperimental({
      enableIsolatedWorkspaces: true,
      enableIsolatedWorkspacesByDefault: false,
      enableManagedSandboxOnly: false,
    });
    heartbeat = heartbeatService(temporary.db, { runtimeEnv: {} });
    providerExecute.mockImplementation(async (input: DispatchInput) => {
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
    providerExecute.mockClear();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (temporary && heartbeat)
      await drainHeartbeatRunsToQuiescence(temporary.db, heartbeat);
    await temporary?.close();
  }, 60_000);

  async function fixture() {
    const caseRoot = path.join(root, randomUUID());
    await mkdir(caseRoot, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", path.join(caseRoot, "configured-home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    const f = await seedNoCodeWorkspaceFixture(temporary.db);
    await temporary.db
      .update(issues)
      .set({ executionWorkspaceSettings: noCodeSettings })
      .where(eq(issues.id, f.issueId));
    const home = resolveDefaultAgentWorkspaceDir(f.agentId);
    return { ...f, caseRoot, home };
  }

  async function dispatch(f: Awaited<ReturnType<typeof fixture>>) {
    const queued = await heartbeat.wakeup(f.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      contextSnapshot: {
        issueId: f.issueId,
        taskId: f.issueId,
        taskKey: f.issueId,
        projectId: f.projectId,
        wakeReason: "manual",
      },
    });
    expect(queued).not.toBeNull();
    if (!queued)
      throw new Error("Acceptance fixture did not enqueue a heartbeat");
    await heartbeat.drainActiveRunExecutions();
    return {
      run: await heartbeat.getRun(queued.id),
      calls: providerExecute.mock.calls
        .map(([input]) => input as DispatchInput)
        .filter((input) => input.runId === queued.id),
    };
  }

  async function assertRefusal(
    f: Awaited<ReturnType<typeof fixture>>,
    actualHome = f.home,
  ) {
    const { run, calls } = await dispatch(f);
    expect
      .soft(
        run?.status,
        "Unsafe configured ancestry must fail before provider dispatch",
      )
      .toBe("failed");
    expect
      .soft(
        run?.error,
        "Refusal must explain the workspace/path authority conflict",
      )
      .toEqual(
        expect.stringMatching(
          /no.code|workspace|repository|git|symlink|symbolic|ancestor/i,
        ),
      );
    expect
      .soft(calls, "Provider must never receive an unsafe cwd")
      .toHaveLength(0);
    await expect
      .soft(
        lstat(path.join(actualHome, "no-code")),
        "Refusal must not create a new task-directory tree",
      )
      .rejects.toMatchObject({ code: "ENOENT" });
  }

  it.each(["directory", "git file", "dangling symlink"] as const)(
    "rejects Git metadata above the configured home (%s) without touching sentinels",
    async (kind) => {
      const f = await fixture();
      const sentinel = path.join(f.caseRoot, "operator-notes.txt");
      await writeFile(sentinel, "preserve ancestor data\n");
      if (kind === "directory") {
        await exec("git", ["init", "-b", "master", f.caseRoot]);
      } else if (kind === "git file") {
        await exec("git", [
          "init",
          "-b",
          "master",
          `--separate-git-dir=${path.join(root, `${randomUUID()}-git-metadata`)}`,
          f.caseRoot,
        ]);
      } else {
        await symlink(
          path.join(f.caseRoot, "missing-git-metadata"),
          path.join(f.caseRoot, ".git"),
        );
      }
      await mkdir(f.home, { recursive: true });
      if (kind !== "dangling symlink") {
        expect(
          (
            await exec("git", ["-C", f.home, "rev-parse", "--show-toplevel"])
          ).stdout.trim(),
        ).toBe(f.caseRoot);
      }
      await assertRefusal(f);
      expect(await readFile(sentinel, "utf8")).toBe("preserve ancestor data\n");
      expect(
        (await lstat(path.join(f.caseRoot, ".git"))).isSymbolicLink(),
      ).toBe(kind === "dangling symlink");
    },
    30_000,
  );

  it.each(["home", "ancestor component"] as const)(
    "rejects a symlinked %s rather than adopting its canonical destination",
    async (kind) => {
      const f = await fixture();
      const destination = path.join(f.caseRoot, "outside-configured-root");
      await mkdir(destination);
      await writeFile(
        path.join(destination, "sentinel.txt"),
        "do not relocate authority\n",
      );
      let actualHome: string;
      if (kind === "home") {
        await mkdir(path.dirname(f.home), { recursive: true });
        await symlink(destination, f.home);
        actualHome = destination;
      } else {
        await mkdir(path.dirname(path.dirname(f.home)), { recursive: true });
        await symlink(destination, path.dirname(f.home));
        actualHome = path.join(destination, f.agentId);
      }
      await assertRefusal(f, actualHome);
      expect(
        await readFile(path.join(destination, "sentinel.txt"), "utf8"),
      ).toBe("do not relocate authority\n");
      if (kind === "ancestor component") {
        await expect
          .soft(
            lstat(actualHome),
            "An ancestor substitution must be rejected before mkdir(home)",
          )
          .rejects.toMatchObject({ code: "ENOENT" });
      }
    },
    30_000,
  );

  it("revalidates a home substituted after a successful heartbeat without following it", async () => {
    const f = await fixture();
    const first = await dispatch(f);
    expect(first.run?.status).toBe("succeeded");
    expect(first.calls).toHaveLength(1);
    const retained = path.join(f.caseRoot, "retained-original-home");
    await rename(f.home, retained);
    const destination = path.join(f.caseRoot, "substituted-home");
    await mkdir(destination);
    await writeFile(
      path.join(destination, "sentinel.txt"),
      "unapproved substitute\n",
    );
    await symlink(destination, f.home);
    await temporary.db
      .update(issues)
      .set({ status: "todo" })
      .where(eq(issues.id, f.issueId));
    await assertRefusal(f, destination);
    expect(await readFile(path.join(destination, "sentinel.txt"), "utf8")).toBe(
      "unapproved substitute\n",
    );
    expect((await lstat(retained)).isDirectory()).toBe(true);
  }, 30_000);

  it("uses an ordinary non-repository home successfully and reuses the same task cwd", async () => {
    const f = await fixture();
    await mkdir(f.home, { recursive: true });
    await writeFile(path.join(f.home, "sentinel.txt"), "ordinary home\n");
    const first = await dispatch(f);
    expect({ status: first.run?.status, error: first.run?.error }).toEqual({
      status: "succeeded",
      error: null,
    });
    expect(first.calls).toHaveLength(1);
    const cwd = first.calls[0].context.paperclipWorkspace.cwd;
    expect(cwd.startsWith(`${f.home}${path.sep}`)).toBe(true);
    expect(first.calls[0].context.paperclipWorkspace.mode).toBe("no_code");
    await expect(
      exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
    ).rejects.toMatchObject({ code: 128 });
    await writeFile(
      path.join(cwd, "task-notes.txt"),
      "keep between heartbeats\n",
    );
    await temporary.db
      .update(issues)
      .set({ status: "todo" })
      .where(eq(issues.id, f.issueId));
    const second = await dispatch(f);
    expect(second.run?.status).toBe("succeeded");
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0].context.paperclipWorkspace.cwd).toBe(cwd);
    expect(await readFile(path.join(cwd, "task-notes.txt"), "utf8")).toBe(
      "keep between heartbeats\n",
    );
    expect(await readFile(path.join(f.home, "sentinel.txt"), "utf8")).toBe(
      "ordinary home\n",
    );
  }, 30_000);
});
