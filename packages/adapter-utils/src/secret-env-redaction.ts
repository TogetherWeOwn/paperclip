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

export type SecretEnvRedactionStream = {
  /** Redact a chunk, holding back a bounded tail that may start a secret. */
  push(chunk: string): string;
  /** Emit whatever is still held back once the stream has ended. */
  flush(): string;
};

/**
 * Redacting each chunk independently misses a secret that straddles a chunk
 * boundary: a child writing more than one pipe buffer of output (`printenv` on
 * a large env, say) can split a value across two `data` events, and neither
 * half matches on its own, so the secret lands in the log verbatim.
 *
 * This keeps the trailing `longestSecret - 1` characters back until the next
 * chunk arrives, so a straddling value is matched once its second half shows
 * up. The held-back tail is bounded by the longest denylisted value and is
 * released by `flush()` at stream end.
 */
export function createSecretEnvRedactionStream(
  secretValues: readonly string[],
  redactedValue: string = REDACTED_SECRET_ENV_VALUE,
): SecretEnvRedactionStream {
  const values = [...new Set(secretValues)].sort((a, b) => b.length - a.length);
  if (values.length === 0) {
    return { push: (chunk) => chunk, flush: () => "" };
  }

  const matchers = values.map((value) => {
    const fallback = new Uint32Array(value.length);
    for (let i = 1, matched = 0; i < value.length; i += 1) {
      while (matched > 0 && value[i] !== value[matched]) {
        matched = fallback[matched - 1] ?? 0;
      }
      if (value[i] === value[matched]) matched += 1;
      fallback[i] = matched;
    }
    return { value, fallback };
  });
  const maxSecretLength = values[0]?.length ?? 0;
  let carry = "";
  return {
    push(chunk: string): string {
      if (!chunk) return "";
      const combined = carry + chunk;
      const scanStart = Math.max(0, combined.length - (maxSecretLength * 2 - 2));
      const scanText = combined.slice(scanStart);
      const unsafeBoundaryDiff = new Int32Array(scanText.length + 1);
      const suffixMatches: Array<{ fallback: Uint32Array; length: number }> = [];

      for (const { value, fallback } of matchers) {
        let matched = 0;
        for (let i = 0; i < scanText.length; i += 1) {
          while (matched > 0 && scanText[i] !== value[matched]) {
            matched = fallback[matched - 1] ?? 0;
          }
          if (scanText[i] === value[matched]) matched += 1;
          if (matched !== value.length) continue;

          // A carry boundary inside a complete match would emit its prefix
          // unredacted. Mark those interior boundaries as unsafe, including
          // overlapping matches, then continue from the match's longest border.
          const matchStart = i - value.length + 1;
          unsafeBoundaryDiff[matchStart + 1] += 1;
          unsafeBoundaryDiff[i + 1] -= 1;
          matched = fallback[matched - 1] ?? 0;
        }
        suffixMatches.push({ fallback, length: matched });
      }

      const unsafeBoundaries = new Int32Array(scanText.length + 1);
      for (let i = 0, active = 0; i < unsafeBoundaryDiff.length; i += 1) {
        active += unsafeBoundaryDiff[i] ?? 0;
        unsafeBoundaries[i] = active;
      }

      let carryStart = combined.length;
      for (const { fallback, length: longestSuffix } of suffixMatches) {
        let length = longestSuffix;
        while (length > 0) {
          const start = combined.length - length;
          if ((unsafeBoundaries[start - scanStart] ?? 0) === 0) {
            carryStart = Math.min(carryStart, start);
            break;
          }
          length = fallback[length - 1] ?? 0;
        }
      }

      carry = combined.slice(carryStart);
      return redactKnownSecretEnvValues(
        combined.slice(0, carryStart),
        values,
        redactedValue,
      );
    },
    flush(): string {
      const remaining = redactKnownSecretEnvValues(carry, values, redactedValue);
      carry = "";
      return remaining;
    },
  };
}
