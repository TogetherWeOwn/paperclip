import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  checkConstraintThresholds,
  collectDiff,
  isIgnored,
  scanAddedLines,
  scanDiff,
  scanRemovedLines,
} from "./floor-guard.mjs";

const added = (file, text) => [{ file, text }];
const removed = (file, text) => [{ file, text }];

describe("scanAddedLines: silenced checker", () => {
  it("flags ts-ignore suppressions in source", () => {
    const findings = scanAddedLines(
      added("server/src/routes/issues.ts", "// @ts-ignore: legacy shape"),
      { ignored: [] },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "silenced-checker");
  });

  it("flags eslint-disable and istanbul ignore", () => {
    const findings = scanAddedLines(
      [
        {
          file: "ui/src/pages/board.tsx",
          text: "// eslint-disable-next-line no-console",
        },
        {
          file: "server/src/services/billing.ts",
          text: "/* istanbul ignore next: hard to reach */",
        },
      ],
      { ignored: [] },
    );
    assert.equal(
      findings.filter((finding) => finding.rule === "silenced-checker").length,
      2,
    );
  });

  it("ignores pattern mentions in markdown docs", () => {
    const findings = scanAddedLines(
      added(
        "CONSTRAINTS.md",
        "- No new `@ts-ignore` or `eslint-disable` comments",
      ),
      { ignored: [] },
    );
    assert.deepEqual(findings, []);
  });

  it("exempts paths listed in the ignore file", () => {
    assert.equal(
      isIgnored("scripts/quality-gates/floor-guard.mjs", [
        "scripts/quality-gates/floor-guard.mjs",
      ]),
      true,
    );
    const findings = scanAddedLines(
      added(
        "scripts/quality-gates/floor-guard.mjs",
        "const SUPPRESSIONS = /@ts-ignore|eslint-disable/;",
      ),
      { ignored: ["scripts/quality-gates/floor-guard.mjs"] },
    );
    assert.deepEqual(findings, []);
  });
});

describe("scanAddedLines: unfinished work and easier tests", () => {
  it("flags explicit not-implemented stubs", () => {
    const findings = scanAddedLines(
      added(
        "server/src/services/export.ts",
        '  throw new Error("Not implemented: csv export");',
      ),
      { ignored: [] },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "unfinished-work");
  });

  it("flags added test skips", () => {
    const findings = scanAddedLines(
      added(
        "server/src/routes/issues.test.ts",
        "  it.skip('lists issues', () => {",
      ),
      { ignored: [] },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "test-made-easier");
  });

  it("ignores skip-shaped application properties and conditional suite guards", () => {
    const findings = scanAddedLines(
      [
        {
          file: "server/src/services/run-model-decision.ts",
          text: "input.skip",
        },
        {
          file: "server/src/routes/issues.test.ts",
          text: "const suite = supported ? describe : describe.skip;",
        },
      ],
      { ignored: [] },
    );
    assert.deepEqual(findings, []);
  });

  it("ignores explanatory TODOs and deliberate empty catches", () => {
    const findings = scanAddedLines(
      [
        {
          file: "server/src/services/export.ts",
          text: "// TODO: revisit if API changes",
        },
        {
          file: "server/src/services/export.ts",
          text: "tryCleanup().catch(() => {});",
        },
        { file: "server/src/services/export.ts", text: "} catch {}" },
      ],
      { ignored: [] },
    );
    assert.deepEqual(findings, []);
  });
});

describe("scanRemovedLines and statuses", () => {
  it("flags assertions removed from a surviving test", () => {
    const findings = scanRemovedLines(
      removed(
        "server/src/routes/issues.test.ts",
        "    expect(tasks[0].title).toBe('a');",
      ),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "assertion-removed");
  });

  it("stays silent when an assertion is reformatted or its message changes", () => {
    const file = "server/src/routes/issues.test.ts";
    const findings = scanRemovedLines(
      removed(file, "    expect(response.status).toBe(200);"),
      {
        added: added(
          file,
          "    expect(response.status).toBe(200); // expected success",
        ),
      },
    );
    assert.deepEqual(findings, []);
  });

  it("does not treat a reshuffled import as a removed assertion", () => {
    const findings = scanRemovedLines(
      removed(
        "server/src/routes/issues.test.ts",
        'import { expect, it } from "vitest";',
      ),
    );
    assert.deepEqual(findings, []);
  });

  it("stays silent when an assertion is tightened, not stripped", () => {
    const findings = scanRemovedLines(
      removed(
        ".github/scripts/tests/pr-dependency-cache.test.mjs",
        "  assert.equal(installers.length, 7);",
      ),
      {
        added: added(
          ".github/scripts/tests/pr-dependency-cache.test.mjs",
          "  assert.equal(installers.length, 8);",
        ),
      },
    );
    assert.deepEqual(findings, []);
  });

  it("stays silent when one assertion is rewritten in place", () => {
    const findings = scanRemovedLines(
      removed(
        "server/src/routes/issues.test.ts",
        "    assert.equal(covered, 80);",
      ),
      {
        added: added(
          "server/src/routes/issues.test.ts",
          "    assert.equal(covered, 60);",
        ),
      },
    );
    assert.deepEqual(findings, []);
  });

  it("pairs through scanDiff the way main() runs it", () => {
    const file = ".github/scripts/tests/pr-dependency-cache.test.mjs";
    const findings = scanDiff(
      {
        added: added(file, "  assert.equal(installers.length, 8);"),
        removed: removed(file, "  assert.equal(installers.length, 7);"),
        statuses: [],
      },
      { ignored: [] },
    );
    assert.deepEqual(findings, []);
  });

  it("flags deleted test files", () => {
    const findings = scanDiff(
      {
        added: [],
        removed: [],
        statuses: [{ status: "D", file: "server/src/routes/issues.test.ts" }],
      },
      { ignored: [] },
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "test-deleted");
  });
});

describe("checkConstraintThresholds", () => {
  const row = (pct) =>
    `| Coverage | Changed lines >= ${pct}% covered | vitest + git diff | CI |`;

  it("flags a lowered coverage number", () => {
    const findings = checkConstraintThresholds(
      removed("CONSTRAINTS.md", row(80)),
      added("CONSTRAINTS.md", row(60)),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "threshold-lowered");
  });

  it("stays silent when a threshold is tightened", () => {
    const findings = checkConstraintThresholds(
      removed("CONSTRAINTS.md", row(80)),
      added("CONSTRAINTS.md", row(90)),
    );
    assert.deepEqual(findings, []);
  });

  it("flags a new Exceptions row", () => {
    const findings = scanAddedLines(
      added(
        "CONSTRAINTS.md",
        "| W1 | `no-explicit-any` | `src/legacy/**` | rewrite tracked | @x | 2027-01-01 |",
      ),
      { ignored: [] },
    );
    assert.ok(findings.some((finding) => finding.rule === "new-exception"));
  });
});

describe("collectDiff integration", () => {
  it("sees uncommitted edits, untracked files, and deleted tests", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "floor-guard-"));
    try {
      const git = (args) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      writeFileSync(path.join(dir, "a.ts"), "export const x = 1;\n");
      writeFileSync(
        path.join(dir, "a.test.ts"),
        "import assert from 'node:assert';\nassert.equal(1, 1);\n",
      );
      git(["add", "."]);
      git(["commit", "-m", "base"]);
      // Uncommitted tracked edit with a suppression.
      writeFileSync(
        path.join(dir, "a.ts"),
        "export const x = 1;\n// @ts-ignore: probe\n",
      );
      // Untracked file with a skip.
      writeFileSync(
        path.join(dir, "b.test.ts"),
        "it.skip('probe', () => {});\n",
      );
      // Deleted test file.
      git(["rm", "-q", "a.test.ts"]);

      const diff = collectDiff("HEAD", "HEAD", dir);
      assert.ok(diff, "collectDiff must not bail on a valid repo");
      const rules = scanDiff(diff, { ignored: [] }).map(
        (finding) => finding.rule,
      );
      assert.ok(
        rules.includes("silenced-checker"),
        `uncommitted suppression must flag, got: ${rules}`,
      );
      assert.ok(
        rules.includes("test-made-easier"),
        `untracked skip must flag, got: ${rules}`,
      );
      assert.ok(
        rules.includes("test-deleted"),
        `deleted test must flag, got: ${rules}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
