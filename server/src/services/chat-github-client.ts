import { createPrivateKey, createSign } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import { conflict, forbidden, unprocessable } from "../errors.js";

export function githubAppJwt(
  appId: string,
  privateKey: string,
  now = new Date(),
): string {
  const epoch = Math.floor(now.getTime() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: epoch - 60, exp: epoch + 540, iss: appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(createPrivateKey(privateKey)).toString("base64url")}`;
}

/** Fixed origin, no redirects, bounded responses, no credential-bearing errors. */
export async function githubBotRequest<T>(
  fetchImpl: typeof fetch,
  token: string | null,
  path: string,
  options: { method?: string; body?: unknown; accept?: string } = {},
): Promise<T> {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  )
    throw forbidden("Invalid GitHub operation path");
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      method: options.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
      headers: {
        accept: options.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  } catch {
    throw unprocessable(
      "GitHub is temporarily unavailable. Retry this operation.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw unprocessable(
      `GitHub rejected this operation (HTTP ${response.status}). Check the App installation and repository permissions.`,
      { code: "github_bot_operation_failed", providerStatus: response.status },
    );
  }
  if (response.status === 204) return undefined as T;
  const reader = response.body?.getReader();
  if (!reader) throw unprocessable("GitHub returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024)
        throw unprocessable(
          "GitHub response exceeds the review limit. Narrow the request or report incomplete coverage.",
        );
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return (options.accept?.includes("diff") ? body : JSON.parse(body)) as T;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Resolve only this endpoint's vaulted App. Never consult personal grants. */
export async function githubBotCredentials(
  db: Db,
  companyId: string,
  endpointId: string,
) {
  const [row] = await db
    .select({ endpoint: chatEndpoints, connection: toolConnections })
    .from(chatEndpoints)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, chatEndpoints.connectionId),
        eq(toolConnections.companyId, companyId),
      ),
    )
    .where(
      and(
        eq(chatEndpoints.companyId, companyId),
        eq(chatEndpoints.id, endpointId),
        eq(chatEndpoints.provider, "github"),
      ),
    );
  if (!row || ["archived", "revoked", "paused"].includes(row.endpoint.status))
    throw conflict("GitHub bot connection is unavailable");
  const secrets = secretService(db);
  const credentials: Record<string, string> = {};
  for (const key of [
    "appId",
    "privateKey",
    "installationId",
    "webhookSecret",
  ]) {
    const ref = row.connection.credentialSecretRefs.find(
      (r) => r.configPath === `credentials.${key}`,
    );
    if (!ref) continue;
    credentials[key] = await secrets.resolveSecretValue(
      companyId,
      ref.secretId,
      ref.versionSelector ?? "latest",
      {
        consumerType: "tool_connection",
        consumerId: row.connection.id,
        configPath: ref.configPath,
        actorType: "system",
        actorId: null,
      },
    );
  }
  if (!credentials.appId || !credentials.privateKey)
    throw conflict("Connect the GitHub App before continuing");
  return {
    ...row,
    credentials,
    appJwt: githubAppJwt(credentials.appId, credentials.privateKey),
  };
}

/** Least-privilege short-lived token restricted to the single task repository. */
const INSTALLATION_TOKEN_SKEW_MS = 60_000;
const INSTALLATION_TOKEN_CACHE_MAX = 500;
const INSTALLATION_TOKEN_FALLBACK_TTL_MS = 55 * 60_000;

type InstallationTokenEntry = { token: string; expiresAtMs: number };
const installationTokenCache = new Map<string, InstallationTokenEntry>();
const installationTokenInflight = new Map<string, Promise<string>>();

function installationTokenCacheKey(input: {
  companyId: string;
  endpointId: string;
  installationId: string;
  repositoryId: string;
}): string {
  return `${input.companyId}:${input.endpointId}:${input.installationId}:${input.repositoryId}`;
}

function readCachedInstallationToken(key: string, now: number): string | null {
  const entry = installationTokenCache.get(key);
  if (!entry) return null;
  if (now >= entry.expiresAtMs - INSTALLATION_TOKEN_SKEW_MS) {
    installationTokenCache.delete(key);
    return null;
  }
  // Refresh recency without reordering expiry semantics.
  installationTokenCache.delete(key);
  installationTokenCache.set(key, entry);
  return entry.token;
}

function storeInstallationToken(key: string, token: string, expiresAtMs: number): void {
  if (installationTokenCache.has(key)) installationTokenCache.delete(key);
  while (installationTokenCache.size >= INSTALLATION_TOKEN_CACHE_MAX) {
    const oldest = installationTokenCache.keys().next();
    if (oldest.done) break;
    installationTokenCache.delete(oldest.value);
  }
  installationTokenCache.set(key, { token, expiresAtMs });
}

export const __installationTokenTestSeams = {
  key: installationTokenCacheKey,
  read: readCachedInstallationToken,
  store: storeInstallationToken,
  skewMs: INSTALLATION_TOKEN_SKEW_MS,
  max: INSTALLATION_TOKEN_CACHE_MAX,
} as const;

/**
 * Drop cached tokens for one repository. The key embeds the installation id,
 * which callers do not hold, so match by company/endpoint/repository affixes.
 * Used when GitHub rejects a cached token (401): the App may have been
 * suspended, re-installed, or re-scoped mid-TTL. Returns evicted count.
 */
export function evictGithubBotRepositoryToken(input: {
  companyId: string;
  endpointId: string;
  repositoryId: string;
}): number {
  const prefix = `${input.companyId}:${input.endpointId}:`;
  const suffix = `:${input.repositoryId}`;
  let evicted = 0;
  for (const key of [...installationTokenCache.keys()]) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      installationTokenCache.delete(key);
      evicted += 1;
    }
  }
  return evicted;
}

/** Test seam only. Never exposes token material. */
export function __clearGithubBotTokenCacheForTests(): void {
  installationTokenCache.clear();
  for (const [, pending] of installationTokenInflight) pending.catch(() => {});
  installationTokenInflight.clear();
}

export async function githubBotRepositoryToken(
  db: Db,
  companyId: string,
  endpointId: string,
  repositoryId: string,
  fetchImpl = fetch,
) {
  const result = await githubBotCredentials(db, companyId, endpointId);
  if (
    !result.connection.enabled ||
    result.connection.status !== "active" ||
    !["active", "verifying"].includes(result.endpoint.status)
  )
    throw conflict("GitHub bot connection is not active");
  if (
    !result.credentials.installationId ||
    !/^[1-9][0-9]*$/.test(repositoryId) ||
    !Number.isSafeInteger(Number(repositoryId))
  )
    throw conflict("Verify the GitHub App installation first");
  const key = installationTokenCacheKey({
    companyId,
    endpointId,
    installationId: result.credentials.installationId,
    repositoryId,
  });
  const cached = readCachedInstallationToken(key, Date.now());
  if (cached) return cached;
  const ongoing = installationTokenInflight.get(key);
  if (ongoing) return ongoing;
  const issue = (async () => {
    const issued = await githubBotRequest<{ token?: string; expires_at?: string }>(
      fetchImpl,
      result.appJwt,
      `/app/installations/${encodeURIComponent(result.credentials.installationId)}/access_tokens`,
      {
        method: "POST",
        body: {
          repository_ids: [Number(repositoryId)],
          permissions: {
            contents: "read",
            metadata: "read",
            issues: "write",
            pull_requests: "write",
            checks: "write",
          },
        },
      },
    );
    if (!issued.token)
      throw unprocessable("GitHub did not issue an installation token");
    const parsed = typeof issued.expires_at === "string" ? Date.parse(issued.expires_at) : Number.NaN;
    storeInstallationToken(
      key,
      issued.token,
      Number.isFinite(parsed) ? parsed : Date.now() + INSTALLATION_TOKEN_FALLBACK_TTL_MS,
    );
    return issued.token;
  })();
  installationTokenInflight.set(key, issue);
  try {
    return await issue;
  } finally {
    installationTokenInflight.delete(key);
  }
}

/**
 * Authenticated GitHub request for one repository. Reuses the cached
 * installation token; when GitHub rejects it with 401 (revoked or re-scoped
 * mid-TTL), evicts the entry and retries once with a freshly issued token.
 * Only the first 401 retries — a second 401 propagates to the caller.
 */
export async function githubBotRepositoryRequest<T>(
  db: Db,
  companyId: string,
  endpointId: string,
  repositoryId: string,
  path: string,
  options: Parameters<typeof githubBotRequest>[3] = {},
  fetchImpl = fetch,
): Promise<T> {
  const token = await githubBotRepositoryToken(db, companyId, endpointId, repositoryId, fetchImpl);
  try {
    return await githubBotRequest<T>(fetchImpl, token, path, options);
  } catch (error) {
    const providerStatus = (error as { details?: { providerStatus?: unknown } })
      ?.details?.providerStatus;
    if (providerStatus !== 401) throw error;
    evictGithubBotRepositoryToken({ companyId, endpointId, repositoryId });
    const fresh = await githubBotRepositoryToken(db, companyId, endpointId, repositoryId, fetchImpl);
    return githubBotRequest<T>(fetchImpl, fresh, path, options);
  }
}
