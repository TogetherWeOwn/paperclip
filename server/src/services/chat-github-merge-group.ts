import { z } from "zod";
import { githubCommitSchema, githubIdSchema } from "@paperclipai/shared";
import type { MergeGroupCarryProofFingerprint } from "@paperclipai/shared";

/**
 * Native Paperclip Review carry for GitHub merge-queue groups.
 *
 * On `merge_group` / `checks_requested` the queue needs a `Paperclip Review`
 * verdict on the group SHA. Re-running a paid review is skipped only when
 * every queued PR's exact head already carries a completed 5/5 review AND the
 * group tree is proven to contain exactly those reviewed changes (empty
 * diff-of-diff, verified by tree ownership, not by commit titles). Every
 * other outcome fails closed with `action_required`: missing or weak reviews
 * are never synthesized from titles, comments, or older heads.
 *
 * Identity is proven only for merge-method groups: every group commit must be
 * a merge commit whose second parent immutably names the queued PR head, and
 * every queue-ref PR must own such an entry. Squash and rebase shapes carry
 * no immutable binding of the group to the reviewed heads — the current pull
 * head and matching trees cannot prove which head the group was cut from —
 * so they fail closed as `ambiguous_group`, as does any unrecognized commit.
 *
 * This module is pure: GitHub reads arrive through `MergeGroupGitHub` and
 * review rows through `MergeGroupCarryInput`, so the whole acceptance matrix
 * runs without a database or network. Persistence, webhook ingress, and check
 * publication live in the wiring layer.
 */

export const PAPERCLIP_REVIEW_CHECK_NAME = "Paperclip Review";
const MERGE_QUEUE_REF_PREFIX = "gh-readonly-queue/";
const MAX_QUEUED_PRS = 100;

const id = z.union([
  githubIdSchema,
  z.number().int().positive().safe().transform(String),
]);
const sha = githubCommitSchema;
const shortSha = z
  .string()
  .regex(/^[0-9a-f]{4,40}$/i)
  .transform((value) => value.toLowerCase());

const payloadSchema = z.object({
  action: z.literal("checks_requested"),
  repository: z.object({
    id,
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  }),
  installation: z.object({ id }).optional(),
  merge_group: z.object({
    head_sha: sha,
    head_ref: z.string().min(1).max(500),
    base_sha: sha,
    base_ref: z.string().min(1).max(500),
  }),
});

export type MergeGroupContext = {
  deliveryId: string;
  repositoryId: string;
  repository: string;
  groupSha: string;
  groupRef: string;
  baseSha: string;
  baseRef: string;
  installationId: string | null;
};

/** Parse after signature + installed-repository admission. Null = ignore. */
export function parseMergeGroupEvent(
  payload: unknown,
  deliveryId: string,
): MergeGroupContext | null {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { data } = parsed;
  return {
    deliveryId,
    repositoryId: String(data.repository.id),
    repository: data.repository.full_name.toLowerCase(),
    groupSha: data.merge_group.head_sha,
    groupRef: data.merge_group.head_ref,
    baseSha: data.merge_group.base_sha,
    baseRef: data.merge_group.base_ref,
    installationId: data.installation ? String(data.installation.id) : null,
  };
}

export type MergeGroupQueuedPr = { pullNumber: number; shortSha: string };

const QUEUE_REF_SEGMENT = /pr-(\d{1,9})-([0-9a-f]{4,40})/gi;

/**
 * Discover candidate PRs from the temporary queue ref. The ref only names
 * the newest entries, so this is discovery — never proof. Every candidate is
 * confirmed through the pulls API, and tree ownership (not enumeration)
 * guarantees no queued change escapes review.
 */
export function parseMergeGroupQueuedPrs(
  groupRef: string,
): MergeGroupQueuedPr[] | null {
  const ref = groupRef.startsWith("refs/heads/")
    ? groupRef.slice("refs/heads/".length)
    : groupRef;
  if (!ref.startsWith(MERGE_QUEUE_REF_PREFIX)) return null;
  const rest = ref.slice(MERGE_QUEUE_REF_PREFIX.length);
  const segments = [...rest.matchAll(QUEUE_REF_SEGMENT)].map((match) => ({
    pullNumber: Number(match[1]),
    shortSha: match[2].toLowerCase(),
  }));
  if (segments.length === 0) return null;
  const seen = new Set<number>();
  const unique = segments.filter((segment) => {
    if (seen.has(segment.pullNumber)) return false;
    seen.add(segment.pullNumber);
    return true;
  });
  return unique.length > 0 && unique.length <= MAX_QUEUED_PRS ? unique : null;
}

export type MergeGroupPull = {
  number: number;
  headSha: string;
  baseSha: string;
  state: string;
  merged: boolean;
};
export type MergeGroupCompareCommit = {
  sha: string;
  /** Parent commit SHAs in order. Merge-method groups carry the PR head as the
   * second parent; squash groups have one parent and no PR-head reference. */
  parents: string[];
  message: string;
};
export type MergeGroupCompare = {
  truncated: boolean;
  commits: MergeGroupCompareCommit[];
};
export type MergeGroupTreeEntry = {
  path: string;
  mode: string;
  type: string;
  sha: string | null;
};
export type MergeGroupTree = {
  sha: string;
  truncated: boolean;
  entries: MergeGroupTreeEntry[];
};
export type MergeGroupHeadCheck = {
  appId: string;
  externalId: string;
  status: string;
  conclusion: string | null;
};

export type MergeGroupGitHub = {
  getPull(pullNumber: number): Promise<MergeGroupPull | null>;
  getCompare(baseSha: string, headSha: string): Promise<MergeGroupCompare | null>;
  /** True merge base of a pull request head against its target branch tip.
   * `pull.base.sha` is the moving target tip, never the diff baseline. */
  getMergeBase(baseSha: string, headSha: string): Promise<string | null>;
  /** Live commit SHA of the queue ref, or null when it cannot be read. */
  getRefSha(groupRef: string): Promise<string | null>;
  getTree(sha: string): Promise<MergeGroupTree | null>;
  listReviewChecks(headSha: string): Promise<MergeGroupHeadCheck[] | null>;
};

/** Native `chat_github_reviews` projection for one exact PR head. */
export type MergeGroupReviewRecord = {
  pullNumber: number;
  headSha: string;
  state: string;
  complete: boolean;
  score: number;
  conclusion: string | null;
  configurationRevision: number;
};

export type MergeGroupCarryInput = {
  endpointId: string;
  appId: string;
  eventAgeMs: number;
  maxEventAgeMs: number;
  /** Exact current policy revision. A review recorded under any other
   * revision was judged by obsolete policy and must not carry. */
  configurationRevision: number;
  reviews: MergeGroupReviewRecord[];
};

export type MergeGroupCarryFailCode =
  | "ambiguous_group"
  | "stale_head"
  | "missing_review"
  | "weak_review"
  | "stale_policy"
  | "check_mismatch"
  | "truncated_evidence"
  | "evidence_unavailable"
  | "nonempty_delta"
  | "pr_overlap"
  | "expired";

export type MergeGroupCarryVerdict =
  | {
      ok: true;
      code: "carry";
      externalId: string;
      groupSha: string;
      carried: Array<{ pullNumber: number; headSha: string }>;
    }
  | {
      ok: false;
      code: MergeGroupCarryFailCode;
      externalId: string;
      groupSha: string;
      detail: string;
      failedPullNumber?: number;
    };

export type MergeGroupCarryFingerprint = {
  endpointId: string;
  appId: string;
  groupSha: string;
  baseSha: string;
  heads: Array<{ pullNumber: number; headSha: string }>;
};

/** Idempotency key: repo is implied by the check run; key is endpoint+group. */
export function mergeGroupCarryExternalId(
  endpointId: string,
  groupSha: string,
): string {
  return `carry:${endpointId}:${groupSha}`;
}

/** Recompute whenever the group, base, or any queued head changes. */
export function sameMergeGroupCarryFingerprint(
  left: MergeGroupCarryFingerprint,
  right: MergeGroupCarryFingerprint,
): boolean {
  return (
    left.endpointId === right.endpointId &&
    left.appId === right.appId &&
    left.groupSha === right.groupSha &&
    left.baseSha === right.baseSha &&
    left.heads.length === right.heads.length &&
    left.heads.every(
      (head, index) =>
        head.pullNumber === right.heads[index]?.pullNumber &&
        head.headSha === right.heads[index]?.headSha,
    )
  );
}

const byPullNumber = (
  left: { pullNumber: number },
  right: { pullNumber: number },
): number => left.pullNumber - right.pullNumber;

/** Snapshot the exact identities observed at the write boundary. Heads and
 * reviews are normalized (lowercase SHAs, sorted by pull number) so a stored
 * fingerprint compares stably. */
export function buildMergeGroupProofFingerprint(args: {
  endpointId: string;
  appId: string;
  ctx: MergeGroupContext;
  heads: Array<{ pullNumber: number; headSha: string }>;
  reviews: MergeGroupCarryInput["reviews"];
  configurationRevision: number;
  runtimeGeneration: number;
}): MergeGroupCarryProofFingerprint {
  return {
    version: 1,
    endpointId: args.endpointId,
    appId: args.appId,
    repositoryId: args.ctx.repositoryId,
    repository: args.ctx.repository,
    groupSha: args.ctx.groupSha.toLowerCase(),
    groupRef: args.ctx.groupRef,
    baseSha: args.ctx.baseSha.toLowerCase(),
    heads: args.heads
      .map((head) => ({
        pullNumber: head.pullNumber,
        headSha: head.headSha.toLowerCase(),
      }))
      .sort(byPullNumber),
    reviews: args.reviews
      .map((review) => ({
        pullNumber: review.pullNumber,
        headSha: review.headSha.toLowerCase(),
        configurationRevision: review.configurationRevision,
      }))
      .sort(byPullNumber),
    configurationRevision: args.configurationRevision,
    runtimeGeneration: args.runtimeGeneration,
  };
}

/** Redelivery replay predicate. A stored proof replays only when every
 * database-observable field still matches the current delivery and source —
 * endpoint, review app, repository, group, base, queue ref, policy revision,
 * and endpoint/credential epoch — plus intact write-time head/review
 * evidence. Anything else is re-judged, never replayed.
 *
 * Residual: provider-fresh heads are not re-read on replay (replay performs
 * no provider calls). The write-time proof was boundary-validated at
 * publication, the group commit is immutable, and a regenerated queue is a
 * new group key; post-publish head drift cannot retroactively falsify the
 * published content binding. */
export function mergeGroupProofReplayMatches(args: {
  stored: MergeGroupCarryProofFingerprint | null | undefined;
  endpointId: string;
  appId: string;
  ctx: MergeGroupContext;
  configurationRevision: number;
  runtimeGeneration: number;
}): boolean {
  const proof = args.stored;
  if (!proof || proof.version !== 1) return false;
  if (!Array.isArray(proof.heads) || !Array.isArray(proof.reviews)) return false;
  return (
    proof.endpointId === args.endpointId &&
    proof.appId === args.appId &&
    proof.repositoryId === args.ctx.repositoryId &&
    proof.repository === args.ctx.repository &&
    proof.groupSha === args.ctx.groupSha.toLowerCase() &&
    proof.groupRef === args.ctx.groupRef &&
    proof.baseSha === args.ctx.baseSha.toLowerCase() &&
    proof.configurationRevision === args.configurationRevision &&
    proof.runtimeGeneration === args.runtimeGeneration
  );
}

const MERGE_SUBJECT = /^Merge pull request #(\d{1,9}) from \S+/;
const SQUASH_SUFFIX = /\(#(\d{1,9})\)\s*$/;

export type MergeGroupCommitPr = {
  pullNumber: number;
  /** PR head named by an immutable merge-commit parent; null for squash. */
  pinnedHeadSha: string | null;
};

/** PR numbers from queue-generated commit subjects. Titles are hints only; a
 * merge-method commit additionally pins the PR head through its second parent.
 * Discovery only: squash entries (`pinnedHeadSha: null`) and unrecognized
 * commits are returned here but always rejected by `decideMergeGroupCarry`,
 * which requires a merge-method binding for every group member. */
export function prsFromCompareCommits(
  commits: MergeGroupCompareCommit[],
): MergeGroupCommitPr[] {
  const found = new Map<number, MergeGroupCommitPr>();
  for (const commit of commits) {
    const firstLine = commit.message.split("\n", 1)[0] ?? "";
    const merge = MERGE_SUBJECT.exec(firstLine);
    if (merge && commit.parents.length === 2) {
      found.set(Number(merge[1]), {
        pullNumber: Number(merge[1]),
        pinnedHeadSha: commit.parents[1]!.toLowerCase(),
      });
      continue;
    }
    const squash = SQUASH_SUFFIX.exec(firstLine);
    if (squash && commit.parents.length === 1 && !found.has(Number(squash[1])))
      found.set(Number(squash[1]), {
        pullNumber: Number(squash[1]),
        pinnedHeadSha: null,
      });
  }
  return [...found.values()];
}

function treeKey(entry: MergeGroupTreeEntry | undefined): string | null {
  if (!entry || !entry.sha) return null;
  return `${entry.type}:${entry.mode}:${entry.sha.toLowerCase()}`;
}

function treeMap(tree: MergeGroupTree): Map<string, MergeGroupTreeEntry> {
  const map = new Map<string, MergeGroupTreeEntry>();
  // Directory nodes change whenever any descendant changes, so disjoint files
  // under one directory would look like an overlap. Leaves carry the proof.
  for (const entry of tree.entries) if (entry.type !== "tree") map.set(entry.path, entry);
  return map;
}

export type MergeGroupOwnership =
  | { ok: true }
  | {
      ok: false;
      code: "nonempty_delta" | "pr_overlap";
      paths: string[];
    };

/**
 * The empty diff-of-diff proof. Every path that differs between the group and
 * its base must be owned by exactly one queued PR whose group blob equals its
 * reviewed-head blob; every other path must equal the group base. Base drift
 * on untouched files passes; base interaction on a reviewed file fails.
 */
export function verifyMergeGroupTreeOwnership(args: {
  groupTree: Map<string, MergeGroupTreeEntry>;
  baseTree: Map<string, MergeGroupTreeEntry>;
  prs: Array<{
    pullNumber: number;
    baseTree: Map<string, MergeGroupTreeEntry>;
    headTree: Map<string, MergeGroupTreeEntry>;
  }>;
}): MergeGroupOwnership {
  // Directory nodes change with any descendant; only leaves carry ownership.
  // Callers normally pass leaf-only maps, but direct callers must not trip.
  const leaves = (tree: Map<string, MergeGroupTreeEntry>) =>
    new Map([...tree].filter(([, entry]) => entry.type !== "tree"));
  args = {
    groupTree: leaves(args.groupTree),
    baseTree: leaves(args.baseTree),
    prs: args.prs.map((pr) => ({
      pullNumber: pr.pullNumber,
      baseTree: leaves(pr.baseTree),
      headTree: leaves(pr.headTree),
    })),
  };
  const paths = new Set<string>();
  for (const tree of [
    args.groupTree,
    args.baseTree,
    ...args.prs.flatMap((pr) => [pr.baseTree, pr.headTree]),
  ]) {
    for (const path of tree.keys()) paths.add(path);
  }
  const overlap: string[] = [];
  const delta: string[] = [];
  for (const path of [...paths].sort()) {
    const owners = args.prs.filter(
      (pr) =>
        treeKey(pr.headTree.get(path)) !== treeKey(pr.baseTree.get(path)),
    );
    if (owners.length > 1) {
      overlap.push(`${path} (pull requests ${owners.map((o) => `#${o.pullNumber}`).join(", ")})`);
      continue;
    }
    const expected = treeKey(
      owners.length === 1
        ? owners[0]!.headTree.get(path)
        : args.baseTree.get(path),
    );
    if (treeKey(args.groupTree.get(path)) !== expected)
      delta.push(path);
  }
  if (overlap.length > 0) return { ok: false, code: "pr_overlap", paths: overlap };
  if (delta.length > 0) return { ok: false, code: "nonempty_delta", paths: delta };
  return { ok: true };
}

export async function decideMergeGroupCarry(
  ctx: MergeGroupContext,
  github: MergeGroupGitHub,
  input: MergeGroupCarryInput,
): Promise<MergeGroupCarryVerdict> {
  const externalId = mergeGroupCarryExternalId(input.endpointId, ctx.groupSha);
  const fail = (
    code: MergeGroupCarryFailCode,
    detail: string,
    failedPullNumber?: number,
  ): MergeGroupCarryVerdict => ({
    ok: false,
    code,
    externalId,
    groupSha: ctx.groupSha,
    detail,
    ...(failedPullNumber === undefined ? {} : { failedPullNumber }),
  });

  if (input.eventAgeMs > input.maxEventAgeMs)
    return fail(
      "expired",
      `the merge_group event arrived ${Math.round(input.eventAgeMs / 1000)}s after delivery, past the recompute window; the group may already be superseded`,
    );

  const refPrs = parseMergeGroupQueuedPrs(ctx.groupRef);
  if (!refPrs)
    return fail(
      "ambiguous_group",
      `the queue ref "${ctx.groupRef}" names no pull request, so the group membership cannot be determined`,
    );

  let liveGroupSha: string | null = null;
  try {
    liveGroupSha = await github.getRefSha(ctx.groupRef);
  } catch {
    liveGroupSha = null;
  }
  if (!liveGroupSha)
    return fail(
      "evidence_unavailable",
      `the queue ref "${ctx.groupRef}" could not be read, so the group cannot be confirmed as current`,
    );
  if (liveGroupSha.toLowerCase() !== ctx.groupSha.toLowerCase())
    return fail(
      "stale_head",
      `the queue ref "${ctx.groupRef}" now points at ${liveGroupSha}, not the delivered group ${ctx.groupSha}; the group was regenerated`,
    );

  let compare: MergeGroupCompare | null = null;
  try {
    compare = await github.getCompare(ctx.baseSha, ctx.groupSha);
  } catch {
    compare = null;
  }
  if (!compare)
    return fail(
      "evidence_unavailable",
      "the group comparison could not be read, so queued pull requests cannot be confirmed",
    );
  if (compare.truncated)
    return fail(
      "truncated_evidence",
      "the group comparison is truncated, so queued pull requests cannot be determined",
    );
  if (compare.commits.length === 0)
    return fail(
      "ambiguous_group",
      "the group comparison lists no commits, so queued pull requests cannot be determined",
    );
  // Real queue refs name the newest PR and the group's parent commit (the
  // previous queue state), never a PR head. Bind that suffix to the actual
  // group commit instead of trusting the ref text.
  const groupCommit = compare.commits[compare.commits.length - 1]!;
  if (groupCommit.sha.toLowerCase() !== ctx.groupSha.toLowerCase())
    return fail(
      "ambiguous_group",
      "the group comparison does not end at the delivered group commit, so its membership cannot be determined",
    );
  const groupParent = groupCommit.parents[0]?.toLowerCase() ?? "";
  for (const refPr of refPrs) {
    if (!groupParent.startsWith(refPr.shortSha.toLowerCase()))
      return fail(
        "ambiguous_group",
        `the queue ref names ${refPr.shortSha} for pull request #${refPr.pullNumber}, which is not the parent of the group commit; the group identity cannot be confirmed`,
        refPr.pullNumber,
      );
  }
  // Immutable membership proof. Every group commit must be a merge-method
  // entry whose second parent names the exact queued PR head; anything else
  // — a squash/rebase shape, an unrecognized message, a malformed parent, or
  // conflicting bindings for one PR — proves nothing about which head the
  // group was cut from and fails closed. Title hints never become identity.
  const boundHeads = new Map<number, string>();
  for (const commit of compare.commits) {
    const firstLine = commit.message.split("\n", 1)[0] ?? "";
    const merge = MERGE_SUBJECT.exec(firstLine);
    const secondParent = commit.parents[1]?.toLowerCase() ?? null;
    if (
      !merge ||
      commit.parents.length !== 2 ||
      !secondParent ||
      !/^[0-9a-f]{40}$/.test(secondParent) ||
      !/^[0-9a-f]{40}$/i.test(commit.sha)
    )
      return fail(
        "ambiguous_group",
        `the group contains commit ${commit.sha} with no immutable binding to a queued pull request head, so the group membership cannot be proven`,
      );
    const pullNumber = Number(merge[1]);
    const prior = boundHeads.get(pullNumber);
    if (prior !== undefined && prior !== secondParent)
      return fail(
        "ambiguous_group",
        `pull request #${pullNumber} is bound to conflicting heads inside one group, so the queued head cannot be determined`,
        pullNumber,
      );
    boundHeads.set(pullNumber, secondParent);
  }
  for (const refPr of refPrs) {
    if (!boundHeads.has(refPr.pullNumber))
      return fail(
        "ambiguous_group",
        `the queue ref names pull request #${refPr.pullNumber}, which has no merge-method entry in the group, so the group membership cannot be proven`,
        refPr.pullNumber,
      );
  }
  const candidates = [...boundHeads.keys()]
    .sort((a, b) => a - b)
    .map((pullNumber) => ({ pullNumber, shortSha: "" }));
  if (candidates.length === 0 || candidates.length > MAX_QUEUED_PRS)
    return fail(
      "ambiguous_group",
      "the queued pull request set is empty or unbounded, so the group membership cannot be determined",
    );

  const pulls: MergeGroupPull[] = [];
  for (const candidate of candidates) {
    let pull: MergeGroupPull | null = null;
    try {
      pull = await github.getPull(candidate.pullNumber);
    } catch {
      pull = null;
    }
    if (!pull || pull.number !== candidate.pullNumber)
      return fail(
        "evidence_unavailable",
        `pull request #${candidate.pullNumber} could not be read, so its queued head cannot be confirmed`,
        candidate.pullNumber,
      );
    const headSha = pull.headSha.toLowerCase();
    const baseSha = pull.baseSha.toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(headSha) || !/^[0-9a-f]{40}$/.test(baseSha))
      return fail(
        "evidence_unavailable",
        `pull request #${candidate.pullNumber} returned invalid commits, so its queued head cannot be confirmed`,
        candidate.pullNumber,
      );
    if (pull.state !== "open" || pull.merged)
      return fail(
        "stale_head",
        `pull request #${candidate.pullNumber} is ${pull.merged ? "already merged" : `not open (${pull.state})`}, so it is no longer a queued entry`,
        candidate.pullNumber,
      );
    // Every candidate carries an immutable pin by construction (the binding
    // pass above rejects unbound shapes). The current pull head is accepted
    // only as a freshness check against that pin — never as identity proof.
    const pinned = boundHeads.get(candidate.pullNumber)!;
    if (pinned !== headSha)
      return fail(
        "stale_head",
        `pull request #${candidate.pullNumber} now points at ${headSha}, which no longer matches the head ${pinned} merged into the queued group; the group is superseded`,
        candidate.pullNumber,
      );
    pulls.push({ ...pull, headSha, baseSha });
  }

  for (const pull of pulls) {
    const record = input.reviews.find(
      (candidate) =>
        candidate.pullNumber === pull.number &&
        candidate.headSha.toLowerCase() === pull.headSha,
    );
    if (!record)
      return fail(
        "missing_review",
        `pull request #${pull.number} has no completed review for its exact queued head ${pull.headSha}`,
        pull.number,
      );
    if (record.configurationRevision !== input.configurationRevision)
      return fail(
        "stale_policy",
        `pull request #${pull.number} head ${pull.headSha} was reviewed under policy revision ${record.configurationRevision}, not the current revision ${input.configurationRevision}`,
        pull.number,
      );
    if (
      record.state !== "completed" ||
      !record.complete ||
      record.score !== 5 ||
      record.conclusion !== "success"
    )
      return fail(
        "weak_review",
        `pull request #${pull.number} head ${pull.headSha} is reviewed ${record.score}/5 (state ${record.state}, conclusion ${record.conclusion ?? "none"}), not a completed 5/5 success`,
        pull.number,
      );
    let checks: MergeGroupHeadCheck[] | null = null;
    try {
      checks = await github.listReviewChecks(pull.headSha);
    } catch {
      checks = null;
    }
    if (!checks)
      return fail(
        "evidence_unavailable",
        `the ${PAPERCLIP_REVIEW_CHECK_NAME} runs on pull request #${pull.number} head ${pull.headSha} could not be read`,
        pull.number,
      );
    const success = checks.some(
      (check) =>
        check.appId === input.appId &&
        check.externalId ===
          `${input.endpointId}:${pull.number}:${pull.headSha}` &&
        check.status === "completed" &&
        check.conclusion === "success",
    );
    if (!success)
      return fail(
        "check_mismatch",
        `pull request #${pull.number} head ${pull.headSha} has no completed ${PAPERCLIP_REVIEW_CHECK_NAME} success from the review app`,
        pull.number,
      );
  }

  const mergeBases = new Map<number, string>();
  for (const pull of pulls) {
    let mergeBase: string | null = null;
    try {
      mergeBase = await github.getMergeBase(pull.baseSha, pull.headSha);
    } catch {
      mergeBase = null;
    }
    mergeBase = mergeBase?.toLowerCase() ?? null;
    if (!mergeBase || !/^[0-9a-f]{40}$/.test(mergeBase))
      return fail(
        "evidence_unavailable",
        `the merge base of pull request #${pull.number} could not be read, so its diff baseline cannot be determined`,
        pull.number,
      );
    mergeBases.set(pull.number, mergeBase);
  }

  const trees = new Map<string, MergeGroupTree>();
  for (const sha of [
    ctx.groupSha,
    ctx.baseSha,
    ...pulls.flatMap((pull) => [pull.headSha, mergeBases.get(pull.number)!]),
  ]) {
    if (trees.has(sha)) continue;
    let tree: MergeGroupTree | null = null;
    try {
      tree = await github.getTree(sha);
    } catch {
      tree = null;
    }
    if (!tree)
      return fail(
        "evidence_unavailable",
        `the file tree for ${sha} could not be read, so group equality cannot be proven`,
      );
    if (tree.truncated)
      return fail(
        "truncated_evidence",
        `the file tree for ${sha} is truncated, so group equality cannot be proven`,
      );
    trees.set(sha, tree);
  }

  const ownership = verifyMergeGroupTreeOwnership({
    groupTree: treeMap(trees.get(ctx.groupSha)!),
    baseTree: treeMap(trees.get(ctx.baseSha)!),
    prs: pulls.map((pull) => ({
      pullNumber: pull.number,
      baseTree: treeMap(trees.get(mergeBases.get(pull.number)!)!),
      headTree: treeMap(trees.get(pull.headSha)!),
    })),
  });
  if (!ownership.ok) {
    if (ownership.code === "pr_overlap")
      return fail(
        "pr_overlap",
        `queued pull requests rewrite the same files (${ownership.paths.join("; ")}); joint ownership cannot be carried`,
      );
    return fail(
      "nonempty_delta",
      `the group differs from the reviewed heads outside an empty merge (${ownership.paths.join(", ")}); the queued change is not identical to what was reviewed`,
    );
  }

  return {
    ok: true,
    code: "carry",
    externalId,
    groupSha: ctx.groupSha,
    carried: pulls.map((pull) => ({
      pullNumber: pull.number,
      headSha: pull.headSha,
    })),
  };
}

export function mergeGroupCarryCheckBody(
  repository: string,
  verdict: MergeGroupCarryVerdict,
): { title: string; summary: string } {
  if (verdict.ok) {
    const lines = verdict.carried.map(
      (entry) => `- PR #${entry.pullNumber} at \`${entry.headSha}\` (completed 5/5 exact-head review)`,
    );
    return {
      title: `Paperclip Review carried from ${verdict.carried.length} reviewed head${verdict.carried.length === 1 ? "" : "s"}`,
      summary: [
        `Carried ${PAPERCLIP_REVIEW_CHECK_NAME} for \`${repository}\` merge group \`${verdict.groupSha}\`:`,
        ...lines,
        "",
        "The queued change is byte-identical to the reviewed heads (empty diff-of-diff); no new review was run.",
      ].join("\n"),
    };
  }
  const scope =
    verdict.failedPullNumber === undefined
      ? ""
      : ` (PR #${verdict.failedPullNumber})`;
  return {
    title: "Paperclip Review cannot be carried to the merge group",
    summary: [
      `${PAPERCLIP_REVIEW_CHECK_NAME} cannot be carried for \`${repository}\` merge group \`${verdict.groupSha}\`${scope}:`,
      "",
      verdict.detail,
      "",
      "Failing closed: no verdict was synthesized. Re-queue once every queued head carries a completed 5/5 review with changes identical to what was reviewed.",
    ].join("\n"),
  };
}
