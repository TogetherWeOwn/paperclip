import { and, eq, inArray, or, sql } from "drizzle-orm";
import { assets, chatGitHubReviewCandidates, chatGitHubReviews, documentRevisions, documents, heartbeatRuns, issueAttachments, issueComments, issueDocuments, issues, type Db } from "@paperclipai/db";
import type { Request, Response } from "express";
import { notFound } from "../errors.js";

/** Always installed at agent API, MCP and live-event boundaries. Not the enrollment switch:
 * admitted candidate data stays private after cancellation, retirement or disable. */
export const GITHUB_PRIMARY_BLINDING_VERSION = 1;

type Visibility = ReturnType<typeof createGitHubPrimaryVisibility>;
type CachedVisibility = { version: string; value: Promise<Visibility | null> };
const visibilityCaches = new WeakMap<Db, Map<string, CachedVisibility>>();
const MAX_CACHED_COMPANIES = 64;

async function visibilityVersion(db: Db, companyId: string) {
  // The covering candidate index and the single-row epoch lookup never touch run
  // history. The epoch also covers aliases created AFTER candidate materialization.
  const [row] = await db.execute<{ count: string; updated: string | null; epoch: string }>(sql`
    select count(*)::text as count, max(updated_at)::text as updated,
      coalesce((select version::text from chat_github_blinding_versions where company_id = ${companyId}), '0') as epoch
    from chat_github_review_candidates where company_id = ${companyId}`);
  if (!row) throw new Error("Review visibility version unavailable");
  return { key: `${row.count}/${row.updated}/${row.epoch}`, empty: row.count === "0" };
}

/** No TTL: a stale privacy cache can leak a newly admitted candidate. Every
 * boundary checks the indexed version, sharing only construction of that exact
 * version. Failed constructions are evicted; all errors fail closed rather than
 * serving a stale snapshot. */
export async function githubPrimaryBlinding(db: Db, companyId: string): Promise<Visibility> {
  let cache = visibilityCaches.get(db);
  if (!cache) { cache = new Map(); visibilityCaches.set(db, cache); }
  for (let attempt = 0; attempt < 4; attempt++) {
    const version = await visibilityVersion(db, companyId);
    let entry = cache.get(companyId);
    if (entry?.version !== version.key) {
      entry = { version: version.key, value: version.empty
        ? Promise.resolve(createGitHubPrimaryVisibility(new Set(), []))
        : loadGitHubPrimaryVisibility(db, companyId) };
      cache.delete(companyId);
      cache.set(companyId, entry);
      if (cache.size > MAX_CACHED_COMPANIES) cache.delete(cache.keys().next().value!);
      // Multiple SELECTs build the token set. A write during construction must
      // not publish a partial snapshot under the new epoch.
      entry.value = entry.value.then(async value => {
        if (!version.empty && (await visibilityVersion(db, companyId)).key !== version.key) return null;
        return value;
      });
    }
    try {
      const value = await entry.value;
      if (value) return value;
      if (cache.get(companyId) === entry) cache.delete(companyId);
    } catch (error) {
      if (cache.get(companyId) === entry) cache.delete(companyId);
      throw error;
    }
  }
  throw new Error("Review visibility changed during snapshot construction");
}

async function loadGitHubPrimaryVisibility(db: Db, companyId: string) {
  const candidates = await db.select({ id: chatGitHubReviewCandidates.id, issueId: chatGitHubReviewCandidates.issueId,
    commentId: chatGitHubReviewCandidates.commentId, conversationId: chatGitHubReviewCandidates.conversationId,
    deliveryId: chatGitHubReviewCandidates.nativeDeliveryId, agentId: chatGitHubReviewCandidates.agentId,
    enrollmentId: chatGitHubReviewCandidates.enrollmentId })
    .from(chatGitHubReviewCandidates)
    .where(eq(chatGitHubReviewCandidates.companyId, companyId));
  const tokens = new Set(candidates.flatMap(c => Object.values(c).filter((v): v is string => !!v)));
  if (candidates.length) {
    const agentIds = [...new Set(candidates.map(c => c.agentId))];
    const issueIds = [...new Set(candidates.flatMap(c => c.issueId ? [c.issueId] : []))];
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), or(
        inArray(heartbeatRuns.agentId, agentIds),
        inArray(heartbeatRuns.nativeIssueId, issueIds),
        // Preserve legacy COALESCE precedence without wrapping indexed columns.
        // Both JSON expressions already have company-prefixed indexes.
        and(sql`${heartbeatRuns.nativeIssueId} is null`, or(
          inArray(sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`, issueIds),
          and(sql`${heartbeatRuns.contextSnapshot}->>'issueId' is null`,
            inArray(sql<string>`${heartbeatRuns.contextSnapshot}->>'taskId'`, issueIds)),
        )),
      )));
    for (const run of runs) tokens.add(run.id);
    const identifiers = await db.select({ identifier: issues.identifier }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
    for (const row of identifiers) if (row.identifier) tokens.add(row.identifier);
    // Deny aliases as well as issue/run paths, including raw attachment downloads
    // whose URL contains only an asset ID and whose response is not JSON.
    const comments = await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), or(inArray(issueComments.issueId, issueIds), inArray(issueComments.authorAgentId, agentIds))));
    const attachments = await db.select({ id: issueAttachments.id, assetId: issueAttachments.assetId }).from(issueAttachments)
      .where(and(eq(issueAttachments.companyId, companyId), inArray(issueAttachments.issueId, issueIds)));
    const candidateAssets = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.companyId, companyId), inArray(assets.createdByAgentId, agentIds)));
    const reviews = await db.select({ id: chatGitHubReviews.id }).from(chatGitHubReviews).where(and(eq(chatGitHubReviews.companyId, companyId),
      or(inArray(chatGitHubReviews.issueId, issueIds), sql`${chatGitHubReviews.shadowLabel} is not null`)));
    const candidateDocuments = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.companyId, companyId),
      or(inArray(documents.createdByAgentId, agentIds), sql`exists (select 1 from ${issueDocuments} d
        where d.document_id = ${documents.id} and d.issue_id in (select issue_id from chat_github_review_candidates where company_id = ${companyId}))`)));
    const revisions = await db.select({ id: documentRevisions.id }).from(documentRevisions).where(and(eq(documentRevisions.companyId, companyId),
      inArray(documentRevisions.documentId, candidateDocuments.map(d => d.id))));
    for (const row of [...comments, ...attachments, ...candidateAssets, ...reviews, ...candidateDocuments, ...revisions])
      for (const id of Object.values(row)) tokens.add(id);
  }
  return createGitHubPrimaryVisibility(tokens, [...new Set(candidates.map(c => c.agentId))]);
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
  function filter(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(filter).filter(v => v !== undefined);
    if (typeof value === "string") {
      // MCP self tools also encode their data as JSON text. Filter both copies.
      try {
        const decoded = JSON.parse(value);
        if (decoded && typeof decoded === "object") return JSON.stringify(filter(decoded) ?? null);
      } catch { /* Ordinary text. */ }
      return containsReference(value) ? undefined : value;
    }
    if (!value || typeof value !== "object" || value instanceof Date) return value;
    const record = value as Record<string, unknown>;
    if (isHiddenRecord(record)) return undefined;
    return Object.fromEntries(Object.entries(record).flatMap(([key, entry]) => {
      if (hiddenKeys.has(key)) return [];
      const visible = filter(entry);
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
  const visibility = await githubPrimaryBlinding(db, companyId);
  if (req.actor.type === "agent" && req.actor.agentId && visibility.candidateAgentIds.includes(req.actor.agentId)) return;
  visibility.assertVisible(req.originalUrl);
  visibility.assertVisible(req.body);
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    // Probe the cheap version at response time: reuse the ingress snapshot unless
    // candidate materialization or an alias write changed it during the request.
    void githubPrimaryBlinding(db, companyId).then(current => {
      const visible = current.filter(body);
      if (visible === undefined) res.status(404);
      json(visible ?? { error: "Not found" });
    }).catch(() => { res.status(503); json({ error: "Review visibility unavailable" }); });
    return res;
  }) as Response["json"];
}
