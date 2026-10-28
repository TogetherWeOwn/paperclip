import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
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
  GitHubPublicationLeaseLost,
  withGitHubPublicationLease,
} from "./chat-github-publication-lease.js";
import type {
  MergeGroupCarryProofFingerprint,
  MergeGroupCarryPublicationAttempt,
} from "@paperclipai/shared";
import {
  PAPERCLIP_REVIEW_CHECK_NAME,
  buildMergeGroupProofFingerprint,
  decideMergeGroupCarry,
  mergeGroupCarryCheckBody,
  mergeGroupCarryExternalId,
  mergeGroupProofReplayMatches,
  parseMergeGroupQueuedPrs,
  prsFromCompareCommits,
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

const FULL_SHA = /^[0-9a-f]{40}$/i;
const REF_SEGMENT = /^[A-Za-z0-9._-]+$/;
const CHECK_RUN_PAGE = 100;

type PublicationLease = Parameters<
  Parameters<typeof withGitHubPublicationLease<void>>[3]
>[0];

export type MergeGroupGitHubRequest = <T>(
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<T>;

/** Strict provider identity: a digit string or a safe-integer number. Arrays,
 * objects, floats, and other shapes must never coerce into an App identity —
 * `String(...)` would turn `['5191093']` into `'5191093'`. Null when the raw
 * value is not a plain App ID. */
function strictAppId(raw: unknown): string | null {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) return null;
    return String(raw);
  }
  if (typeof raw === "string" && /^[0-9]+$/.test(raw)) return raw;
  return null;
}

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
      const commits: { sha: string; parents: string[]; message: string }[] = [];
      for (const entry of compare.commits) {
        if (!entry || typeof entry !== "object") return null;
        const commit = entry as {
          sha?: unknown;
          parents?: unknown;
          commit?: { message?: unknown };
        };
        if (
          typeof commit.sha !== "string" ||
          !FULL_SHA.test(commit.sha) ||
          !Array.isArray(commit.parents) ||
          typeof commit.commit?.message !== "string"
        )
          return null;
        const parents: string[] = [];
        for (const parent of commit.parents) {
          const parentSha = (parent as { sha?: unknown } | null)?.sha;
          if (typeof parentSha !== "string" || !FULL_SHA.test(parentSha))
            return null;
          parents.push(parentSha.toLowerCase());
        }
        commits.push({
          sha: commit.sha,
          parents,
          message: commit.commit.message,
        });
      }
      // Exact totals only: a missing or malformed total cannot prove the page
      // is complete, so it is rejected rather than defaulted. A short page is
      // truncated evidence (rejected downstream); a long page is malformed.
      // Repeated commit identities can satisfy the total while hiding unseen
      // commits, so uniqueness is required as well.
      const total = compare.total_commits;
      if (typeof total !== "number" || !Number.isInteger(total) || total < 0)
        return null;
      if (total < commits.length) return null;
      const identities = new Set(commits.map((commit) => commit.sha.toLowerCase()));
      if (identities.size !== commits.length) return null;
      return { truncated: total > commits.length, commits };
    },
    async getMergeBase(baseSha, headSha) {
      if (!FULL_SHA.test(baseSha) || !FULL_SHA.test(headSha)) return null;
      let raw: unknown;
      try {
        raw = await request<unknown>(`/compare/${baseSha}...${headSha}`);
      } catch {
        return null;
      }
      const mergeBase = (
        raw as { merge_base_commit?: { sha?: unknown } } | null
      )?.merge_base_commit?.sha;
      return typeof mergeBase === "string" && FULL_SHA.test(mergeBase)
        ? mergeBase.toLowerCase()
        : null;
    },
    async getRefSha(groupRef) {
      const segments = groupRef.startsWith("refs/heads/")
        ? groupRef.slice("refs/heads/".length).split("/")
        : null;
      if (
        !segments ||
        !segments.every(
          (segment) =>
            REF_SEGMENT.test(segment) && segment !== "." && segment !== "..",
        )
      )
        return null;
      let raw: unknown;
      try {
        raw = await request<unknown>(
          `/git/ref/heads/${segments.map(encodeURIComponent).join("/")}`,
        );
      } catch {
        return null;
      }
      const ref = raw as {
        ref?: unknown;
        object?: { sha?: unknown; type?: unknown };
      } | null;
      if (
        !ref ||
        ref.ref !== groupRef ||
        ref.object?.type !== "commit" ||
        typeof ref.object.sha !== "string" ||
        !FULL_SHA.test(ref.object.sha)
      )
        return null;
      return ref.object.sha.toLowerCase();
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
      // Strict tree evidence: an explicit boolean truncation flag, exact
      // object identities, supported type/mode pairs, and nonempty unique
      // paths. Anything less is rejected — a malformed blob must never
      // masquerade as a deletion in the absence comparison downstream.
      if (
        typeof tree.sha !== "string" ||
        !FULL_SHA.test(tree.sha) ||
        typeof tree.truncated !== "boolean" ||
        !Array.isArray(tree.tree)
      )
        return null;
      const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
      const seenPaths = new Set<string>();
      // Valid Git path structure: no NUL byte, no leading slash, no empty
      // segments, and no `.`/`..` segments. Only structure is enforced here —
      // legitimate whitespace and executable/symlink/gitlink modes still pass.
      const isValidGitPath = (path: string): boolean => {
        if (path.includes("\0") || path.startsWith("/")) return false;
        const segments = path.split("/");
        return segments.every(
          (segment) =>
            segment.length > 0 && segment !== "." && segment !== "..",
        );
      };
      for (const entry of tree.tree) {
        if (!entry || typeof entry !== "object") return null;
        const node = entry as {
          path?: unknown;
          mode?: unknown;
          type?: unknown;
          sha?: unknown;
        };
        if (
          typeof node.path !== "string" ||
          node.path.length === 0 ||
          !isValidGitPath(node.path) ||
          seenPaths.has(node.path) ||
          typeof node.mode !== "string" ||
          typeof node.type !== "string" ||
          typeof node.sha !== "string" ||
          !FULL_SHA.test(node.sha) ||
          !(
            (node.type === "blob" &&
              (node.mode === "100644" ||
                node.mode === "100755" ||
                node.mode === "120000")) ||
            (node.type === "tree" && node.mode === "040000") ||
            (node.type === "commit" && node.mode === "160000")
          )
        )
          return null;
        seenPaths.add(node.path);
        entries.push({
          path: node.path,
          mode: node.mode,
          type: node.type,
          sha: node.sha,
        });
      }
      return {
        sha: tree.sha,
        truncated: tree.truncated,
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
      const { check_runs: runs, total_count: total } = raw as {
        check_runs?: unknown;
        total_count?: unknown;
      };
      if (!Array.isArray(runs) || !completeCheckRunPage(total, runs.length))
        return null;
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
        const appId = strictAppId(run.app?.id);
        if (
          typeof run.status !== "string" ||
          typeof run.external_id !== "string" ||
          appId === null ||
          (run.conclusion !== null &&
            run.conclusion !== undefined &&
            typeof run.conclusion !== "string")
        )
          return null;
        checks.push({
          appId,
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

/** A check-run page is only evidence when the provider-reported total is an
 * integer that exactly matches this single page. A missing, malformed, short
 * or paginated total means unseen runs may exist: never "no success". */
function completeCheckRunPage(total: unknown, returned: number): boolean {
  return (
    typeof total === "number" &&
    Number.isInteger(total) &&
    total >= 0 &&
    total <= CHECK_RUN_PAGE &&
    total === returned
  );
}

export type MergeGroupCheckRunRef = {
  id: number;
  status: string;
  externalId: string;
  appId: string;
};

/** Strict listing of the Paperclip Review runs on the group head. Throws when
 * the listing is unavailable, malformed or truncated so the caller can never
 * POST a duplicate on top of runs it could not see. */
export async function readMergeGroupCheckRuns(
  request: MergeGroupGitHubRequest,
  groupSha: string,
): Promise<MergeGroupCheckRunRef[]> {
  const unavailable = () =>
    new Error("carried check runs could not be listed completely");
  const raw = await request<unknown>(
    `/commits/${groupSha}/check-runs?check_name=Paperclip%20Review&per_page=${CHECK_RUN_PAGE}`,
  );
  if (!raw || typeof raw !== "object") throw unavailable();
  const { check_runs: runs, total_count: total } = raw as {
    check_runs?: unknown;
    total_count?: unknown;
  };
  if (!Array.isArray(runs) || !completeCheckRunPage(total, runs.length))
    throw unavailable();
  return runs.map((entry): MergeGroupCheckRunRef => {
    const run = entry as {
      id?: unknown;
      status?: unknown;
      external_id?: unknown;
      app?: { id?: unknown };
    } | null;
    // Check IDs are positive safe integers: -1, 0, and 2^53 are malformed
    // evidence, never run identities.
    const appId = strictAppId(run?.app?.id);
    if (
      !run ||
      typeof run.id !== "number" ||
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      typeof run.status !== "string" ||
      typeof run.external_id !== "string" ||
      appId === null
    )
      throw unavailable();
    return {
      id: run.id,
      status: run.status,
      externalId: run.external_id,
      appId,
    };
  });
}

/** Mutable identities re-read uncached at the provider-write boundary. */
export type MergeGroupBoundaryObservation = {
  revision: number;
  generation: number;
  enabled: boolean;
  admitted: boolean;
  appId: string;
  refSha: string | null;
  heads: Map<number, string | null>;
};

export type MergeGroupBoundaryCheck =
  | "match"
  | "disabled"
  | "connection"
  | "drift";

/** Re-read every mutable identity uncached at the write boundary: policy
 * revision and enablement, endpoint/credential epoch, review-app identity,
 * repository admission, the live queue-ref target, and every candidate pull
 * head. No memoization — these reads must observe the provider and the
 * configuration as they are now, not as evaluation saw them. Null when the
 * source row itself is gone. */
export async function readMergeGroupBoundaryObservation(
  db: Db,
  request: MergeGroupGitHubRequest,
  action: Pick<typeof chatActions.$inferSelect, "companyId" | "endpointId">,
  ctx: MergeGroupContext,
  pullNumbers: number[],
): Promise<MergeGroupBoundaryObservation | null> {
  const [fresh] = await db
    .select({
      endpoint: chatEndpoints,
      resource: chatEndpointResources,
      configuration: chatGitHubConfigurations.configuration,
      revision: chatGitHubConfigurations.revision,
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
  if (!fresh) return null;
  const generation =
    (fresh.endpoint.setup as { runtimeGeneration?: number } | null)
      ?.runtimeGeneration ?? 0;
  const reader = createMergeGroupGitHubReader(request);
  const heads = new Map<number, string | null>();
  for (const pullNumber of pullNumbers) {
    const pull = await reader.getPull(pullNumber);
    heads.set(pullNumber, pull ? pull.headSha : null);
  }
  return {
    revision: fresh.revision,
    generation,
    enabled: mergeGroupCarryEnabled(fresh.configuration),
    admitted:
      ["active", "verifying"].includes(fresh.endpoint.status) &&
      fresh.resource.enabled &&
      fresh.resource.availability === "available" &&
      String(fresh.resource.metadata?.providerRepositoryId) ===
        ctx.repositoryId,
    appId: fresh.endpoint.botExternalId ?? "",
    refSha: await reader.getRefSha(ctx.groupRef),
    heads,
  };
}

/** True only when the boundary observation matches the evaluated evidence on
 * every mutable identity. `disabled`/`connection` cancel without a provider
 * write; `drift` re-judges once. Success is never published from stale
 * evidence — only a matched boundary publishes it. */
export function checkMergeGroupBoundary(args: {
  observation: MergeGroupBoundaryObservation;
  sourceGeneration: number;
  sourceAppId: string;
  evaluation: {
    revision: number;
    observedRefSha: string | null;
    observedHeads: Array<{ pullNumber: number; headSha: string }>;
  };
}): MergeGroupBoundaryCheck {
  const { observation: o, evaluation: e } = args;
  if (!o.enabled) return "disabled";
  if (
    !o.admitted ||
    o.generation !== args.sourceGeneration ||
    o.appId !== args.sourceAppId
  )
    return "connection";
  if (o.revision !== e.revision) return "drift";
  const norm = (sha: string | null) => sha?.toLowerCase() ?? null;
  if (norm(o.refSha) !== norm(e.observedRefSha)) return "drift";
  const expected = new Map(
    e.observedHeads.map((head) => [head.pullNumber, head.headSha.toLowerCase()]),
  );
  if (o.heads.size !== expected.size) return "drift";
  for (const [pullNumber, headSha] of expected)
    if (norm(o.heads.get(pullNumber) ?? null) !== headSha) return "drift";
  return "match";
}

/** HTTP statuses that document a rejected-before-application outcome for a
 * check-run write: the request was refused (bad request, auth, forbidden,
 * unknown target, unprocessable), so no write applied. Every other signal —
 * 5xx (including a gateway error after an upstream commit), 429, an unknown
 * status, a transport failure, a timeout, or a lost response — is ambiguous:
 * the write may have landed and must reconcile, never blindly retry a POST.
 * Defaults to ambiguous. */
const DEFINITIVE_NON_APPLICATION_STATUS = new Set([400, 401, 403, 404, 422]);

/** A provider rejection is definitive only when the provider answered with a
 * documented non-application status. Anything else keeps the write intent
 * and reconciles. Defaults to ambiguous. */
export function isDefinitiveProviderRejection(error: unknown): boolean {
  const details = (error as { details?: unknown } | null)?.details;
  const status =
    details && typeof details === "object"
      ? (details as { providerStatus?: unknown }).providerStatus
      : undefined;
  return typeof status === "number" && DEFINITIVE_NON_APPLICATION_STATUS.has(status);
}

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

/** Positive provider receipt for a check-run write. A 200 with an empty or
 * partial body (`{}`) proves nothing was created: it stays ambiguous,
 * reconciles through the listing, and never settles `processed`. Only a
 * receipt naming this exact check (positive ID), this group head, this
 * idempotency key, the review App, and a completed conclusion matching the
 * planned verdict counts as success. Null = ambiguous, never success. */
export function parseMergeGroupCheckReceipt(args: {
  response: unknown;
  ctx: MergeGroupContext;
  endpointId: string;
  appId: string;
  expectedConclusion: "success" | "action_required";
}): { checkId: string } | null {
  const receipt = args.response as {
    id?: unknown;
    head_sha?: unknown;
    external_id?: unknown;
    app?: { id?: unknown };
    status?: unknown;
    conclusion?: unknown;
  } | null;
  if (!receipt || typeof receipt !== "object") return null;
  const checkId =
    typeof receipt.id === "number" &&
    Number.isSafeInteger(receipt.id) &&
    receipt.id > 0
      ? String(receipt.id)
      : typeof receipt.id === "string" && /^[1-9][0-9]*$/.test(receipt.id)
        ? receipt.id
        : null;
  if (checkId === null) return null;
  if (
    typeof receipt.head_sha !== "string" ||
    receipt.head_sha.toLowerCase() !== args.ctx.groupSha.toLowerCase()
  )
    return null;
  if (
    receipt.external_id !==
    mergeGroupCarryExternalId(args.endpointId, args.ctx.groupSha)
  )
    return null;
  if (strictAppId(receipt.app?.id) !== args.appId) return null;
  if (receipt.status !== "completed") return null;
  if (receipt.conclusion !== args.expectedConclusion) return null;
  return { checkId };
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
    extraResult?: Record<string, unknown>,
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
          ...extraResult,
        },
        updatedAt: new Date(),
      })
      // Never regress an action another owner already finished.
      .where(
        and(
          eq(chatActions.id, id),
          inArray(chatActions.status, ["received", "failed"]),
        ),
      );
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
    const prior = Number(
      (action.result as { attempts?: unknown } | null)?.attempts ?? 0,
    );
    try {
      // One writer per endpoint/repo/group across deliveries and processes. A
      // crashed owner's lease expires and the action is retried by the outbox.
      await withGitHubPublicationLease(
        db,
        {
          companyId: action.companyId,
          endpointId: action.endpointId,
          repositoryId: ctx.repositoryId,
          groupKey: ctx.groupSha,
        },
        fetchImpl,
        (lease) => runLocked(lease, id, ctx, payload),
      );
    } catch (error) {
      if (error instanceof GitHubPublicationLeaseLost) return;
      const attempts = prior + 1;
      // Ambiguous in-flight work never strands: when the row still holds an
      // unconfirmed write intent, this action becomes its reconcile-only
      // recoverer instead of cancelling at attempt eight. Recovery retries
      // reconciliation until the write is adopted, superseded, or expired —
      // never a second POST on an empty listing.
      let row: { publicationAttempt: unknown } | undefined;
      try {
        [row] = await db
          .select({
            publicationAttempt: chatGithubCarryRuns.publicationAttempt,
          })
          .from(chatGithubCarryRuns)
          .where(
            and(
              eq(chatGithubCarryRuns.endpointId, action.endpointId),
              eq(chatGithubCarryRuns.repositoryId, ctx.repositoryId),
              eq(chatGithubCarryRuns.groupSha, ctx.groupSha),
            ),
          )
          .limit(1);
      } catch {
        row = undefined;
      }
      if (row?.publicationAttempt) {
        await failAction(id, "carry_publication_failed", attempts, true, {
          reconcileOnly: true,
        }).catch(() => {});
        return;
      }
      const retryable = attempts < 8;
      await failAction(id, "carry_publication_failed", attempts, retryable).catch(
        () => {},
      );
      if (!retryable) {
        await db
          .update(chatGithubCarryRuns)
          .set({ status: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(chatGithubCarryRuns.endpointId, action.endpointId),
              eq(chatGithubCarryRuns.repositoryId, ctx.repositoryId),
              eq(chatGithubCarryRuns.groupSha, ctx.groupSha),
              ne(chatGithubCarryRuns.status, "processed"),
            ),
          )
          .catch(() => {});
      }
    }
  }

  async function runLocked(
    lease: PublicationLease,
    id: string,
    ctx: MergeGroupContext,
    payload: { admitted?: boolean; reason?: string; runtimeGeneration?: number },
  ) {
    // Re-read under the lease: another delivery may have finished first.
    const [action] = await db
      .select()
      .from(chatActions)
      .where(eq(chatActions.id, id))
      .limit(1);
    if (!action || ["processed", "cancelled"].includes(action.status)) return;
    // Recover the existing intent before admission checks or provider reads.
    // Revocation and expiry must retire it even when GitHub is unavailable.
    const [existing] = await db
      .select()
      .from(chatGithubCarryRuns)
      .where(
        and(
          eq(chatGithubCarryRuns.endpointId, action.endpointId),
          eq(chatGithubCarryRuns.repositoryId, ctx.repositoryId),
          eq(chatGithubCarryRuns.groupSha, ctx.groupSha),
        ),
      )
      .limit(1);
    let carryRowId: string | null = existing?.id ?? null;
    const pendingAttempt: MergeGroupCarryPublicationAttempt | null =
      existing?.publicationAttempt ?? null;
    const settle = (
      status: "processed" | "cancelled",
      result: Record<string, unknown>,
    ) =>
      lease.commit(async (tx) => {
        await tx
          .update(chatActions)
          .set({ status, result, updatedAt: new Date() })
          .where(eq(chatActions.id, id));
      });
    const nextAttempts = () =>
      Number((action.result as { attempts?: unknown } | null)?.attempts ?? 0) + 1;
    const isReconcileOnly = () =>
      (action.result as { reconcileOnly?: unknown } | null)?.reconcileOnly ===
      true;

    // Retire the intent and its retry owner atomically under the lease. A
    // failed cleanup must leave the action retryable, never strand the row.
    const finish = (code: string) =>
      lease.commit(async (tx) => {
        if (carryRowId) {
          await tx
            .update(chatGithubCarryRuns)
            .set({
              status: "failed",
              code,
              publicationAttempt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatGithubCarryRuns.id, carryRowId),
                ne(chatGithubCarryRuns.status, "processed"),
              ),
            );
        }
        await tx
          .update(chatActions)
          .set({ status: "cancelled", result: { code }, updatedAt: new Date() })
          .where(eq(chatActions.id, id));
      });

    // Apply the local expiry bound before any fallible provider operation.
    // The catch path can otherwise reschedule an expired intent forever.
    if (
      (pendingAttempt || isReconcileOnly()) &&
      Date.now() - new Date(action.createdAt).getTime() >
        MERGE_GROUP_CARRY_MAX_EVENT_AGE_MS
    ) {
      await finish("carry_expired");
      return;
    }

    /** Bounded terminal settlement for reconcile-only recovery. Ambiguous
     * work retires only through an explicit bound: the delivery window
     * expired (the group is superseded by definition), or the live queue ref
     * moved past this group (another group owns the queue now). Anything
     * else keeps reconciling. True when settled terminally. */
    const settleReconcileTerminal = async (): Promise<boolean> => {
      const ageMs = Date.now() - new Date(action.createdAt).getTime();
      if (ageMs > MERGE_GROUP_CARRY_MAX_EVENT_AGE_MS) {
        await finish("carry_expired");
        return true;
      }
      let liveRef: string | null = null;
      try {
        liveRef = await createMergeGroupGitHubReader(request).getRefSha(
          ctx.groupRef,
        );
      } catch {
        liveRef = null;
      }
      if (
        liveRef &&
        liveRef.toLowerCase() !== ctx.groupSha.toLowerCase()
      ) {
        await finish("carry_superseded");
        return true;
      }
      return false;
    };

    /** Terminal abort that never strands ambiguous work. When the owned row
     * still holds an unconfirmed write intent, this action becomes its
     * reconcile-only recoverer (bounded by supersession/expiry) instead of
     * cancelling. Otherwise the row is failed explicitly with the code — a
     * terminal, inspectable state a new delivery can take over — and the
     * action cancels. */
    const abortUnresolved = async (code: string): Promise<void> => {
      const rowId = carryRowId;
      if (rowId) {
        let row: { publicationAttempt: unknown } | undefined;
        try {
          [row] = await db
            .select({
              publicationAttempt: chatGithubCarryRuns.publicationAttempt,
            })
            .from(chatGithubCarryRuns)
            .where(eq(chatGithubCarryRuns.id, rowId))
            .limit(1);
        } catch {
          row = undefined;
        }
        if (row?.publicationAttempt) {
          if (await settleReconcileTerminal()) return;
          await failAction(id, code, nextAttempts(), true, {
            reconcileOnly: true,
          });
          return;
        }
        await lease
          .commit(async (tx) => {
            await tx
              .update(chatGithubCarryRuns)
              .set({ status: "failed", code, updatedAt: new Date() })
              .where(
                and(
                  eq(chatGithubCarryRuns.id, rowId),
                  ne(chatGithubCarryRuns.status, "processed"),
                ),
              );
          })
          .catch(() => {});
      }
      await settle("cancelled", { code });
    };

    const [source] = await db
      .select({
        endpoint: chatEndpoints,
        resource: chatEndpointResources,
        configuration: chatGitHubConfigurations.configuration,
        revision: chatGitHubConfigurations.revision,
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
      await finish("connection_changed");
      return;
    }
    if (!mergeGroupCarryEnabled(source.configuration)) {
      await finish("carry_disabled");
      return;
    }
    if (payload.admitted === false) {
      await settle("cancelled", {
        code: "not_admitted",
        reason: payload.reason ?? null,
      });
      return;
    }

    const externalId = mergeGroupCarryExternalId(
      action.endpointId,
      ctx.groupSha,
    );
    const appId = source.endpoint.botExternalId ?? "";
    const sourceGeneration =
      (source.endpoint.setup as { runtimeGeneration?: number } | null)
        ?.runtimeGeneration ?? 0;
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
        configurationRevision: source.revision,
        status: "processing",
        externalId,
      })
      .onConflictDoNothing()
      .returning({ id: chatGithubCarryRuns.id });
    // A prior attempt's write intent survives takeover: an ambiguous write
    // reconciles only and never authorizes a second POST.
    carryRowId = claimed?.id ?? carryRowId;
    if (!claimed) {
      if (existing?.status === "processed") {
        // Replay compares the stored proof (heads plus review outcomes)
        // against current local review evidence. Only a stored successful
        // carry replays; mutable or negative outcomes — a 4/5 that has since
        // completed 5/5, a rescored or reconcluded review — are re-judged so
        // the fresh verdict is published, never the stale one.
        const storedReviewRows = await db
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
        const replayed = mergeGroupProofReplayMatches({
          stored: existing.proofFingerprint,
          endpointId: action.endpointId,
          appId,
          ctx,
          configurationRevision: source.revision,
          runtimeGeneration: sourceGeneration,
          verdictOk: existing.verdictOk === true,
          currentReviews: storedReviewRows.map(toReviewRecord),
        });
        if (replayed) {
          // Same proof, already published: no new provider write.
          await settle("processed", {
            code: existing.code,
            carryRunId: existing.id,
            replayed: true,
          });
          return;
        }
      }
      // A processing/failed/cancelled row is a prior owner that never
      // finished (the lease proves it is gone); a processed row whose proof no
      // longer matches is re-judged. Take it over, preserving any unconfirmed
      // write intent for reconciliation.
      if (existing) {
        await lease.commit(async (tx) => {
          await tx
            .update(chatGithubCarryRuns)
            .set({
              status: "processing",
              configurationRevision: source.revision,
              updatedAt: new Date(),
            })
            .where(eq(chatGithubCarryRuns.id, existing.id));
        });
      }
    }

    const token = await githubBotRepositoryToken(
      db,
      action.companyId,
      action.endpointId,
      ctx.repositoryId,
      lease.fetch,
    );
    const prefix = `/repos/${ctx.repository.split("/").map(encodeURIComponent).join("/")}`;
    const request: MergeGroupGitHubRequest = <T,>(
      path: string,
      options?: { method?: string; body?: unknown },
    ) => githubBotRequest<T>(lease.fetch, token, `${prefix}${path}`, options);

    // Evidence is read fresh, uncached, immediately before the single write.
    let evaluation = await evaluateCarry(request, action, ctx, appId);
    if (!evaluation) {
      await abortUnresolved("carry_disabled");
      return;
    }
    // The write boundary: re-read every mutable identity uncached and compare
    // against the evaluated evidence. Success is published only on a matched
    // boundary. Drift re-judges once; connection breaks cancel without a
    // provider write. A last-minute read is not an atomic cross-system
    // compare-and-write — the residual remote race is documented on the
    // replay predicate — but no stale evidence ever authorizes success.
    let observation = await readMergeGroupBoundaryObservation(
      db,
      request,
      action,
      ctx,
      evaluation.pullNumbers,
    );
    let boundaryCheck: MergeGroupBoundaryCheck = observation
      ? checkMergeGroupBoundary({
          observation,
          sourceGeneration,
          sourceAppId: appId,
          evaluation,
        })
      : "connection";
    let proofGeneration = observation?.generation ?? sourceGeneration;
    if (boundaryCheck === "disabled") {
      await abortUnresolved("carry_disabled");
      return;
    }
    if (boundaryCheck === "connection" || !observation) {
      await abortUnresolved("connection_changed");
      return;
    }
    if (boundaryCheck === "drift") {
      const second = await evaluateCarry(request, action, ctx, appId);
      if (!second) {
        await abortUnresolved("carry_disabled");
        return;
      }
      const recheck = await readMergeGroupBoundaryObservation(
        db,
        request,
        action,
        ctx,
        second.pullNumbers,
      );
      const recheckResult: MergeGroupBoundaryCheck = recheck
        ? checkMergeGroupBoundary({
            observation: recheck,
            sourceGeneration,
            sourceAppId: appId,
            evaluation: second,
          })
        : "connection";
      if (recheckResult === "disabled") {
        await abortUnresolved("carry_disabled");
        return;
      }
      if (recheckResult === "connection") {
        await abortUnresolved("connection_changed");
        return;
      }
      if (recheckResult === "drift") {
        // Fail-closed verdicts are always safe to publish; an ok verdict on
        // still-drifting evidence is not. Stay non-successful and retryable
        // without any provider write rather than publish from drift.
        if (!second.verdict.ok) {
          evaluation = second;
          proofGeneration = recheck?.generation ?? proofGeneration;
        } else {
          const attempts = nextAttempts();
          if (attempts >= 8) {
            await abortUnresolved("carry_evidence_unstable");
            return;
          }
          await failAction(id, "carry_evidence_unstable", attempts, true);
          return;
        }
      } else {
        evaluation = second;
        if (recheck) {
          observation = recheck;
          proofGeneration = recheck.generation;
        }
      }
    }
    const { verdict } = evaluation;
    const proof = buildMergeGroupProofFingerprint({
      endpointId: action.endpointId,
      appId,
      ctx,
      heads: verdict.ok ? verdict.carried : [],
      reviews: evaluation.reviews,
      configurationRevision: evaluation.revision,
      runtimeGeneration: proofGeneration,
    });

    // Read the group head's existing runs last and strictly: an unavailable,
    // malformed or truncated listing throws here and nothing is ever written.
    const existingChecks = await readMergeGroupCheckRuns(request, ctx.groupSha);

    // Final publication authorization: revalidate every mutable identity
    // uncached AFTER the last inventory read, at the intent-commit/POST
    // authorization point. A revocation that landed during the listing — a
    // disabled flag, a new policy revision, a rotated endpoint epoch or
    // credential generation, a changed review App, a disabled repository, a
    // moved queue ref, or a moved PR head — cancels or defers here. No stale
    // evidence authorizes the write. (The residual remote race — a GitHub
    // change between this read and the POST — is documented, not eliminated.)
    {
      const authorization = await readMergeGroupBoundaryObservation(
        db,
        request,
        action,
        ctx,
        evaluation.pullNumbers,
      );
      const authorizationCheck: MergeGroupBoundaryCheck = authorization
        ? checkMergeGroupBoundary({
            observation: authorization,
            sourceGeneration,
            sourceAppId: appId,
            evaluation,
          })
        : "connection";
      if (authorizationCheck === "disabled") {
        await abortUnresolved("carry_disabled");
        return;
      }
      if (authorizationCheck === "connection" || !authorization) {
        await abortUnresolved("connection_changed");
        return;
      }
      if (authorizationCheck === "drift") {
        const attempts = nextAttempts();
        if (attempts >= 8) {
          await abortUnresolved("carry_evidence_unstable");
          return;
        }
        await failAction(id, "carry_evidence_unstable", attempts, true);
        return;
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
    if (plan.method === "POST" && (pendingAttempt || isReconcileOnly())) {
      // An earlier attempt may have landed without a confirmed receipt (or
      // this action is in reconcile-only recovery), and a possibly stale
      // empty listing cannot prove otherwise. Reconcile only: never a second
      // POST. Explicit terminal bounds (supersession/expiry) retire the work;
      // at the attempt bound with live intent, enter (or stay in)
      // reconcile-only recovery instead of stranding it.
      if (await settleReconcileTerminal()) return;
      const attempts = nextAttempts();
      if (attempts >= 8 || isReconcileOnly()) {
        await failAction(id, "carry_ambiguous_write", attempts, true, {
          reconcileOnly: true,
        });
        return;
      }
      await failAction(id, "carry_ambiguous_write", attempts, true);
      return;
    }
    // Record the write intent durably before the provider call so a crash or
    // a lost response retries into reconciliation, never a blind second POST.
    const attempt: MergeGroupCarryPublicationAttempt = {
      method: plan.method,
      externalId,
      attemptedAt: new Date().toISOString(),
      ambiguous: false,
    };
    if (carryRowId) {
      await lease.commit(async (tx) => {
        await tx
          .update(chatGithubCarryRuns)
          .set({ publicationAttempt: attempt, updatedAt: new Date() })
          .where(eq(chatGithubCarryRuns.id, carryRowId));
      });
    }
    let posted: unknown;
    try {
      posted = await request<unknown>(plan.path, {
        method: plan.method,
        body: plan.body,
      });
    } catch (error) {
      if (carryRowId) {
        // Only a documented definitive non-application clears the intent;
        // anything else may have landed and must reconcile.
        const ambiguous = !isDefinitiveProviderRejection(error);
        const rowId = carryRowId;
        await lease
          .commit(async (tx) => {
            await tx
              .update(chatGithubCarryRuns)
              .set({
                publicationAttempt: ambiguous
                  ? { ...attempt, ambiguous: true }
                  : null,
                updatedAt: new Date(),
              })
              .where(eq(chatGithubCarryRuns.id, rowId));
          })
          .catch(() => {});
      }
      throw error;
    }
    // A positive receipt is required before `processed`: an empty or partial
    // success body stays ambiguous, keeps the intent, and reconciles — it
    // never settles success.
    const receipt = parseMergeGroupCheckReceipt({
      response: posted,
      ctx,
      endpointId: action.endpointId,
      appId,
      expectedConclusion: plan.body.conclusion,
    });
    if (!receipt) {
      if (carryRowId) {
        const rowId = carryRowId;
        await lease
          .commit(async (tx) => {
            await tx
              .update(chatGithubCarryRuns)
              .set({
                publicationAttempt: { ...attempt, ambiguous: true },
                updatedAt: new Date(),
              })
              .where(eq(chatGithubCarryRuns.id, rowId));
          })
          .catch(() => {});
      }
      const attempts = nextAttempts();
      if (attempts >= 8) {
        await abortUnresolved("carry_receipt_unverified");
        return;
      }
      await failAction(id, "carry_receipt_unverified", attempts, true);
      return;
    }
    const checkId = receipt.checkId;

    await lease.commit(async (tx) => {
      await tx
        .update(chatGithubCarryRuns)
        .set({
          baseSha: ctx.baseSha,
          heads: verdict.ok ? verdict.carried : [],
          configurationRevision: evaluation.revision,
          status: "processed",
          verdictOk: verdict.ok,
          code: verdict.code,
          detail: verdict.ok ? null : verdict.detail,
          checkId,
          proofFingerprint: proof,
          publicationAttempt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatGithubCarryRuns.endpointId, action.endpointId),
            eq(chatGithubCarryRuns.repositoryId, ctx.repositoryId),
            eq(chatGithubCarryRuns.groupSha, ctx.groupSha),
          ),
        );
      await tx
        .update(chatActions)
        .set({
          status: "processed",
          result: { code: verdict.ok ? "carry" : verdict.code, attempts: 0 },
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, id));
    });
  }

  /** One uncached evidence pass. Returns null when carry was disabled after
   * admission. The policy revision is read at this moment, not at delivery.
   * Observed provider identities (queue-ref target, pull heads) are returned
   * alongside the verdict so the write boundary can revalidate them uncached. */
  async function evaluateCarry(
    request: MergeGroupGitHubRequest,
    action: typeof chatActions.$inferSelect,
    ctx: MergeGroupContext,
    appId: string,
  ): Promise<{
    verdict: MergeGroupCarryVerdict;
    revision: number;
    reviews: MergeGroupReviewRecord[];
    pullNumbers: number[];
    observedRefSha: string | null;
    observedHeads: Array<{ pullNumber: number; headSha: string }>;
  } | null> {
    const [config] = await db
      .select({
        revision: chatGitHubConfigurations.revision,
        configuration: chatGitHubConfigurations.configuration,
      })
      .from(chatGitHubConfigurations)
      .where(eq(chatGitHubConfigurations.endpointId, action.endpointId));
    if (!config || !mergeGroupCarryEnabled(config.configuration)) return null;

    const github = createMergeGroupGitHubReader(request);
    const cache = new Map<string, Promise<unknown>>();
    const memo = <K extends keyof MergeGroupGitHub>(
      name: K,
      key: string,
      load: () => ReturnType<MergeGroupGitHub[K]>,
    ) => {
      const cacheKey = `${name}:${key}`;
      if (!cache.has(cacheKey)) cache.set(cacheKey, load());
      return cache.get(cacheKey) as ReturnType<MergeGroupGitHub[K]>;
    };
    // The cache only dedupes within this single pass.
    const cached: MergeGroupGitHub = {
      getPull: (n) => memo("getPull", String(n), () => github.getPull(n)),
      getCompare: (base, head) =>
        memo("getCompare", `${base}:${head}`, () => github.getCompare(base, head)),
      getMergeBase: (base, head) =>
        memo("getMergeBase", `${base}:${head}`, () =>
          github.getMergeBase(base, head),
        ),
      getRefSha: (ref) => memo("getRefSha", ref, () => github.getRefSha(ref)),
      getTree: (sha) => memo("getTree", sha, () => github.getTree(sha)),
      listReviewChecks: (sha) =>
        memo("listReviewChecks", sha, () => github.listReviewChecks(sha)),
    };

    // Discover the queued set once so the review lookup and the decision
    // observe identical evidence; tree ownership (not enumeration) is proof.
    const pullNumbers = new Set<number>();
    for (const pr of parseMergeGroupQueuedPrs(ctx.groupRef) ?? [])
      pullNumbers.add(pr.pullNumber);
    const compare = await cached.getCompare(ctx.baseSha, ctx.groupSha);
    for (const pr of prsFromCompareCommits(compare?.commits ?? []))
      pullNumbers.add(pr.pullNumber);

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
    const input: MergeGroupCarryInput = {
      endpointId: action.endpointId,
      appId,
      eventAgeMs: Date.now() - new Date(action.createdAt).getTime(),
      maxEventAgeMs: MERGE_GROUP_CARRY_MAX_EVENT_AGE_MS,
      configurationRevision: config.revision,
      reviews,
    };
    // Read through the same memo so the decision observes identical evidence
    // with no extra provider call; the boundary re-reads these uncached.
    const observedRefSha = await cached.getRefSha(ctx.groupRef);
    return {
      verdict: await decideMergeGroupCarry(ctx, cached, input),
      revision: config.revision,
      reviews,
      pullNumbers: [...pullNumbers].sort((a, b) => a - b),
      observedRefSha,
      observedHeads: [...confirmed].map(([pullNumber, head]) => ({
        pullNumber,
        headSha: head.headSha,
      })),
    };
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
