import type { Db } from "@paperclipai/db";
import { projectGitAuthorizationService } from "./project-git-authorization.js";

export type CodeDeliveryPullRequestIdentity = {
  projectId: string;
  workspaceId: string;
  repository: string;
  repositoryId: string;
  number: number;
  baseRef: string;
  reviewedHeadSha: string;
};

export type CodeDeliveryPullRequestObservation = {
  repository: string;
  repositoryId: string;
  number: number;
  baseRef: string;
  headSha: string;
  draft: boolean;
  state: "open" | "closed" | "merged";
  mergedAt: string | null;
  mergeCommitSha: string | null;
  observedAt: string;
};

export type CodeDeliveryGitHubResult =
  | { status: "observed"; pullRequests: CodeDeliveryPullRequestObservation[] }
  | { status: "unavailable"; reason: "invalid_identity" | "authorization_unavailable" | "provider_unavailable" | "invalid_response" | "response_too_large" | "deadline_exceeded" };

type Options = { fetch?: typeof fetch };
type ObjectValue = Record<string, unknown>;
const MAX_PULL_REQUESTS = 16;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEADLINE_MS = 20_000;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const providerId = (value: unknown): string | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;

class Unavailable extends Error {
  constructor(readonly reason: Extract<CodeDeliveryGitHubResult, { status: "unavailable" }>["reason"]) {
    super(reason);
  }
}

function validIdentity(value: CodeDeliveryPullRequestIdentity): boolean {
  const parts = value.repository.split("/");
  return parts.length === 2 && /^[a-z0-9][a-z0-9-]{0,38}$/i.test(parts[0]!)
    && /^[a-z0-9_.-]{1,100}$/i.test(parts[1]!) && ![".", ".."].includes(parts[1]!)
    && /^[1-9][0-9]*$/.test(value.repositoryId) && value.repositoryId.length <= 20
    && Number.isSafeInteger(value.number) && value.number > 0
    && typeof value.baseRef === "string" && value.baseRef.length > 0 && value.baseRef.length <= 255
    && !/[\x00-\x20\x7f]/.test(value.baseRef) && sha(value.reviewedHeadSha)
    && typeof value.projectId === "string" && value.projectId.length > 0
    && typeof value.workspaceId === "string" && value.workspaceId.length > 0;
}

function mergedTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function parsePullRequest(value: unknown, expected: CodeDeliveryPullRequestIdentity): CodeDeliveryPullRequestObservation {
  const pull = object(value);
  const base = object(pull?.base);
  const repository = object(base?.repo);
  const headSha = object(pull?.head)?.sha;
  const canonical = expected.repository.toLowerCase();
  const apiUrl = `https://api.github.com/repos/${canonical}/pulls/${expected.number}`;
  const htmlUrl = `https://github.com/${canonical}/pull/${expected.number}`;
  if (!pull || pull.number !== expected.number || typeof pull.url !== "string" || pull.url.toLowerCase() !== apiUrl
    || typeof pull.html_url !== "string" || pull.html_url.toLowerCase() !== htmlUrl
    || providerId(repository?.id) !== expected.repositoryId
    || typeof repository?.full_name !== "string" || repository.full_name.toLowerCase() !== canonical
    || typeof repository.url !== "string" || repository.url.toLowerCase() !== `https://api.github.com/repos/${canonical}`
    || base?.ref !== expected.baseRef || !sha(headSha)
    || typeof pull.merged !== "boolean" || typeof pull.draft !== "boolean"
    || (pull.state !== "open" && pull.state !== "closed")) throw new Unavailable("invalid_response");
  if (pull.merged ? (pull.state !== "closed" || pull.draft || !mergedTimestamp(pull.merged_at) || !sha(pull.merge_commit_sha))
    : pull.merged_at !== null) throw new Unavailable("invalid_response");
  return {
    repository: canonical,
    repositoryId: expected.repositoryId,
    number: expected.number,
    baseRef: expected.baseRef,
    headSha: headSha.toLowerCase(),
    draft: pull.draft,
    state: pull.merged ? "merged" : pull.state,
    mergedAt: pull.merged ? pull.merged_at as string : null,
    mergeCommitSha: pull.merged ? (pull.merge_commit_sha as string).toLowerCase() : null,
    observedAt: new Date().toISOString(),
  };
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Unavailable("invalid_response");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Unavailable("response_too_large");
      chunks.push(part.value);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new Unavailable("invalid_response");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createCodeDeliveryGitHubReader(db: Db, options: Options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const authorization = projectGitAuthorizationService(db);
  return async (companyId: string, pullRequests: CodeDeliveryPullRequestIdentity[]): Promise<CodeDeliveryGitHubResult> => {
    if (!companyId || !Array.isArray(pullRequests) || pullRequests.length > MAX_PULL_REQUESTS) return { status: "unavailable", reason: "invalid_identity" };
    const identities = new Map<string, CodeDeliveryPullRequestIdentity>();
    for (const identity of pullRequests) {
      if (!identity || typeof identity.repository !== "string" || !validIdentity(identity)) return { status: "unavailable", reason: "invalid_identity" };
      const key = `${identity.repositoryId}:${identity.number}`;
      if (identities.has(key)) return { status: "unavailable", reason: "invalid_identity" };
      identities.set(key, { ...identity });
    }
    if (!identities.size) return { status: "observed", pullRequests: [] };
    const signal = AbortSignal.timeout(DEADLINE_MS);
    const observations: CodeDeliveryPullRequestObservation[] = [];
    try {
      for (const identity of identities.values()) {
        signal.throwIfAborted();
        let token: string | null;
        try {
          token = await authorization.resolve({
            companyId, projectId: identity.projectId, workspaceId: identity.workspaceId,
            expectedRepository: identity.repository, requireAuthentication: true,
          }, { projectId: identity.projectId, workspaceId: identity.workspaceId, operation: "inspect" });
        } catch {
          throw new Unavailable("authorization_unavailable");
        }
        signal.throwIfAborted();
        if (!token) throw new Unavailable("authorization_unavailable");
        const response = await fetchImpl(`https://api.github.com/repos/${identity.repository.toLowerCase()}/pulls/${identity.number}`, {
          redirect: "error", cache: "no-store", signal,
          headers: {
            accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
            authorization: `Bearer ${token}`,
          },
        });
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw new Unavailable("provider_unavailable");
        }
        observations.push(parsePullRequest(await readBody(response, signal), identity));
      }
      signal.throwIfAborted();
      return { status: "observed", pullRequests: observations };
    } catch (error) {
      return { status: "unavailable", reason: signal.aborted ? "deadline_exceeded" : error instanceof Unavailable ? error.reason : "provider_unavailable" };
    }
  };
}
