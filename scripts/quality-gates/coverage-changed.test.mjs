import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function runGit(cwd, ...args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=ci-test",
      "-c",
      "user.email=ci-test@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(changedFile, buildStatus = 0) {
  const root = mkdtempSync(path.join(tmpdir(), "paperclip-coverage-changed-"));
  mkdirSync(path.join(root, "scripts/quality-gates"), { recursive: true });
  mkdirSync(path.join(root, "bin"));
  for (const file of ["coverage-changed.mjs", "changed.mjs"]) {
    copyFileSync(
      new URL(file, import.meta.url),
      path.join(root, "scripts/quality-gates", file),
    );
  }
  const events = path.join(root, "events");
  writeFileSync(events, "");
  writeFileSync(
    path.join(root, "scripts/ensure-plugin-build-deps.mjs"),
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(events)}, "build\\n");
process.exit(${buildStatus});
`,
  );
  writeFileSync(
    path.join(root, "bin/pnpm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(events)}, "vitest\\n");
console.log("fixture coverage ran");
`,
    { mode: 0o755 },
  );
  runGit(root, "init", "-q", "-b", "main");
  runGit(root, "add", ".");
  runGit(root, "commit", "-q", "-m", "fixture");
  const base = runGit(root, "rev-parse", "HEAD");
  mkdirSync(path.dirname(path.join(root, changedFile)), { recursive: true });
  writeFileSync(path.join(root, changedFile), "export {};\n");
  runGit(root, "add", changedFile);
  runGit(root, "commit", "-q", "-m", "changed file");
  return {
    root,
    run() {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/quality-gates/coverage-changed.mjs",
          "--base",
          base,
          "--head",
          "HEAD",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
            GITHUB_STEP_SUMMARY: path.join(root, "summary"),
          },
        },
      );
      return { ...result, events: readFileSync(events, "utf8") };
    },
  };
}

test("coverage runner prepares SDK outputs before Vitest without a workflow build step", () => {
  const setup = fixture("server/src/__tests__/example.test.ts");
  try {
    const result = setup.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events, "build\nvitest\n");
    assert.match(result.stdout, /vitest exit code: 0/);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("coverage runner reports failed SDK preparation without attempting Vitest", () => {
  const setup = fixture("server/src/__tests__/example.test.ts", 7);
  try {
    const result = setup.run();
    assert.equal(result.status, 0, "coverage remains a WARN-only gate");
    assert.equal(result.events, "build\n");
    assert.match(result.stdout, /WARN: SDK preparation failed.*7/);
    assert.doesNotMatch(result.stdout, /vitest exit code/);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("coverage runner does not build when no Vitest tests changed", () => {
  const setup = fixture("server/src/example.ts");
  try {
    const result = setup.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events, "");
    assert.match(result.stdout, /No test files changed/);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});
