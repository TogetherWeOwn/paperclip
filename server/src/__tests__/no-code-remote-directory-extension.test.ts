import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ gitBacked: false })),
  restore: vi.fn(async () => undefined),
  sync: vi.fn(async (_input: { localDir: string }) => undefined),
  ssh: vi.fn(async () => ({
    stdout: Buffer.from("{}").toString("base64"),
    stderr: "",
  })),
  provider: vi.fn(),
  bridge: vi.fn(async () => ({ env: {}, stop: async () => {} })),
}));
vi.mock("@paperclipai/adapter-utils/ssh", async () => ({
  ...(await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  )),
  prepareWorkspaceForSshExecution: io.prepare,
  restoreWorkspaceFromSshExecution: io.restore,
  syncDirectoryToSsh: io.sync,
  runSshCommand: io.ssh,
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async () => ({
  ...(await vi.importActual<
    typeof import("@paperclipai/adapter-utils/execution-target")
  >("@paperclipai/adapter-utils/execution-target")),
  // Only external provider/probe/bridge I/O is replaced. Runtime staging is real.
  runAdapterExecutionTargetProcess: io.provider,
  ensureAdapterExecutionTargetCommandResolvable: async () => {},
  ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
  resolveAdapterExecutionTargetCommandForLogs: async () => "/fixture/provider",
  startAdapterExecutionTargetPaperclipBridge: io.bridge,
}));
vi.mock("@paperclipai/adapter-utils/server-utils", async () => ({
  ...(await vi.importActual<
    typeof import("@paperclipai/adapter-utils/server-utils")
  >("@paperclipai/adapter-utils/server-utils")),
  ensureCommandResolvable: async () => {},
  resolveCommandForLogs: async () => "/fixture/provider",
}));

import { execute as executeClaude } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

function providerResult(args: string[]) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    pid: 123,
    startedAt: new Date().toISOString(),
    stderr: "",
    stdout: args.includes("--version")
      ? "2.1.280 (Claude Code)\n"
      : [
          JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "fresh-fixture-session",
          }),
          JSON.stringify({
            type: "result",
            session_id: "fresh-fixture-session",
            result: "done",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ].join("\n"),
  };
}

// Real shell filesystem under run-owned scratch stands in for the remote sandbox.
// No provider process, SSH connection, installation or credential lookup can run.
function scratchRunner(
  home: string,
  commands: string[],
): CommandManagedRuntimeRunner {
  return {
    execute: async (input) =>
      new Promise((resolve, reject) => {
        commands.push([input.command, ...(input.args ?? [])].join(" "));
        const child = spawn(input.command, input.args ?? [], {
          cwd: input.cwd,
          env: { PATH: process.env.PATH, HOME: home, ...input.env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data.toString();
        });
        child.stderr.on("data", (data) => {
          stderr += data.toString();
        });
        child.on("error", reject);
        child.on("close", (exitCode, signal) =>
          resolve({
            exitCode,
            signal,
            timedOut: false,
            stdout,
            stderr,
            pid: child.pid ?? null,
            startedAt: new Date().toISOString(),
          }),
        );
        if (input.stdin != null) child.stdin.write(input.stdin);
        child.stdin.end();
      }),
  };
}

// Merely disabling sync is insufficient: the provider must not run in the old
// repository cwd. Removing transport/session isolation should fail these tests.
describe.each([
  { adapterType: "codex_local", execute: executeCodex },
  { adapterType: "claude_local", execute: executeClaude },
])(
  "$adapterType remote no-code directory acceptance",
  ({ adapterType, execute }) => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    async function invoke(
      transport: "ssh" | "sandbox",
      mode: string,
      savedSession = false,
    ) {
      const root = await mkdtemp(
        path.join(
          process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
          "no-code-remote-extension-",
        ),
      );
      const cwd = path.join(root, "local-ordinary");
      const home = path.join(root, "provider-home");
      const environmentRoot = path.join(root, "authorized-environment-root");
      const repository = path.join(environmentRoot, "existing-repository");
      await Promise.all([
        mkdir(cwd),
        mkdir(home),
        mkdir(repository, { recursive: true }),
      ]);
      await mkdir(path.join(repository, ".git"));
      await writeFile(
        path.join(repository, "KEEP.txt"),
        "Existing repository must survive\n",
      );
      await writeFile(
        path.join(cwd, "DO-NOT-TRANSFER.txt"),
        "Working-tree bytes are not runtime assets\n",
      );
      const instructions = path.join(root, "RUNTIME-INSTRUCTIONS.md");
      await writeFile(
        instructions,
        "Runtime instruction asset is authorized.\n",
      );
      const commands: string[] = [];
      const targets: AdapterExecutionTarget[] = [];
      io.provider.mockImplementation(
        async (
          _run: string,
          target: AdapterExecutionTarget,
          _command: string,
          args: string[],
        ) => {
          if (!args.includes("--version")) targets.push(target);
          return providerResult(args);
        },
      );
      const ssh = {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: environmentRoot,
        remoteCwd: repository,
        privateKey: "fixture-not-a-credential",
        knownHosts: "fixture-known-hosts",
        strictHostKeyChecking: true,
      };
      const workspaceRealization = {
        mode: "copy" as const,
        authoritativeRoot: environmentRoot,
        pathAliases: [],
        outboundRestorePaths: [],
      };
      const target: AdapterExecutionTarget =
        transport === "ssh"
          ? {
              kind: "remote",
              transport: "ssh",
              remoteCwd: repository,
              spec: ssh,
              workspaceRealization,
            }
          : {
              kind: "remote",
              transport: "sandbox",
              providerKey: "test-only",
              remoteCwd: repository,
              runner: scratchRunner(home, commands),
              streamRunLogs: false,
              workspaceRealization,
            };
      const result = await execute({
        runId: randomUUID(),
        agent: {
          id: "fixture-agent",
          companyId: "fixture-company",
          name: "Fixture",
          adapterType,
          adapterConfig: {},
        },
        runtime: {
          sessionId: savedSession ? "repository-session" : null,
          sessionDisplayId: savedSession ? "repository-session" : null,
          sessionParams: savedSession
            ? { sessionId: "repository-session", cwd: repository }
            : null,
          taskKey: "fixture-task",
        },
        config: {
          engine: "cli",
          command: adapterType === "codex_local" ? "codex" : "claude",
          instructionsFilePath: instructions,
          env: { CODEX_HOME: home, HOME: home },
        },
        context: {
          issueId: "fixture-task",
          paperclipWorkspace: { cwd, source: "agent_home", mode },
        },
        executionTarget: target,
        executionTransport:
          transport === "ssh" ? { remoteExecution: ssh } : undefined,
        onLog: async () => {},
      });
      return { result, cwd, targets, commands, repository, environmentRoot };
    }

    it.each(["ssh", "sandbox"] as const)(
      "%s no-code provider cwd is an ordinary directory below the authorized execution root",
      async (transport) => {
        const f = await invoke(transport, "no_code");
        expect(f.result.exitCode).toBe(0);
        expect(f.targets).toHaveLength(1);
        const cwd = (f.targets[0] as { remoteCwd: string }).remoteCwd;
        expect(cwd).not.toBe(f.repository);
        expect(cwd.startsWith(`${f.environmentRoot}/`)).toBe(true);
        expect(cwd).not.toContain("existing-repository/");
        expect(
          await readFile(path.join(f.repository, "KEEP.txt"), "utf8"),
        ).toBe("Existing repository must survive\n");
        if (transport === "sandbox") {
          await expect(access(cwd)).resolves.toBeUndefined();
          await expect(access(path.join(cwd, ".git"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      },
      30_000,
    );

    it.each(["ssh", "sandbox"] as const)(
      "%s no-code skips working-tree transfers while permitting runtime assets",
      async (transport) => {
        const f = await invoke(transport, "no_code");
        expect(f.result.exitCode).toBe(0);
        expect(io.prepare).not.toHaveBeenCalled();
        expect(io.restore).not.toHaveBeenCalled();
        expect(
          io.sync.mock.calls.some(([input]) => input.localDir === f.cwd),
        ).toBe(false);
        if (transport === "ssh")
          expect(io.sync.mock.calls.length).toBeGreaterThan(0);
        else {
          await expect(
            access(path.join(f.repository, "DO-NOT-TRANSFER.txt")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            f.commands.some((command) =>
              command.includes(".paperclip-runtime"),
            ),
          ).toBe(true);
        }
      },
      30_000,
    );

    it.each(["ssh", "sandbox"] as const)(
      "%s no-code does not pass a saved code session to the provider",
      async (transport) => {
        const f = await invoke(transport, "no_code", true);
        expect(f.result.exitCode).toBe(0);
        const args = io.provider.mock.calls
          .filter((call) => !(call[3] as string[]).includes("--version"))
          .flatMap((call) => call[3] as string[]);
        expect(args).not.toContain("repository-session");
        expect(args).not.toContain("resume");
        expect(args).not.toContain("--resume");
      },
      30_000,
    );

    it("ordinary SSH task retains repository working-tree seed and restore", async () => {
      const f = await invoke("ssh", "isolated_workspace");
      expect(f.result.exitCode).toBe(0);
      expect(f.targets).toHaveLength(1);
      expect(io.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ localDir: f.cwd }),
      );
      expect(io.restore).toHaveBeenCalledWith(
        expect.objectContaining({ localDir: f.cwd }),
      );
    }, 30_000);
  },
);
