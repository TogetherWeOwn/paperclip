import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";
import {
  RUN_PID_LIMIT_EXCEEDED,
  resolveRunPidLimit,
} from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta, authToken } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config, and PAPERCLIP_API_KEY is
    // never accepted from config — the harness-minted run token is the only
    // source. Other PAPERCLIP_* keys Paperclip did not assign flow through.
    if (isForbiddenConfigEnvKey(k)) continue;
    if (isPaperclipRuntimeEnvKey(k) && k in env) continue;
    env[k] = v;
  }
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  // runtimeEnv is only used to resolve the command path and log HOME below;
  // the child env is built inside runChildProcess from
  // sanitizeInheritedPaperclipEnv(process.env) + env, so a PAPERCLIP_API_KEY
  // on the server process never reaches the child.
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const runPidLimit = resolveRunPidLimit(config.runPidLimit);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    pidLimit: runPidLimit,
    onLog,
    onSpawn: ctx.onSpawn,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  // A typed transport failure (today: the per-run PID budget) fails the run
  // even without a nonzero exit: the SIGTERM-kill shape is exitCode null +
  // signal SIGTERM, which the exitCode test below would read as success and
  // drop the typed code. Signal-only kills without an errorCode keep the
  // historical success shape (terminal-result cleanup relies on it).
  if (proc.errorCode) {
    const pidLimit = proc.errorCode === RUN_PID_LIMIT_EXCEEDED;
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: pidLimit
        ? `Run PID limit exceeded (budget ${proc.pidStats?.limit ?? runPidLimit}); this run only was stopped`
        : `Process failed (${proc.errorCode})`,
      errorCode: proc.errorCode,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        ...(proc.pidStats ? { pidStats: proc.pidStats } : {}),
      },
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      errorCode: proc.errorCode ?? null,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
        ...(proc.pidStats ? { pidStats: proc.pidStats } : {}),
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
      ...(proc.pidStats ? { pidStats: proc.pidStats } : {}),
    },
  };
}
