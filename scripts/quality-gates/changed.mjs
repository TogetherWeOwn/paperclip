#!/usr/bin/env node
/**
 * changed.mjs
 *
 * Shared helpers for the phase-1 quality gates. Reads the PR file list from
 * git and classifies files for Biome and coverage. No third-party imports so
 * the gates run on a plain Node 24 runner.
 */

import { execFileSync } from "node:child_process";

const BIOME_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".css",
]);

const TEST_PATTERNS = [".test.", ".spec.", "__tests__", "/tests/"];

export function isBiomeFile(filePath) {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) {
    return false;
  }
  return BIOME_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

export function isTestFile(filePath) {
  return TEST_PATTERNS.some((pattern) => filePath.includes(pattern));
}

export function isSourceFile(filePath) {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) {
    return false;
  }
  const ext = filePath.slice(dot).toLowerCase();
  return (
    (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") &&
    !isTestFile(filePath)
  );
}

function readArg(args, name) {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  const prefixed = args.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

/**
 * Resolve the base/head SHAs for the diff. Explicit args win, then the
 * BASE_SHA/HEAD_SHA env vars set by CI, then the local merge-base fallback.
 */
export function resolveRange(args = process.argv.slice(2), env = process.env) {
  let base =
    readArg(args, "base") || env.BASE_SHA || env.GITHUB_BASE_SHA || undefined;
  const head =
    readArg(args, "head") || env.HEAD_SHA || env.GITHUB_HEAD_SHA || "HEAD";

  if (!base) {
    try {
      base = execFileSync("git", ["merge-base", "HEAD", "origin/master"], {
        encoding: "utf8",
      }).trim();
    } catch {
      base = "HEAD~1";
    }
  }
  return { base, head };
}

export function getChangedFiles(base, head) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`],
    { encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
