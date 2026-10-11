import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBiomeFile,
  isSourceFile,
  isTestFile,
  resolveRange,
} from "./changed.mjs";

describe("isBiomeFile", () => {
  it("accepts JS/TS/JSON/CSS sources", () => {
    assert.equal(isBiomeFile("server/src/routes/issues.ts"), true);
    assert.equal(isBiomeFile("ui/src/pages/board.tsx"), true);
    assert.equal(isBiomeFile("scripts/check.mjs"), true);
    assert.equal(isBiomeFile("biome.json"), true);
    assert.equal(isBiomeFile("ui/src/index.css"), true);
  });

  it("rejects workflows, docs, and extensionless files", () => {
    assert.equal(isBiomeFile(".github/workflows/pr.yml"), false);
    assert.equal(isBiomeFile("doc/DEVELOPING.md"), false);
    assert.equal(isBiomeFile("Dockerfile"), false);
  });
});

describe("isTestFile / isSourceFile", () => {
  it("flags test paths", () => {
    assert.equal(isTestFile("server/src/routes/issues.test.ts"), true);
    assert.equal(isTestFile("server/src/__tests__/x.test.ts"), true);
    assert.equal(isTestFile("server/src/routes/issues.ts"), false);
  });

  it("treats non-test JS/TS as source", () => {
    assert.equal(isSourceFile("server/src/routes/issues.ts"), true);
    assert.equal(isSourceFile("server/src/routes/issues.test.ts"), false);
    assert.equal(isSourceFile("doc/DEVELOPING.md"), false);
  });
});

describe("resolveRange", () => {
  it("prefers explicit args over env", () => {
    const range = resolveRange(["--base", "abc", "--head", "def"], {});
    assert.deepEqual(range, { base: "abc", head: "def" });
  });

  it("reads CI env vars and defaults head to HEAD", () => {
    const range = resolveRange([], { BASE_SHA: "base123" });
    assert.deepEqual(range, { base: "base123", head: "HEAD" });
  });

  it("supports equals-form args", () => {
    const range = resolveRange(["--base=abc"], { HEAD_SHA: "head123" });
    assert.deepEqual(range, { base: "abc", head: "head123" });
  });
});
