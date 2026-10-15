import { z } from "zod";
import { githubCommitSchema, githubIdSchema } from "@paperclipai/shared";

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
  parents: number;
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
  reviews: MergeGroupReviewRecord[];
};

export type MergeGroupCarryFailCode =
  | "ambiguous_group"
  | "stale_head"
  | "missing_review"
  | "weak_review"
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

const MERGE_SUBJECT = /^Merge pull request #(\d{1,9}) from \S+/;
const SQUASH_SUFFIX = /\(#(\d{1,9})\)\s*$/;

/** PR numbers from queue-generated commit subjects. Titles are hints only. */
function prsFromCompareCommits(commits: MergeGroupCompareCommit[]): number[] {
  const found: number[] = [];
  for (const commit of commits) {
    const firstLine = commit.message.split("\n", 1)[0] ?? "";
    const merge = MERGE_SUBJECT.exec(firstLine);
    if (merge && commit.parents === 2) {
      found.push(Number(merge[1]));
      continue;
    }
    const squash = SQUASH_SUFFIX.exec(firstLine);
    if (squash && commit.parents === 1) found.push(Number(squash[1]));
  }
  return [...new Set(found)];
}

function treeKey(entry: MergeGroupTreeEntry | undefined): string | null {
  if (!entry || !entry.sha) return null;
  return `${entry.type}:${entry.mode}:${entry.sha.toLowerCase()}`;
}

function treeMap(tree: MergeGroupTree): Map<string, MergeGroupTreeEntry> {
  const map = new Map<string, MergeGroupTreeEntry>();
  for (const entry of tree.entries) map.set(entry.path, entry);
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
  const commitPrs = prsFromCompareCommits(compare.commits);
  const candidates = [...refPrs];
  for (const pullNumber of commitPrs) {
    if (candidates.some((candidate) => candidate.pullNumber === pullNumber))
      continue;
    candidates.push({ pullNumber, shortSha: "" });
  }
  candidates.sort((a, b) => a.pullNumber - b.pullNumber);
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
    if (
      candidate.shortSha &&
      !headSha.startsWith(candidate.shortSha.toLowerCase())
    )
      return fail(
        "stale_head",
        `pull request #${candidate.pullNumber} now points at ${headSha}, which no longer matches the queued group; the group is superseded`,
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

  const trees = new Map<string, MergeGroupTree>();
  for (const sha of [
    ctx.groupSha,
    ctx.baseSha,
    ...pulls.flatMap((pull) => [pull.headSha, pull.baseSha]),
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
      baseTree: treeMap(trees.get(pull.baseSha.toLowerCase())!),
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
