import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { hasGitHubPrimaryBlinding } from "./chat-github-primary-blinding-state.js";
import { isGitHubPrimaryReviewer } from "./chat-github-primary-reviewers.js";
import type { Request, Response } from "express";
import { notFound } from "../errors.js";

/** Always installed at agent API, MCP and live-event boundaries. Not the enrollment switch:
 * admitted candidate data stays private after cancellation, retirement or disable. */
export const GITHUB_PRIMARY_BLINDING_VERSION = 1;

type Visibility = ReturnType<typeof createGitHubPrimaryVisibility>;
const passthrough: Visibility = { active: false, candidateAgentIds: [], filter: value => value, assertVisible() {} };
type Waiter = { resolve: (value: Visibility) => void; reject: (error: unknown) => void };
type CachedVisibility = { snapshot?: { key: string; value: Visibility; databaseSnapshot?: string }; waiters: Waiter[]; running: boolean };
const visibilityCaches = new WeakMap<Db, Map<string, CachedVisibility>>();
const MAX_CACHED_COMPANIES = 64;

/** A single READ COMMITTED statement computes both the watermark and any reload.
 * Only candidate identities/aliases participate, not company-wide write epochs or
 * status/body timestamps. Fingerprint the identities themselves: count/max alone
 * misses replacement of a non-maximal alias, and timestamps predate late commits.
 * UNION ALL keeps each run predicate independently indexable (including legacy
 * nativeIssueId -> issueId -> taskId precedence). No row locks, triggers or writes.
 */
export function githubPrimaryVisibilityQuery(companyId: string, previousKey: string | null) {
  return sql`
    with candidates as materialized (
      select id, issue_id, comment_id, conversation_id, native_delivery_id, agent_id, enrollment_id
      from chat_github_review_candidates where company_id = ${companyId}
    ), candidate_agents as materialized (select distinct agent_id from candidates),
    candidate_issues as materialized (select distinct issue_id from candidates where issue_id is not null),
    candidate_documents as materialized (
      select id from documents where company_id = ${companyId}
        and created_by_agent_id = any(array(select agent_id from candidate_agents))
      union
      select id from documents where company_id = ${companyId} and id = any(array(
        select document_id from issue_documents where company_id = ${companyId}
          and issue_id = any(array(select issue_id from candidate_issues))))
    ), tokens as (
      select unnest(array[id, issue_id, comment_id, conversation_id, native_delivery_id, agent_id, enrollment_id])::text as token from candidates
      union all select id::text from heartbeat_runs where company_id = ${companyId}
        and agent_id = any(array(select agent_id from candidate_agents))
      union all select id::text from heartbeat_runs where company_id = ${companyId}
        and native_issue_id = any(array(select issue_id from candidate_issues))
      union all select id::text from heartbeat_runs where company_id = ${companyId} and native_issue_id is null
        and context_snapshot->>'issueId' = any(array(select issue_id::text from candidate_issues))
      union all select id::text from heartbeat_runs where company_id = ${companyId} and native_issue_id is null
        and context_snapshot->>'issueId' is null
        and context_snapshot->>'taskId' = any(array(select issue_id::text from candidate_issues))
      union all select identifier from issues where company_id = ${companyId}
        and id = any(array(select issue_id from candidate_issues))
      union all select id::text from issue_comments where company_id = ${companyId}
        and issue_id = any(array(select issue_id from candidate_issues))
      union all select id::text from issue_comments where company_id = ${companyId}
        and author_agent_id = any(array(select agent_id from candidate_agents))
      union all select unnest(array[id, asset_id])::text from issue_attachments where company_id = ${companyId}
        and issue_id = any(array(select issue_id from candidate_issues))
      union all select id::text from assets where company_id = ${companyId}
        and created_by_agent_id = any(array(select agent_id from candidate_agents))
      union all select id::text from chat_github_reviews where company_id = ${companyId}
        and issue_id = any(array(select issue_id from candidate_issues))
      union all select id::text from chat_github_reviews where company_id = ${companyId}
        and shadow_label is not null and exists (select 1 from candidates)
      union all select id::text from candidate_documents
      union all select id::text from document_revisions where company_id = ${companyId}
        and document_id = any(array(select id from candidate_documents))
    ), identities as (
      select coalesce(array_agg(token order by token collate "C"), array[]::text[]) as tokens from tokens where token is not null
    ), snapshot as (
      select tokens, array(select agent_id::text from candidate_agents order by agent_id) as agents from identities
    ), versioned as materialized (
      select *, encode(sha256(convert_to(array_to_string(agents, ',') || '/' || array_to_string(tokens, ','), 'UTF8')), 'hex') as key from snapshot
    ) select key, agents, case when key is distinct from ${previousKey} then tokens end as tokens,
      pg_current_snapshot()::text as database_snapshot from versioned`;
}

/** Every caller gets a snapshot started AFTER it asked. Coalesce only waiting
 * readers, never readers arriving after a query has started: sharing that older
 * in-flight query would miss a late alias commit at the response boundary.
 * Serial batches also prevent an older result overwriting a newer cache entry.
 * The single-statement snapshot needs no retries, even under continuous writes. */
export async function githubPrimaryBlinding(db: Db, companyId: string): Promise<Visibility> {
  if (!hasGitHubPrimaryBlinding(db, companyId)) return passthrough;
  let cache = visibilityCaches.get(db);
  if (!cache) { cache = new Map(); visibilityCaches.set(db, cache); }
  let entry = cache.get(companyId);
  if (!entry) { entry = { waiters: [], running: false }; cache.set(companyId, entry); }
  const current = entry;
  const drain = async () => {
    const waiters = current.waiters.splice(0);
    try {
      // Equal MVCC snapshots prove that no transaction's writes became visible,
      // hence no candidate identity/alias can have changed. This history-independent statement
      // avoids computing the full fingerprint twice on an unchanged request.
      // Compare the entire snapshot (including in-progress XIDs), not just xmax:
      // an older transaction may commit a LATE_ALIAS_CANARY during the request.
      // Unrelated commits conservatively fall back to the candidate fingerprint;
      // no write-path triggers, locks, timestamps or statistics are involved.
      let unchanged = false;
      if (current.snapshot?.databaseSnapshot) {
        const [probe] = await db.execute<{ database_snapshot: string }>(sql`
          select pg_current_snapshot()::text as database_snapshot`);
        if (!probe?.database_snapshot) throw new Error("Review visibility watermark unavailable");
        unchanged = probe.database_snapshot === current.snapshot.databaseSnapshot;
      }
      if (!unchanged) {
        const [row] = await db.execute<{ key: string; agents: string[]; tokens: string[] | null; database_snapshot?: string }>(
          githubPrimaryVisibilityQuery(companyId, current.snapshot?.key ?? null));
        if (!row) throw new Error("Review visibility unavailable");
        if (row.key !== current.snapshot?.key) {
          if (!row.tokens) throw new Error("Review visibility aliases unavailable");
          current.snapshot = { key: row.key, value: row.agents.length
            ? createGitHubPrimaryVisibility(new Set(row.tokens), row.agents) : passthrough };
        }
        current.snapshot!.databaseSnapshot = row.database_snapshot;
      }
      for (const waiter of waiters) waiter.resolve(current.snapshot!.value);
    } catch (error) {
      // Do not return the cached value on an error. A subsequent call probes anew.
      for (const waiter of waiters) waiter.reject(error);
    } finally {
      if (current.waiters.length) queueMicrotask(() => { void drain(); });
      else {
        current.running = false;
        cache!.delete(companyId); cache!.set(companyId, current);
        for (const [id, value] of cache!) {
          if (cache!.size <= MAX_CACHED_COMPANIES) break;
          if (!value.running) cache!.delete(id);
        }
      }
    }
  };
  return new Promise<Visibility>((resolve, reject) => {
    current.waiters.push({ resolve, reject });
    if (!current.running) { current.running = true; queueMicrotask(() => { void drain(); }); }
  });
}

export function createGitHubPrimaryVisibility(tokens: ReadonlySet<string>, candidateAgentIds: string[]) {
  // Preserve the former non-Unicode /i regex's canonicalization, including its
  // ASCII word boundaries. Whole-string lowercasing turns a Kelvin sign into k
  // and can wrongly unhide a UUID beside it; expanding ß also shifts offsets.
  const fold = (text: string) => /[^\x00-\x7f]/.test(text)
    ? text.replace(/[\s\S]/g, char => {
      const upper = char.toUpperCase();
      return upper.length === 1 && !(char.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : char;
    })
    : text.toUpperCase();
  const references = new Set([...tokens].map(fold));
  const lengths = [...new Set([...references].map(token => token.length))];
  const word = (char: string | undefined) => char !== undefined && /[a-z0-9_-]/i.test(char);
  const containsReference = (text: string) => {
    if (!references.size) return false;
    try { text = decodeURIComponent(text); } catch { /* Not a URL-encoded value. */ }
    text = fold(text);
    // Match whole IDs via set membership, not a history-sized alternation regex.
    // Length buckets also preserve identifiers containing punctuation. TOG-2
    // must never hide TOG-20, nor a UUID embedded in a larger token.
    for (let start = 0; start < text.length; start++) {
      if (start > 0 && word(text[start - 1])) continue;
      for (const length of lengths) {
        const end = start + length;
        if (end <= text.length && !word(text[end]) && references.has(text.slice(start, end))) return true;
      }
    }
    return false;
  };
  const hiddenKeys = new Set(["githubPairingSeed", "githubPairedCandidate", "previousAssessments", "isolationTests"]);
  const structuredText = (value: string) => {
    try { const parsed = JSON.parse(value); return parsed !== null && typeof parsed === "object"; }
    catch { return false; }
  };
  const isHiddenRecord = (record: Record<string, unknown>) =>
    typeof record.shadowLabel === "string" || typeof record.githubShadowLabel === "string"
    || typeof record.shadow_label === "string" || typeof record.github_shadow_label === "string"
    || Object.values(record).some(value => typeof value === "string" && !structuredText(value) && containsReference(value));
  function hasHiddenData(value: unknown): boolean {
    if (typeof value === "string") {
      try { const decoded = JSON.parse(value); return decoded !== value && hasHiddenData(decoded); }
      catch { return false; }
    }
    if (!value || typeof value !== "object" || value instanceof Date) return false;
    if (Array.isArray(value)) return value.some(hasHiddenData);
    const record = value as Record<string, unknown>;
    return isHiddenRecord(record) || Object.hasOwn(record, "githubPairingSeed")
      || Object.hasOwn(record, "githubPairedCandidate") || Object.values(record).some(hasHiddenData);
  }
  function filter(value: unknown): unknown {
    // With no candidate references or actual shadow records, ordinary user keys
    // such as previousAssessments are not evidence of private review data.
    if (!references.size && !hasHiddenData(value)) return value;
    return filterHidden(value);
  }
  function filterHidden(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(filterHidden).filter(v => v !== undefined);
    if (typeof value === "string") {
      // MCP self tools also encode their data as JSON text. Filter both copies.
      try {
        const decoded = JSON.parse(value);
        if (decoded && typeof decoded === "object") {
          const visible = filterHidden(decoded);
          // Parsing JSON text is lossy (large integers, whitespace). Only encode
          // it again when redaction actually changed the decoded value.
          return isDeepStrictEqual(decoded, visible) ? value : JSON.stringify(visible ?? null);
        }
      } catch { /* Ordinary text. */ }
      return containsReference(value) ? undefined : value;
    }
    if (!value || typeof value !== "object" || value instanceof Date) return value;
    const record = value as Record<string, unknown>;
    if (isHiddenRecord(record)) return undefined;
    return Object.fromEntries(Object.entries(record).flatMap(([key, entry]) => {
      if (hiddenKeys.has(key)) return [];
      const visible = filterHidden(entry);
      return visible === undefined ? [] : [[key, visible]];
    }));
  }
  return {
    active: candidateAgentIds.length > 0,
    candidateAgentIds,
    filter,
    assertVisible(value: unknown) {
      if (containsReference(typeof value === "string" ? value : JSON.stringify(value) ?? "")) throw notFound();
    },
  };
}

/** Installed AFTER candidate confinement. Candidate requests never get this
 * broader API path; board access remains the operator's private evaluation view.
 * Deny direct resource paths before any stream/attachment handler can run, then
 * filter collection/enriched JSON at the final response seam, not just /issues. */
export async function installGitHubPrimaryApiBlinding(db: Db, companyId: string, req: Request, res: Response) {
  if (req.actor.type !== "agent" || !req.actor.agentId) return;
  const agentId = req.actor.agentId;
  const visibility = isGitHubPrimaryReviewer(db, companyId, agentId) ? await githubPrimaryBlinding(db, companyId) : null;
  if (visibility?.candidateAgentIds.includes(agentId)) return;
  visibility?.assertVisible(req.originalUrl);
  visibility?.assertVisible(req.body);
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    // Non-primary responses are byte-identical, without any DB work or JSON walk.
    // Recheck the in-memory set in case this agent was promoted during the route.
    if (!visibility && !isGitHubPrimaryReviewer(db, companyId, agentId)) return json(body);
    // Revalidate candidate-scoped identities at response time. Never reuse an
    // ingress snapshot without checking for aliases committed during the request.
    void githubPrimaryBlinding(db, companyId).then(current => {
      // Even null/undefined responses must retain Express's original semantics
      // for companies without candidates, not become a synthetic error body.
      if (!current.active) { json(body); return; }
      const visible = current.filter(body);
      if (visible === undefined) res.status(404);
      json(visible ?? { error: "Not found" });
    }).catch(() => { res.status(503); json({ error: "Review visibility unavailable" }); });
    return res;
  }) as Response["json"];
}
