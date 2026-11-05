import { and, eq } from "drizzle-orm";
import { codeDeliveryDiscoveries, type codeDeliveryDecisions, type codeDeliveryObligations, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

type Discovery = typeof codeDeliveryDiscoveries.$inferSelect;
type Obligation = typeof codeDeliveryObligations.$inferSelect;

export function discoverGitHubPullRequest(value: unknown): { repository: string; number: number } | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) return null;
  const match = /^\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})\/pull\/([1-9][0-9]*)(?:\/(?:files|commits|checks))?\/?$/i.exec(url.pathname);
  if (!match || [".", ".."].includes(match[2]!)) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number > 2_147_483_647) return null;
  return { repository: `${match[1]}/${match[2]}`.toLowerCase(), number };
}

export async function reconcileDeliveryDiscoveries(tx: Db, companyId: string, issueId: string, ids: string[], obligation?: Obligation) {
  const discoveries = await tx.select().from(codeDeliveryDiscoveries).where(and(eq(codeDeliveryDiscoveries.companyId, companyId),
    eq(codeDeliveryDiscoveries.issueId, issueId)));
  const selected = discoveries.filter(row => ids.includes(row.id));
  if (selected.length !== ids.length || (!obligation && selected.length !== discoveries.length)) {
    throw conflict("Retained code associations require independent reconciliation", { code: "code_delivery_decision_conflict", reason: "unreconciled_associations" });
  }
  for (const discovery of selected) {
    const pr = discoverGitHubPullRequest(discovery.snapshot.url);
    const matches = obligation && pr && obligation.repository === pr.repository && obligation.pullRequestNumber === pr.number;
    const claimsPullRequest = discovery.snapshot.type === "pull_request"
      || (typeof discovery.snapshot.url === "string" && /\/(?:pull|pulls|merge_requests)\//i.test(discovery.snapshot.url));
    if (pr ? !matches : claimsPullRequest || !["branch", "commit"].includes(String(discovery.snapshot.type))) {
      throw conflict("Discovery does not match this delivery decision", { code: "code_delivery_decision_conflict", reason: "discovery_identity_mismatch" });
    }
  }
  return selected.map(row => ({ discoveryId: row.id, sourceRevision: row.sourceRevision, obligationId: obligation?.id ?? null }));
}

export function matchDeliveryDiscovery(discovery: Discovery, obligations: Obligation[], decisions: Array<typeof codeDeliveryDecisions.$inferSelect> = [],
  transferredObligationIds: ReadonlySet<string> = new Set()) {
  const identity = discoverGitHubPullRequest(discovery.snapshot.url);
  const obligation = identity ? obligations.find(row => row.companyId === discovery.companyId
    && (row.ownerIssueId === discovery.issueId || row.sourceIssueId === discovery.issueId || transferredObligationIds.has(row.id))
    && row.provider === "github" && row.repository === identity.repository && row.pullRequestNumber === identity.number) : null;
  if (obligation) return { discoveryId: discovery.id, obligationId: obligation.id, decisionId: null };
  for (const decision of decisions) {
    if (decision.companyId !== discovery.companyId || decision.issueId !== discovery.issueId
      || !["no_pr", "accept_head"].includes(decision.kind) || !Array.isArray(decision.payload.reconciliations)) continue;
    for (const entry of decision.payload.reconciliations) {
      if (!entry || typeof entry !== "object" || entry.discoveryId !== discovery.id || entry.sourceRevision !== discovery.sourceRevision) continue;
      const accepted = decision.kind === "accept_head" && obligations.find(row => row.id === entry.obligationId
        && row.id === decision.obligationId && (row.ownerIssueId === discovery.issueId || row.sourceIssueId === discovery.issueId || transferredObligationIds.has(row.id)));
      if (accepted || (decision.kind === "no_pr" && entry.obligationId === null)) {
        return { discoveryId: discovery.id, obligationId: accepted ? accepted.id : null, decisionId: decision.id };
      }
    }
  }
  return { discoveryId: discovery.id, obligationId: null, decisionId: null };
}
