import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden, payloadTooLarge, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { stripSecretBearingUrlParts } from "../middleware/redact-sensitive.js";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { connectionIntentService } from "./connection-intents.js";
import { withGitHubOperationCredential } from "./github-operation-credentials.js";
import {
  createRunSecretRedactionRegistry,
  redactRegisteredSecretValues,
} from "./run-secret-redaction.js";

// Immutable IDs verified from Paperclip's project repository catalog.
export const GITHUB_DIAGNOSTIC_REPOSITORY_IDS = [
  "1396224242",
  "1396224001",
  "1319564297",
] as const;

export const GITHUB_DIAGNOSTIC_REPOSITORIES = {
  "1396224242": { owner: "TogetherWeOwn", repo: "two-bot-next" },
  "1396224001": { owner: "TogetherWeOwn", repo: "two-web-next" },
  "1319564297": { owner: "TogetherWeOwn", repo: "kofra" },
} as const satisfies Record<
  (typeof GITHUB_DIAGNOSTIC_REPOSITORY_IDS)[number],
  { owner: string; repo: string }
>;

const repositoryIdSchema = z.enum(GITHUB_DIAGNOSTIC_REPOSITORY_IDS);
const positiveJobIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);

export const githubActionsJobLogsInputSchema = z.strictObject({
  repositoryId: repositoryIdSchema,
  jobId: positiveJobIdSchema,
});

export const githubRepositoryWebhooksInputSchema = z.strictObject({
  repositoryId: repositoryIdSchema,
});

export type GitHubReadRunClaims = Pick<
  RuntimeToolsTokenClaims,
  "sub" | "company_id" | "run_id" | "responsible_user_id"
>;

type RepositoryId = (typeof GITHUB_DIAGNOSTIC_REPOSITORY_IDS)[number];
type FetchLike = typeof fetch;

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_WEBHOOK_RESPONSE_BYTES = 512 * 1024;
const MAX_WEBHOOKS = 100;
const LOG_DOWNLOAD_HOST = /^productionresultssa\d+\.blob\.core\.windows\.net$/i;
// Secret-name affixes are bounded so these patterns stay linear on a 1 MiB log made of
// long dash- or underscore-joined runs. An unbounded affix backtracks quadratically.
const SECRET_NAME = String.raw`[A-Za-z0-9_-]{0,64}(?:api[-_]?key|(?:access[-_]?|auth[-_]?|refresh[-_]?|id[-_]?)?token|secret|passw(?:or)?d|credential|private[-_]?key|cookie|connection[-_]?string|jwt|bearer|authorization|signature|sig)[A-Za-z0-9_-]{0,64}`;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const PROVIDER_KEY_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,})\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const PEM_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g;
const ADD_MASK_PATTERN = /(::add-mask::)\S*/gi;
const BEARER_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi;
const AUTHORIZATION_PATTERN = /\b(authorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?)[^\s,;]+/gi;
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]{1,200}:[^\s/@]{1,200}@/gi;
const JSON_SECRET_FIELD_PATTERN = new RegExp(String.raw`("(?:${SECRET_NAME})"\s*:\s*")(?:\\.|[^"\\])*"`, "gi");
const CLI_SECRET_OPTION_PATTERN = new RegExp(String.raw`(\B--?${SECRET_NAME}(?:=|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)`, "gi");
const SECRET_ASSIGNMENT_PATTERN = new RegExp(String.raw`(\b${SECRET_NAME}\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;"']+)`, "gi");
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const REDACTED = "[REDACTED]";

function repositoryApiUrl(repositoryId: RepositoryId, resource: string) {
  const repository = GITHUB_DIAGNOSTIC_REPOSITORIES[repositoryId];
  return new URL(
    `/repos/${repository.owner}/${repository.repo}/${resource}`,
    GITHUB_API_BASE,
  );
}

function repositoryLabel(repositoryId: RepositoryId) {
  const repository = GITHUB_DIAGNOSTIC_REPOSITORIES[repositoryId];
  return `${repository.owner}/${repository.repo}`;
}

function githubHeaders(token: string, accept: string) {
  return new Headers({
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  });
}

async function fetchWithoutLeakingErrors(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
) {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw unprocessable("GitHub read operation could not be completed");
  }
}

async function discardBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already being discarded; never surface provider details.
  }
}

async function readBoundedText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - byteLength;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        byteLength = maxBytes;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // The bounded prefix is sufficient; do not expose stream errors.
        }
        break;
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } catch {
    throw unprocessable("GitHub read operation could not be completed");
  } finally {
    reader.releaseLock();
  }

  return {
    text: new TextDecoder().decode(Buffer.concat(chunks, byteLength)),
    truncated,
  };
}

function checkedLogDownloadUrl(location: string | null) {
  if (!location) throw unprocessable("GitHub did not provide a job-log download URL");
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw forbidden("GitHub returned an invalid job-log redirect");
  }
  // The endpoint's temporary download link is fetched without GitHub authorization.
  // Only the Actions log-storage host family observed by this integration is accepted.
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.hash
    || !LOG_DOWNLOAD_HOST.test(url.hostname)
  ) {
    // Hostname only: operators need it to confirm the allowlist, and the path and query can carry signed values.
    logger.warn({ host: url.hostname.slice(0, 255) }, "Rejected unapproved GitHub job-log redirect host");
    throw forbidden("GitHub returned an unapproved job-log redirect");
  }
  return url.toString();
}

export function sanitizeGitHubDiagnosticText(value: string, secretValues: string[]) {
  return redactRegisteredSecretValues(value, secretValues)
    .replace(PEM_BLOCK_PATTERN, "[REDACTED PRIVATE KEY]")
    .replace(ADD_MASK_PATTERN, `$1${REDACTED}`)
    .replace(GITHUB_TOKEN_PATTERN, REDACTED)
    .replace(PROVIDER_KEY_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(AUTHORIZATION_PATTERN, `$1${REDACTED}`)
    .replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}@`)
    .replace(JSON_SECRET_FIELD_PATTERN, `$1${REDACTED}"`)
    .replace(CLI_SECRET_OPTION_PATTERN, `$1${REDACTED}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED}`)
    .replace(URL_PATTERN, stripSecretBearingUrlParts);
}

// A log cut at the byte cap can end inside a secret. Keep only complete whitespace-delimited
// text so a partial token never reaches the sanitizer's blind spot.
function dropTrailingPartialToken(value: string) {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(value[index]!)) return value.slice(0, index);
  }
  return "";
}

function sanitizeStrings(value: unknown, secretValues: string[]): unknown {
  if (typeof value === "string") return sanitizeGitHubDiagnosticText(value, secretValues);
  if (Array.isArray(value)) return value.map((entry) => sanitizeStrings(entry, secretValues));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeStrings(entry, secretValues)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeString(value: unknown, maxLength = 160): string | null {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function sanitizeWebhook(value: unknown) {
  const hook = asRecord(value);
  if (!hook) return null;
  const config = asRecord(hook.config);
  const insecureSsl = config?.insecure_ssl === "1"
    ? true
    : config?.insecure_ssl === "0"
      ? false
      : null;
  return {
    id: typeof hook.id === "number" && Number.isSafeInteger(hook.id) ? hook.id : null,
    name: safeString(hook.name),
    type: safeString(hook.type),
    active: typeof hook.active === "boolean" ? hook.active : null,
    events: Array.isArray(hook.events)
      ? hook.events
          .filter((event): event is string => typeof event === "string")
          .slice(0, 100)
          .map((event) => event.slice(0, 100))
      : [],
    createdAt: safeString(hook.created_at, 64),
    updatedAt: safeString(hook.updated_at, 64),
    config: {
      contentType: safeString(config?.content_type, 40),
      insecureSsl,
    },
  };
}

export function githubReadOperationsService(
  db: Db,
  deps: { fetch?: FetchLike } = {},
) {
  const runContext = connectionIntentService(db);
  const secretRedaction = createRunSecretRedactionRegistry(db);
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function validateRun(claims: GitHubReadRunClaims) {
    await runContext.validate(claims);
  }

  async function withRunCredential<T>(
    claims: GitHubReadRunClaims,
    operation: Parameters<typeof withGitHubOperationCredential<T>>[2],
  ): Promise<T> {
    await validateRun(claims);
    return withGitHubOperationCredential(
      db,
      {
        companyId: claims.company_id,
        agentId: claims.sub,
        runId: claims.run_id,
      },
      operation,
    );
  }

  return {
    actionsJobLogs: async (claims: GitHubReadRunClaims, input: unknown) => {
      const parsed = githubActionsJobLogsInputSchema.parse(input);
      return withRunCredential(claims, async (credential) => {
        const apiUrl = repositoryApiUrl(parsed.repositoryId, `actions/jobs/${parsed.jobId}/logs`);
        const response = await fetchWithoutLeakingErrors(fetchImpl, apiUrl.toString(), {
          method: "GET",
          headers: githubHeaders(credential.token, "application/vnd.github+json"),
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.status !== 302) {
          await discardBody(response);
          throw unprocessable("GitHub Actions job logs are unavailable");
        }
        const downloadUrl = checkedLogDownloadUrl(response.headers.get("location"));
        await discardBody(response);

        const download = await fetchWithoutLeakingErrors(fetchImpl, downloadUrl, {
          method: "GET",
          headers: new Headers({ Accept: "text/plain" }),
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (download.status !== 200) {
          await discardBody(download);
          throw unprocessable("GitHub Actions job logs could not be downloaded");
        }
        const contentType = download.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType && !["text/plain", "application/octet-stream"].includes(contentType)) {
          await discardBody(download);
          throw unprocessable("GitHub returned an unsupported job-log format");
        }
        const body = await readBoundedText(download, MAX_LOG_BYTES);
        const registeredRedactions = await secretRedaction.redactForRun(
          claims.company_id,
          claims.run_id,
          body.text,
        );
        const logs = sanitizeGitHubDiagnosticText(
          body.truncated ? dropTrailingPartialToken(registeredRedactions) : registeredRedactions,
          credential.token ? [credential.token] : [],
        );
        return {
          repositoryId: parsed.repositoryId,
          repository: repositoryLabel(parsed.repositoryId),
          jobId: parsed.jobId,
          logs,
          truncated: body.truncated,
        };
      });
    },

    repositoryWebhooks: async (claims: GitHubReadRunClaims, input: unknown) => {
      const parsed = githubRepositoryWebhooksInputSchema.parse(input);
      return withRunCredential(claims, async (credential) => {
        const url = repositoryApiUrl(parsed.repositoryId, "hooks");
        url.searchParams.set("per_page", String(MAX_WEBHOOKS));
        url.searchParams.set("page", "1");
        const response = await fetchWithoutLeakingErrors(fetchImpl, url.toString(), {
          method: "GET",
          headers: githubHeaders(credential.token, "application/vnd.github+json"),
          redirect: "error",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.status !== 200) {
          await discardBody(response);
          throw unprocessable("GitHub repository webhooks are unavailable");
        }
        const body = await readBoundedText(response, MAX_WEBHOOK_RESPONSE_BYTES);
        if (body.truncated) throw payloadTooLarge("GitHub webhook response exceeded the allowed size");

        let hooks: unknown;
        try {
          hooks = JSON.parse(body.text);
        } catch {
          throw unprocessable("GitHub returned an invalid webhook response");
        }
        if (!Array.isArray(hooks)) throw unprocessable("GitHub returned an invalid webhook response");
        const safeHooks = hooks.slice(0, MAX_WEBHOOKS).map(sanitizeWebhook).filter((hook) => hook !== null);
        const redacted = await secretRedaction.redactForRun(
          claims.company_id,
          claims.run_id,
          {
            repositoryId: parsed.repositoryId,
            repository: repositoryLabel(parsed.repositoryId),
            webhooks: safeHooks,
            pageLimitReached: hooks.length >= MAX_WEBHOOKS,
          },
        );
        return sanitizeStrings(redacted, credential.token ? [credential.token] : []);
      });
    },
  };
}
