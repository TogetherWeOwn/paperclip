/**
 * Parent/child + blocks cycle detection for startup-safe recovery.
 *
 * A parent issue implicitly waits on its open children to finish (recovery
 * materializes that wait as an explicit `blocks` edge, child -> parent).
 * When the child is already (transitively) blocked by the parent through
 * first-class `blocks` edges, materializing the implicit edge closes a
 * dependency loop:
 *
 *   P --blocks--> ... --blocks--> C   (explicit edges)
 *   C --completes-before--> P          (implicit parent/child completion)
 *
 * Attempting the `issues.update({ blockedByIssueIds })` for that
 * materialization throws `unprocessable("Blocking relations cannot contain
 * cycles")`. At startup that throw escapes the recovery sweep and crashes
 * the boot, and the supervisor restart retries the same input: a
 * crash-loop. Recovery must instead detect the cycle first, park the
 * members with a notice naming the cycle, and take no further automatic
 * action.
 *
 * These helpers are pure (in-memory graph) so they are unit-testable and
 * cannot touch the database. The DB-backed recovery service builds the
 * adjacency from `issue_relations` and delegates the decision here.
 */

export interface ParentChildCycleIssue {
  id: string;
  identifier: string | null;
  /** Parent issue id, or null for top-level issues. */
  parentId: string | null;
}

export interface ParentChildBlocksRelation {
  blockerIssueId: string;
  blockedIssueId: string;
}

export interface ParentChildBlocksCycle {
  /** The parent that implicitly waits on `childId` to finish. */
  parentId: string;
  /** The open child whose completion the parent waits on. */
  childId: string;
  /**
   * Explicit `blocks` path from parent to child (blocker -> ... -> blocked),
   * inclusive of both ends. Closing the loop is the implicit
   * child-completes-before-parent edge.
   */
  explicitPath: string[];
}

/** Hard bound so a degenerate graph cannot turn detection into a storm. */
export const PARENT_CHILD_BLOCKS_CYCLE_SEARCH_LIMIT = 500;

function buildBlockerAdjacency(
  relations: ParentChildBlocksRelation[],
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const relation of relations) {
    if (!relation.blockerIssueId || !relation.blockedIssueId) continue;
    if (relation.blockerIssueId === relation.blockedIssueId) continue;
    const list = adjacency.get(relation.blockerIssueId) ?? [];
    if (!list.includes(relation.blockedIssueId)) list.push(relation.blockedIssueId);
    adjacency.set(relation.blockerIssueId, list);
  }
  return adjacency;
}

/**
 * Breadth-first explicit `blocks` path from `fromId` (blocker) to `toId`
 * (blocked), inclusive of both ends. Returns null when `toId` is not
 * reachable from `fromId`.
 */
export function findExplicitBlocksPath(
  relations: ParentChildBlocksRelation[],
  fromId: string,
  toId: string,
): string[] | null {
  if (!fromId || !toId || fromId === toId) return null;
  const adjacency = buildBlockerAdjacency(relations);
  const previous = new Map<string, string | null>([[fromId, null]]);
  const queue = [fromId];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    if (visited > PARENT_CHILD_BLOCKS_CYCLE_SEARCH_LIMIT) return null;
    if (current === toId) {
      const path = [current];
      let node: string | null | undefined = previous.get(current);
      while (node) {
        path.unshift(node);
        node = previous.get(node);
      }
      return path;
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!previous.has(next)) {
        previous.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}

/**
 * Check whether materializing `childId` as a blocker of `parentId` (the
 * parent implicitly waiting on its open child) would close a dependency
 * loop. Returns the cycle when the child is already transitively blocked
 * by the parent through explicit `blocks` edges.
 */
export function findParentChildBlocksCycle(
  relations: ParentChildBlocksRelation[],
  parentId: string,
  childId: string,
): ParentChildBlocksCycle | null {
  const explicitPath = findExplicitBlocksPath(relations, parentId, childId);
  if (!explicitPath) return null;
  return { parentId, childId, explicitPath };
}

/**
 * Scan every parent/child pair and return each parent/child + blocks cycle.
 * One entry per (parent, child) pair; callers park the union of members.
 */
export function findAllParentChildBlocksCycles(
  issues: ParentChildCycleIssue[],
  relations: ParentChildBlocksRelation[],
): ParentChildBlocksCycle[] {
  const cycles: ParentChildBlocksCycle[] = [];
  const childrenByParent = new Map<string, string[]>();
  for (const issue of issues) {
    if (!issue.parentId || issue.parentId === issue.id) continue;
    const list = childrenByParent.get(issue.parentId) ?? [];
    if (!list.includes(issue.id)) list.push(issue.id);
    childrenByParent.set(issue.parentId, list);
  }
  for (const [parentId, childIds] of childrenByParent) {
    for (const childId of childIds) {
      const cycle = findParentChildBlocksCycle(relations, parentId, childId);
      if (cycle) cycles.push(cycle);
    }
  }
  return cycles;
}

function issueLabel(
  issuesById: Map<string, ParentChildCycleIssue>,
  id: string,
): string {
  return issuesById.get(id)?.identifier ?? id;
}

/** Marker embedded in the park notice so recovery posts it at most once. */
export function parentChildBlocksCycleMarker(
  cycle: Pick<ParentChildBlocksCycle, "parentId" | "childId">,
): string {
  return `parent_child_blocks_cycle:${cycle.parentId}:${cycle.childId}`;
}

/**
 * Human-readable park notice naming the cycle members and the edges that
 * form the loop, plus the manual unblock path. Take no further automatic
 * action after posting this.
 */
export function buildParentChildBlocksCycleNotice(
  cycle: ParentChildBlocksCycle,
  issues: ParentChildCycleIssue[],
): string {
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  const parentLabel = issueLabel(issuesById, cycle.parentId);
  const childLabel = issueLabel(issuesById, cycle.childId);
  const pathLabels = cycle.explicitPath.map((id) => issueLabel(issuesById, id));
  const explicitEdges = pathLabels
    .slice(1)
    .map((label, index) => `${pathLabels[index]} --blocks--> ${label}`)
    .join(", ");
  return (
    `Paperclip parked automatic recovery here: ${parentLabel} and its child ${childLabel} ` +
    `form a parent/child + blocks cycle, so dependency recovery cannot proceed on its own.\n\n` +
    `Cycle: ${explicitEdges} (explicit blocks edges), while ${parentLabel} implicitly waits ` +
    `on its open child ${childLabel} to finish. Adding ${childLabel} as a blocker of ` +
    `${parentLabel} would close the loop ${[...pathLabels, pathLabels[0]].join(" -> ")}.\n\n` +
    `No further automatic action will be taken on this cycle. To unblock manually: remove the ` +
    `blocks edge that points into the child, or complete/reparent the child, then move the ` +
    `parent back to todo.\n\n` +
    `(${parentChildBlocksCycleMarker(cycle)})`
  );
}
