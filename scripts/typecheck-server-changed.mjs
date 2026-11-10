#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectServerTests } from "./run-server-unit-tests.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const compiler = path.join(repoRoot, "node_modules/.bin/tsc");

export function serverChangedProject(files, root = repoRoot) {
  const selected = selectServerTests(files, root);
  if (selected.some((file) => !file.endsWith(".test.ts"))) {
    throw new Error("Type-check selection requires TypeScript .test.ts files");
  }
  // Ask the installed compiler to expand the normal project's inherited roots.
  // TypeScript 7 ships a CLI, not the old JavaScript compiler API.
  const result = spawnSync(
    compiler,
    ["-p", path.join(root, "server/tsconfig.json"), "--showConfig"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.error?.message ?? result.stdout + result.stderr);
  }
  const production = JSON.parse(result.stdout).files;
  if (!Array.isArray(production) || production.length === 0) {
    throw new Error("The production server project has no root files");
  }
  return {
    extends: path.join(root, "server/tsconfig.source.json"),
    files: [...new Set([...production, ...selected])].map((file) =>
      path.resolve(root, "server", file),
    ),
    include: [],
    exclude: [],
  };
}

export function typecheckServerChanged(files) {
  const project = serverChangedProject(files);
  const scratch = mkdtempSync(path.join(repoRoot, "server/.typecheck-"));
  try {
    const config = path.join(scratch, "tsconfig.json");
    writeFileSync(config, JSON.stringify(project));
    console.log("[typecheck:server:changed] Effective project roots:");
    for (const file of project.files)
      console.log(path.relative(repoRoot, file));
    const result = spawnSync(compiler, ["-p", config], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = typecheckServerChanged(process.argv.slice(2));
  } catch (error) {
    console.error(`[typecheck:server:changed] ${error.message}`);
    process.exitCode = 1;
  }
}
