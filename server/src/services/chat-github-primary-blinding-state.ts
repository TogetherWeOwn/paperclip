import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

// Admission is a control-plane operation, not an agent request. Keep the negative
// fast path out of the database entirely. Bootstrap before accepting requests;
// arm BEFORE projecting candidates, not after their transaction commits.
const admissions = new WeakMap<Db, Map<string, { pending: number; enrolled: boolean }>>();
// If startup cannot establish the negative set, no company may use the bypass.
// startServer also awaits bootstrap before accepting requests.
const uncertainBootstraps = new WeakSet<Db>();
function companies(db: Db) {
  let state = admissions.get(db);
  if (!state) { state = new Map(); admissions.set(db, state); }
  return state;
}

export function hasGitHubPrimaryBlinding(db: Db, companyId: string) {
  const state = admissions.get(db)?.get(companyId);
  return uncertainBootstraps.has(db) || (!!state && (state.enrolled || state.pending > 0));
}

/** Startup is fail-closed. An admission kill switch does not unseal past results. */
export async function initializeGitHubPrimaryBlinding(db: Db) {
  uncertainBootstraps.add(db);
  const rows = await db.execute<{ company_id: string }>(sql`
    select distinct company_id from chat_github_review_candidates`);
  const state = companies(db);
  for (const row of rows) {
    const company = state.get(row.company_id);
    if (company) company.enrolled = true;
    else state.set(row.company_id, { pending: 0, enrolled: true });
  }
  uncertainBootstraps.delete(db);
}

/** All candidate projection paths use this barrier on their root Db handle.
 * No production issue/comment/run write participates in it or acquires a lock.
 * Failed/disabled admissions return to the zero-query path if no data landed. */
export async function withGitHubPrimaryBlindingAdmission<T>(db: Db, companyId: string, project: () => Promise<T>): Promise<T> {
  const state = companies(db);
  let company = state.get(companyId);
  if (!company) { company = { pending: 0, enrolled: false }; state.set(companyId, company); }
  company.pending++;
  try { return await project(); }
  finally {
    try {
      if (!company.enrolled) {
        const [row] = await db.execute<{ present: boolean }>(sql`
          select exists (select 1 from chat_github_review_candidates where company_id = ${companyId}) as present`);
        if (!row) throw new Error("Review admission visibility unavailable");
        // Another admission may have enrolled while this older read was in flight.
        // Once true, enrollment is monotonic for the lifetime of this Db handle.
        company.enrolled ||= row.present;
      }
    } catch (error) {
      company.enrolled = true; // Never turn a read failure into permission to disclose.
      throw error;
    } finally {
      company.pending--;
      if (!company.enrolled && company.pending === 0) state.delete(companyId);
    }
  }
}
