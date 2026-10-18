import { createHash } from "node:crypto";
import type { GitHubReviewEventContext } from "@paperclipai/shared";
import { githubCommitSchema } from "@paperclipai/shared";
import type { GitHubReviewInputSnapshot } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";

export type GitHubReviewReader = {
  request<T>(path: string, options?: { method?: string; body?: unknown; accept?: string }): Promise<T>;
};

export function githubSnapshotDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry,
  )).digest("hex");
}

/** Capture is bounded, before the candidate wake, and never retried after its admission.
 * Primary admission and waking do not wait for candidate snapshot capture.
 * GitHub has no atomic multi-resource revision. Two identical sweeps detect
 * observed concurrent changes, not a claim of provider serializability. */
export async function captureGitHubReviewSnapshot(
  api: GitHubReviewReader, event: GitHubReviewEventContext,
  bot?: { login: string; appId: string },
  /** Known-at-admission reason no checkout will be produced (e.g. disabled).
   * The checkout itself is commit-addressed and never blocks this seal. */
  repositoryFailure?: string,
): Promise<GitHubReviewInputSnapshot> {
  const startedAt = new Date().toISOString();
  const headSha = githubCommitSchema.parse(event.headSha);
  const baseSha = githubCommitSchema.parse(event.baseSha);
  const comparePath = `/compare/${baseSha}...${headSha}?per_page=1&page=1`;
  const sweep = async () => {
    const responses: Record<string, unknown> = Object.create(null);
    const byRoute: Record<string, number> = {};
    const isBotArtifact = (value: unknown): boolean => {
      if (!bot || !value || typeof value !== "object") return false;
      const row = value as {
        user?: { login?: unknown }; creator?: { login?: unknown };
        app?: { id?: unknown }; performed_via_github_app?: { id?: unknown };
      };
      return [row.user, row.creator].some(user => typeof user?.login === "string" && user.login.toLowerCase() === bot.login.toLowerCase())
        || [row.app, row.performed_via_github_app].some(app => app?.id != null && String(app.id) === bot.appId);
    };
    let size = 0;
    const read = async <T>(route: string): Promise<T> => {
      if (Date.now() - Date.parse(startedAt) > 15_000) throw conflict("snapshot_capture_budget_exceeded");
      const result = await api.request<T>(route);
      size += Buffer.byteLength(JSON.stringify(result));
      if (size > 16 * 1024 * 1024) throw conflict("snapshot_capture_size_exceeded");
      responses[route] = result;
      return result;
    };
    // Resources are read concurrently (pages within one collection stay in
    // order): sequential reads made a metadata-only seal take 5.5-7.1s.
    // Concurrency changes no guarantee: GitHub has no atomic multi-resource
    // revision either way, and the two-sweep digest check still detects change.
    const collect = async (route: string) => {
      const retained: unknown[] = [];
      const checks = route.endsWith("/check-runs");
      let redacted = 0;
      for (let page = 1; page <= 30; page++) {
        const key = `${route}?per_page=100&page=${page}`;
        const result = await read<unknown>(key);
        const items = checks ? (result as { check_runs?: unknown[] }).check_runs : result;
        if (!Array.isArray(items)) throw conflict("snapshot_capture_invalid_collection");
        for (const item of items) {
          if (!route.endsWith("/files") && isBotArtifact(item)) redacted++;
          else retained.push(item);
        }
        delete responses[key];
        if (items.length < 100) break;
        if (page === 30) throw conflict("snapshot_capture_truncated");
      }
      byRoute[route] = redacted;
      // Repage after redaction. A shortened page must not hide later human
      // comments or leave an original page accessible through a direct read.
      for (let offset = 0; offset <= retained.length; offset += 100) {
        const items = retained.slice(offset, offset + 100);
        responses[`${route}?per_page=100&page=${offset / 100 + 1}`] = checks ? { check_runs: items } : items;
      }
    };
    const [pull, comparison] = await Promise.all([
      read<{ head: { sha: string }; base: { sha: string } }>(`/pulls/${event.pullNumber}`),
      read<{ merge_base_commit: { sha: string } }>(comparePath),
      ...[
        `/pulls/${event.pullNumber}/files`, `/issues/${event.pullNumber}/comments`,
        `/pulls/${event.pullNumber}/reviews`, `/pulls/${event.pullNumber}/comments`,
        `/commits/${headSha}/check-runs`, `/commits/${headSha}/statuses`,
      ].map(collect),
    ] as const);
    if (pull.head.sha !== headSha || pull.base.sha !== baseSha) throw conflict("snapshot_capture_head_changed");
    const diffBaseSha = githubCommitSchema.parse(comparison.merge_base_commit.sha);
    return { responses, diffBaseSha, ...(bot ? { redactions: {
      total: Object.values(byRoute).reduce((sum, n) => sum + n, 0), byRoute, botLogin: bot.login, appId: bot.appId,
    } } : {}) };
  };
  const first = await sweep();
  const second = await sweep();
  if (githubSnapshotDigest(first) !== githubSnapshotDigest(second)) throw conflict("snapshot_capture_mutated");
  const checkout = repositoryFailure ? { repositoryFailure } : {};
  const sealed = { version: 2 as const, startedAt, finishedAt: new Date().toISOString(), headSha, baseSha, ...first, ...checkout };
  // PostgreSQL jsonb rejects NUL and lone surrogates in decoded strings. Keep
  // exact JSON bytes, not a lossy sanitizer, and verify their decoded digest.
  return { ...sealed, digest: githubSnapshotDigest(sealed), responses: Object.fromEntries(
    Object.entries(first.responses).map(([route, value]) => [route, Buffer.from(JSON.stringify(value)).toString("base64")]),
  ) };
}

/** This is selected BEFORE creating any live client. The only network capability
 * it receives is a read-only transport for commit-addressed objects. No branch,
 * PR, comment, review, check or missing snapshot response can fall back to live. */
export function githubSnapshotReader(
  snapshot: GitHubReviewInputSnapshot | undefined,
  expected: { headSha: string; baseSha: string; pullNumber: number },
  immutableRequest: <T>(path: string) => Promise<T>,
  previousHead?: string | null,
): GitHubReviewReader {
  if (!snapshot) throw conflict("This paired review has no sealed admission snapshot; live reads are forbidden");
  const { digest, ...sealed } = snapshot;
  let responses = snapshot.responses;
  try {
    if (snapshot.version === 2) responses = Object.fromEntries(Object.entries(responses).map(([route, value]) => {
      if (typeof value !== "string") throw new Error("Invalid encoded response");
      return [route, JSON.parse(Buffer.from(value, "base64").toString("utf8"))];
    }));
  } catch { throw conflict("Invalid sealed review snapshot"); }
  if (![1, 2].includes(snapshot.version) || snapshot.headSha !== expected.headSha || snapshot.baseSha !== expected.baseSha
      || githubSnapshotDigest({ ...sealed, responses }) !== digest) throw conflict("Invalid sealed review snapshot");
  const commits = new Set([snapshot.headSha, snapshot.diffBaseSha]);
  return {
    async request<T>(route: string, options?: { method?: string; body?: unknown; accept?: string }) {
      if (options?.method && options.method !== "GET" || options?.body !== undefined)
        throw forbidden("Snapshot readers cannot publish");
      if (Object.hasOwn(responses, route)) return structuredClone(responses[route]) as T;
      // A completed collection has an implicit empty tail. Only known captured
      // collections qualify; malformed/missing objects never become empty success.
      const page = /^(.*\?per_page=100&page=)([1-9][0-9]*)$/.exec(route);
      if (page && Number(page[2]) <= 100) {
        for (let n = 1; n < Number(page[2]); n++) {
          const result = responses[`${page[1]}${n}`];
          const items = Array.isArray(result) ? result : (result as { check_runs?: unknown[] } | undefined)?.check_runs;
          if (items && items.length < 100) return (Array.isArray(result) ? [] : { check_runs: [] }) as T;
        }
      }
      const contents = /^\/contents\/([^?]+)\?ref=([a-f0-9]{40})$/.exec(route);
      if (contents && commits.has(contents[2]!)) {
        const decoded = decodeURIComponent(contents[1]!);
        if (decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some(p => p === ".." || p === "." || !p))
          throw forbidden("Invalid pinned source path");
        const result = await immutableRequest<Record<string, unknown>>(route);
        // Do not follow download URLs, symlinks or submodules. Directories have no
        // file bytes and are reported unavailable, never traversed on the host.
        if (result.type && result.type !== "file" || result.submodule_git_url || result.target)
          throw conflict("Pinned source is not a regular file");
        if (result.encoding !== "base64" || typeof result.content !== "string" || typeof result.sha !== "string")
          throw conflict("Pinned file bytes are unavailable");
        const bytes = Buffer.from(result.content.replace(/\s/g, ""), "base64");
        const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (sha !== result.sha || bytes.length !== result.size) throw conflict("Pinned source blob verification failed");
        return { encoding: "base64", content: bytes.toString("base64"), sha, size: bytes.length } as T;
      }
      if (previousHead && route === `/compare/${githubCommitSchema.parse(previousHead)}...${snapshot.headSha}?per_page=1&page=1`)
        return immutableRequest<T>(route);
      throw conflict("Object is absent from the sealed review snapshot; live fallback is forbidden");
    },
  };
}
