import { and, eq, isNull, sql } from "drizzle-orm";
import { chatDeliveries, chatGitHubReviews, type Db } from "@paperclipai/db";
import type { GitHubReviewEventContext } from "@paperclipai/shared";
import { githubBotRepositoryToken, githubBotRequest } from "./chat-github-client.js";

/** Paperclip's own check never gates the request for it. */
const OWN_CHECK = "Paperclip Review";
const GREEN = new Set(["success", "neutral", "skipped"]);

export interface GitHubCheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at?: string | null;
  started_at?: string | null;
  id?: number;
}

export type GitHubGreenState = "green" | "pending" | "red";

/**
 * Required checks (from the branch rules) must each have a completed green
 * latest run; any completed non-green run of any other check is red. Without
 * required checks, every check must be completed green and at least one must
 * exist. Re-runs supersede earlier attempts of the same check name.
 */
export function githubHeadGreenState(
  runs: readonly GitHubCheckRunSummary[],
  required: readonly string[],
): GitHubGreenState {
  const latest = new Map<string, GitHubCheckRunSummary>();
  for (const run of runs) {
    if (run.name === OWN_CHECK) continue;
    const seen = latest.get(run.name);
    const key = (r: GitHubCheckRunSummary) =>
      `${r.started_at ?? ""}|${String(r.id ?? 0).padStart(20, "0")}`;
    if (!seen || key(run) > key(seen)) latest.set(run.name, run);
  }
  let pending = false;
  for (const run of latest.values()) {
    if (run.status !== "completed") {
      pending = true;
      continue;
    }
    if (!GREEN.has(run.conclusion ?? "")) return "red";
  }
  const gating = required.filter((name) => name !== OWN_CHECK);
  if (gating.length) {
    for (const name of gating) {
      const run = latest.get(name);
      if (!run || run.status !== "completed") return "pending";
    }
    return "green";
  }
  if (!latest.size || pending) return "pending";
  return "green";
}

export type GitHubGreenRequestOutcome =
  | { status: "requested"; headSha: string; reason: string }
  | {
      status:
        | "closed"
        | "draft"
        | "pending"
        | "red"
        | "already_reviewed"
        | "already_requested"
        | "not_admitted";
      headSha?: string;
      reason?: string;
    };

interface PullRequestPayload {
  state: string;
  draft: boolean;
  number: number;
  title: string;
  body: string | null;
  base: { sha: string; ref: string };
  head: { sha: string };
  user: { id: number; login: string; type?: string };
  labels: Array<{ name: string }>;
}

/**
 * Reads the pull request and its head checks with the endpoint's own
 * repository-scoped App token and builds the automatic review context only
 * when the head is green and has no live or completed review yet. The context
 * is built from GitHub's data, never from the caller.
 */
export async function githubGreenReviewContext(input: {
  db: Db;
  fetchImpl: typeof fetch;
  companyId: string;
  endpointId: string;
  repositoryId: string;
  repository: string;
  pullNumber: number;
}): Promise<
  | { ready: true; context: GitHubReviewEventContext }
  | { ready: false; outcome: GitHubGreenRequestOutcome }
> {
  const token = await githubBotRepositoryToken(
    input.db,
    input.companyId,
    input.endpointId,
    input.repositoryId,
    input.fetchImpl,
    "read",
  );
  const prefix = `/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
  const get = <T>(path: string) =>
    githubBotRequest<T>(input.fetchImpl, token, `${prefix}${path}`);
  const pr = await get<PullRequestPayload>(`/pulls/${input.pullNumber}`);
  const headSha = pr.head.sha.toLowerCase();
  if (pr.state !== "open") return { ready: false, outcome: { status: "closed", headSha } };
  if (pr.draft) return { ready: false, outcome: { status: "draft", headSha } };
  const attempt = await githubGreenReviewAttempt(input.db, {
    companyId: input.companyId,
    endpointId: input.endpointId,
    repositoryId: input.repositoryId,
    pullNumber: input.pullNumber,
    headSha,
  });
  if (attempt.kind !== "ready")
    return {
      ready: false,
      outcome: {
        status: attempt.kind === "retries_exhausted" ? "already_reviewed" : attempt.kind,
        headSha,
      },
    };
  const rules = await get<
    Array<{
      type: string;
      parameters?: { required_status_checks?: Array<{ context: string }> };
    }>
  >(`/rules/branches/${encodeURIComponent(pr.base.ref)}`);
  const required = [
    ...new Set(
      rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) =>
          (rule.parameters?.required_status_checks ?? []).map((c) => c.context),
        ),
    ),
  ];
  const runs: GitHubCheckRunSummary[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await get<{ total_count: number; check_runs: GitHubCheckRunSummary[] }>(
      `/commits/${headSha}/check-runs?per_page=100&filter=latest&page=${page}`,
    );
    runs.push(...batch.check_runs);
    if (runs.length >= batch.total_count || batch.check_runs.length < 100) break;
  }
  const state = githubHeadGreenState(runs, required);
  if (state !== "green") return { ready: false, outcome: { status: state, headSha } };
  return {
    ready: true,
    context: {
      event: "checks_green",
      deliveryId: attempt.deliveryId,
      repositoryId: input.repositoryId,
      repository: input.repository.toLowerCase(),
      pullNumber: pr.number,
      title: pr.title.slice(0, 1000),
      body: (pr.body ?? "").slice(0, 24000),
      baseSha: pr.base.sha.toLowerCase(),
      headSha,
      baseBranch: pr.base.ref,
      author: {
        id: String(pr.user.id),
        login: pr.user.login,
        isBot: pr.user.type === "Bot",
      },
      // The request is the server's own green-checks decision; authority is
      // the PR author's, exactly as for an automatic pull_request event.
      sender: { id: String(pr.user.id), login: pr.user.login },
      draft: pr.draft,
      labels: pr.labels.map((label) => label.name),
    },
  };
}

/** First review plus two retries per head. */
export const GITHUB_GREEN_REVIEW_MAX_ATTEMPTS = 3;

/**
 * Decides whether a head may get a (re)review and under which delivery id.
 * Review rows and deliveries are unique per delivery id, so each attempt has
 * its own id: attempt 1 is `checks-green:<repo>:<pr>:<head>`, attempt N>1
 * appends `:attempt-N`. An attempt is spent when its review row ended
 * incomplete/error/superseded, or when its delivery ended failed/filtered
 * without ever writing a review row (the row insert rolls back with the task
 * transaction). A delivery still pending under an attempt's id is in flight
 * and is reported, never repeated.
 */
export async function githubGreenReviewAttempt(
  db: Db,
  input: {
    companyId: string;
    endpointId: string;
    repositoryId: string;
    pullNumber: number;
    headSha: string;
  },
): Promise<
  | { kind: "already_reviewed" | "already_requested" | "retries_exhausted" }
  | { kind: "ready"; deliveryId: string; attempt: number }
> {
  const rows = await db
    .select({
      state: chatGitHubReviews.state,
      /** The chat_deliveries row id that started this review. */
      deliveryId: chatGitHubReviews.deliveryId,
    })
    .from(chatGitHubReviews)
    .where(
      and(
        eq(chatGitHubReviews.companyId, input.companyId),
        eq(chatGitHubReviews.endpointId, input.endpointId),
        eq(chatGitHubReviews.repositoryId, input.repositoryId),
        eq(chatGitHubReviews.pullNumber, input.pullNumber),
        eq(chatGitHubReviews.headSha, input.headSha),
      ),
    );
  if (rows.some((row) => LIVE_OR_DONE.has(row.state)))
    return { kind: "already_reviewed" };
  const base = `checks-green:${input.repositoryId}:${input.pullNumber}:${input.headSha}`;
  const deliveries = await db
    .select({
      id: chatDeliveries.id,
      state: chatDeliveries.state,
      deliveryId: sql<string>`${chatDeliveries.normalizedEvent}->'githubAutomatic'->'context'->>'deliveryId'`,
    })
    .from(chatDeliveries)
    .where(
      and(
        eq(chatDeliveries.companyId, input.companyId),
        eq(chatDeliveries.endpointId, input.endpointId),
        sql`${chatDeliveries.normalizedEvent}->'githubAutomatic'->'context'->>'deliveryId' like ${`${base}%`}`,
      ),
    );
  for (let attempt = 1; attempt <= GITHUB_GREEN_REVIEW_MAX_ATTEMPTS; attempt++) {
    const deliveryId = attempt === 1 ? base : `${base}:attempt-${attempt}`;
    const delivery = deliveries.find((row) => row.deliveryId === deliveryId);
    if (!delivery) return { kind: "ready", deliveryId, attempt };
    // Review rows reference the chat_deliveries row id, not the event's
    // delivery id. A row here is not live or done (checked above): spent.
    if (rows.some((row) => row.deliveryId === delivery.id)) continue;
    if (DEAD_DELIVERY.has(delivery.state)) continue;
    return { kind: "already_requested" };
  }
  return { kind: "retries_exhausted" };
}

const LIVE_OR_DONE = new Set(["queued", "running", "completed"]);
const DEAD_DELIVERY = new Set(["failed", "filtered"]);

/**
 * A queued review that never started is dead once its head moves or the pull
 * request closes; mark it superseded so queues and checks reflect real work.
 * Synchronize matches only the payload's previous head, so a late event cannot
 * supersede a newer head. Started, assessed, or terminal reviews are never touched.
 */
export async function supersedeQueuedGitHubReviews(
  db: Db,
  input: {
    companyId: string;
    endpointId: string;
    repositoryId: string;
    pullNumber: number;
    /** null when the pull request closed: every queued review is stale. */
    beforeHeadSha: string | null;
  },
): Promise<number> {
  const rows = await db
    .update(chatGitHubReviews)
    .set({ state: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(chatGitHubReviews.companyId, input.companyId),
        eq(chatGitHubReviews.endpointId, input.endpointId),
        eq(chatGitHubReviews.repositoryId, input.repositoryId),
        eq(chatGitHubReviews.pullNumber, input.pullNumber),
        eq(chatGitHubReviews.state, "queued"),
        isNull(chatGitHubReviews.assessment),
        isNull(chatGitHubReviews.runId),
        ...(input.beforeHeadSha !== null
          ? [eq(chatGitHubReviews.headSha, input.beforeHeadSha.toLowerCase())]
          : []),
      ),
    )
    .returning({ id: chatGitHubReviews.id });
  return rows.length;
}

/** pull_request webhook actions that move or end a head; null otherwise. */
export function githubHeadTransition(payload: unknown): {
  repositoryId: string;
  pullNumber: number;
  beforeHeadSha: string | null;
} | null {
  const data = payload as {
    action?: unknown;
    before?: unknown;
    repository?: { id?: unknown };
    pull_request?: { number?: unknown; head?: { sha?: unknown } };
  } | null;
  const action = data?.action;
  if (action !== "synchronize" && action !== "closed") return null;
  const repositoryId = data?.repository?.id;
  const pullNumber = data?.pull_request?.number;
  const head = data?.pull_request?.head?.sha;
  if (
    (typeof repositoryId !== "number" && typeof repositoryId !== "string") ||
    !/^[1-9][0-9]*$/.test(String(repositoryId)) ||
    typeof pullNumber !== "number" ||
    !Number.isSafeInteger(pullNumber) ||
    pullNumber < 1
  )
    return null;
  if (action === "closed")
    return { repositoryId: String(repositoryId), pullNumber, beforeHeadSha: null };
  const before = data?.before;
  if (
    typeof head !== "string" ||
    !/^[a-f0-9]{40}$/i.test(head) ||
    typeof before !== "string" ||
    !/^[a-f0-9]{40}$/i.test(before)
  )
    return null;
  return {
    repositoryId: String(repositoryId),
    pullNumber,
    beforeHeadSha: before.toLowerCase(),
  };
}
