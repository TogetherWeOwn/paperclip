#!/usr/bin/env node
/**
 * floor-guard.mjs
 *
 * HARD gate: fail the change when the diff lowers the quality bar instead of
 * meeting it. Adapted from the constraint-driven-development skill reference
 * (references/floor-guard.md); the diff plumbing and exit-code contract are
 * unchanged, the patterns are adapted to this repo's stack.
 *
 * Detects the five bar-lowering moves:
 *   1. silenced-checker  - new suppression comments (@ts-ignore,
 *                          eslint-disable, biome-ignore, istanbul ignore, ...)
 *   2. test-made-easier  - new skips (.skip), deleted test files
 *   3. assertion-removed - assertions stripped from a surviving test
 *   4. unfinished-work   - not-implemented stubs, empty catch blocks
 *   5. threshold-lowered / new-exception - CONSTRAINTS.md weakened or a new
 *                          Exceptions row added without discussion
 *
 * Contract: exit 0 clean, exit 1 at least one violation, exit 2 the guard
 * could not run (not a git repo, no base). A 2 never reads as a 0.
 * Reports the rule and the location, never a matched secret value.
 *
 * Code-pattern rules (1-4) skip Markdown prose: naming a forbidden pattern
 * in docs is inert, so only code files are scanned. CONSTRAINTS.md checks
 * (5) always apply and are never exempted by the ignore file.
 *
 * Usage: node scripts/quality-gates/floor-guard.mjs [--base <sha>] [--head <sha>]
 * Env: BASE_SHA / HEAD_SHA (set by CI from the pull request), else merge-base.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveRange } from "./changed.mjs";

export const IGNORE_FILE = ".constraintsignore";
const CONSTRAINTS_FILE = "CONSTRAINTS.md";

// Suppression forms for this stack (JS/TS + Biome + shared security tools).
const SUPPRESSIONS =
  /@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|# *noqa|# *type: *ignore|istanbul ignore|nosemgrep|gitleaks:allow|Stryker disable/;
// Unfinished-work markers.
const STUBS =
  /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*\(\w*\)\s*\{\s*\}|catch\s*\{\s*\}|\bTODO\b|\bpass\s*# *stub/;
// Test-made-easier markers (added skips).
const SKIPS = /\.(skip|todo)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|t\.Skip\(/;
// Assertion calls stripped from surviving tests.
const ASSERTIONS = /\b(expect|assert|should)\b/;
// Test file paths.
const TEST_PATH = /\.(test|spec)\.|_test\.|test_/;
// New Exceptions table rows in CONSTRAINTS.md.
const EXCEPTION_ROW = /^\| *(W|E)\d+ *\|/;

function isMarkdown(file) {
  return file.toLowerCase().endsWith(".md");
}

function isConstraintsFile(file) {
  return file === CONSTRAINTS_FILE || file.endsWith(`/${CONSTRAINTS_FILE}`);
}

function globToRegExp(glob) {
  const escaped = glob
    .split("**")
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]"),
    )
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/** True when the ignore file exempts this path from code-pattern rules. */
export function isIgnored(file, globs) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

/** Read ignore globs (one per line, `#` comments and blanks skipped). */
export function loadIgnoreGlobs(rootDir) {
  const ignorePath = path.join(rootDir, IGNORE_FILE);
  if (!existsSync(ignorePath)) {
    return [];
  }
  return readFileSync(ignorePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function flag(findings, rule, file, text) {
  findings.push({ rule, file, text: text.trim().slice(0, 120) });
}

/** Scan added lines for suppressions, stubs, skips, and new exceptions. */
export function scanAddedLines(lines, { ignored = [] } = {}) {
  const findings = [];
  for (const { file, text } of lines) {
    if (isConstraintsFile(file)) {
      if (EXCEPTION_ROW.test(text)) {
        flag(findings, "new-exception", file, text);
      }
      continue;
    }
    if (isMarkdown(file) || isIgnored(file, ignored)) {
      continue;
    }
    if (SUPPRESSIONS.test(text)) {
      flag(findings, "silenced-checker", file, text);
    }
    if (STUBS.test(text)) {
      flag(findings, "unfinished-work", file, text);
    }
    if (SKIPS.test(text)) {
      flag(findings, "test-made-easier", file, text);
    }
  }
  return findings;
}

/** Scan removed lines for assertions stripped from surviving tests. */
export function scanRemovedLines(lines) {
  const findings = [];
  for (const { file, text } of lines) {
    if (TEST_PATH.test(file) && ASSERTIONS.test(text)) {
      flag(findings, "assertion-removed", file, text);
    }
  }
  return findings;
}

/** Flag deleted test files from name-status entries. */
export function scanStatuses(statuses, { ignored = [] } = {}) {
  const findings = [];
  for (const { status, file } of statuses) {
    if (status !== "D" || isMarkdown(file) || isIgnored(file, ignored)) {
      continue;
    }
    if (TEST_PATH.test(file)) {
      flag(findings, "test-deleted", file, "(test file deleted)");
    }
  }
  return findings;
}

const numbersIn = (text) => (text.match(/\d+(\.\d+)?/g) || []).map(Number);

/**
 * Flag CONSTRAINTS.md numbers that went down. Tightening (numbers up, or
 * lines only added) stays silent; loosening is loud.
 */
export function checkConstraintThresholds(removed, added) {
  const findings = [];
  const removedRows = removed.filter((line) => isConstraintsFile(line.file));
  const addedRows = added.filter((line) => isConstraintsFile(line.file));
  for (const row of removedRows) {
    const key = row.text.split(/[|:]/)[0];
    const peer = addedRows.find(
      (candidate) => candidate.text.split(/[|:]/)[0] === key,
    );
    if (!peer) {
      continue;
    }
    const before = numbersIn(row.text);
    const after = numbersIn(peer.text);
    const lowered = after.some(
      (value, index) => before[index] !== undefined && value < before[index],
    );
    if (lowered) {
      flag(
        findings,
        "threshold-lowered",
        row.file,
        `${row.text}  ->  ${peer.text}`,
      );
    }
  }
  return findings;
}

/** Combine every check over one diff snapshot. */
export function scanDiff(diff, { ignored = [] } = {}) {
  return [
    ...scanAddedLines(diff.added, { ignored }),
    ...scanRemovedLines(diff.removed),
    ...scanStatuses(diff.statuses ?? [], { ignored }),
    ...checkConstraintThresholds(diff.removed, diff.added),
  ];
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch {
    return null;
  }
}

/**
 * Like git(), but keeps stdout when the command exits 1 with diff output.
 * `git diff --no-index` exits 1 whenever the files differ (unlike in-repo
 * diff, which exits 0), so treating exit 1 as failure silently drops every
 * untracked file. Only exit 1 with stdout counts as a diff; anything else is
 * a real failure.
 */
function gitDiff(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch (error) {
    if (error?.status === 1 && typeof error?.stdout === "string") {
      return error.stdout;
    }
    return null;
  }
}

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Collect added/removed lines plus deletion statuses for the committed range
 * base...head AND the working tree (staged, unstaged, and untracked files).
 * A guard that reads only the committed range misses local work in progress.
 */
export function collectDiff(base, head, root) {
  const committed = gitDiff(
    ["diff", "--unified=0", `${base}...${head}`, "--"],
    root,
  );
  const committedDeleted = gitDiff(
    ["diff", "--name-status", "--diff-filter=D", `${base}...${head}`, "--"],
    root,
  );
  const worktree = gitDiff(["diff", "--unified=0", "HEAD", "--"], root);
  const worktreeDeleted = gitDiff(
    ["diff", "--name-status", "--diff-filter=D", "HEAD", "--"],
    root,
  );
  const untrackedList = git(
    ["ls-files", "--others", "--exclude-standard"],
    root,
  );
  if (
    committed === null ||
    committedDeleted === null ||
    worktree === null ||
    worktreeDeleted === null ||
    untrackedList === null
  ) {
    return null;
  }
  let untracked = "";
  for (const file of untrackedList
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    untracked +=
      gitDiff(["diff", "--no-index", "--unified=0", "/dev/null", file], root) ??
      "";
  }
  const diff = `${committed}\n${worktree}\n${untracked}`;
  const deleted = `${committedDeleted}\n${worktreeDeleted}`;
  const added = [];
  const removed = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(6).replace(/^b\//, "");
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ file, text: line.slice(1) });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed.push({ file, text: line.slice(1) });
    }
  }
  const statuses = deleted
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      return { status, file: rest.join(" ") };
    });
  return { added, removed, statuses };
}

function main() {
  const root = repoRoot();
  if (!root) {
    console.error("floor-guard: not a git repository.");
    process.exit(2);
  }
  const { base, head } = resolveRange();
  const diff = collectDiff(base, head, root);
  if (!diff) {
    console.error(`floor-guard: no diff for ${base}...${head}.`);
    process.exit(2);
  }
  const ignored = loadIgnoreGlobs(root);
  const findings = scanDiff(diff, { ignored });
  if (findings.length === 0) {
    console.log(`floor-guard: clean (${base}...${head}).`);
    process.exit(0);
  }
  console.error(`floor-guard: ${findings.length} floor violation(s):`);
  for (const finding of findings) {
    console.error(`  [${finding.rule}] ${finding.file}: ${finding.text}`);
  }
  console.error(
    "\nEach is a move that lowers the bar. Fix the code, or route it through a tracked CONSTRAINTS.md exception.",
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("floor-guard.mjs")) {
  main();
}
