import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { afterEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ gitBacked: false })),
  restore: vi.fn(async () => undefined),
  sync: vi.fn(async (_input: { localDir: string }) => undefined),
  ssh: vi.fn(async () => ({
    stdout: Buffer.from("{}").toString("base64"),
    stderr: "",
    exitCode: 0,
  })),
  provider: vi.fn(),
  localProvider: vi.fn(() => {
    throw new Error("Unexpected controller-local provider launch");
  }),
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
  // Preserve real no-code selection, target/session handling and runtime staging.
  // Replace only provider processes, external installation/probes and bridge I/O.
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
  runChildProcess: io.localProvider,
}));

import { execute as executeCursor } from "@paperclipai/adapter-cursor-local/server";
import { execute as executeGemini } from "@paperclipai/adapter-gemini-local/server";
import { execute as executeGrok } from "@paperclipai/adapter-grok-local/server";
import { execute as executeKimi } from "@paperclipai/adapter-kimi-local/server";
import { execute as executeOpenCode } from "@paperclipai/adapter-opencode-local/server";
import { execute as executePi } from "@paperclipai/adapter-pi-local/server";

type Adapter = {
  adapterType: string;
  command: string;
  execute: typeof executeCursor;
};
const adapters: Adapter[] = [
  { adapterType: "cursor", command: "agent", execute: executeCursor },
  { adapterType: "gemini_local", command: "gemini", execute: executeGemini },
  { adapterType: "grok_local", command: "grok", execute: executeGrok },
  { adapterType: "kimi_local", command: "kimi", execute: executeKimi },
  {
    adapterType: "opencode_local",
    command: "opencode",
    execute: executeOpenCode,
  },
  { adapterType: "pi_local", command: "pi", execute: executePi },
];
const sessionId = "repository-session";

function isProbe(args: string[]) {
  return (
    args.includes("--version") ||
    args.includes("models") ||
    args.includes("--list-models")
  );
}

// Literal provider protocols, not a single Claude-shaped response for all CLIs.
function providerResult(adapterType: string, args: string[]) {
  let stdout: string;
  if (args.includes("models"))
    stdout = "opencode/gpt-5-nano\nopenai/gpt-5.4-mini\n";
  else if (args.includes("--list-models"))
    stdout = "Provider  Model\nopenai    gpt-5.4-mini\n";
  else if (args.includes("--version")) stdout = "1.0.0\n";
  else if (adapterType === "grok_local")
    stdout = JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId,
      requestId: "request-fixture",
    });
  else if (adapterType === "kimi_local")
    stdout = [
      { role: "assistant", content: "done" },
      {
        role: "meta",
        type: "session.resume_hint",
        session_id: sessionId,
        command: `kimi -r ${sessionId}`,
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
  else if (adapterType === "opencode_local")
    stdout = [
      { type: "step_start", sessionID: sessionId },
      { type: "text", sessionID: sessionId, part: { text: "done" } },
      {
        type: "step_finish",
        sessionID: sessionId,
        part: {
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
  else if (adapterType === "pi_local")
    stdout = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: "done",
        usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } },
      },
      toolResults: [],
    });
  else if (adapterType === "gemini_local")
    stdout = [
      { type: "system", subtype: "init", session_id: sessionId },
      { type: "message", role: "assistant", content: "done" },
      {
        type: "result",
        status: "success",
        session_id: sessionId,
        stats: { input_tokens: 1, output_tokens: 1 },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
  else
    stdout = [
      { type: "system", subtype: "init", session_id: sessionId },
      {
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
      {
        type: "result",
        session_id: sessionId,
        result: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    pid: 123,
    startedAt: new Date().toISOString(),
    stderr: "",
    stdout,
  };
}

async function fixture(adapter: Adapter) {
  const scratch = await mkdtemp(
    path.join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
      "no-code-adapter-matrix-",
    ),
  );
  const cwd = path.join(scratch, "local-workspace");
  const home = path.join(scratch, "provider-home");
  const root = path.join(scratch, "authorized-environment-root");
  const repository = path.join(root, "existing-repository");
  await Promise.all([
    mkdir(cwd),
    mkdir(home),
    mkdir(path.join(repository, ".git"), { recursive: true }),
  ]);
  await writeFile(
    path.join(cwd, "DO-NOT-TRANSFER.txt"),
    "working-tree bytes are not runtime assets\n",
  );
  await writeFile(
    path.join(repository, "KEEP.txt"),
    "retain existing repository\n",
  );
  const instructions = path.join(scratch, "RUNTIME-INSTRUCTIONS.md");
  await writeFile(instructions, "Authorized runtime instruction asset.\n");
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, "config"));
  vi.stubEnv("OPENCODE_ALLOW_ALL_MODELS", "");
  io.provider.mockImplementation(
    async (
      _run: string,
      _target: AdapterExecutionTarget,
      _command: string,
      args: string[],
    ) => providerResult(adapter.adapterType, args),
  );
  const ssh = {
    host: "127.0.0.1",
    port: 2222,
    username: "fixture",
    remoteWorkspacePath: root,
    remoteCwd: repository,
    privateKey: "fixture-not-a-credential",
    knownHosts: "fixture-known-hosts",
    strictHostKeyChecking: true,
  };
  const target: AdapterExecutionTarget = {
    kind: "remote",
    transport: "ssh",
    remoteCwd: repository,
    spec: ssh,
    workspaceRealization: {
      mode: "copy",
      authoritativeRoot: root,
      pathAliases: [],
      outboundRestorePaths: [],
    },
  };
  async function invoke(
    mode?: string,
    runtime?: AdapterExecutionContext["runtime"],
  ) {
    return adapter.execute({
      runId: randomUUID(),
      agent: {
        id: "fixture-agent",
        companyId: "fixture-company",
        name: "Fixture",
        adapterType: adapter.adapterType,
        adapterConfig: {},
      },
      runtime: runtime ?? {
        sessionId: null,
        sessionDisplayId: null,
        sessionParams: null,
        taskKey: "fixture-task",
      },
      config: {
        engine: "cli",
        command: adapter.command,
        instructionsFilePath: instructions,
        ...(adapter.adapterType === "opencode_local"
          ? { model: "opencode/gpt-5-nano" }
          : {}),
        ...(adapter.adapterType === "pi_local"
          ? { model: "openai/gpt-5.4-mini" }
          : {}),
        env: {
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, "config"),
          GROK_HOME: path.join(home, "grok"),
          KIMI_HOME: path.join(home, "kimi"),
        },
      },
      context: {
        issueId: "fixture-task",
        paperclipWorkspace: {
          cwd,
          source: "agent_home",
          ...(mode === undefined ? {} : { mode }),
        },
      },
      executionTarget: target,
      executionTransport: { remoteExecution: ssh },
      onLog: async () => {},
    });
  }
  function providerCalls() {
    return io.provider.mock.calls.filter(
      (call) => !isProbe(call[3] as string[]),
    );
  }
  return { cwd, root, repository, invoke, providerCalls };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function noCodeOutcome(
  f: Fixture,
  runtime?: AdapterExecutionContext["runtime"],
) {
  let result: Awaited<ReturnType<Fixture["invoke"]>> | undefined;
  let refusal: string | undefined;
  try {
    result = await f.invoke("no_code", runtime);
  } catch (error) {
    refusal = String(error);
  }
  if (result?.exitCode === 0 && !result.errorMessage)
    return { supported: true, result };
  // An unsupported adapter may fail closed, but not after copying a tree or
  // contacting the provider. Arbitrary harness/config failures are not passes.
  expect(refusal ?? String(result?.errorMessage ?? result?.errorCode)).toMatch(
    /no.code.*(unsupported|not.supported)|(unsupported|not.supported).*no.code/i,
  );
  expect(io.prepare).not.toHaveBeenCalled();
  expect(io.restore).not.toHaveBeenCalled();
  expect(io.sync.mock.calls.some(([input]) => input.localDir === f.cwd)).toBe(
    false,
  );
  expect(io.provider).not.toHaveBeenCalled();
  expect(io.localProvider).not.toHaveBeenCalled();
  return { supported: false };
}

// Missing no-code/sync flags must fail against production adapter execution,
// not a regex over adapter source or a mocked prepareRuntime implementation.
describe.each(adapters)(
  "$adapterType remaining remote no-code acceptance",
  (adapter) => {
    afterEach(() => {
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });

    it("explicit no-code never seeds or restores a working tree", async () => {
      const f = await fixture(adapter);
      const outcome = await noCodeOutcome(f);
      if (!outcome.supported) return;
      expect(f.providerCalls()).toHaveLength(1);
      expect.soft(io.prepare).not.toHaveBeenCalled();
      expect.soft(io.restore).not.toHaveBeenCalled();
      expect(
        io.sync.mock.calls.some(([input]) => input.localDir === f.cwd),
      ).toBe(false);
      expect(
        await readFile(path.join(f.cwd, "DO-NOT-TRANSFER.txt"), "utf8"),
      ).toBe("working-tree bytes are not runtime assets\n");
      expect(await readFile(path.join(f.repository, "KEEP.txt"), "utf8")).toBe(
        "retain existing repository\n",
      );
    }, 20_000);

    it("explicit no-code provider cwd is non-repository under the authorized root", async () => {
      const f = await fixture(adapter);
      const outcome = await noCodeOutcome(f);
      if (!outcome.supported) return;
      expect(f.providerCalls()).toHaveLength(1);
      const target = f.providerCalls()[0][1] as { remoteCwd: string };
      expect(target.remoteCwd).not.toBe(f.repository);
      expect(target.remoteCwd.startsWith(`${f.root}/`)).toBe(true);
      expect(target.remoteCwd).not.toContain("existing-repository/");
    }, 20_000);

    it("explicit no-code never resumes a previously produced code-provider session", async () => {
      const f = await fixture(adapter);
      const prior = await f.invoke("isolated_workspace");
      expect(prior.exitCode).toBe(0);
      expect(prior.sessionId).toBeTruthy();
      expect(prior.sessionParams).toBeTruthy();
      const runtime = {
        sessionId: prior.sessionId ?? null,
        sessionDisplayId: prior.sessionDisplayId ?? null,
        sessionParams: prior.sessionParams ?? null,
        taskKey: "fixture-task",
      };
      vi.clearAllMocks();
      const outcome = await noCodeOutcome(f, runtime);
      if (!outcome.supported) return;
      expect(f.providerCalls()).toHaveLength(1);
      const argv = f.providerCalls().flatMap((call) => call[3] as string[]);
      expect(argv).not.toContain(prior.sessionId);
      expect(argv).not.toContain(sessionId);
      expect(argv).not.toContain("--resume");
      expect(argv).not.toContain("--continue");
    }, 20_000);

    it.each([undefined, "agent_default", "isolated_workspace"])(
      "ordinary mode %s retains working-tree seed and restore",
      async (mode) => {
        const f = await fixture(adapter);
        const result = await f.invoke(mode);
        expect(result.exitCode).toBe(0);
        expect(result.errorMessage).toBeFalsy();
        expect(f.providerCalls()).toHaveLength(1);
        expect(io.prepare).toHaveBeenCalledWith(
          expect.objectContaining({ localDir: f.cwd }),
        );
        expect(io.restore).toHaveBeenCalledWith(
          expect.objectContaining({ localDir: f.cwd }),
        );
        expect(io.localProvider).not.toHaveBeenCalled();
      },
      20_000,
    );
  },
);
