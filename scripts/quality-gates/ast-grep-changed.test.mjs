import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { configDir, resolveAstGrep, scanChanged } from "./ast-grep-changed.mjs";

const VACUOUS_LINE = ["expect", "(true).toBe(true);"].join("");

describe("resolveAstGrep: binary selection", () => {
  it("prefers ast-grep on PATH when present", () => {
    assert.deepEqual(resolveAstGrep({ onPath: true }), {
      command: "ast-grep",
      prefixArgs: [],
    });
  });

  it("falls back to the pinned npx package when absent", () => {
    const resolved = resolveAstGrep({ onPath: false });
    assert.equal(resolved.command, "npx");
    assert.ok(
      resolved.prefixArgs.join(" ").includes("@ast-grep/cli@0.50.0"),
      `pinned package missing in ${resolved.prefixArgs.join(" ")}`,
    );
  });
});

describe("configDir: vendored rule pack", () => {
  it("points at the vendored meta-only rules with fixtures", () => {
    const dir = configDir();
    assert.ok(
      dir.endsWith(path.join("scripts", "quality-gates", "meta-only", "rules")),
      dir,
    );
  });
});

describe("scanChanged integration (temp repo)", () => {
  it("reports the shared vacuous-test rule on a violating file and stays WARN", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ast-grep-changed-"));
    try {
      const git = (args) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      writeFileSync(path.join(dir, "probe.js"), "const x = 1;\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]).trim();
      writeFileSync(
        path.join(dir, "probe.test.mjs"),
        `it("pins behavior", () => { ${VACUOUS_LINE} });\n`,
      );
      git(["add", "."]);
      git(["commit", "-qm", "violation"]);
      const head = git(["rev-parse", "HEAD"]).trim();

      const report = scanChanged({ base, head, repoRoot: dir });
      assert.equal(report.exit, 0, "WARN gate never fails");
      assert.ok(
        report.findings.some(
          (finding) => finding.ruleId === "ts-vacuous-literal-expect",
        ),
        `expected ts-vacuous-literal-expect in ${JSON.stringify(report.findings)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is quiet on a clean tree", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ast-grep-changed-"));
    try {
      const git = (args) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      writeFileSync(path.join(dir, "probe.js"), "const x = 1;\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]).trim();
      writeFileSync(path.join(dir, "probe.js"), "const x = 2;\n");
      git(["add", "."]);
      git(["commit", "-qm", "clean change"]);
      const head = git(["rev-parse", "HEAD"]).trim();

      const report = scanChanged({ base, head, repoRoot: dir });
      assert.equal(report.exit, 0);
      assert.deepEqual(report.findings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
