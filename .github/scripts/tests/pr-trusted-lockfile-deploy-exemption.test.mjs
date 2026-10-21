import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const WORKFLOW = ".github/workflows/pr-trusted.yml";
const BASE_STEP = "Resolve current PR base";
const LOCKFILE_STEP = "Block manual lockfile edits";

// Slice a step's lines out of the workflow text: from its `- name:` line up
// to (but excluding) the next step's `- name:` line. Steps sit at the same
// indent, so a sibling step is the next `- name:` at equal-or-lower indent.
function stepBlock(lines, stepName) {
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s*-\\s*name:\\s*${stepName}\\s*$`).test(line),
  );
  assert.ok(
    start !== -1,
    `${WORKFLOW} must contain a "${stepName}" step for this test to guard`,
  );
  const startIndent = lines[start].match(/^\s*/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)-\s*name:/);
    if (match && match[1].length <= startIndent) {
      end = i;
      break;
    }
  }
  return { start, lines: lines.slice(start, end) };
}

// Collect the folded `if:` condition lines of a step block into one string.
function stepCondition(blockLines) {
  const ifIndex = blockLines.findIndex((line) => /^\s*if:\s*(>-|[|>])?\s*$/.test(line) || /^\s*if:\s*\S/.test(line));
  assert.ok(ifIndex !== -1, `"${LOCKFILE_STEP}" must declare an if: condition`);
  const ifIndent = blockLines[ifIndex].match(/^\s*/)[0].length;
  const inline = blockLines[ifIndex].match(/^\s*if:\s*(?![|>]-?\s*$)(\S.*)$/);
  const parts = inline ? [inline[1]] : [];
  for (let i = ifIndex + 1; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (line.trim() === "") continue;
    if (line.match(/^\s*/)[0].length <= ifIndent) break;
    parts.push(line.trim());
  }
  return parts.join(" ");
}

test("lockfile blocker exempts deploy bases via the resolved live base", async () => {
  const contents = await readFile(WORKFLOW, "utf8");
  const lines = contents.split("\n");

  const base = stepBlock(lines, BASE_STEP);
  const lockfile = stepBlock(lines, LOCKFILE_STEP);

  // The exemption reads steps.base.outputs.ref, so the base step must run
  // first and must publish the resolved ref.
  assert.ok(
    base.start < lockfile.start,
    `"${BASE_STEP}" (line ${base.start + 1}) must run before "${LOCKFILE_STEP}" (line ${lockfile.start + 1})`,
  );
  assert.match(
    base.lines.join("\n"),
    /echo\s+"ref=\$base_ref"\s*>>\s*"\$GITHUB_OUTPUT"/,
    `"${BASE_STEP}" must publish the resolved base ref as a ref output`,
  );

  const condition = stepCondition(lockfile.lines);
  assert.match(
    condition,
    /startsWith\(\s*steps\.base\.outputs\.ref\s*,\s*'deploy\/'\s*\)/,
    `"${LOCKFILE_STEP}" condition must exempt deploy/ bases via steps.base.outputs.ref, got: ${condition}`,
  );
  assert.doesNotMatch(
    condition,
    /github\.base_ref/,
    `"${LOCKFILE_STEP}" condition must not read github.base_ref (the stale event snapshot), got: ${condition}`,
  );
  assert.match(
    condition,
    /chore\/refresh-lockfile/,
    `"${LOCKFILE_STEP}" condition must retain the chore/refresh-lockfile exemption, got: ${condition}`,
  );
  assert.match(
    condition,
    /dependabot\[bot\]/,
    `"${LOCKFILE_STEP}" condition must retain the dependabot exemption, got: ${condition}`,
  );
});
