import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

// Only GitHub endpoint assignees are primary reviewers. Unknown scope is NOT an
// empty set: until bootstrap succeeds (or during an endpoint mutation), retain
// the former all-agent blinding. There is no request-time membership query.
type CompanyScope = { agents: Set<string>; pending: number; generation: number; uncertain: boolean };
type Scope = { loaded: boolean; companies: Map<string, CompanyScope> };
const scopes = new WeakMap<Db, Scope>();
function scope(db: Db) {
  let state = scopes.get(db);
  if (!state) { state = { loaded: false, companies: new Map() }; scopes.set(db, state); }
  return state;
}
function companyScope(state: Scope, companyId: string) {
  let company = state.companies.get(companyId);
  if (!company) {
    company = { agents: new Set(), pending: 0, generation: 0, uncertain: false };
    state.companies.set(companyId, company);
  }
  return company;
}

export function isGitHubPrimaryReviewer(db: Db, companyId: string, agentId: string) {
  const state = scopes.get(db);
  const company = state?.companies.get(companyId);
  return !state?.loaded || !!company && (company.uncertain || company.pending > 0 || company.agents.has(agentId));
}

/** Called alongside candidate bootstrap, before the server accepts requests. */
export async function initializeGitHubPrimaryReviewers(db: Db) {
  const state = scope(db);
  state.loaded = false;
  const generations = new Map([...state.companies].map(([id, company]) => [id, company.generation]));
  const rows = await db.execute<{ company_id: string; assigned_agent_id: string }>(sql`
    select company_id, assigned_agent_id from chat_endpoints where provider = 'github'`);
  const agents = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!agents.has(row.company_id)) agents.set(row.company_id, new Set());
    agents.get(row.company_id)!.add(row.assigned_agent_id);
  }
  for (const id of new Set([...state.companies.keys(), ...agents.keys()])) {
    const company = companyScope(state, id);
    if (company.pending || company.generation !== (generations.get(id) ?? 0)) continue;
    company.agents = agents.get(id) ?? new Set();
    company.uncertain = false;
  }
  state.loaded = true;
}

/** Also usable by maintenance callers after changing an endpoint assignment.
 * A failed/stale refresh leaves that company closed, never an obsolete bypass. */
export async function refreshGitHubPrimaryReviewers(db: Db, companyId: string) {
  const company = companyScope(scope(db), companyId);
  company.uncertain = true;
  const generation = ++company.generation;
  const rows = await db.execute<{ assigned_agent_id: string }>(sql`
    select assigned_agent_id from chat_endpoints where company_id = ${companyId} and provider = 'github'`);
  if (company.pending || company.generation !== generation) return;
  company.agents = new Set(rows.map(row => row.assigned_agent_id));
  company.uncertain = false;
}

/** Arm BEFORE committing an endpoint create/update. Refresh after commit, with
 * overlapping mutations fenced so an older read cannot erase a new assignee. */
export async function withGitHubPrimaryReviewerChange<T>(db: Db, companyId: string, change: () => Promise<T>): Promise<T> {
  const company = companyScope(scope(db), companyId);
  company.pending++;
  company.generation++;
  company.uncertain = true;
  try { return await change(); }
  finally {
    company.pending--;
    await refreshGitHubPrimaryReviewers(db, companyId);
  }
}
