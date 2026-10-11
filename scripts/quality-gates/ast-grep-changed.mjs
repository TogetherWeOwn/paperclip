#!/usr/bin/env node
/**
 * ast-grep-changed.mjs
 *
 * WARN gate (phase 1): scan changed files with the shared meta-only
 * ast-grep rule pack instead of hand-written pattern checks.
 *
 * The rules and their fixtures are vendored byte-for-byte from the
 * ops-tooling `quality/meta-only-assets` branch (see PROVENANCE.md in
 * `scripts/quality-gates/meta-only/`); only the `tests/__snapshots__/`
 * lockfile is generated on our side so `sg test` stays a real check.
 * This gate never fails: findings are reported, not blocking, until the
 * baseline exists (phase 2).
 *
 * Usage: node scripts/quality-gates/ast-grep-changed.mjs [--base <sha>] [--head <sha>]
 * Env: BASE_SHA / HEAD_SHA (set by CI from the pull request), else merge-base.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { resolveRange } from "./changed.mjs";

/** Pinned CLI. Matches the upstream validation receipt (0.50.0). */
export const AST_GREP_PIN = "@ast-grep/cli@0.50.0";

/**
 * Select how to invoke ast-grep. Prefers a real `ast-grep` binary on PATH
 * (never bare `sg`: on Linux that is the shadow-utils group-switcher),
 * otherwise falls back to the pinned npx package (needs network).
 * `overrides.onPath` injects the detection result for tests.
 */
export function resolveAstGrep(overrides = {}) {
  const onPath =
    overrides.onPath ??
    (() => {
      try {
        const probe = spawnSync("ast-grep", ["--version"], {
          encoding: "utf8",
          timeout: 15000,
        });
        return !probe.error && probe.status === 0;
      } catch {
        return false;
      }
    })();
  if (onPath) {
    return { command: "ast-grep", prefixArgs: [] };
  }
  return {
    command: "npx",
    prefixArgs: ["--yes", "--package", AST_GREP_PIN, "ast-grep"],
  };
}

/** Absolute path of the vendored rule pack (sgconfig.yml lives here). */
export function configDir() {
  return fileURLToPath(new URL("./meta-only/rules", import.meta.url));
}

function runAstGrep(resolved, args, options = {}) {
  try {
    const result = spawnSync(resolved.command, [...resolved.prefixArgs, ...args], {
      encoding: "utf8",
      timeout: 300000,
      ...options,
    });
    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      spawnError: result.error ? String(result.error) : null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      spawnError: String(error),
    };
  }
}

/** Run the vendored fixture suite. Proves the wired pack is healthy. */
export function runFixtureTests(resolved, dir = configDir()) {
  return runAstGrep(resolved, ["test", "-c", path.join(dir, "sgconfig.yml")], {
    cwd: dir,
  });
}

function changedFiles(base, head, repoRoot) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractFindings(scanJson) {
  let parsed;
  try {
    parsed = JSON.parse(scanJson);
  } catch {
    return null;
  }
  const matches = Array.isArray(parsed) ? parsed : (parsed.matches ?? []);
  const findings = [];
  const pushNode = (file, node) => {
    const ruleId =
      node.ruleId ?? node.rule_id ?? node.id ?? node.rule ?? "unknown";
    const range = node.range ?? {};
    const start = range.start ?? node.startPos ?? {};
    findings.push({
      ruleId: String(ruleId),
      file: String(file),
      // ast-grep reports 0-based lines; surface them 1-based for humans.
      line: typeof start.line === "number" ? start.line + 1 : null,
    });
  };
  for (const match of matches) {
    // `sg scan --json` emits one flat node per hit; older shapes group
    // nodes under a file entry. Accept both.
    if (match.nodes || match.results) {
      const file = match.file ?? match.path ?? "";
      for (const node of match.nodes ?? match.results ?? []) {
        pushNode(file, node);
      }
    } else {
      pushNode(match.file ?? match.path ?? "", match);
    }
  }
  return findings;
}

/**
 * Scan the changed files in [base...head]. Always WARN: the returned
 * `exit` is 0 even with findings or tooling failures.
 */
export function scanChanged({ base, head, repoRoot = process.cwd() } = {}) {
  const resolved = resolveAstGrep();
  const config = configDir();

  let files;
  try {
    files = changedFiles(base, head, repoRoot);
  } catch (error) {
    return {
      exit: 0,
      findings: [],
      files: [],
      fixture: { ok: false, output: "" },
      note: `WARN: could not list changed files: ${error.message}`,
    };
  }

  if (files.length === 0) {
    return {
      exit: 0,
      findings: [],
      files,
      fixture: { ok: true, output: "skipped (no changed files)" },
      note: `ast-grep-changed: no changed files (${base}...${head}).`,
    };
  }

  const fixture = runFixtureTests(resolved, config);
  const fixtureOutput = `${fixture.stdout}\n${fixture.stderr}`.trim();

  const scan = runAstGrep(
    resolved,
    ["scan", "--config", path.join(config, "sgconfig.yml"), "--json", ...files],
    {
      cwd: repoRoot,
    },
  );
  if (scan.spawnError || (!scan.ok && !scan.stdout)) {
    return {
      exit: 0,
      findings: [],
      files,
      fixture: { ok: fixture.ok, output: fixtureOutput },
      note: `WARN: ast-grep scan did not run: ${scan.spawnError ?? scan.stderr.trim().slice(-500) ?? "unknown error"}`,
    };
  }

  const findings = extractFindings(scan.stdout) ?? [];
  return {
    exit: 0,
    findings,
    files,
    fixture: { ok: fixture.ok, output: fixtureOutput },
    note:
      findings.length === 0
        ? `ast-grep-changed: PASS. ${files.length} changed file(s), no shared-rule findings.`
        : `ast-grep-changed: WARN. ${findings.length} finding(s) on ${files.length} changed file(s) (report only).`,
    rawScan: findings.length === 0 ? undefined : scan.stdout.slice(0, 4000),
  };
}

function summarize(lines) {
  const body = `${lines.join("\n")}\n`;
  process.stdout.write(body);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      appendFileSync(
        summaryFile,
        `### ast-grep shared rules (WARN)\n\n${body}\n`,
      );
    } catch {
      // Step summaries are best effort. The console log carries the report.
    }
  }
}

// When executed directly (not imported by the test), run the gate.
const invokedAsScript =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const { base, head } = resolveRange();
  const report = scanChanged({ base, head });
  const lines = [report.note ?? ""];
  if (!report.fixture.ok) {
    lines.push(
      "WARN: vendored fixture suite did not pass; the rule pack may need a resync (see PROVENANCE.md).",
      "```",
      (report.fixture.output || "(no output)").slice(-2000),
      "```",
    );
  }
  for (const finding of report.findings) {
    lines.push(
      `- ${finding.ruleId} ${finding.file}${finding.line == null ? "" : `:${finding.line}`}`,
    );
  }
  summarize(lines.filter((line) => line !== ""));
  process.exit(report.exit);
}
