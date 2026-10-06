import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

/**
 * `adapterConfig.isolateRuntime: true` is for an agent that reads untrusted
 * input. When set, the Claude child starts from an empty environment and
 * receives only {@link isolatedRuntimeEnv}: the agent's explicit model/auth
 * bindings, PATH/HOME/temp/locale basics, the run's Paperclip identity keys,
 * and the harness-minted run token exactly as today. It inherits nothing from
 * the server process. Nothing is persisted to disk.
 *
 * Off by default, so no other agent changes behavior. Older builds ignore the
 * unknown flag and run as before; this build refuses the ACP engine and
 * remote targets under the flag rather than running them un-isolated.
 */
export function isIsolatedRuntime(config: unknown): boolean {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
  return asBoolean((config as Record<string, unknown>).isolateRuntime, false);
}

// Explicit non-harness keys the child may see, taken from the adapter-built
// env (explicit agent/model bindings). Every entry is either a provider
// credential the agent is bound to or a model-selection key the CLI reads.
// Anything else server- or project-named (GH_*, GIT_*, DATABASE_URL, bare
// TOKEN/SECRET names) is denied by default.
const FROM_ADAPTER_ENV = [
  // Claude and Anthropic subscription and API auth.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CONFIG_DIR",
  // AWS Bedrock inference.
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  // Vertex inference. Taken only from explicit agent bindings, never probed.
  "CLAUDE_CODE_USE_VERTEX",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

// Taken from the adapter env when present, else from the server process (a
// child needs a PATH/HOME/temp/locale to start; these carry no credentials).
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

// Proxy selection for networkScope="allowlist" runs. Adapter bindings win;
// the server fallback keeps an allowlisted run's egress proxy working.
const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export const CLAUDE_ISOLATED_RUNTIME_ENV_KEYS: readonly string[] = [
  ...FROM_ADAPTER_ENV,
  ...PLATFORM_BASICS,
  ...PROXY_KEYS,
];

/**
 * Build the isolated child env. `PAPERCLIP_*` keys the adapter assigned for
 * this run (agent/company/run/task ids, wake/approval context, workspace and
 * runtime descriptors, the API URL, and the harness-minted `PAPERCLIP_API_KEY`
 * run token) pass by prefix: they are per-run harness namespace, never server
 * secrets, and the invoke record lists exactly this set for the CISO re-read.
 * Every other key must be named above; unknown server names never pass.
 */
export function isolatedRuntimeEnv(
  adapterEnv: Record<string, string>,
  serverEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FROM_ADAPTER_ENV) {
    const value = adapterEnv[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  for (const [key, value] of Object.entries(adapterEnv)) {
    if (!key.startsWith("PAPERCLIP_")) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    out[key] = value;
  }
  for (const key of [...PLATFORM_BASICS, ...PROXY_KEYS]) {
    const value = adapterEnv[key] ?? serverEnv[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}
