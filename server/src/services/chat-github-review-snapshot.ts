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

/** Capture is bounded, before the normal wake, and never retried after admission.
 * GitHub has no atomic multi-resource revision. Two identical sweeps detect
 * observed concurrent changes, not a claim of provider serializability. */
export async function captureGitHubReviewSnapshot(
  api: GitHubReviewReader, event: GitHubReviewEventContext,
): Promise<GitHubReviewInputSnapshot> {
  const startedAt = new Date().toISOString();
  const headSha = githubCommitSchema.parse(event.headSha);
  const baseSha = githubCommitSchema.parse(event.baseSha);
  const comparePath = `/compare/${baseSha}...${headSha}?per_page=1&page=1`;
  const sweep = async () => {
    const responses: Record<string, unknown> = Object.create(null);
    let size = 0;
    const read = async <T>(route: string): Promise<T> => {
      if (Date.now() - Date.parse(startedAt) > 15_000) throw conflict("snapshot_capture_budget_exceeded");
      const result = await api.request<T>(route);
      size += Buffer.byteLength(JSON.stringify(result));
      if (size > 16 * 1024 * 1024) throw conflict("snapshot_capture_size_exceeded");
      responses[route] = result;
      return result;
    };
    const pull = await read<{ head: { sha: string }; base: { sha: string } }>(`/pulls/${event.pullNumber}`);
    if (pull.head.sha !== headSha || pull.base.sha !== baseSha) throw conflict("snapshot_capture_head_changed");
    for (const route of [
      `/pulls/${event.pullNumber}/files`, `/issues/${event.pullNumber}/comments`,
      `/pulls/${event.pullNumber}/reviews`, `/pulls/${event.pullNumber}/comments`,
      `/commits/${headSha}/check-runs`, `/commits/${headSha}/statuses`,
    ]) {
      for (let page = 1; page <= 30; page++) {
        const result = await read<unknown>(`${route}?per_page=100&page=${page}`);
        const items = route.endsWith("/check-runs")
          ? (result as { check_runs?: unknown[] }).check_runs : result;
        if (!Array.isArray(items)) throw conflict("snapshot_capture_invalid_collection");
        if (items.length < 100) break;
        if (page === 30) throw conflict("snapshot_capture_truncated");
      }
    }
    const comparison = await read<{ merge_base_commit: { sha: string } }>(comparePath);
    const diffBaseSha = githubCommitSchema.parse(comparison.merge_base_commit.sha);
    return { responses, diffBaseSha };
  };
  const first = await sweep();
  const second = await sweep();
  if (githubSnapshotDigest(first) !== githubSnapshotDigest(second)) throw conflict("snapshot_capture_mutated");
  const sealed = { version: 1 as const, startedAt, finishedAt: new Date().toISOString(), headSha, baseSha, ...first };
  return { ...sealed, digest: githubSnapshotDigest(sealed) };
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
  if (snapshot.version !== 1 || snapshot.headSha !== expected.headSha || snapshot.baseSha !== expected.baseSha
      || githubSnapshotDigest(sealed) !== digest) throw conflict("Invalid sealed review snapshot");
  const commits = new Set([snapshot.headSha, snapshot.diffBaseSha]);
  return {
    async request<T>(route: string, options?: { method?: string; body?: unknown; accept?: string }) {
      if (options?.method && options.method !== "GET" || options?.body !== undefined)
        throw forbidden("Snapshot readers cannot publish");
      if (Object.hasOwn(snapshot.responses, route)) return structuredClone(snapshot.responses[route]) as T;
      // A completed collection has an implicit empty tail. Only known captured
      // collections qualify; malformed/missing objects never become empty success.
      const page = /^(.*\?per_page=100&page=)([1-9][0-9]*)$/.exec(route);
      if (page && Number(page[2]) <= 100) {
        for (let n = 1; n < Number(page[2]); n++) {
          const result = snapshot.responses[`${page[1]}${n}`];
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
