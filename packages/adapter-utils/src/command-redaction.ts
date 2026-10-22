export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

// These exact public Executor helper addresses resemble dotted bearer tokens.
// Do not exempt arbitrary provider paths, prefixes, or user-defined selectors.
const PUBLIC_EXECUTOR_TOOL_SELECTORS = new Set([
  "executor.coreTools.integrations.list",
  "executor.coreTools.connections.list",
  "executor.coreTools.policies.list",
]);
export function isPublicExecutorToolSelector(value: string): boolean {
  return PUBLIC_EXECUTOR_TOOL_SELECTORS.has(value);
}

// Bound the [A-Za-z0-9_-] affixes to {0,64} around the secret keyword core.
// Unbounded `*` affixes backtrack quadratically on long dash runs through the
// unanchored option/assignment/JSON regexes below (every `-` is a `\b` start
// that re-scans): a 16KB dashy access-log line cost ~80ms in the assignment
// regex alone, stalling the event loop on unauthenticated input. Same bound as
// the server SECRET_FIELD_NAME_PATTERN; names with longer affixes are not
// masked there either.
const SECRET_NAME_PATTERN = String.raw`[A-Za-z0-9_-]{0,64}(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]{0,64}`;

const COMMAND_CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${SECRET_NAME_PATTERN}(?:\s+|=)(["']?))[^\s"'` +
    "`" +
    String.raw`]+(\2)`,
  "gi",
);
const COMMAND_ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${SECRET_NAME_PATTERN}\s*=\s*)(?:(\\["'])([\s\S]*?)\2|(["'])([^"'` +
    "`" +
    String.raw`\r\n]*)\4|([^\s"'` +
    "`" +
    String.raw`]+))`,
  "gi",
);
const COMMAND_AUTHORIZATION_BEARER_RE =
  /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g;
// A JWT-shaped secret is a dot run containing a window of three or four long
// segments. This scan is match-then-validate: the run matcher is a leading
// char plus one greedy class with no required trailing literal, so it
// consumes each input char once (linear). A single-regexp three-segment match
// is quadratic here instead — every `-` is a `\b` start that greedily
// consumes the run and backtracks it looking for a dot (~180ms for a 16KB
// dashy line), stalling the event loop on unauthenticated input. Windows are
// validated per token in redactJwtWindows below.
const COMMAND_JWT_RUN_RE = /[A-Za-z0-9_-][A-Za-z0-9_.-]*/g;
const COMMAND_JWT_SEGMENT_RE = /^[A-Za-z0-9_-]{8,}$/;
const COMMAND_SECRET_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
] as const;

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  return (
    COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) ||
    command.includes(".")
  );
}

/**
 * Length of the JWT window (greedy 4 like the old optional fourth segment,
 * else 3) starting at segment `start`, or 0 when no window opens there.
 */
function jwtWindowLength(segments: string[], start: number): 0 | 3 | 4 {
  const first = segments[start];
  const second = segments[start + 1];
  const third = segments[start + 2];
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    !COMMAND_JWT_SEGMENT_RE.test(first) ||
    !COMMAND_JWT_SEGMENT_RE.test(second) ||
    !COMMAND_JWT_SEGMENT_RE.test(third)
  ) {
    return 0;
  }
  const fourth = segments[start + 3];
  if (fourth !== undefined && COMMAND_JWT_SEGMENT_RE.test(fourth)) {
    return 4;
  }
  return 3;
}

/**
 * Whether the run suffix starting at char `start` is exactly a known public
 * helper address. Compared in place so a many-segment run never re-joins a
 * suffix per window (that would be quadratic in the segment count).
 */
function isPublicSelectorSuffix(run: string, start: number): boolean {
  for (const selector of PUBLIC_EXECUTOR_TOOL_SELECTORS) {
    if (
      run.length - start === selector.length &&
      run.startsWith(selector, start)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Redact JWT windows inside one dot run. Windows are non-overlapping and
 * emitted left to right, so a 7-segment run redacts as two windows exactly
 * like the old global match; the exemption still applies to the complete
 * address from the window start, so a longer secret sharing a public prefix
 * stays redacted. Runs without dots, short segments, and exact public helper
 * addresses pass through unchanged.
 */
function redactJwtWindows(run: string, redactedValue: string): string {
  if (!run.includes(".")) return run;
  const segments = run.split(".");
  const offsets: number[] = new Array(segments.length);
  let offset = 0;
  for (let i = 0; i < segments.length; i += 1) {
    offsets[i] = offset;
    offset += (segments[i] as string).length + 1;
  }
  const parts: string[] = [];
  let index = 0;
  while (index < segments.length) {
    const window = jwtWindowLength(segments, index);
    const start = offsets[index] as number;
    if (window > 0 && !isPublicSelectorSuffix(run, start)) {
      parts.push(redactedValue);
      index += window;
    } else {
      parts.push(segments[index] as string);
      index += 1;
    }
  }
  return parts.join(".");
}

export function redactCommandText(
  command: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!maybeContainsSecretText(command)) return command;
  return command
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1${redactedValue}$3`)
    .replace(
      COMMAND_ENV_SECRET_ASSIGNMENT_RE,
      (
        _match,
        prefix: string,
        escapedQuote: string | undefined,
        _escapedValue: string | undefined,
        rawQuote: string | undefined,
      ) => {
        const quote = escapedQuote ?? rawQuote;
        return quote
          ? `${prefix}${quote}${redactedValue}${quote}`
          : `${prefix}${redactedValue}`;
      },
    )
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RUN_RE, (run) =>
      redactJwtWindows(run, redactedValue),
    );
}

// A JSON secret field is a key/value pair such as `"token":"opaque-value"`. The
// command redaction handles shell `KEY=value` syntax only. A sandbox diagnostic
// can also carry a serialized JSON error, so the sanitizer must redact the JSON
// form too. The value body consumes JSON escape sequences. An escaped quote
// (`\"`) inside the value does not end the match early.
const JSON_SECRET_FIELD_RE = new RegExp(
  String.raw`("(?:${SECRET_NAME_PATTERN})"\s*:\s*")(?:\\[\s\S]|[^"\\])*(")`,
  "gi",
);
// An escaped JSON secret field is the same pair inside a JSON string. The double
// quote appears as `\"` and a backslash appears as `\\`. The value body
// consumes the doubled escape sequences. An escaped quote inside the value does
// not end the match early. The value ends at the next unescaped `\"`.
const JSON_ESCAPED_SECRET_FIELD_RE = new RegExp(
  String.raw`(\\"(?:${SECRET_NAME_PATTERN})\\"\s*:\s*\\")(?:\\\\\\\\|\\\\\\"|\\\\[\s\S]|[^\\"])*(\\")`,
  "gi",
);

/**
 * Redact secrets from an untrusted diagnostic string.
 *
 * The function first runs the command redaction. The command redaction handles
 * shell `KEY=value` assignments, CLI secret options, bearer headers, and common
 * token shapes. The function then redacts JSON and escaped-JSON secret fields,
 * because a sandbox diagnostic can carry a serialized JSON error such as
 * `{"token":"opaque-value"}`. The caller must still bound the length after this
 * step.
 */
export function redactDiagnosticText(
  text: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  return redactCommandText(text, redactedValue)
    .replace(JSON_ESCAPED_SECRET_FIELD_RE, `$1${redactedValue}$2`)
    .replace(JSON_SECRET_FIELD_RE, `$1${redactedValue}$2`);
}
