import { and, eq, inArray, or, sql } from "drizzle-orm";
import { assets, chatGitHubReviewCandidates, chatGitHubReviews, documentRevisions, documents, heartbeatRuns, issueAttachments, issueComments, issueDocuments, issues, type Db } from "@paperclipai/db";
import type { Request, Response } from "express";
import { notFound } from "../errors.js";

/** Always installed at agent API, MCP and live-event boundaries. Not the enrollment switch:
 * admitted candidate data stays private after cancellation, retirement or disable. */
export const GITHUB_PRIMARY_BLINDING_VERSION = 1;

export async function githubPrimaryBlinding(db: Db, companyId: string) {
  const candidates = await db.select({ id: chatGitHubReviewCandidates.id, issueId: chatGitHubReviewCandidates.issueId,
    commentId: chatGitHubReviewCandidates.commentId, conversationId: chatGitHubReviewCandidates.conversationId,
    deliveryId: chatGitHubReviewCandidates.nativeDeliveryId, agentId: chatGitHubReviewCandidates.agentId,
    enrollmentId: chatGitHubReviewCandidates.enrollmentId })
    .from(chatGitHubReviewCandidates)
    .where(eq(chatGitHubReviewCandidates.companyId, companyId));
  const tokens = new Set(candidates.flatMap(c => Object.values(c).filter((v): v is string => !!v)));
  if (candidates.length) {
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), sql`exists (select 1 from chat_github_review_candidates c
        where c.company_id = ${companyId} and (c.agent_id = ${heartbeatRuns.agentId}
        or c.issue_id::text = coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')))`));
    for (const run of runs) tokens.add(run.id);
    const agentIds = candidates.map(c => c.agentId);
    const issueIds = candidates.flatMap(c => c.issueId ? [c.issueId] : []);
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
  // Match whole IDs: hiding TOG-2 must not also hide the primary's TOG-20.
  const references = tokens.size ? new RegExp(`(^|[^a-z0-9_-])(?:${[...tokens].map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z0-9_-])`, "i") : null;
  const containsReference = (text: string) => {
    try { text = decodeURIComponent(text); } catch { /* Not a URL-encoded value. */ }
    return references?.test(text) ?? false;
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
    active: candidates.length > 0,
    candidateAgentIds: candidates.map(c => c.agentId),
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
    // Read again at response time so a concurrent materialization cannot leak
    // through a collection query executed after the ingress snapshot.
    void githubPrimaryBlinding(db, companyId).then(current => {
      const visible = current.filter(body);
      if (visible === undefined) res.status(404);
      json(visible ?? { error: "Not found" });
    }).catch(() => { res.status(503); json({ error: "Review visibility unavailable" }); });
    return res;
  }) as Response["json"];
}
