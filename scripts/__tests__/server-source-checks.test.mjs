import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { selectServerTests } from "../run-server-unit-tests.mjs";
import { serverChangedProject } from "../typecheck-server-changed.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const selected =
  "server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts";

test("requires exact existing server tests and deduplicates selection", () => {
  assert.deepEqual(selectServerTests([selected, selected]), [
    selected.slice(7),
  ]);
  for (const files of [
    [],
    ["server/src"],
    ["server/src/**/*.test.ts"],
    ["--passWithNoTests"],
    [selected, "server/src/missing.test.ts"],
    ["server/src/../outside.test.ts"],
    ["server/src/a.test.ts", "--watch"],
  ]) {
    assert.throws(() => selectServerTests(files));
  }
});

test("rejects symlinks and directories even with test-looking names", (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "server-test-selection-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(path.join(fixture, "server/src"), { recursive: true });
  writeFileSync(path.join(fixture, "outside.test.ts"), "");
  symlinkSync(
    "../../outside.test.ts",
    path.join(fixture, "server/src/link.test.ts"),
  );
  mkdirSync(path.join(fixture, "server/src/directory.test.ts"));
  assert.throws(
    () => selectServerTests(["server/src/link.test.ts"], fixture),
    /regular file/,
  );
  assert.throws(
    () => selectServerTests(["server/src/directory.test.ts"], fixture),
    /regular file/,
  );
});

test("CLI refuses absent or invalid selection before starting Vitest", () => {
  for (const files of [
    [],
    [selected, "server/src/not-present.test.ts"],
    ["--passWithNoTests"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/run-server-unit-tests.mjs", ...files],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[test:server:unit\]/);
    assert.doesNotMatch(result.stdout, /RUN|Test Files/);
  }
});

test("normal server tests resolve both runner entry points from source", async () => {
  const { default: config } = await import("../../server/vitest.config.ts");
  const sourceConfig = JSON.parse(
    readFileSync(
      new URL("../../server/tsconfig.source.json", import.meta.url),
      "utf8",
    ),
  );
  for (const name of [
    "@paperclipai/paperclip-runner",
    "@paperclipai/paperclip-runner/live",
  ]) {
    const alias = config.resolve.alias.find(({ find }) => find.test(name));
    assert.equal(
      alias?.replacement,
      path.resolve(root, "server", sourceConfig.compilerOptions.paths[name][0]),
      `${name} must also load in the normal server suite`,
    );
  }
});

test("source project checks all server tests without changing the build config", () => {
  const result = spawnSync(
    path.join(root, "node_modules/.bin/tsc"),
    ["-p", "server/tsconfig.source.json", "--showConfig"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.strict, true);
  const sourceConfig = JSON.parse(
    readFileSync(
      new URL("../../server/tsconfig.source.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(sourceConfig.exclude, []);
  assert.ok(
    config.files.includes(
      "./src/__tests__/issue-agent-mutation-ownership-routes.test.ts",
    ),
  );
  assert.ok(config.files.includes("./src/services/heartbeat.ts"));
  const buildConfig = JSON.parse(
    readFileSync(
      new URL("../../server/tsconfig.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(buildConfig.compilerOptions.rootDir, "src");
  assert.deepEqual(buildConfig.exclude, ["src/__tests__"]);
  for (const [name, [source]] of Object.entries(config.compilerOptions.paths)) {
    assert.ok(
      statSource(source),
      `${name} must resolve to a real source entry, not dist`,
    );
  }
});

test("changed project unions every production root with exact TypeScript tests", () => {
  const result = spawnSync(
    path.join(root, "node_modules/.bin/tsc"),
    ["-p", "server/tsconfig.json", "--showConfig"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const production = JSON.parse(result.stdout).files.map((file) =>
    path.resolve(root, "server", file),
  );
  const project = serverChangedProject([selected]);
  assert.deepEqual(project.files, [
    ...new Set([...production, path.join(root, selected)]),
  ]);
  assert.deepEqual(project.include, []);
  assert.deepEqual(project.exclude, []);
  assert.throws(() => serverChangedProject([]));
});

test("typecheck CLI rejects invalid selection before invoking the compiler", () => {
  for (const files of [[], ["--watch"], ["server/src/missing.test.ts"]]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/typecheck-server-changed.mjs", ...files],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[typecheck:server:changed\]/);
    assert.doesNotMatch(result.stdout, /Effective project roots/);
  }
});

test("selected test, production root and transitive import errors all fail the project", (t) => {
  const fixture = mkdtempSync(
    path.join(os.tmpdir(), "server-typecheck-fixture-"),
  );
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, "server/src");
  mkdirSync(path.join(source, "__tests__"), { recursive: true });
  writeFileSync(
    path.join(fixture, "server/tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: true,
      },
      include: ["src"],
      exclude: ["src/__tests__"],
    }),
  );
  writeFileSync(
    path.join(fixture, "server/tsconfig.source.json"),
    JSON.stringify({
      extends: "./tsconfig.json",
      exclude: [],
    }),
  );
  const testFile = "server/src/__tests__/selected.test.ts";
  const files = {
    production: path.join(source, "main.ts"),
    selected: path.join(fixture, testFile),
    imported: path.join(source, "__tests__/dependency.test.ts"),
  };
  const valid = {
    production: 'export const production: string = "ok";',
    selected:
      'import { value } from "./dependency.test"; export const selected: string = value;',
    imported: 'export const value: string = "ok";',
  };
  for (const [name, file] of Object.entries(files))
    writeFileSync(file, valid[name]);
  writeFileSync(
    path.join(source, "__tests__/unselected.test.ts"),
    "const bad: string = 1;",
  );
  const project = serverChangedProject([testFile], fixture);
  const config = path.join(fixture, "tsconfig.changed.json");
  writeFileSync(config, JSON.stringify(project));
  const check = () =>
    spawnSync(path.join(root, "node_modules/.bin/tsc"), ["-p", config], {
      encoding: "utf8",
    });
  assert.equal(check().status, 0);
  for (const [name, file] of Object.entries(files)) {
    writeFileSync(file, `${valid[name]}\nconst broken: string = 1;`);
    const result = check();
    assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /TS2322/);
    writeFileSync(file, valid[name]);
  }
  // The ownership-route regression used Boolean(details), which does not narrow null.
  writeFileSync(
    files.selected,
    `
    export function hasFingerprint(details: Record<string, unknown> | null) {
      return Boolean(details) && typeof details === "object" && "unblockDescriptorFingerprint" in details;
    }
  `,
  );
  const nullable = check();
  assert.equal(nullable.status, 1, nullable.stdout + nullable.stderr);
  assert.match(nullable.stdout, /TS18047/);
  writeFileSync(files.selected, valid.selected);
  rmSync(files.imported);
  const missingSource = check();
  assert.equal(
    missingSource.status,
    1,
    missingSource.stdout + missingSource.stderr,
  );
  assert.match(missingSource.stdout, /TS2307/);
  mkdirSync(path.join(fixture, "server/scripts"));
  writeFileSync(path.join(fixture, "server/scripts/runtime.test.mjs"), "");
  assert.deepEqual(
    selectServerTests(["server/scripts/runtime.test.mjs"], fixture),
    ["scripts/runtime.test.mjs"],
  );
  assert.throws(
    () => serverChangedProject(["server/scripts/runtime.test.mjs"], fixture),
    /requires TypeScript/,
  );
});

function statSource(source) {
  return (
    !source.includes("/dist/") &&
    readFileSync(path.resolve(root, "server", source), "utf8").length > 0
  );
}
