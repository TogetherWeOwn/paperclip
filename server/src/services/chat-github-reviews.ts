import { insertChatActions } from "./chat-publication-authority.js";
import {
  GitHubPublicationLeaseLost,
  withGitHubPublicationLease,
} from "./chat-github-publication-lease.js";
import {
  projectSafeChatPublicationText,
  scrubInternalReferences,
} from "./chat-publication-projection.js";
import {
  githubPullPermalink,
  renderInlineFinding,
  renderReviewSummary,
} from "./chat-github-review-template.js";
import { githubEgressReferenceScope } from "./chat-task-url.js";
import { githubReviewCheckService } from "./chat-github-checks.js";
import { primaryGitHubReview } from "./chat-github-primary.js";
import { githubRunCapability } from "./chat-github-shadow.js";
import { githubSnapshotReader, type GitHubReviewReader } from "./chat-github-review-snapshot.js";
import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  toolInvocations,
  agents,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatGitHubConfigurations,
  chatGitHubReviews,
  chatMessageLinks,
  heartbeatRuns,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  githubCommitSchema,
  type GitHubReviewEventContext,
  type GitHubReviewPolicy,
} from "@paperclipai/shared";
import { HttpError, conflict, forbidden, notFound } from "../errors.js";
import {
  githubBotRepositoryToken,
  githubBotRequest,
} from "./chat-github-client.js";
import { githubChatPrincipalAccess } from "./chat-github-access.js";
import {
  effectiveGitHubReviewPolicy,
  githubReviewConclusion,
  githubReviewPathIsExcluded,
  githubReviewLineIsInPatch,
  githubShadowLabel,
  validateGitHubReviewAssessment,
  validatePersistedGitHubReviewAssessment,
} from "./chat-github-review-policy.js";
import {
  isIssueWithinLowTrustBoundary,
  resolveCoreTrustPreset,
} from "./trust-preset-resolver.js";
import { githubBotToolsForSession } from "./chat-github-tools.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import {
  githubAutomaticAdmission,
  githubPreviousAssessment,
} from "./chat-github-events.js";
import { logActivity } from "./activity-log.js";

type Session = {
  companyId: string;
  agentId: string | null;
  issueId: string | null;
  runId: string | null;
};
type Pull = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  head: { sha: string };
  base: { sha: string; ref: string };
  user: { id: number; login: string; type: string };
  labels: Array<{ name: string }>;
};
type File = {
  filename: string;
  previous_filename?: string;
  patch?: string;
  status: string;
  additions: number;
  deletions: number;
};
const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? Object.fromEntries(
              Object.keys(entry)
                .sort()
                .map((key) => [key, entry[key]]),
            )
          : entry,
      ),
    )
    .digest("hex");
const marker = (kind: string, key: string) =>
  `<!-- paperclip-${kind}:${hash(key)} -->`;
const readSchema = z
  .object({
    section: z.enum([
      "metadata",
      "files",
      "comments",
      "reviews",
      "inline_comments",
      "checks",
      "changes_since_review",
    ]),
    page: z.number().int().min(1).max(100).default(1),
  })
  .strict();
const commentSchema = z
  .object({
    body: z.string().trim().min(1).max(24000),
    idempotencyKey: z.string().min(1).max(160),
  })
  .strict();
const formalSchema = commentSchema
  .extend({
    event: z.enum(["APPROVE", "REQUEST_CHANGES"]),
    reviewedCommit: githubCommitSchema,
  })
  .strict();

export function githubChatReviewService(db: Db, fetchImpl = fetch) {
  async function scope(session: Session, publishing = false) {
    if (!session.agentId || !session.issueId || !session.runId)
      throw forbidden(
        "GitHub bot tools require an active assigned-agent task run",
      );
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, session.runId),
          eq(heartbeatRuns.companyId, session.companyId),
          eq(heartbeatRuns.agentId, session.agentId),
        ),
      );
    const taskId =
      run?.nativeIssueId ??
      run?.contextSnapshot?.issueId ??
      run?.contextSnapshot?.taskId;
    if (
      !run ||
      taskId !== session.issueId ||
      (!publishing && run.status !== "running") ||
      (publishing && !["running", "succeeded"].includes(run.status))
    )
      throw forbidden("This task run is no longer authorized");
    const capability = await githubRunCapability(db, session);
    if (!capability) throw forbidden("This run has no exact GitHub admission capability");
    const commentId = run.contextSnapshot?.wakeCommentId;
    const [source] =
      typeof commentId === "string"
        ? await db
            .select({
              conversation: chatConversations,
              delivery: chatDeliveries,
              endpoint: chatEndpoints,
              resource: chatEndpointResources,
              config: chatGitHubConfigurations,
            })
            .from(chatMessageLinks)
            .innerJoin(
              chatDeliveries,
              eq(chatDeliveries.id, chatMessageLinks.deliveryId),
            )
            .innerJoin(
              chatConversations,
              eq(chatConversations.id, chatMessageLinks.conversationId),
            )
            .innerJoin(
              chatEndpoints,
              eq(chatEndpoints.id, chatConversations.endpointId),
            )
            .innerJoin(
              chatEndpointResources,
              eq(chatEndpointResources.id, chatConversations.resourceId),
            )
            .innerJoin(
              chatGitHubConfigurations,
              eq(chatGitHubConfigurations.endpointId, chatEndpoints.id),
            )
            .where(
              and(
                eq(chatMessageLinks.companyId, session.companyId),
                eq(chatMessageLinks.commentId, commentId),
                eq(chatConversations.issueId, session.issueId),
                eq(chatEndpoints.id, capability.endpoint.id),
                eq(chatEndpoints.provider, "github"),
              ),
            )
        : [];
    if (
      !source ||
      !source.delivery.principalId ||
      !source.config.configuration.toolsEnabled ||
      !["active", "verifying"].includes(source.endpoint.status) ||
      !source.resource.enabled ||
      source.resource.availability !== "available"
    )
      throw forbidden(
        "This run has no active GitHub bot capability for its conversation",
      );
    const access = await githubChatPrincipalAccess(
      db,
      source.endpoint,
      source.delivery.principalId,
    );
    if (!access?.allowed)
      throw forbidden("The initiating GitHub person is no longer authorized");
    const automatic = source.delivery.normalizedEvent.githubAutomatic as
      { context: GitHubReviewEventContext } | undefined;
    if (
      automatic &&
      !(await githubAutomaticAdmission(db, source.endpoint, automatic.context))
        ?.allowed
    )
      throw forbidden("Automatic review authority is no longer available");
    const repositoryId = String(
      source.resource.metadata?.providerRepositoryId ?? "",
    );
    const repository = source.resource.providerResourceId;
    if (
      !/^[1-9][0-9]*$/.test(repositoryId) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    )
      throw conflict(
        "Refresh the bot's repository access before using its tools",
      );
    const match =
      /^github:([^:]+):(?:(issue):)?([1-9][0-9]*)(?::rc:([1-9][0-9]*))?$/.exec(
        source.conversation.externalThreadId,
      );
    if (!match || match[1]!.toLowerCase() !== repository.toLowerCase())
      throw forbidden("Invalid task repository binding");
    const [agent] = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, session.companyId),
          eq(agents.id, session.agentId),
        ),
      );
    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, session.companyId),
          eq(issues.id, session.issueId),
        ),
      );
    if (!agent || !issue || issue.assigneeAgentId !== agent.id)
      throw forbidden("The assigned agent changed");
    const [project] = issue.projectId
      ? await db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.companyId, session.companyId),
              eq(projects.id, issue.projectId),
            ),
          )
      : [];
    const trust = resolveCoreTrustPreset({
      companyId: session.companyId,
      agent,
      issue,
      project,
      run: {
        companyId: session.companyId,
        executionPolicy: run.contextSnapshot?.executionPolicy,
      },
    });
    if (trust.kind === "denied")
      throw forbidden("The agent's trust policy is incomplete");
    // The caller's task/run binding is fixed; never export credentials. Review
    // submissions are governed output, not authority to mutate other tasks.
    if (
      trust.kind === "low_trust_review" &&
      (!(trust.boundary.allowedToolClasses ?? []).includes("github.pr.read") ||
        !isIssueWithinLowTrustBoundary(trust.boundary, issue))
    )
      throw forbidden(
        "The low-trust boundary does not permit GitHub review tools",
      );
    return {
      ...source,
      run,
      agent,
      issue,
      access,
      repositoryId,
      repository,
      number: Number(match[3]),
      isIssue: !!match[2],
      replyId: match[4] ?? null,
      enrollment: capability.enrollment,
      candidate: capability.candidate,
      previousAssessment: capability.enrollment?.envelope.previousAssessments?.[capability.candidate?.armId ?? "primary"] ?? null,
      policy: capability.enrollment?.envelope.policy ?? effectiveGitHubReviewPolicy(
        source.config.configuration,
        repositoryId,
      ),
      shadowLabel: source.conversation.githubShadowLabel
        ?? source.delivery.githubShadowLabel
        ?? githubShadowLabel(source.config.configuration),
    };
  }
  /** The shadow label pinned on this task's newest review row, if any. A
   * labelled review must never publish, even if shadow mode is later
   * disabled in config, so write tools consult the row as well as config. */
  async function pinnedShadowLabel(
    session: Session,
    source: Awaited<ReturnType<typeof scope>>,
  ): Promise<string | null> {
    const [row] = await db
      .select({ shadowLabel: chatGitHubReviews.shadowLabel })
      .from(chatGitHubReviews)
      .where(
        and(
          eq(chatGitHubReviews.companyId, session.companyId),
          eq(chatGitHubReviews.endpointId, source.endpoint.id),
          eq(chatGitHubReviews.issueId, source.issue.id),
          isNotNull(chatGitHubReviews.shadowLabel),
        ),
      )
      .orderBy(desc(chatGitHubReviews.createdAt))
      .limit(1);
    return row?.shadowLabel ?? null;
  }
  async function client(
    source: Awaited<ReturnType<typeof scope>>,
    requestFetch = fetchImpl,
  ) {
    const token = await githubBotRepositoryToken(
      db,
      source.endpoint.companyId,
      source.endpoint.id,
      source.repositoryId,
      requestFetch,
    );
    const prefix = `/repos/${source.repository.split("/").map(encodeURIComponent).join("/")}`;
    return {
      prefix,
      request: <T>(
        path: string,
        options?: Parameters<typeof githubBotRequest>[3],
      ) =>
        githubBotRequest<T>(requestFetch, token, `${prefix}${path}`, options),
    };
  }
  async function diffBaseSha(
    api: GitHubReviewReader,
    baseSha: string,
    headSha: string,
  ) {
    const comparison = await api.request<{ merge_base_commit: { sha: string } }>(
      `/compare/${githubCommitSchema.parse(baseSha)}...${githubCommitSchema.parse(headSha)}?per_page=1&page=1`,
    );
    return githubCommitSchema.parse(comparison.merge_base_commit.sha);
  }
  async function reviewForHead(
    source: Awaited<ReturnType<typeof scope>>,
    pull: Pull,
  ) {
    const [prior] = await db
      .select()
      .from(chatGitHubReviews)
      .where(
        and(
          eq(chatGitHubReviews.companyId, source.endpoint.companyId),
          eq(chatGitHubReviews.endpointId, source.endpoint.id),
          eq(chatGitHubReviews.issueId, source.issue.id),
          eq(chatGitHubReviews.headSha, pull.head.sha),
          source.enrollment ? eq(chatGitHubReviews.deliveryId, source.delivery.id) : undefined,
        ),
      )
      .orderBy(desc(chatGitHubReviews.createdAt))
      .limit(1);
    if (prior && prior.runId === source.run.id) return prior;
    if (prior && !prior.runId && prior.deliveryId === source.delivery.id) {
      const [claimed] = await db
        .update(chatGitHubReviews)
        .set({ runId: source.run.id, state: "running", updatedAt: new Date() })
        .where(
          and(
            eq(chatGitHubReviews.id, prior.id),
            isNull(chatGitHubReviews.runId),
          ),
        )
        .returning();
      if (claimed) return claimed;
      return reviewForHead(source, pull);
    }
    const manual = source.delivery.normalizedEvent.githubManual as
      | {
          policy: GitHubReviewPolicy;
          revision: number;
          event: "mention" | "comment";
        }
      | undefined;
    const automatic = source.delivery.normalizedEvent.githubAutomatic as
      | {
          context: GitHubReviewEventContext;
          policy: GitHubReviewPolicy;
          revision: number;
        }
      | undefined;
    const context: GitHubReviewEventContext = {
      event: manual?.event ?? "mention",
      repositoryId: source.repositoryId,
      repository: source.repository,
      pullNumber: source.number,
      title: pull.title,
      body: pull.body ?? "",
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      baseBranch: pull.base.ref,
      draft: pull.draft,
      author: {
        id: String(pull.user.id),
        login: pull.user.login,
        isBot: pull.user.type === "Bot",
      },
      sender: {
        id: String(
          (source.delivery.normalizedEvent.principal as { externalId?: string })
            ?.externalId ?? "",
        ),
        login: String(
          (source.delivery.normalizedEvent.principal as { handle?: string })
            ?.handle ?? "",
        ),
      },
      labels: pull.labels.map((l) => l.name),
      ...(automatic ? automatic.context : {}),
      // Keep the source admission identity even when retries get per-run rows.
      deliveryId: source.delivery.id,
    };
    const [review] = await db
      .insert(chatGitHubReviews)
      .values({
        companyId: source.endpoint.companyId,
        endpointId: source.endpoint.id,
        issueId: source.issue.id,
        runId: source.run.id,
        repositoryId: source.repositoryId,
        repository: source.repository,
        pullNumber: source.number,
        headSha: pull.head.sha,
        deliveryId: source.candidate ? source.delivery.id : `run:${source.run.id}:${pull.head.sha}`,
        configurationRevision:
          source.enrollment?.configurationRevision ?? manual?.revision ?? automatic?.revision ?? source.config.revision,
        policySnapshot: source.enrollment?.envelope.policy ?? manual?.policy ?? automatic?.policy ?? source.policy,
        event: context,
        state: "running",
        shadowLabel: source.shadowLabel,
      })
      .onConflictDoNothing()
      .returning();
    if (review) {
      // Shadow reviews never create a check run (enqueue also guards).
      if (!source.shadowLabel)
        await githubReviewCheckService(db, fetchImpl).enqueue(
          source.endpoint,
          context,
          true,
          "authorized_manual_request",
          source.delivery.id,
        );
      return review;
    }
    const [existing] = await db
      .select()
      .from(chatGitHubReviews)
      .where(
        and(
          eq(chatGitHubReviews.endpointId, source.endpoint.id),
          eq(
            chatGitHubReviews.deliveryId,
            source.candidate ? source.delivery.id : `run:${source.run.id}:${pull.head.sha}`,
          ),
        ),
      );
    return existing!;
  }
  async function stage(
    source: Awaited<ReturnType<typeof scope>>,
    operation: string,
    payload: Record<string, unknown>,
    key: string,
    invocationId: string | undefined,
    toolName: string,
    parameters: unknown,
    writer: Db | Parameters<Parameters<Db["transaction"]>[0]>[0] = db,
  ) {
    const actionKey = `github_publication:${source.issue.id}:${operation}:${hash(key)}`;
    const values = {
      companyId: source.endpoint.companyId,
      endpointId: source.endpoint.id,
      conversationId: source.conversation.id,
      principalId: source.delivery.principalId,
      deliveryId: source.delivery.id,
      kind: "github_review_publication",
      providerActionId: actionKey,
      payload: {
        version: 1,
        operation,
        invocationId,
        toolName,
        parameters,
        runtimeGeneration:
          (source.endpoint.setup as { runtimeGeneration?: number })
            .runtimeGeneration ?? 0,
        session: {
          companyId: source.endpoint.companyId,
          agentId: source.agent.id,
          issueId: source.issue.id,
          runId: source.run.id,
        },
        ...payload,
      },
      status: "received",
    };
    const [action] = await insertChatActions(writer, values, { onConflictDoNothing: true });
    if (!action) {
      const [existing] = await writer
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, source.endpoint.id),
            eq(chatActions.providerActionId, actionKey),
          ),
        );
      if (
        !existing ||
        hash({ ...existing.payload, invocationId: undefined }) !==
          hash({ ...values.payload, invocationId: undefined })
      )
        throw conflict(
          "This publication key was already used for different content",
        );
      return existing.id;
    }
    return action.id;
  }
  async function receipt(actionId: string) {
    const [action] = await db
      .select({ status: chatActions.status, result: chatActions.result })
      .from(chatActions)
      .where(eq(chatActions.id, actionId));
    return {
      actionId,
      status: action?.status ?? "received",
      receipt: action?.result ?? null,
    };
  }
  async function execute(
    session: Session,
    name: string,
    input: unknown,
    invocationId?: string,
  ) {
    const source = await scope(session);
    if (name === "comment") {
      const parsed = commentSchema.parse(input);
      const shadowLabel =
        source.shadowLabel ?? (await pinnedShadowLabel(session, source));
      if (shadowLabel)
        return {
          actionId: null,
          status: "shadow_stored",
          receipt: null,
          shadowLabel,
        };
      const actionId = await stage(
        source,
        "comment",
        parsed,
        parsed.idempotencyKey,
        invocationId,
        name,
        input,
      );
      await processPublication(actionId);
      return receipt(actionId);
    }
    if (source.isIssue)
      throw conflict(
        "This task is bound to a GitHub issue. Pull request review tools require a PR conversation.",
      );
    // A legacy capture label proves publication denial, not blinded inputs.
    // No admission snapshot exists for these tasks. Refuse source reads before
    // constructing any live client (also after configuration is switched off).
    if ((name === "read_pull_request" || name === "read_file")
      && (source.shadowLabel ?? await pinnedShadowLabel(session, source))
      && !source.enrollment?.envelope.snapshot) {
      throw conflict("Capture-only review reads require a sealed admission snapshot", { code: "github_review_snapshot_required" });
    }
    if (source.candidate && (source.enrollment?.envelope.snapshot?.version !== 2
      || !source.enrollment.envelope.snapshot.redactions)) {
      throw conflict("Candidate snapshot predates bot-answer blinding; live reads are forbidden");
    }
    const useSnapshot = !!source.candidate || !!source.enrollment?.envelope.snapshot;
    const api: GitHubReviewReader = useSnapshot
      ? githubSnapshotReader(source.enrollment?.envelope.snapshot, {
          headSha: source.enrollment!.headSha, baseSha: source.enrollment!.baseSha, pullNumber: source.number,
        }, async path => {
          // This closure is invoked ONLY after the snapshot reader validates an
          // exact commit-addressed object. No general live client exists here.
          const token = await githubBotRepositoryToken(db, source.endpoint.companyId, source.endpoint.id, source.repositoryId, fetchImpl, "read");
          return githubBotRequest(fetchImpl, token, `/repos/${source.repository}${path}`);
        }, source.previousAssessment?.headSha)
      : await client(source);
    const pull = await api.request<Pull>(`/pulls/${source.number}`);
    const automatic = source.delivery.normalizedEvent.githubAutomatic as
      { context: GitHubReviewEventContext } | undefined;
    if (automatic && automatic.context.headSha !== pull.head.sha)
      throw conflict(
        "This automatic review was requested for an older pull request head. Continue with the newest authorized PR event or an authorized manual request.",
      );
    if (name === "read_pull_request") {
      const parsed = readSchema.parse(input);
      if (parsed.section === "metadata") {
        const configuration = (source.delivery.normalizedEvent.githubManual ??
          source.delivery.normalizedEvent.githubAutomatic) as
          { policy: GitHubReviewPolicy; revision: number } | undefined;
        const previous = source.enrollment ? source.previousAssessment : await githubPreviousAssessment(
          db,
          source.endpoint,
          source.repositoryId,
          source.number,
        );
        return {
          untrusted: true,
          pull,
          diffBaseSha: await diffBaseSha(api, pull.base.sha, pull.head.sha),
          reviewPolicy: source.enrollment?.envelope.policy ?? configuration?.policy ?? source.policy,
          configurationRevision:
            source.enrollment?.configurationRevision ?? configuration?.revision ?? source.config.revision,
          previousAssessment: previous
            ? {
                reviewedCommit: previous.headSha,
                assessment: previous.assessment,
                taskId: previous.issueId,
                runId: previous.runId,
              }
            : null,
        };
      }
      if (parsed.section === "changes_since_review") {
        const previous = source.enrollment ? source.previousAssessment : await githubPreviousAssessment(
          db,
          source.endpoint,
          source.repositoryId,
          source.number,
        );
        if (!previous)
          return {
            untrusted: true,
            items: [],
            priorReviewedCommit: null,
            reviewedCommit: pull.head.sha,
            guidance:
              "No previous assessment. Read all current pull request files.",
          };
        const comparison = await api.request<{
          files?: File[];
          status: string;
          total_commits: number;
        }>(`/compare/${previous.headSha}...${pull.head.sha}?per_page=1&page=1`);
        const files = comparison.files ?? [];
        return {
          untrusted: true,
          priorReviewedCommit: previous.headSha,
          reviewedCommit: pull.head.sha,
          status: comparison.status,
          totalCommits: comparison.total_commits,
          items: files.filter(
            (file) =>
              !githubReviewPathIsExcluded(file.filename, source.policy) &&
              !githubReviewPathIsExcluded(
                file.previous_filename ?? file.filename,
                source.policy,
              ),
          ),
          potentiallyTruncated: files.length >= 300,
          guidance:
            "GitHub limits comparison files to 300. This delta is supporting context; read all current PR files before claiming complete coverage. Force pushes can change ancestry.",
        };
      }
      if (parsed.section === "checks") {
        const checks = await api.request<{ check_runs: unknown[] }>(`/commits/${pull.head.sha}/check-runs?per_page=100&page=${parsed.page}`);
        const statuses = await api.request<unknown[]>(`/commits/${pull.head.sha}/statuses?per_page=100&page=${parsed.page}`);
        return { untrusted: true, items: checks.check_runs, statuses,
          hasMore: checks.check_runs.length === 100 || statuses.length === 100, page: parsed.page, reviewedCommit: pull.head.sha };
      }
      const route =
        parsed.section === "comments"
          ? `/issues/${source.number}/comments`
          : `/pulls/${source.number}/${parsed.section === "inline_comments" ? "comments" : parsed.section}`;
      const rows = await api.request<Array<Record<string, unknown>>>(
        `${route}?per_page=100&page=${parsed.page}`,
      );
      return {
        untrusted: true,
        items:
          parsed.section === "files"
            ? rows.filter(
                (file) =>
                  !githubReviewPathIsExcluded(
                    String(file.filename),
                    source.policy,
                  ) &&
                  !githubReviewPathIsExcluded(
                    String(file.previous_filename ?? file.filename),
                    source.policy,
                  ),
              )
            : rows,
        hasMore: rows.length === 100,
        page: parsed.page,
        reviewedCommit: pull.head.sha,
      };
    }
    if (name === "read_file") {
      const parsed = z
        .object({
          path: z.string().min(1).max(1024),
          revision: z.enum(["head", "base"]),
        })
        .strict()
        .parse(input);
      if (
        parsed.path.startsWith("/") ||
        parsed.path.split("/").includes("..") ||
        parsed.path.includes("\\") ||
        githubReviewPathIsExcluded(parsed.path, source.policy)
      )
        throw forbidden("This path is excluded from the review");
      const revision = parsed.revision === "head"
        ? pull.head.sha
        : await diffBaseSha(api, pull.base.sha, pull.head.sha);
      const result = await api.request<Record<string, unknown>>(
        `/contents/${parsed.path.split("/").map(encodeURIComponent).join("/")}?ref=${revision}`,
      );
      // Provider URLs can contain credentials or direct download capabilities.
      return {
        untrusted: true,
        path: parsed.path,
        encoding: result.encoding,
        content: result.content,
        sha: result.sha,
        size: result.size,
      };
    }
    if (name === "begin_review") {
      const parsed = z
        .object({ reviewedCommit: githubCommitSchema })
        .strict()
        .safeParse(input);
      if (!parsed.success)
        throw new HttpError(400, "Provide the reviewedCommit from PR metadata");
      if (parsed.data.reviewedCommit !== pull.head.sha)
        throw conflict(
          "The PR head changed. Read current metadata before starting a review.",
        );
      const review = await reviewForHead(source, pull);
      return {
        reviewId: review.id,
        reviewedCommit: review.headSha,
        state: review.state,
      };
    }
    if (name === "submit_review") {
      const review = await reviewForHead(source, pull);
      const assessment = validateGitHubReviewAssessment(input, pull.head.sha, {
        ...review.policySnapshot,
        ignoredPaths: [
          ...review.policySnapshot.ignoredPaths,
          ...source.policy.ignoredPaths,
        ],
      });
      const reviewedDiffBase = await diffBaseSha(api, pull.base.sha, pull.head.sha);
      const files: File[] = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await api.request<File[]>(
          `/pulls/${source.number}/files?per_page=100&page=${page}`,
        );
        files.push(...batch);
        if (batch.length < 100) break;
        if (page === 30 && assessment.complete)
          throw conflict(
            "GitHub's file listing was truncated. Submit an incomplete review.",
          );
      }
      const permittedFiles = files.filter(
        (f) =>
          !githubReviewPathIsExcluded(f.filename, source.policy) &&
          !githubReviewPathIsExcluded(
            f.previous_filename ?? f.filename,
            source.policy,
          ),
      );
      const paths = new Set(
        permittedFiles.flatMap((file) =>
          file.previous_filename
            ? [file.filename, file.previous_filename]
            : [file.filename],
        ),
      );
      const byPath = new Map(
        permittedFiles.map((file) => [file.filename, file]),
      );
      if (assessment.findings.some((finding) =>
        finding.side === "LEFT" && finding.basePath !==
          (byPath.get(finding.path)?.previous_filename ?? finding.path)
      ))
        throw conflict("LEFT-side basePath must match GitHub's base filename for the changed file.");
      if (
        assessment.findings.some(
          (finding) =>
            !githubReviewLineIsInPatch(
              byPath.get(finding.path)?.patch,
              finding.line,
              finding.side,
            ),
        )
      )
        throw conflict(
          "Each inline finding must identify a line and side in GitHub's current diff. Move findings outside the available diff into the summary.",
        );
      if (
        assessment.findings.some((f) => !paths.has(f.path)) ||
        assessment.coverage.reviewedPaths.some((path) => !paths.has(path))
      )
        throw conflict(
          "Assessment coverage and findings must refer to this PR's allowed changed files",
        );
      if (
        assessment.complete &&
        (assessment.coverage.omittedPaths.some((path) => paths.has(path)) ||
          permittedFiles.some(
            (file) =>
              !assessment.coverage.reviewedPaths.includes(file.filename),
          ))
      )
        throw conflict(
          "A complete assessment must cover every non-excluded changed file",
        );
      // Shadow if the label was pinned at review creation or shadow mode is
      // enabled in the current config; either direction suppresses, so
      // toggling config mid-review can never leak a shadow assessment.
      const shadowLabel = review.shadowLabel ?? source.shadowLabel;
      // Commit the immutable assessment and its publication together. A restart
      // must never leave a stored result with no durable publication intent.
      // Shadow reviews are the one exception: the stored assessment is the
      // whole result, and no publication intent is ever staged.
      const actionId = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(chatGitHubReviews)
          .where(eq(chatGitHubReviews.id, review.id))
          .for("update");
        if (
          !current ||
          (current.assessment && hash(current.assessment) !== hash(assessment))
        )
          throw conflict(
            "This run already submitted its assessment. Start another review to revise it.",
          );
        await tx
          .update(chatGitHubReviews)
          .set({
            assessment,
            event: current.assessment
              ? current.event
              : { ...current.event, diffBaseSha: reviewedDiffBase },
            conclusion: githubReviewConclusion(
              assessment,
              review.policySnapshot.ratingThreshold,
            ),
            state: assessment.complete ? "completed" : "incomplete",
            shadowLabel: current.shadowLabel ?? shadowLabel,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatGitHubReviews.id, review.id),
              eq(chatGitHubReviews.companyId, session.companyId),
            ),
          );
        if (shadowLabel) return null;
        return stage(
          source,
          "assessment",
          { reviewId: review.id, reviewedCommit: pull.head.sha },
          review.id,
          invocationId,
          name,
          input,
          tx,
        );
      });
      const conclusion = githubReviewConclusion(
        assessment,
        review.policySnapshot.ratingThreshold,
      );
      if (!actionId)
        return {
          reviewId: review.id,
          actionId: null,
          status: "shadow_stored",
          receipt: null,
          score: assessment.score,
          conclusion,
          shadowLabel,
        };
      await processPublication(actionId);
      return {
        reviewId: review.id,
        ...(await receipt(actionId)),
        score: assessment.score,
        conclusion,
      };
    }
    if (name === "formal_review") {
      const parsed = formalSchema.parse(input);
      if (parsed.reviewedCommit !== pull.head.sha)
        throw conflict("The PR head changed. Review the new commits first.");
      if (source.shadowLabel)
        throw forbidden(
          "Shadow review endpoints never publish formal GitHub reviews",
        );
      assertFormalPermission(source.policy, parsed.event);
      const [assessed] = await db
        .select()
        .from(chatGitHubReviews)
        .where(
          and(
            eq(chatGitHubReviews.endpointId, source.endpoint.id),
            eq(chatGitHubReviews.issueId, source.issue.id),
            eq(chatGitHubReviews.runId, source.run.id),
            eq(chatGitHubReviews.headSha, pull.head.sha),
            eq(chatGitHubReviews.state, "completed"),
          ),
        );
      if (!assessed?.assessment?.complete)
        throw conflict("Submit a complete assessment before a formal review");
      if (assessed.shadowLabel)
        throw forbidden(
          "Shadow review endpoints never publish formal GitHub reviews",
        );
      const actionId = await stage(
        source,
        "formal_review",
        parsed,
        parsed.idempotencyKey,
        invocationId,
        name,
        input,
      );
      await processPublication(actionId);
      return receipt(actionId);
    }
    throw notFound("Unknown GitHub bot tool");
  }
  function assertFormalPermission(
    policy: GitHubReviewPolicy,
    event: "APPROVE" | "REQUEST_CHANGES",
  ) {
    if (
      !(event === "APPROVE" ? policy.allowApprove : policy.allowRequestChanges)
    )
      throw forbidden(`Formal ${event} reviews are disabled for this bot`);
  }
  async function assertPublicationAuthority(
    source: Awaited<ReturnType<typeof scope>>,
    action: typeof chatActions.$inferSelect,
  ) {
    if (
      (source.endpoint.setup as { runtimeGeneration?: number })
        .runtimeGeneration !== action.payload.runtimeGeneration &&
      !(
        (source.endpoint.setup as { runtimeGeneration?: number })
          .runtimeGeneration === undefined &&
        action.payload.runtimeGeneration === 0
      )
    )
      throw forbidden(
        "The bot connection changed after this operation was requested",
      );
    const toolName = String(action.payload.toolName);
    const tool = (
      await githubBotToolsForSession(db, {
        companyId: source.endpoint.companyId,
        agentId: source.agent.id,
        issueId: source.issue.id,
        runId: source.run.id,
      })
    ).find(
      (tool) =>
        tool.connectionId === source.endpoint.connectionId &&
        tool.upstreamToolName === toolName,
    );
    if (!tool) throw forbidden("The bot tool is no longer available");
    const decision = await toolAccessPolicyService(db).decide({
      companyId: source.endpoint.companyId,
      actor: {
        actorType: "agent",
        actorId: source.agent.id,
        agentId: source.agent.id,
      },
      runContext: {
        heartbeatRunId: source.run.id,
        issueId: source.issue.id,
        projectId: source.issue.projectId,
      },
      request: {
        toolName: tool.name,
        applicationId: tool.applicationId,
        applicationKey: tool.applicationKey,
        connectionId: tool.connectionId,
        catalogEntryId: tool.catalogEntryId,
        providerType: tool.providerType,
        upstreamToolName: toolName,
        riskLevel: tool.risk,
        arguments: action.payload.parameters,
        sideEffecting: true,
      },
      consumeRateLimit: false,
    });
    if (decision.allowed) return;
    if (
      decision.decision === "require_approval" &&
      typeof action.payload.invocationId === "string"
    ) {
      const [invocation] = await db
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.id, action.payload.invocationId),
            eq(toolInvocations.companyId, source.endpoint.companyId),
            eq(toolInvocations.runId, source.run.id),
            eq(toolInvocations.agentId, source.agent.id),
            eq(toolInvocations.connectionId, source.endpoint.connectionId),
            eq(toolInvocations.toolName, tool.name),
          ),
        );
      if (
        invocation?.approvalState === "approved" &&
        ["executing", "completed"].includes(invocation.status)
      )
        return;
    }
    throw forbidden(decision.explanation);
  }
  async function processPublication(actionId: string) {
    // Existing chat outbox maintenance retries this action after a restart.
    // A durable per-PR lease serializes dispatch; markers recover unknown writes.
    const [action] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "github_review_publication"),
        ),
      )
      .limit(1);
    if (
      !action ||
      action.status === "processed" ||
      action.status === "cancelled"
    )
      return;
    const [binding] = await db
      .select({
        thread: chatConversations.externalThreadId,
        repository: chatEndpointResources.metadata,
      })
      .from(chatConversations)
      .innerJoin(
        chatEndpointResources,
        eq(chatEndpointResources.id, chatConversations.resourceId),
      )
      .where(
        and(
          eq(chatConversations.id, action.conversationId!),
          eq(chatConversations.companyId, action.companyId),
          eq(chatConversations.endpointId, action.endpointId),
        ),
      );
    const number = binding?.thread.match(
      /^github:[^:]+:(?:issue:)?([1-9][0-9]*)(?::rc:[1-9][0-9]*)?$/,
    )?.[1];
    if (!number || !binding?.repository.providerRepositoryId) return;
    await withGitHubPublicationLease(
      db,
      {
        companyId: action.companyId,
        endpointId: action.endpointId,
        repositoryId: String(binding.repository.providerRepositoryId),
        number: Number(number),
      },
      fetchImpl,
      async (lease) => {
        const [fresh] = await db
          .select()
          .from(chatActions)
          .where(eq(chatActions.id, actionId));
        if (!fresh || ["processed", "cancelled"].includes(fresh.status)) return;
        const session = action.payload.session as Session;
        if (!session || session.companyId !== action.companyId)
          throw forbidden("Invalid GitHub publication binding");
        try {
          const source = await scope(session, true);
          const egressScope = await githubEgressReferenceScope(
            db,
            source.endpoint.companyId,
            null,
          );
          const publicReviewText = (text: string) =>
            scrubInternalReferences(
              projectSafeChatPublicationText(text),
              egressScope,
            );
          if (
            source.endpoint.id !== action.endpointId ||
            source.conversation.id !== action.conversationId ||
            source.delivery.id !== action.deliveryId
          )
            throw forbidden("GitHub publication context changed");
          // Defense in depth for intents staged before shadow mode was
          // enabled: a 403 settles the action as cancelled, never retried,
          // and no provider write has happened yet at this point.
          if (source.shadowLabel)
            throw forbidden("Shadow review endpoints do not publish to GitHub");
          await assertPublicationAuthority(source, action);
          const api = await client(source, lease.fetch);
          const publicationMarker = marker(
            "publication",
            action.providerActionId,
          );
          const findByMarker = async (route: string, bodyMarker: string) => {
            for (let page = 1; page <= 100; page++) {
              const rows = await api.request<
                Array<{
                  id: number;
                  body?: string;
                  html_url: string;
                  user?: { login?: string };
                }>
              >(`${route}?per_page=100&page=${page}`);
              const found = rows.find(
                (row) =>
                  row.body?.includes(bodyMarker) &&
                  row.user?.login === source.endpoint.botUsername,
              );
              if (found) return found;
              if (rows.length < 100) return null;
            }
            throw conflict(
              "GitHub history is too large to safely resolve a publication retry",
            );
          };
          const currentHead = async (expected: string) => {
            const currentSource = await scope(session, true);
            // Called immediately before each write group, so this also stops
            // a dispatch whose endpoint entered shadow mode mid-flight.
            if (currentSource.shadowLabel)
              throw forbidden("Shadow reviews are never published to GitHub");
            await assertPublicationAuthority(currentSource, action);
            if (action.payload.operation === "formal_review")
              assertFormalPermission(
                currentSource.policy,
                action.payload.event as "APPROVE" | "REQUEST_CHANGES",
              );
            const [newer] = await db
              .select({ id: chatGitHubReviews.id })
              .from(chatGitHubReviews)
              .where(
                and(
                  eq(chatGitHubReviews.endpointId, source.endpoint.id),
                  eq(chatGitHubReviews.repositoryId, source.repositoryId),
                  eq(chatGitHubReviews.pullNumber, source.number),
                  eq(chatGitHubReviews.companyId, session.companyId),
                  primaryGitHubReview(),
                  gt(chatGitHubReviews.createdAt, source.run.createdAt),
                  sql`${chatGitHubReviews.runId} is distinct from ${source.run.id}`,
                  sql`${chatGitHubReviews.assessment} is not null`,
                ),
              )
              .limit(1);
            if (newer) throw conflict("github_review_superseded");
            const current = await api.request<Pull>(`/pulls/${source.number}`);
            if (current.head.sha !== expected)
              throw conflict("github_review_superseded");
            return currentSource;
          };
          const operation = action.payload.operation;
          let receipt: Record<string, unknown>;
          if (operation === "comment") {
            const body = `${publicReviewText(String(action.payload.body))}\n\n${publicationMarker}`;
            const route = source.replyId
              ? `/pulls/${source.number}/comments`
              : `/issues/${source.number}/comments`;
            const prior = await findByMarker(route, publicationMarker);
            const fresh = await scope(session, true);
            await assertPublicationAuthority(fresh, action);
            // Re-check after marker reads: shadow enabled, or a label pinned,
            // while this dispatch was in flight still suppresses the write.
            if (fresh.shadowLabel || (await pinnedShadowLabel(session, fresh)))
              throw forbidden("Shadow reviews are never published to GitHub");
            const posted =
              prior ??
              (await api.request<{ id: number; html_url: string }>(
                source.replyId
                  ? `/pulls/${source.number}/comments/${source.replyId}/replies`
                  : route,
                { method: "POST", body: { body } },
              ));
            receipt = { id: String(posted.id), url: posted.html_url };
          } else if (operation === "formal_review") {
            const parsed = formalSchema.parse({
              body: action.payload.body,
              event: action.payload.event,
              reviewedCommit: action.payload.reviewedCommit,
              idempotencyKey: action.payload.idempotencyKey,
            });
            assertFormalPermission(source.policy, parsed.event);
            await currentHead(parsed.reviewedCommit);
            const prior = await findByMarker(
              `/pulls/${source.number}/reviews`,
              publicationMarker,
            );
            const fresh = await scope(session, true);
            if (fresh.shadowLabel || (await pinnedShadowLabel(session, fresh)))
              throw forbidden("Shadow reviews are never published to GitHub");
            const posted =
              prior ??
              (await api.request<{ id: number; html_url: string }>(
                `/pulls/${source.number}/reviews`,
                {
                  method: "POST",
                  body: {
                    commit_id: parsed.reviewedCommit,
                    event: parsed.event,
                    body: `${publicReviewText(parsed.body)}\n\n${publicationMarker}`,
                  },
                },
              ));
            receipt = { id: String(posted.id), url: posted.html_url };
          } else if (operation === "assessment") {
            const [review] = await db
              .select()
              .from(chatGitHubReviews)
              .where(
                and(
                  eq(chatGitHubReviews.id, String(action.payload.reviewId)),
                  eq(chatGitHubReviews.companyId, action.companyId),
                  eq(chatGitHubReviews.endpointId, action.endpointId),
                  eq(chatGitHubReviews.runId, session.runId!),
                ),
              )
              .limit(1);
            if (!review?.assessment)
              throw conflict("Review assessment is unavailable");
            if (review.shadowLabel)
              throw forbidden("Shadow reviews are never published to GitHub");
            await currentHead(review.headSha);
            const assessment = validatePersistedGitHubReviewAssessment(
              review.assessment,
              review.headSha,
              {
                ...review.policySnapshot,
                ignoredPaths: [
                  ...review.policySnapshot.ignoredPaths,
                  ...source.policy.ignoredPaths,
                ],
              },
            );
            const conclusion = githubReviewConclusion(
              assessment,
              review.policySnapshot.ratingThreshold,
            );
            // LEFT coordinates are relative to the diff merge base, not the
            // target branch tip. Resolve old rows by their pinned commit pair.
            const evidenceBase = review.event.diffBaseSha ?? (
              assessment.findings.some((finding) => finding.side === "LEFT" && finding.basePath)
                ? await diffBaseSha(api, review.event.baseSha, review.headSha)
                : review.event.baseSha
            );
            // Internal Task/Run/history links are omitted; check runs use the
            // public PR permalink as their Details URL.
            const summary = publicReviewText(
              renderReviewSummary({
                assessment,
                repository: source.repository,
                pullNumber: source.number,
                headSha: review.headSha,
                baseSha: evidenceBase,
                scope: egressScope,
              }),
            );
            const summaryMarker = marker(
              "review",
              `${source.endpoint.id}:${source.repositoryId}:${source.number}`,
            );
            let summaryReceipt: { id: number; html_url: string } | null = null;
            if (source.policy.publishSummary) {
              const previous = await findByMarker(
                `/issues/${source.number}/comments`,
                summaryMarker,
              );
              const currentSummarySource = await currentHead(review.headSha);
              if (!currentSummarySource.policy.publishSummary)
                throw forbidden("Summary publication is disabled");
              summaryReceipt = await api.request(
                previous
                  ? `/issues/comments/${previous.id}`
                  : `/issues/${source.number}/comments`,
                {
                  method: previous ? "PATCH" : "POST",
                  body: { body: `${summary}\n\n${summaryMarker}` },
                },
              );
            }
            const severity = { info: 0, warning: 1, error: 2 };
            const receipts = { ...review.publicationReceipts };
            if (source.policy.publishInline)
              for (const finding of assessment.findings) {
                if (
                  severity[finding.severity] <
                  severity[source.policy.minimumCommentSeverity]
                )
                  continue;
                const key = hash({
                  key: finding.key,
                  path: finding.path,
                  line: finding.line,
                  side: finding.side,
                });
                const findingMarker = marker(
                  "finding",
                  `${source.endpoint.id}:${source.repositoryId}:${source.number}:${key}`,
                );
                const prior = await findByMarker(
                  `/pulls/${source.number}/comments`,
                  findingMarker,
                );
                const currentFindingSource = await currentHead(review.headSha);
                if (
                  !currentFindingSource.policy.publishInline ||
                  severity[finding.severity] <
                    severity[currentFindingSource.policy.minimumCommentSeverity]
                )
                  continue;
                if (
                  githubReviewPathIsExcluded(
                    finding.path,
                    currentFindingSource.policy,
                  )
                )
                  throw forbidden("Finding path is now excluded");
                const posted =
                  prior ??
                  (await api.request<{ id: number; html_url: string }>(
                    `/pulls/${source.number}/comments`,
                    {
                      method: "POST",
                      body: {
                        body: `${publicReviewText(
                          renderInlineFinding({
                            finding,
                            score: assessment.score,
                            complete: assessment.complete,
                            repository: source.repository,
                            headSha: review.headSha,
                            baseSha: evidenceBase,
                            scope: egressScope,
                          }),
                        )}\n\n${findingMarker}`,
                        commit_id: review.headSha,
                        path: finding.path,
                        line: finding.line,
                        side: finding.side,
                      },
                    },
                  ));
                // Replies to a finding continue the task that published it. The
                // provider gives inline threads their own root comment ID, so
                // bind that native thread before returning the publication.
                // Retries recover the same provider comment and preserve any
                // established ownership instead of moving existing follow-ups.
                await lease.commit(async (tx) => {
                  await tx
                    .insert(chatConversations)
                    .values({
                      companyId: source.endpoint.companyId,
                      endpointId: source.endpoint.id,
                      resourceId: source.resource.id,
                      issueId: source.issue.id,
                      externalConversationId:
                        source.conversation.externalConversationId,
                      externalThreadId: `github:${source.repository}:${source.number}:rc:${posted.id}`,
                      sessionGeneration: 1,
                      externalLabel: source.conversation.externalLabel,
                      providerUrl: posted.html_url,
                      isDirectMessage: false,
                      state: "active",
                      lastActivityAt: new Date(),
                    })
                    .onConflictDoNothing();
                });
                receipts[key] = {
                  id: String(posted.id),
                  url: posted.html_url,
                  digest: hash(finding),
                };
              }
            await currentHead(review.headSha);
            const checks = await api.request<{
              check_runs: Array<{
                id: number;
                external_id?: string;
                app?: { id?: number };
              }>;
            }>(
              `/commits/${review.headSha}/check-runs?check_name=Paperclip%20Review&per_page=100`,
            );
            const check = checks.check_runs.find(
              (item) =>
                item.external_id ===
                  `${source.endpoint.id}:${source.number}:${review.headSha}` &&
                String(item.app?.id) === source.endpoint.botExternalId,
            );
            await currentHead(review.headSha);
            const postedCheck = await api.request<{
              id: number;
              html_url: string;
            }>(check ? `/check-runs/${check.id}` : "/check-runs", {
              method: check ? "PATCH" : "POST",
              body: {
                name: "Paperclip Review",
                head_sha: review.headSha,
                external_id: `${source.endpoint.id}:${source.number}:${review.headSha}`,
                details_url: githubPullPermalink(source.repository, source.number),
                status: "completed",
                conclusion,
                output: {
                  title: assessment.complete
                    ? `${assessment.score}/5`
                    : "Incomplete review",
                  summary,
                },
              },
            });
            await lease.commit(async (tx) => {
              await tx
                .update(chatGitHubReviews)
                .set({
                  conclusion,
                  checkId: String(postedCheck.id),
                  checkUrl: postedCheck.html_url,
                  summaryId: summaryReceipt
                    ? String(summaryReceipt.id)
                    : review.summaryId,
                  summaryUrl: summaryReceipt?.html_url ?? review.summaryUrl,
                  publicationReceipts: receipts,
                  updatedAt: new Date(),
                })
                .where(eq(chatGitHubReviews.id, review.id));
            });
            receipt = {
              reviewId: review.id,
              checkUrl: postedCheck.html_url,
              summaryUrl: summaryReceipt?.html_url ?? null,
            };
          } else throw forbidden("Unknown GitHub publication");
          await lease.commit(async (tx) => {
            await tx
              .update(chatActions)
              .set({
                status: "processed",
                result: receipt,
                updatedAt: new Date(),
              })
              .where(eq(chatActions.id, action.id));
            await logActivity(tx as unknown as Db, {
              companyId: action.companyId,
              actorType: "agent",
              actorId: source.agent.id,
              action: "chat_github.published",
              entityType: "issue",
              entityId: source.issue.id,
              runId: source.run.id,
              details: { actionId: action.id, operation, ...receipt },
            });
          });
        } catch (error) {
          if (error instanceof GitHubPublicationLeaseLost) return;
          const attempts = Number(fresh.result?.attempts ?? 0) + 1;
          const denied = error instanceof HttpError && error.status === 403;
          const superseded =
            error instanceof Error &&
            error.message === "github_review_superseded";
          if (superseded && typeof action.payload.reviewId === "string")
            await lease.commit(async (tx) => {
              await tx
                .update(chatGitHubReviews)
                .set({ state: "superseded", updatedAt: new Date() })
                .where(
                  and(
                    eq(chatGitHubReviews.id, String(action.payload.reviewId)),
                    eq(chatGitHubReviews.companyId, action.companyId),
                  ),
                );
            });
          await lease.commit(async (tx) => {
            await tx
              .update(chatActions)
              .set({
                status: superseded || denied ? "cancelled" : "failed",
                result: {
                  attempts,
                  retryable: !superseded && !denied && attempts < 8,
                  retryAt: new Date(
                    Date.now() + Math.min(300000, 1000 * 2 ** attempts),
                  ).toISOString(),
                  code: superseded
                    ? "stale_head"
                    : denied
                      ? "authorization_changed"
                      : "publication_failed",
                },
                updatedAt: new Date(),
              })
              .where(eq(chatActions.id, action.id));
          });
        }
      },
    );
  }
  async function processPending(limit = 10) {
    const rows = await db
      .select({
        id: chatActions.id,
        status: chatActions.status,
        result: chatActions.result,
      })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "github_review_publication"),
          or(
            eq(chatActions.status, "received"),
            and(
              eq(chatActions.status, "failed"),
              sql`${chatActions.result}->>'retryable' = 'true'`,
              sql`(${chatActions.result}->>'retryAt')::timestamptz <= now()`,
            ),
          ),
        ),
      )
      .orderBy(chatActions.createdAt)
      .limit(limit);
    for (const row of rows)
      if (
        row.status === "received" ||
        (row.result?.retryable === true &&
          Date.parse(String(row.result.retryAt)) <= Date.now())
      )
        await processPublication(row.id);
    return rows.length;
  }
  return { execute, processPending, scope };
}
