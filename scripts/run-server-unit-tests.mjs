#!/usr/bin/env node
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export function selectServerTests(files, root = repoRoot) {
  if (files.length === 0) {
    throw new Error(
      "Select explicit server test files, for example server/src/__tests__/issue-execution-policy.test.ts",
    );
  }
  return [
    ...new Set(
      files.map((file) => {
        if (
          !/^server\/(src\/.+\.test\.ts|scripts\/.+\.test\.mjs)$/.test(file) ||
          /[\\*?{}[\]()!]/.test(file) ||
          file
            .split("/")
            .some((part) => part === "." || part === ".." || part === "")
        ) {
          throw new Error(`Not an explicit server test file: ${file}`);
        }
        const resolved = realpathSync(path.resolve(root, file));
        if (
          !statSync(resolved).isFile() ||
          path
            .relative(realpathSync(root), resolved)
            .split(path.sep)
            .join("/") !== file
        ) {
          throw new Error(
            `Test must be a regular file inside the server source tree: ${file}`,
          );
        }
        return file.slice("server/".length);
      }),
    ),
  ];
}

export async function runServerTests(files) {
  const include = selectServerTests(files);
  const { startVitest } = await import("vitest/node");
  const context = await startVitest("test", [], {
    root: path.join(repoRoot, "server"),
    config: path.join(repoRoot, "server/vitest.source.config.ts"),
    include,
    watch: false,
    passWithNoTests: false,
    cache: false,
  });
  await context.exit();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runServerTests(process.argv.slice(2)).catch((error) => {
    console.error(`[test:server:unit] ${error.message}`);
    process.exitCode = 1;
  });
}
