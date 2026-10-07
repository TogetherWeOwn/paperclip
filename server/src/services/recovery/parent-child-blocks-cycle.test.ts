import { describe, expect, it } from "vitest";

import {
  buildParentChildBlocksCycleNotice,
  findAllParentChildBlocksCycles,
  findExplicitBlocksPath,
  findExplicitBlocksPathToAny,
  findParentChildBlocksCycle,
  parentChildBlocksCycleMarker,
} from "./parent-child-blocks-cycle.js";

// Reference shape from the 10-05/10-06 startup crash-loops: parent P with
// child C, first-class edge P blocks C, while P implicitly waits on C via
// parent/child completion. Recovery must park, never materialize C -> P.
const parent = { id: "p-id", identifier: "P", parentId: null };
const child = { id: "c-id", identifier: "C", parentId: "p-id" };

describe("parent/child + blocks cycle detection", () => {
  it("detects the direct parent-blocks-child reference case", () => {
    const cycle = findParentChildBlocksCycle(
      [{ blockerIssueId: "p-id", blockedIssueId: "c-id" }],
      "p-id",
      "c-id",
    );

    expect(cycle).toEqual({
      parentId: "p-id",
      childId: "c-id",
      explicitPath: ["p-id", "c-id"],
    });
  });

  it("detects a transitive parent-blocks-child path", () => {
    const relations = [
      { blockerIssueId: "p-id", blockedIssueId: "x-id" },
      { blockerIssueId: "x-id", blockedIssueId: "c-id" },
    ];

    expect(findParentChildBlocksCycle(relations, "p-id", "c-id")).toEqual({
      parentId: "p-id",
      childId: "c-id",
      explicitPath: ["p-id", "x-id", "c-id"],
    });
    expect(findExplicitBlocksPath(relations, "p-id", "c-id")).toEqual([
      "p-id",
      "x-id",
      "c-id",
    ]);
    expect(
      findExplicitBlocksPathToAny(relations, "p-id", ["missing-id", "c-id"]),
    ).toEqual({ targetId: "c-id", path: ["p-id", "x-id", "c-id"] });
  });

  it("finds cycles beyond the former bounded search depth", () => {
    const pathLength = 600;
    const relations = Array.from({ length: pathLength }, (_, index) => ({
      blockerIssueId: `issue-${index}`,
      blockedIssueId: `issue-${index + 1}`,
    }));

    const path = findExplicitBlocksPath(
      relations,
      "issue-0",
      `issue-${pathLength}`,
    );

    expect(path).toHaveLength(pathLength + 1);
    expect(path?.[0]).toBe("issue-0");
    expect(path?.at(-1)).toBe(`issue-${pathLength}`);
  });

  it("reports no cycle when the child is not blocked by the parent", () => {
    expect(
      findParentChildBlocksCycle(
        [{ blockerIssueId: "x-id", blockedIssueId: "c-id" }],
        "p-id",
        "c-id",
      ),
    ).toBeNull();
  });

  it("reports no cycle for a plain blocks edge with no parent/child link", () => {
    const cycles = findAllParentChildBlocksCycles(
      [
        { id: "p-id", identifier: "P", parentId: null },
        { id: "c-id", identifier: "C", parentId: null },
      ],
      [{ blockerIssueId: "p-id", blockedIssueId: "c-id" }],
    );

    expect(cycles).toEqual([]);
  });

  it("reports no cycle when the parent has no blocks path to the child", () => {
    const cycles = findAllParentChildBlocksCycles(
      [parent, child],
      [{ blockerIssueId: "c-id", blockedIssueId: "x-id" }],
    );

    expect(cycles).toEqual([]);
  });

  it("finds every cyclic parent/child pair in the graph", () => {
    const cycles = findAllParentChildBlocksCycles(
      [
        parent,
        child,
        { id: "x-id", identifier: "X", parentId: "p-id" },
        { id: "u-id", identifier: "U", parentId: null },
      ],
      [
        { blockerIssueId: "p-id", blockedIssueId: "c-id" },
        { blockerIssueId: "p-id", blockedIssueId: "x-id" },
        { blockerIssueId: "u-id", blockedIssueId: "p-id" },
      ],
    );

    expect(cycles).toEqual([
      { parentId: "p-id", childId: "c-id", explicitPath: ["p-id", "c-id"] },
      { parentId: "p-id", childId: "x-id", explicitPath: ["p-id", "x-id"] },
    ]);
  });

  it("ignores self-parent links", () => {
    expect(
      findAllParentChildBlocksCycles(
        [{ id: "p-id", identifier: "P", parentId: "p-id" }],
        [{ blockerIssueId: "p-id", blockedIssueId: "p-id" }],
      ),
    ).toEqual([]);
  });

  it("parks with a notice naming the cards and the edges", () => {
    const cycle = findParentChildBlocksCycle(
      [{ blockerIssueId: "p-id", blockedIssueId: "c-id" }],
      "p-id",
      "c-id",
    )!;
    const notice = buildParentChildBlocksCycleNotice(cycle, [parent, child]);

    expect(notice).toContain("P");
    expect(notice).toContain("C");
    expect(notice).toContain("P --blocks--> C");
    expect(notice).toContain("P -> C -> P");
    expect(notice).toContain("No further automatic action");
    expect(notice).toContain(parentChildBlocksCycleMarker(cycle));
  });
});
