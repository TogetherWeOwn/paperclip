import { and, desc, eq, or, sql } from "drizzle-orm";
import {
  chatActions,
  chatEndpointResources,
  chatEndpoints,
  chatGithubCarryRuns,
  chatGitHubConfigurations,
  chatGitHubReviews,
  companies,
  type Db,
} from "@paperclipai/db";
import { runtimePublicOrigin } from "./cloud-runtime-identity.js";
import {
  githubBotRepositoryToken,
  githubBotRequest,
} from "./chat-github-client.js";
import {
  PAPERCLIP_REVIEW_CHECK_NAME,
  decideMergeGroupCarry,
  mergeGroupCarryCheckBody,
  mergeGroupCarryExternalId,
  parseMergeGroupQueuedPrs,
  type MergeGroupCarryInput,
  type MergeGroupCarryVerdict,
  type MergeGroupContext,
  type MergeGroupGitHub,
  type MergeGroupReviewRecord,
} from "./chat-github-merge-group.js";

/** Recompute window for a merge_group event before it is treated as superseded. */
export const MERGE_GROUP_CARRY_MAX_EVENT_AGE_MS = 30 * 60_000;

const CARRY_ACTION_KIND = "github_merge_group_carry";

/** Native carry stays inert until the endpoint opts in. The host bridge owns
 * carry until native support is reviewed and released; enabling this flag on
 * an endpoint while the bridge still writes would create two check writers. */
export function mergeGroupCarryEnabled(
  configuration: { mergeGroupCarryEnabled?: boolean } | null | undefined,
): boolean {
  return configuration?.mergeGroupCarryEnabled === true;
}

export type MergeGroupGitHubRequest = <T>(
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<T>;

/** Map raw GitHub REST payloads onto the pure decision interface. Every
 * failure or malformed payload becomes null so the decision fails closed. */
export function createMergeGroupGitHubReader(
  request: MergeGroupGitHubRequest,
): MergeGroupGitHub {
  return {
    async getPull(pullNumber) {
      let raw: unknown;
      try {
        raw = await request<unknown>(`/pulls/${pullNumber}`);
      } catch {
        return null;
      }
      if (!raw || typeof raw !== "object") return null;
      const pull = raw as {
        number?: unknown;
        head?: { sha?: unknown };
        base?: { sha?: unknown };
        state?: unknown;
        merged?: unknown;
      };
      if (
        typeof pull.number !== "number" ||
        !Number.isInteger(pull.number) ||
        typeof pull.head?.sha !== "string" ||
        typeof pull.base?.sha !== "string" ||
        typeof pull.state !== "string" ||
        typeof pull.merged !== "boolean"
      )
        return null;
      return {
        number: pull.number,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        state: pull.state,
        merged: pull.merged,
      };
    },
    async getCompare(baseSha, headSha) {
      let raw: unknown;
      try {
        raw = await request<unknown>(`/compare/${baseSha}...${headSha}`);
      } catch {
        return null;
      }
      if (!raw || typeof raw !== "object") return null;
      const compare = raw as {
        total_commits?: unknown;
        commits?: unknown;
      };
      if (!Array.isArray(compare.commits)) return null;
      const commits: { sha: string; parents: number; message: string }[] = [];
      for (const entry of compare.commits) {
        if (!entry || typeof entry !== "object") return null;
        const commit = entry as {
          sha?: unknown;
          parents?: unknown;
          commit?: { message?: unknown };
        };
        if (
          typeof commit.sha !== "string" ||
          !Array.isArray(commit.parents) ||
          typeof commit.commit?.message !== "string"
        )
          return null;
        commits.push({
          sha: commit.sha,
          parents: commit.parents.length,
          message: commit.commit.message,
        });
      }
      const total =
        typeof compare.total_commits === "number"
          ? compare.total_commits
          : commits.length;
      return { truncated: total > commits.length, commits };
    },
    async getTree(sha) {
      let raw: unknown;
      try {
        raw = await request<unknown>(`/git/trees/${sha}?recursive=1`);
      } catch {
        return null;
      }
      if (!raw || typeof raw !== "object") return null;
      const tree = raw as { sha?: unknown; truncated?: unknown; tree?: unknown };
      if (typeof tree.sha !== "string" || !Array.isArray(tree.tree))
        return null;
      const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
      for (const entry of tree.tree) {
        if (!entry || typeof entry !== "object") return null;
        const node = entry as {
          path?: unknown;
          mode?: unknown;
          type?: unknown;
          sha?: unknown;
        };
        if (typeof node.path !== "string") return null;
        entries.push({
          path: node.path,
          mode: typeof node.mode === "string" ? node.mode : "",
          type: typeof node.type === "string" ? node.type : "",
          sha: typeof node.sha === "string" ? node.sha : null,
        });
      }
      return {
        sha: tree.sha,
        truncated: tree.truncated === true,
        entries,
      };
    },
    async listReviewChecks(headSha) {
      let raw: unknown;
      try {
        raw = await request<unknown>(
          `/commits/${headSha}/check-runs?check_name=Paperclip%20Review&per_page=100`,
        );
      } catch {
        return null;
      }
      if (!raw || typeof raw !== "object") return null;
      const { check_runs: runs } = raw as { check_runs?: unknown };
      if (!Array.isArray(runs)) return null;
      const checks: {
        appId: string;
        externalId: string;
        status: string;
        conclusion: string | null;
      }[] = [];
      for (const entry of runs) {
        if (!entry || typeof entry !== "object") return null;
        const run = entry as {
          status?: unknown;
          conclusion?: unknown;
          external_id?: unknown;
          app?: { id?: unknown };
        };
        if (
          typeof run.status !== "string" ||
          typeof run.external_id !== "string" ||
          (run.conclusion !== null &&
            run.conclusion !== undefined &&
            typeof run.conclusion !== "string")
        )
          return null;
        checks.push({
          appId: String(run.app?.id ?? ""),
          externalId: run.external_id,
          status: run.status,
          conclusion:
            typeof run.conclusion === "string" ? run.conclusion : null,
        });
      }
      return checks;
    },
  };
}

export type MergeGroupCheckRunRef = {
  id: number;
  status: string;
  externalId: string;
  appId: string;
};

export type MergeGroupCheckPublication = {
  method: "POST" | "PATCH";
  path: string;
  body: {
    name: string;
    head_sha: string;
    external_id: string;
    details_url?: string;
    status: "completed";
    conclusion: "success" | "action_required";
    output: { title: string; summary: string };
  };
};

/** Plan the single check-run write for a carry verdict. A run that already
 * carries this idempotency key is patched in place; otherwise a fresh run is
 * posted. Completed-to-completed updates can change the conclusion, so a
 * prior run is always adopted rather than duplicated. */
export function planMergeGroupCheckPublication(args: {
  ctx: MergeGroupContext;
  endpointId: string;
  appId: string;
  verdict: MergeGroupCarryVerdict;
  existingChecks: MergeGroupCheckRunRef[];
  detailsUrl: string | null;
}): MergeGroupCheckPublication {
  const externalId = mergeGroupCarryExternalId(args.endpointId, args.ctx.groupSha);
  const { title, summary } = mergeGroupCarryCheckBody(
    args.ctx.repository,
    args.verdict,
  );
  const body: MergeGroupCheckPublication["body"] = {
    name: PAPERCLIP_REVIEW_CHECK_NAME,
    head_sha: args.ctx.groupSha,
    external_id: externalId,
    ...(args.detailsUrl ? { details_url: args.detailsUrl } : {}),
    status: "completed",
    conclusion: args.verdict.ok ? "success" : "action_required",
    output: { title, summary },
  };
  const match = args.existingChecks.find(
    (check) =>
      check.externalId === externalId && check.appId === args.appId,
  );
  if (match) return { method: "PATCH", path: `/check-runs/${match.id}`, body };
  return { method: "POST", path: "/check-runs", body };
}

function toReviewRecord(row: {
  pullNumber: number;
  headSha: string;
  state: string;
  assessment: { complete?: unknown; score?: unknown } | null;
  conclusion: string | null;
  configurationRevision: number;
}): MergeGroupReviewRecord {
  return {
    pullNumber: row.pullNumber,
    headSha: row.headSha,
    state: row.state,
    complete: row.assessment?.complete === true,
    score:
      typeof row.assessment?.score === "number" ? row.assessment.score : 0,
    conclusion: row.conclusion,
    configurationRevision: row.configurationRevision,
  };
}

/** Carry outbox: one action per webhook delivery, one verdict per group key.
 * Check delivery and review admission run independently; the publication below
 * owns the group verdict and its retries. */
export function githubMergeGroupCarryService(db: Db, fetchImpl = fetch) {
  async function enqueue(
    endpoint: typeof chatEndpoints.$inferSelect,
    ctx: MergeGroupContext,
    admitted: boolean,
    reason: string,
    revision: number,
  ) {
    const [config] = await db
      .select()
      .from(chatGitHubConfigurations)
      .where(eq(chatGitHubConfigurations.endpointId, endpoint.id));
    if (!config || !mergeGroupCarryEnabled(config.configuration)) return;
    await db
      .insert(chatActions)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        kind: CARRY_ACTION_KIND,
        providerActionId: `github-merge-carry:${ctx.deliveryId}`,
        payload: {
          version: 1,
          ctx,
          admitted,
          reason,
          revision,
          runtimeGeneration:
            (endpoint.setup as { runtimeGeneration?: number })
              .runtimeGeneration ?? 0,
        },
        status: "received",
      })
      .onConflictDoNothing();
  }

  async function failAction(
    id: string,
    code: string,
    attempts: number,
    retryable: boolean,
  ) {
    await db
      .update(chatActions)
      .set({
        status: retryable ? "failed" : "cancelled",
        result: {
          attempts,
          retryable,
          ...(retryable
            ? {
                retryAt: new Date(
                  Date.now() + Math.min(300000, 1000 * 2 ** attempts),
                ).toISOString(),
              }
            : {}),
          code,
        },
        updatedAt: new Date(),
      })
      .where(eq(chatActions.id, id));
  }

  async function dispatch(id: string) {
    const [action] = await db
      .select()
      .from(chatActions)
      .where(
        and(eq(chatActions.id, id), eq(chatActions.kind, CARRY_ACTION_KIND)),
      )
      .limit(1);
    if (!action || ["processed", "cancelled"].includes(action.status)) return;
    const payload = action.payload as {
      ctx?: MergeGroupContext;
      admitted?: boolean;
      reason?: string;
      revision?: number;
      runtimeGeneration?: number;
    };
    const ctx = payload.ctx;
    if (
      !ctx ||
      typeof ctx.groupSha !== "string" ||
      typeof ctx.groupRef !== "string" ||
      typeof ctx.baseSha !== "string" ||
      typeof ctx.repositoryId !== "string" ||
      typeof ctx.repository !== "string"
    ) {
      await failAction(id, "carry_payload_invalid", 1, false);
      return;
    }
    let attempts = Number(
      (action.result as { attempts?: unknown } | null)?.attempts ?? 0,
    );
    try {
      const [source] = await db
        .select({
          endpoint: chatEndpoints,
          resource: chatEndpointResources,
          configuration: chatGitHubConfigurations.configuration,
          companyPrefix: companies.issuePrefix,
        })
        .from(chatEndpoints)
        .innerJoin(companies, eq(companies.id, chatEndpoints.companyId))
        .innerJoin(
          chatGitHubConfigurations,
          eq(chatGitHubConfigurations.endpointId, chatEndpoints.id),
        )
        .innerJoin(
          chatEndpointResources,
          eq(chatEndpointResources.endpointId, chatEndpoints.id),
        )
        .where(
          and(
            eq(chatEndpoints.id, action.endpointId),
            eq(chatEndpoints.companyId, action.companyId),
            eq(chatEndpointResources.providerResourceId, ctx.repository),
          ),
        );
      if (
        !source ||
        !["active", "verifying"].includes(source.endpoint.status) ||
        !source.resource.enabled ||
        source.resource.availability !== "available" ||
        String(source.resource.metadata?.providerRepositoryId) !==
          ctx.repositoryId ||
        ((source.endpoint.setup as { runtimeGeneration?: number })
          .runtimeGeneration ?? 0) !== payload.runtimeGeneration
      ) {
        await db
          .update(chatActions)
          .set({
            status: "cancelled",
            result: { code: "connection_changed" },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, id));
        return;
      }
      if (!mergeGroupCarryEnabled(source.configuration)) {
        await db
          .update(chatActions)
          .set({
            status: "cancelled",
            result: { code: "carry_disabled" },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, id));
        return;
      }
      if (payload.admitted === false) {
        await db
          .update(chatActions)
          .set({
            status: "cancelled",
            result: { code: "not_admitted", reason: payload.reason ?? null },
            updatedAt: new Date(),
          })
          .where(eq(chatActions.id, id));
        return;
      }

      const externalId = mergeGroupCarryExternalId(
        action.endpointId,
        ctx.groupSha,
      );
      const [claimed] = await db
        .insert(chatGithubCarryRuns)
        .values({
          companyId: action.companyId,
          endpointId: action.endpointId,
          repositoryId: ctx.repositoryId,
          repository: ctx.repository,
          groupSha: ctx.groupSha,
          baseSha: ctx.baseSha,
          heads: [],
          deliveryId: ctx.deliveryId,
          configurationRevision:
            typeof payload.revision === "number" ? payload.revision : 0,
          status: "processing",
          externalId,
        })
        .onConflictDoNothing()
        .returning({ id: chatGithubCarryRuns.id });
      if (!claimed) {
        const [existing] = await db
          .select()
          .from(chatGithubCarryRuns)
          .where(
            and(
              eq(chatGithubCarryRuns.endpointId, action.endpointId),
              eq(chatGithubCarryRuns.groupSha, ctx.groupSha),
            ),
          )
          .limit(1);
        if (existing?.status === "processed") {
          // Same group key already has a verdict: return it without new writes.
          await db
            .update(chatActions)
            .set({
              status: "processed",
              result: {
                code: existing.code,
                carryRunId: existing.id,
                replayed: true,
              },
              updatedAt: new Date(),
            })
            .where(eq(chatActions.id, id));
          return;
        }
        if (existing?.status === "processing") return;
        if (existing) {
          await db
            .update(chatGithubCarryRuns)
            .set({ status: "processing", updatedAt: new Date() })
            .where(eq(chatGithubCarryRuns.id, existing.id));
        }
      }

      const token = await githubBotRepositoryToken(
        db,
        action.companyId,
        action.endpointId,
        ctx.repositoryId,
        fetchImpl,
      );
      const prefix = `/repos/${ctx.repository.split("/").map(encodeURIComponent).join("/")}`;
      const request: MergeGroupGitHubRequest = <T,>(
        path: string,
        options?: { method?: string; body?: unknown },
      ) => githubBotRequest<T>(fetchImpl, token, `${prefix}${path}`, options);
      const github = createMergeGroupGitHubReader(request);
      const cache = new Map<string, Promise<unknown>>();
      const cached: MergeGroupGitHub = {
        getPull: (n) => {
          const key = `pull:${n}`;
          if (!cache.has(key)) cache.set(key, github.getPull(n));
          return cache.get(key) as ReturnType<MergeGroupGitHub["getPull"]>;
        },
        getCompare: (base, head) => {
          const key = `compare:${base}:${head}`;
          if (!cache.has(key)) cache.set(key, github.getCompare(base, head));
          return cache.get(key) as ReturnType<MergeGroupGitHub["getCompare"]>;
        },
        getTree: (sha) => {
          const key = `tree:${sha}`;
          if (!cache.has(key)) cache.set(key, github.getTree(sha));
          return cache.get(key) as ReturnType<MergeGroupGitHub["getTree"]>;
        },
        listReviewChecks: (sha) => {
          const key = `checks:${sha}`;
          if (!cache.has(key)) cache.set(key, github.listReviewChecks(sha));
          return cache.get(key) as ReturnType<
            MergeGroupGitHub["listReviewChecks"]
          >;
        },
      };

      // Discover the queued set once so the review lookup and the decision
      // observe identical evidence; tree ownership (not enumeration) is proof.
      const refPrs = parseMergeGroupQueuedPrs(ctx.groupRef) ?? [];
      const compare = await cached.getCompare(ctx.baseSha, ctx.groupSha);
      const commitPrs = new Set<number>();
      for (const commit of compare?.commits ?? []) {
        const firstLine = commit.message.split("\n", 1)[0] ?? "";
        const merge = /^Merge pull request #(\d{1,9}) from \S+/.exec(firstLine);
        if (merge && commit.parents === 2) {
          commitPrs.add(Number(merge[1]));
          continue;
        }
        const squash = /\(#(\d{1,9})\)\s*$/.exec(firstLine);
        if (squash && commit.parents === 1) commitPrs.add(Number(squash[1]));
      }
      const pullNumbers = new Set<number>();
      for (const pr of refPrs) pullNumbers.add(pr.pullNumber);
      for (const n of commitPrs) pullNumbers.add(n);

      const confirmed = new Map<number, { headSha: string }>();
      for (const n of [...pullNumbers].sort((a, b) => a - b)) {
        const pull = await cached.getPull(n);
        if (pull) confirmed.set(n, { headSha: pull.headSha });
      }
      const reviewRows = await db
        .select()
        .from(chatGitHubReviews)
        .where(
          and(
            eq(chatGitHubReviews.endpointId, action.endpointId),
            eq(chatGitHubReviews.repositoryId, ctx.repositoryId),
          ),
        )
        .orderBy(desc(chatGitHubReviews.createdAt))
        .limit(500);
      const reviews: MergeGroupReviewRecord[] = [];
      for (const [pullNumber, head] of confirmed) {
        const row = reviewRows.find(
          (candidate) =>
            candidate.pullNumber === pullNumber &&
            candidate.headSha.toLowerCase() === head.headSha.toLowerCase(),
        );
        if (row) reviews.push(toReviewRecord(row));
      }

      const appId = source.endpoint.botExternalId ?? "";
      const input: MergeGroupCarryInput = {
        endpointId: action.endpointId,
        appId,
        eventAgeMs: Date.now() - new Date(action.createdAt).getTime(),
        maxEventAgeMs: MERGE_GROUP_CARRY_MAX_EVENT_AGE_MS,
        reviews,
      };
      const verdict = await decideMergeGroupCarry(ctx, cached, input);

      // Publication is idempotent by construction: an existing run carrying
      // this key is adopted, so a crash between POST and row update replays
      // into a PATCH instead of a duplicate run. The decision projection
      // drops run ids, so the group head is listed raw to resolve ids here.
      const rawGroupChecks = await request<{
        check_runs?: Array<{
          id?: unknown;
          status?: unknown;
          conclusion?: unknown;
          external_id?: unknown;
          app?: { id?: unknown };
        }>;
      }>(
        `/commits/${ctx.groupSha}/check-runs?check_name=Paperclip%20Review&per_page=100`,
      ).catch(() => null);
      const existingChecks: MergeGroupCheckRunRef[] = [];
      if (Array.isArray(rawGroupChecks?.check_runs)) {
        for (const run of rawGroupChecks.check_runs) {
          if (
            typeof run?.id !== "number" ||
            !Number.isInteger(run.id) ||
            typeof run?.status !== "string" ||
            typeof run?.external_id !== "string"
          )
            throw new Error("carried check runs could not be listed");
          existingChecks.push({
            id: run.id,
            status: run.status,
            externalId: run.external_id,
            appId: String(run.app?.id ?? ""),
          });
        }
      }
      const origin = runtimePublicOrigin();
      const detailsUrl = origin
        ? `${origin}/${encodeURIComponent(source.companyPrefix)}/apps/chat/${action.endpointId}/reviews`
        : null;
      const plan = planMergeGroupCheckPublication({
        ctx,
        endpointId: action.endpointId,
        appId,
        verdict,
        existingChecks,
        detailsUrl,
      });
      const posted = await request<{ id?: unknown; html_url?: unknown }>(
        plan.path,
        { method: plan.method, body: plan.body },
      );
      const checkId =
        typeof posted?.id === "number" || typeof posted?.id === "string"
          ? String(posted.id)
          : null;

      await db
        .update(chatGithubCarryRuns)
        .set({
          baseSha: ctx.baseSha,
          heads: verdict.ok ? verdict.carried : [],
          configurationRevision:
            typeof payload.revision === "number" ? payload.revision : 0,
          status: "processed",
          verdictOk: verdict.ok,
          code: verdict.code,
          detail: verdict.ok ? null : verdict.detail,
          checkId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatGithubCarryRuns.endpointId, action.endpointId),
            eq(chatGithubCarryRuns.groupSha, ctx.groupSha),
          ),
        );
      await db
        .update(chatActions)
        .set({
          status: "processed",
          result: {
            code: verdict.ok ? "carry" : verdict.code,
            attempts: 0,
          },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, id));
    } catch (error) {
      attempts++;
      const retryable = attempts < 8;
      await failAction(
        id,
        "carry_publication_failed",
        attempts,
        retryable,
      ).catch(() => {});
      if (!retryable) {
        await db
          .update(chatGithubCarryRuns)
          .set({ status: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(chatGithubCarryRuns.endpointId, action.endpointId),
              eq(chatGithubCarryRuns.groupSha, ctx.groupSha),
            ),
          )
          .catch(() => {});
      }
      void error;
    }
  }

  async function processPending(limit = 10) {
    const rows = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, CARRY_ACTION_KIND),
          or(
            and(
              eq(chatActions.status, "received"),
              sql`(${chatActions.result}->>'retryAt' is null or (${chatActions.result}->>'retryAt')::timestamptz <= now())`,
            ),
            and(
              eq(chatActions.status, "failed"),
              sql`${chatActions.result}->>'retryable' = 'true'`,
              sql`(${chatActions.result}->>'retryAt')::timestamptz <= now()`,
            ),
          ),
        ),
      )
      .orderBy(chatActions.updatedAt)
      .limit(limit);
    for (const row of rows) await dispatch(row.id);
  }

  return { enqueue, processPending };
}
