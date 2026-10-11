#!/usr/bin/env node
/**
 * biome-changed.mjs
 *
 * HARD gate: Biome must pass on every newly added Biome-handled file.
 * Modified existing files are checked as WARN until the repository baseline is clean.
 *
 * Usage: node scripts/quality-gates/biome-changed.mjs [--base <sha>] [--head <sha>]
 * Env: BASE_SHA / HEAD_SHA (set by CI from the pull request), else merge-base.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  getAddedFiles,
  getChangedFiles,
  isBiomeFile,
  resolveRange,
} from "./changed.mjs";

const { base, head } = resolveRange();
const changed = getChangedFiles(base, head).filter(isBiomeFile);
const addedSet = new Set(getAddedFiles(base, head));
const added = changed.filter((file) => addedSet.has(file));
const modified = changed.filter((file) => !addedSet.has(file));

function check(files, severity) {
  if (files.length === 0) {
    return;
  }
  console.log(`biome-changed: checking ${files.length} ${severity} file(s):`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
  const result = spawnSync("pnpm", ["exec", "biome", "check", ...files], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      `biome-changed: failed to run Biome: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.status !== 0 && severity === "HARD") {
    console.error(
      "biome-changed: HARD FAIL. Run `pnpm exec biome check --write <file>` locally, then commit.",
    );
    process.exit(result.status ?? 1);
  }
  if (result.status !== 0) {
    console.warn(
      "biome-changed: WARN. Existing-file findings are non-blocking until the baseline is clean.",
    );
  }
}

check(modified, "WARN");
check(added, "HARD");
if (changed.length === 0) {
  console.log(
    `biome-changed: no Biome-handled files changed (${base}...${head}).`,
  );
} else {
  console.log("biome-changed: PASS. New files satisfy Biome.");
}
