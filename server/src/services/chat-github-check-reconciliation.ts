export interface GitHubReviewCheckRun {
  id: number;
  status?: string;
  external_id?: string;
  details_url?: string;
  app?: { id?: number };
}

export interface GitHubReviewCheckResponse {
  check_runs: GitHubReviewCheckRun[];
}

type GitHubReviewCheckRequest = (
  path: string,
) => Promise<GitHubReviewCheckResponse>;

const CHECK_RUN_PAGE_SIZE = 100;
const MAX_CHECK_RUN_PAGES = 100;
const RECONCILED_URL_CACHE_LIMIT = 512;
const RECONCILED_URL_CACHE_TTL_MS = 5 * 60 * 1000;
const reconciledCheckUrls = new Map<
  string,
  { detailsUrl: string; verifiedAt: number }
>();

function reconciliationKey(externalId: string, appId: string): string {
  return JSON.stringify([appId, externalId]);
}

export function hasReconciledGitHubCheckUrl(
  externalId: string,
  appId: string,
  detailsUrl: string,
): boolean {
  const key = reconciliationKey(externalId, appId);
  const cached = reconciledCheckUrls.get(key);
  if (!cached) return false;
  if (Date.now() - cached.verifiedAt >= RECONCILED_URL_CACHE_TTL_MS) {
    reconciledCheckUrls.delete(key);
    return false;
  }
  if (cached.detailsUrl !== detailsUrl) return false;
  reconciledCheckUrls.delete(key);
  reconciledCheckUrls.set(key, cached);
  return true;
}

export function rememberGitHubCheckUrl(
  externalId: string,
  appId: string,
  detailsUrl: string,
): void {
  const key = reconciliationKey(externalId, appId);
  reconciledCheckUrls.delete(key);
  reconciledCheckUrls.set(key, { detailsUrl, verifiedAt: Date.now() });
  if (reconciledCheckUrls.size > RECONCILED_URL_CACHE_LIMIT) {
    const oldestKey = reconciledCheckUrls.keys().next().value;
    if (oldestKey !== undefined) reconciledCheckUrls.delete(oldestKey);
  }
}

export async function findGitHubReviewChecks(
  request: GitHubReviewCheckRequest,
  headSha: string,
  externalId: string,
  appId: string,
): Promise<GitHubReviewCheckRun[]> {
  const matches: GitHubReviewCheckRun[] = [];
  for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
    const query = new URLSearchParams({
      check_name: "Paperclip Review",
      filter: "all",
      app_id: appId,
      per_page: String(CHECK_RUN_PAGE_SIZE),
      page: String(page),
    });
    const { check_runs: checkRuns } = await request(
      `/commits/${encodeURIComponent(headSha)}/check-runs?${query}`,
    );
    matches.push(
      ...checkRuns.filter(
        (check) =>
          check.external_id === externalId && String(check.app?.id) === appId,
      ),
    );
    if (checkRuns.length < CHECK_RUN_PAGE_SIZE) return matches;
  }
  throw new Error("GitHub review check history exceeded the pagination limit");
}
