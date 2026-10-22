import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type AdapterExecutionTarget,
  prepareNoCodeExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import type {
  EnvironmentDriverExecuteInput,
  EnvironmentDriverRealizeWorkspaceInput,
  EnvironmentRuntimeService,
} from "../services/environment-runtime.js";
import { buildWorkspaceRealizationRecordFromDriverInput } from "../services/workspace-realization.js";
import type { RealizedExecutionWorkspace } from "../services/workspace-runtime.js";

const boundary = vi.hoisted(() => ({ ssh: vi.fn(), transfers: vi.fn() }));
// Replace only external SSH I/O and persistence/config-decryption boundaries.
// Record construction, orchestration, target resolution and safety shell stay real.
vi.mock("@paperclipai/adapter-utils/ssh", async () => ({
  ...(await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  )),
  runSshCommand: boundary.ssh,
  prepareWorkspaceForSshExecution: boundary.transfers,
  restoreWorkspaceFromSshExecution: boundary.transfers,
  syncDirectoryToSsh: boundary.transfers,
}));
vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: async (
    _db: unknown,
    _companyId: string,
    environment: Environment,
  ) => ({ driver: environment.driver, config: environment.config }),
}));
vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ updateLeaseMetadata: async () => null }),
}));
vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({ update: async () => null }),
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: async () => undefined,
}));

const exec = promisify(execFile);
afterEach(() => {
  vi.clearAllMocks();
});

async function fixture(
  transport: "sandbox" | "ssh",
  hostState: "missing" | "ordinary" | "same",
) {
  const scratch = await mkdtemp(
    path.join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
      "remote-authority-",
    ),
  );
  const remoteRoot = path.join(scratch, "authorized remote root's directory");
  const hostRoot =
    hostState === "same" ? remoteRoot : path.join(scratch, "host-only-source");
  const home = path.join(scratch, "shell-home");
  await mkdir(remoteRoot);
  await mkdir(home);
  if (hostState === "ordinary") await mkdir(hostRoot);
  await writeFile(
    path.join(remoteRoot, "KEEP.txt"),
    "authorized remote data\n",
  );
  if (hostState === "ordinary")
    await writeFile(path.join(hostRoot, "KEEP.txt"), "host-only data\n");
  const runId = `run-${randomUUID()}`;
  const now = new Date(0);
  const environment: Environment = {
    id: randomUUID(),
    name: "Scratch execution environment",
    description: null,
    driver: transport,
    status: "active",
    envVars: {},
    metadata: null,
    config:
      transport === "ssh"
        ? {
            host: "no-network.example.test",
            port: 22,
            username: "fixture",
            remoteWorkspacePath: remoteRoot,
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          }
        : { provider: "scratch-only", reuseLease: false, timeoutMs: 5_000 },
    createdAt: now,
    updatedAt: now,
  };
  const lease: EnvironmentLease = {
    id: randomUUID(),
    companyId: randomUUID(),
    environmentId: environment.id,
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: runId,
    status: "active",
    leasePolicy: "ephemeral",
    provider: transport === "ssh" ? "ssh" : "scratch-only",
    providerLeaseId: null,
    acquiredAt: now,
    lastUsedAt: now,
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: { remoteCwd: remoteRoot },
    createdAt: now,
    updatedAt: now,
  };
  const calls: string[] = [];
  const safeEnv = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  async function shell(
    command: string,
    args: string[],
    env: Record<string, string> = {},
    cwd = scratch,
  ) {
    if (!["sh", "/bin/sh", "bash", "/bin/bash"].includes(command))
      throw new Error(`Unexpected scratch executable: ${command}`);
    calls.push(args.join(" "));
    try {
      const result = await exec(command, args, {
        cwd,
        env: { ...safeEnv, ...env },
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      const failed = error as {
        code?: number | string;
        signal?: string;
        stdout?: string;
        stderr?: string;
      };
      if (typeof failed.code !== "number") throw error;
      return {
        exitCode: failed.code,
        signal: failed.signal ?? null,
        timedOut: false,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? "",
      };
    }
  }
  boundary.ssh.mockImplementation(
    async (
      _config: unknown,
      command: string,
      options: { env?: Record<string, string> } = {},
    ) => {
      const result = await shell("/bin/sh", ["-c", command], options.env);
      if (result.exitCode !== 0) {
        throw Object.assign(
          new Error(result.stderr || "Scratch SSH command failed"),
          {
            code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          },
        );
      }
      return { stdout: result.stdout, stderr: result.stderr };
    },
  );
  boundary.transfers.mockImplementation(() => {
    throw new Error("No-code must not transfer a working tree");
  });
  const noCapabilities = {
    reusableLeases: false,
    nativeSyncIn: false,
    nativeSyncOut: false,
    persistentProcessSessions: false,
    independentControlCommands: false,
    incrementalSessionOutput: false,
    concurrentSyncOperations: false,
    duplexCommandStream: false,
    runnerWebSocketIngress: false,
  };
  const runtime = {
    realizeWorkspace: async (
      input: EnvironmentDriverRealizeWorkspaceInput,
    ) => ({
      cwd: remoteRoot,
      metadata: {
        workspaceRealization: buildWorkspaceRealizationRecordFromDriverInput({
          ...input,
          cwd: remoteRoot,
        }),
      },
    }),
    execute: async (input: EnvironmentDriverExecuteInput) =>
      shell(input.command, input.args ?? [], input.env, input.cwd),
    resolveCapabilities: async () => noCapabilities,
    readSandboxDuplexBridgeInput: async () => ({ enabled: false }),
    supportsSync: () => false,
    syncIn: boundary.transfers,
    syncOut: boundary.transfers,
  } as unknown as EnvironmentRuntimeService;
  const workspace: RealizedExecutionWorkspace = {
    baseCwd: hostRoot,
    cwd: hostRoot,
    source: "agent_home",
    projectId: null,
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    strategy: "project_primary",
    branchName: null,
    branchCreatedByRuntime: false,
    worktreePath: null,
    warnings: [],
    created: false,
  };
  const realized = await environmentRunOrchestrator({} as Db, {
    environmentRuntime: runtime,
  }).realizeForRun({
    environment,
    lease,
    adapterType: "codex_local",
    companyId: lease.companyId,
    issueId: null,
    heartbeatRunId: runId,
    executionWorkspace: workspace,
    effectiveExecutionWorkspaceMode: "no_code",
    persistedExecutionWorkspace: null,
  });
  expect(realized.executionTarget).toMatchObject({ kind: "remote", transport });
  expect(realized.workspaceRealization).toMatchObject({ mode: "copy" });
  return {
    scratch,
    remoteRoot,
    hostRoot,
    runId,
    calls,
    target: realized.executionTarget,
  };
}

async function attempt(
  f: Awaited<ReturnType<typeof fixture>>,
  target = f.target,
) {
  try {
    return {
      prepared: await prepareNoCodeExecutionTarget({ runId: f.runId, target }),
      error: undefined,
    };
  } catch (error) {
    return { prepared: undefined, error };
  }
}
function remoteCwd(target: AdapterExecutionTarget | null | undefined) {
  return target?.kind === "remote" ? target.remoteCwd : undefined;
}

// A host-local source is not a remote permission. These tests intentionally let
// production construct the copy record rather than hand-authoring root metadata.
describe.each(["sandbox", "ssh"] as const)(
  "composed no-code remote authority (%s)",
  (transport) => {
    it.each(["missing", "ordinary"] as const)(
      "uses the remote-authorized root when a distinct host path is %s",
      async (hostState) => {
        const f = await fixture(transport, hostState);
        const result = await attempt(f);
        if (hostState === "missing") {
          await expect
            .soft(
              lstat(f.hostRoot),
              "Missing host path must not be created on the remote",
            )
            .rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await expect
            .soft(
              lstat(path.join(f.hostRoot, ".paperclip-runtime")),
              "No-code must never create its cwd outside the configured remote root",
            )
            .rejects.toMatchObject({ code: "ENOENT" });
          expect(
            await readFile(path.join(f.hostRoot, "KEEP.txt"), "utf8"),
          ).toBe("host-only data\n");
        }
        expect(
          await readFile(path.join(f.remoteRoot, "KEEP.txt"), "utf8"),
        ).toBe("authorized remote data\n");
        expect(boundary.transfers).not.toHaveBeenCalled();
        expect(f.calls.length).toBeGreaterThan(0);
        expect
          .soft(
            result.error,
            "A missing host-only path must not make an ordinary authorized remote root unusable",
          )
          .toBeUndefined();
        const cwd = path.join(
          f.remoteRoot,
          ".paperclip-runtime",
          "no-code",
          f.runId,
        );
        expect(result.prepared).toMatchObject({
          kind: "remote",
          transport,
          remoteCwd: cwd,
        });
        expect((await lstat(cwd)).isDirectory()).toBe(true);
        expect(await readdir(cwd)).toEqual([]);
      },
    );

    it("rejects an authorized remote repository root without creating directories in an ordinary host path", async () => {
      const f = await fixture(transport, "ordinary");
      await mkdir(path.join(f.remoteRoot, ".git"));
      await writeFile(
        path.join(f.remoteRoot, ".git", "KEEP"),
        "repository metadata\n",
      );
      const result = await attempt(f);
      expect
        .soft(
          result.error,
          "Remote repository-root refusal must not be defeated by host-local realization metadata",
        )
        .toEqual(
          expect.objectContaining({
            message: expect.stringMatching(
              /no.code|repository|git|root|ordinary/i,
            ),
          }),
        );
      await expect
        .soft(
          lstat(path.join(f.hostRoot, ".paperclip-runtime")),
          "A refusal must not create outside the authorized root",
        )
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect
        .soft(lstat(path.join(f.remoteRoot, ".paperclip-runtime")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(f.hostRoot, "KEEP.txt"), "utf8")).toBe(
        "host-only data\n",
      );
      expect(
        await readFile(path.join(f.remoteRoot, ".git", "KEEP"), "utf8"),
      ).toBe("repository metadata\n");
      expect(boundary.transfers).not.toHaveBeenCalled();
    });

    it("is idempotent when heartbeat preparation is followed by adapter preparation for the same run", async () => {
      const f = await fixture(transport, "same");
      const first = await prepareNoCodeExecutionTarget({
        runId: f.runId,
        target: f.target,
      });
      const cwd = path.join(
        f.remoteRoot,
        ".paperclip-runtime",
        "no-code",
        f.runId,
      );
      expect(remoteCwd(first)).toBe(cwd);
      await writeFile(
        path.join(cwd, "result.md"),
        "retain between preparations\n",
      );
      const second = await prepareNoCodeExecutionTarget({
        runId: f.runId,
        target: first,
      });
      expect(remoteCwd(second)).toBe(cwd);
      expect(await readdir(cwd)).toEqual(["result.md"]);
      expect(await readFile(path.join(cwd, "result.md"), "utf8")).toBe(
        "retain between preparations\n",
      );
      expect(boundary.transfers).not.toHaveBeenCalled();
    });
  },
);
