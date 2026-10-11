#!/usr/bin/env node
/**
 * biome-changed.mjs
 *
 * HARD gate: Biome must pass on every changed Biome-handled file.
 * The full-repo scan stays WARN (report only) until existing code is clean.
 *
 * Usage: node scripts/quality-gates/biome-changed.mjs [--base <sha>] [--head <sha>]
 * Env: BASE_SHA / HEAD_SHA (set by CI from the pull request), else merge-base.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { getChangedFiles, isBiomeFile, resolveRange } from "./changed.mjs";

const { base, head } = resolveRange();
const changed = getChangedFiles(base, head).filter(isBiomeFile);

if (changed.length === 0) {
  console.log(
    `biome-changed: no Biome-handled files changed (${base}...${head}).`,
  );
  process.exit(0);
}

console.log(`biome-changed: checking ${changed.length} file(s):`);
for (const file of changed) {
  console.log(`  ${file}`);
}

const result = spawnSync("pnpm", ["exec", "biome", "check", ...changed], {
  stdio: "inherit",
});

if (result.error) {
  console.error(`biome-changed: failed to run Biome: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    "biome-changed: HARD FAIL. Run `pnpm exec biome check --write <file>` locally, then commit.",
  );
  process.exit(result.status ?? 1);
}

console.log("biome-changed: PASS. All changed files satisfy Biome.");
