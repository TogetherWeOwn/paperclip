export const REDACTED_SECRET_ENV_VALUE = "***REDACTED***";

// Static denylist of env var NAMES known to carry live secret material.
// A redactor must not learn its needles from a corpus of previously
// captured/leaked values (that would mean ingesting the very incident
// reports it exists to prevent). Extend this list by name only, never by
// feeding it captured secret values.
export const KNOWN_SECRET_ENV_VAR_NAMES: readonly string[] = [
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
  "PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET",
  "PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",
  "PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",
  "PAPERCLIP_ID_CONNECTOR_SEAL_PRIVATE_KEY",
  "PAPERCLIP_ID_CONNECTOR_SIGN_PRIVATE_KEY",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_BRIDGE_API_KEY",
  "PAPERCLIP_BRIDGE_TOKEN",
  "PAPERCLIP_GITHUB_TOKEN",
  "PAPERCLIP_GIT_TOKEN",
  "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
  "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN",
  "PAPERCLIP_TELEMETRY_BACKEND_TOKEN",
  "PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN",
  "PAPERCLIP_NATIVE_MCP_TOKEN",
  "PAPERCLIP_RUNTIME_TOOLS_TOKEN",
  "PAPERCLIP_DEV_SERVER_STATUS_TOKEN",
  "PAPERCLIP_WORKSPACE_READINESS_TOKEN",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "CURSOR_API_KEY",
  "CODEX_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_MODEL_API_KEY",
  "NOVITA_API_KEY",
  "DAYTONA_API_KEY",
  "E2B_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SLACK_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "CLIENT_SECRET",
  "AWS_SESSION_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
] as const;

// A short value (e.g. "1", "true", an empty string) is too likely to appear
// coincidentally in ordinary output; redacting it would corrupt unrelated
// text for no security benefit.
const MIN_REDACTABLE_VALUE_LENGTH = 6;

export function collectKnownSecretEnvValues(
  env: Record<string, string | undefined>,
  extraNames: readonly string[] = [],
): string[] {
  const names = new Set<string>([...KNOWN_SECRET_ENV_VAR_NAMES, ...extraNames]);
  const values = new Set<string>();
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length >= MIN_REDACTABLE_VALUE_LENGTH) {
      values.add(value);
    }
  }
  // Longest first: if one denylisted value happens to be a substring of
  // another, redact the longer (more specific) match first so it isn't
  // partially consumed by the shorter one.
  return Array.from(values).sort((a, b) => b.length - a.length);
}

export function redactKnownSecretEnvValues(
  text: string,
  secretValues: readonly string[],
  redactedValue: string = REDACTED_SECRET_ENV_VALUE,
): string {
  if (!text || secretValues.length === 0) return text;
  let result = text;
  // Longest first so a secret value that is a substring of another denylisted
  // value is not left partially exposed by an earlier, shorter replacement.
  for (const value of [...secretValues].sort((a, b) => b.length - a.length)) {
    if (!result.includes(value)) continue;
    result = result.split(value).join(redactedValue);
  }
  return result;
}
