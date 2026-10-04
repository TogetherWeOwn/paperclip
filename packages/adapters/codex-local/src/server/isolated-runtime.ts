import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

/**
 * `adapterConfig.isolateRuntime: true` is for an agent that reads untrusted
 * input. It removes ambient authority from the Codex process in three ways:
 *
 *  1. The child starts from an empty environment and receives only
 *     {@link isolatedRuntimeEnv}. It inherits nothing from the server and
 *     nothing from project, routine or environment bindings.
 *  2. No MCP gateway is written to `$CODEX_HOME/config.toml`, and any block an
 *     earlier build left there is stripped. The heartbeat also mints no gateway
 *     token for the run.
 *  3. The run's agent JWT is not placed in the process environment.
 *
 * Off by default, so no other agent changes behavior.
 */
export function isIsolatedRuntime(config: unknown): boolean {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
  return asBoolean((config as Record<string, unknown>).isolateRuntime, false);
}

// Names the child may see. Every entry is either a locale/path/temp basic or a
// non-secret run identifier. `OPENAI_API_KEY` is the one credential: it is the
// metered key this agent is bound to, and the CLI reads it from `auth.json`.
const FROM_ADAPTER_ENV = [
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_WAKE_REASON",
] as const;

// Taken from the adapter env when present (per-run temp dirs), else from the
// server process.
const PLATFORM_BASICS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
] as const;

export const ISOLATED_RUNTIME_ENV_KEYS: readonly string[] = [
  ...FROM_ADAPTER_ENV,
  ...PLATFORM_BASICS,
];

export function isolatedRuntimeEnv(
  adapterEnv: Record<string, string>,
  serverEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FROM_ADAPTER_ENV) {
    const value = adapterEnv[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  for (const key of PLATFORM_BASICS) {
    const value = adapterEnv[key] ?? serverEnv[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}
