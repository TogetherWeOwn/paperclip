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

function statSource(source) {
  return (
    !source.includes("/dist/") &&
    readFileSync(path.resolve(root, "server", source), "utf8").length > 0
  );
}
