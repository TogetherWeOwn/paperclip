#!/usr/bin/env node

/**
 * coverage-changed.mjs
 *
 * WARN gate (phase 1): report coverage for changed Vitest test files.
 * This gate never fails. It runs Vitest only for test files in configured
 * Vitest projects; other runners (such as node:test under scripts/) are skipped.
 *
 * Usage: node scripts/quality-gates/coverage-changed.mjs [--base <sha>] [--head <sha>]
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  getChangedFiles,
  isSourceFile,
  isVitestTestFile,
  resolveRange,
} from "./changed.mjs";

function summarize(lines) {
  const body = `${lines.join("\n")}\n`;
  process.stdout.write(`${body}`);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      appendFileSync(
        summaryFile,
        `### Changed-test coverage report (WARN)\n\n${body}\n`,
      );
    } catch {
      // Step summaries are best effort. The console log carries the report.
    }
  }
}

function siblingTestExists(sourceFile) {
  const dir = path.posix.dirname(sourceFile);
  const base = path.posix
    .basename(sourceFile)
    .replace(/\.(ts|tsx|js|jsx)$/, "");
  const candidates = [
    `${dir}/${base}.test.ts`,
    `${dir}/${base}.test.tsx`,
    `${dir}/${base}.spec.ts`,
    `${dir}/__tests__/${base}.test.ts`,
  ];
  return candidates.some((candidate) => existsSync(candidate));
}

const { base, head } = resolveRange();
const changed = getChangedFiles(base, head);
const testFiles = changed.filter(isVitestTestFile);
const sourceFiles = changed.filter(isSourceFile);

if (testFiles.length > 0) {
  summarize([
    `Changed test files: ${testFiles.length}. Running vitest with coverage (WARN only).`,
    ...testFiles.map((file) => `- ${file}`),
  ]);
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--coverage.enabled",
      "--coverage.provider=v8",
      "--coverage.reporter=text",
      "--passWithNoTests",
      ...testFiles,
    ],
    { encoding: "utf8", timeout: 600000 },
  );
  if (result.error) {
    summarize([`WARN: coverage run did not start: ${result.error.message}`]);
    process.exit(0);
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const tail = output.trim().split("\n").slice(-40).join("\n");
  summarize([
    `vitest exit code: ${result.status} (WARN gate ignores it).`,
    "Coverage tail:",
    "```",
    tail || "(no output)",
    "```",
  ]);
  process.exit(0);
}

if (sourceFiles.length > 0) {
  const missing = sourceFiles.filter((file) => !siblingTestExists(file));
  summarize([
    `Changed source files: ${sourceFiles.length}. No test files changed in this range.`,
    missing.length === 0
      ? "Every changed source file has a colocated test. Good."
      : `WARN: ${missing.length} changed source file(s) have no colocated test:`,
    ...missing.map((file) => `- ${file}`),
    "Changed-line coverage is not measured by this report; add tests for changed source now.",
  ]);
  process.exit(0);
}

summarize(["No JS/TS source or test changes in this range. Nothing to cover."]);
process.exit(0);
