import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const {
  DEFAULT_PREFIXES,
  EXEC_MAX_BUFFER,
  findInternalRefs,
  parseCommitRecords,
  resolvePrefixes,
  runPublicPushHygieneCheck,
  scanDiffForRefs,
} = await import("../../../scripts/check-public-push-hygiene.mjs");

// All tracker ids below are synthetic. SYNTH is not a real instance prefix;
// it is injected explicitly so fixtures never resemble a real internal id.
const PREFIXES = ["SYNTH"];
const DIRTY_ID = "SYNTH-4821";

function mockExec({ log = "", diff = "", failOn = null }: { log?: string; diff?: string; failOn?: string | null } = {}) {
  return vi.fn((cmd: string) => {
    if (failOn && cmd.startsWith(failOn)) {
      throw new Error(`mock git failure: ${cmd}`);
    }
    if (cmd.startsWith("git rev-parse")) return "";
    if (cmd.startsWith("git log")) return log;
    if (cmd.startsWith("git diff")) return diff;
    throw new Error(`unexpected command: ${cmd}`);
  });
}

function quiet() {
  return { log: vi.fn(), error: vi.fn() };
}

describe("public push hygiene gate", () => {
  it("dirty commit-message negative: flags a tracker id in a new message", () => {
    const exec = mockExec({
      log: `abc123def456\x1fdocs(ledger): mark source already-equivalent\n\nRefs ${DIRTY_ID}.\x1e`,
    });
    const { log, error } = quiet();
    const exitCode = runPublicPushHygieneCheck({
      base: "origin/master",
      head: "HEAD",
      prefixes: PREFIXES,
      execFn: exec,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`references: ${DIRTY_ID}`));
  });

  it("dirty ledger-row negative: flags a tracker id in an added markdown line", () => {
    const exec = mockExec({
      diff: [
        "diff --git a/ops/paperclip/FORK-TRACKING.md b/ops/paperclip/FORK-TRACKING.md",
        "--- a/ops/paperclip/FORK-TRACKING.md",
        "+++ b/ops/paperclip/FORK-TRACKING.md",
        "@@ -16,0 +17,1 @@",
        `+- row: source #7 already-equivalent. Refs ${DIRTY_ID}.`,
      ].join("\n"),
    });
    const { log, error } = quiet();
    const exitCode = runPublicPushHygieneCheck({
      base: "origin/master",
      head: "HEAD",
      prefixes: PREFIXES,
      execFn: exec,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`ops/paperclip/FORK-TRACKING.md:17 references: ${DIRTY_ID}`),
    );
  });

  it("clean positive: public refs, CVE ids, encodings and lowercase text pass", () => {
    const exec = mockExec({
      log: `abc123def456\x1ffix(adapter): warn on card-named branches (#110)\n\nFixes #110, see https://github.com/paperclipai/paperclip/pull/110.\x1e`,
      diff: [
        "diff --git a/docs/notes.md b/docs/notes.md",
        "--- a/docs/notes.md",
        "+++ b/docs/notes.md",
        "@@ -1,0 +2,2 @@",
        "+Patched CVE-2024-1234 handling; body is UTF-8 over HTTP-2.",
        "+Branch renamed from tog/old-name to fix/descriptive-name.",
      ].join("\n"),
    });
    const { log, error } = quiet();
    const exitCode = runPublicPushHygieneCheck({
      base: "origin/master",
      head: "HEAD",
      prefixes: PREFIXES,
      execFn: exec,
      log,
      error,
    });

    expect(exitCode).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  it("scanner-error negative: unresolvable refs and git failures exit 2, never 0", () => {
    const failVerify = mockExec({ failOn: "git rev-parse" });
    const { error: error1 } = quiet();
    expect(
      runPublicPushHygieneCheck({
        base: "no-such-base",
        head: "HEAD",
        prefixes: PREFIXES,
        execFn: failVerify,
        log: vi.fn(),
        error: error1,
      }),
    ).toBe(2);

    const failLog = mockExec({ failOn: "git log" });
    const { error: error2 } = quiet();
    expect(
      runPublicPushHygieneCheck({
        base: "origin/master",
        head: "HEAD",
        prefixes: PREFIXES,
        execFn: failLog,
        log: vi.fn(),
        error: error2,
      }),
    ).toBe(2);
  });

  it("default prefixes wire the company tracker families without fixtures", () => {
    expect(DEFAULT_PREFIXES).toEqual(["TOG", "PAP", "PAPA"]);
    // Split literal: proves the default path end to end while keeping this
    // repo's own gate scan clean (no contiguous PREFIX-digits literal here).
    // Synthetic: no such issue exists.
    const synthetic = `Refs ${"TOG"}-99999.`;
    expect(findInternalRefs(synthetic)).toEqual([`${"TOG"}-99999`]);
    expect(findInternalRefs("Refs #110")).toEqual([]);
    expect(findInternalRefs("tog-123 lowercase")).toEqual([]);
    expect(findInternalRefs("bare TOG with no digits")).toEqual([]);
  });

  it("counts added-line numbers across hunks and ignores removed lines", () => {
    const findings = scanDiffForRefs(
      [
        "diff --git a/a.md b/a.md",
        "--- a/a.md",
        "+++ b/a.md",
        "@@ -5,0 +6,2 @@",
        "+clean line",
        `+dirty ${DIRTY_ID} line`,
        "@@ -20,0 +30,1 @@",
        `-removed ${DIRTY_ID} line is not publication`,
      ].join("\n"),
      PREFIXES,
    );

    expect(findings).toEqual([{ file: "a.md", line: 7, refs: [DIRTY_ID] }]);
  });

  it("scans added content that starts with ++ instead of mistaking it for a header", () => {
    const findings = scanDiffForRefs(
      [
        "diff --git a/a.md b/a.md",
        "--- a/a.md",
        "+++ b/a.md",
        "@@ -1,0 +2,1 @@",
        `++++pre-increment line still cites ${DIRTY_ID}`,
      ].join("\n"),
      PREFIXES,
    );

    expect(findings).toEqual([{ file: "a.md", line: 2, refs: [DIRTY_ID] }]);
  });

  it("parses multi-commit log records", () => {
    const records = parseCommitRecords(
      `aaa\x1ffirst ${DIRTY_ID}\x1e\ndirty-leading-newline-record\x1fsecond\x1e`,
    );
    expect(records).toEqual([
      { sha: "aaa", body: `first ${DIRTY_ID}` },
      { sha: "dirty-leading-newline-record", body: "second" },
    ]);
  });

  it("merges default, flag and env prefixes deduplicated and uppercased", () => {
    expect(resolvePrefixes({ extra: ["synth"], env: {} })).toEqual(["TOG", "PAP", "PAPA", "SYNTH"]);
    expect(resolvePrefixes({ extra: [], env: { PUBLIC_HYGIENE_PREFIXES: "tog, ZED " } })).toEqual([
      "TOG",
      "PAP",
      "PAPA",
      "ZED",
    ]);
  });

  it("raises the git exec buffer so large branch deltas do not ENOBUFS (exit 2)", () => {
    // execSync defaults to 1 MiB; a two-week-old branch delta already nears
    // that. The scanner must keep headroom and still fail closed on real git
    // failures (covered above).
    expect(EXEC_MAX_BUFFER).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it("exercises the real git exec path on a >1MiB clean delta (kills the ENOBUFS mutant)", () => {
    // Mutant: delete `maxBuffer: EXEC_MAX_BUFFER` from defaultExec. The
    // constant assertion above stays green, but this test runs the real
    // execSync path (no execFn) over a >1MiB delta and would exit 2 ENOBUFS.
    const root = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
          process.env.PAPERCLIP_SCRATCH_DIR ??
          tmpdir(),
        "public-push-hygiene-large-",
      ),
    );
    const prevCwd = process.cwd();
    try {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=CI Fixture",
            "-c",
            "user.email=ci-fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8" },
        ).trim();
      git("init", "-q");
      writeFileSync(join(root, "base.txt"), "base fixture\n");
      git("add", ".");
      git("commit", "-qm", "fixture base");
      const base = git("rev-parse", "HEAD");
      const lines = Array.from(
        { length: 40000 },
        (_, i) => `clean fixture line ${i} with no references`,
      ).join("\n");
      writeFileSync(join(root, "large.txt"), `${lines}\n`);
      expect(lines.length).toBeGreaterThan(1024 * 1024);
      git("add", ".");
      git("commit", "-qm", "fixture large clean delta");
      const head = git("rev-parse", "HEAD");
      process.chdir(root);
      const { log, error } = quiet();
      const exitCode = runPublicPushHygieneCheck({
        base,
        head,
        prefixes: PREFIXES,
        log,
        error,
      });
      expect(exitCode).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      process.chdir(prevCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins the whole-branch scan: a dirty commit followed by a clean commit still flags", () => {
    // Guards the merge-base full-delta contract at the script level: only the
    // last delta is clean, so a delta-scoped scan would exit 0 and hide the
    // earlier dirty commit.
    const root = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
          process.env.PAPERCLIP_SCRATCH_DIR ??
          tmpdir(),
        "public-push-hygiene-delta-",
      ),
    );
    const prevCwd = process.cwd();
    try {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=CI Fixture",
            "-c",
            "user.email=ci-fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8" },
        ).trim();
      git("init", "-q");
      writeFileSync(join(root, "base.txt"), "base fixture\n");
      git("add", ".");
      git("commit", "-qm", "fixture base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(root, "zz1.md"), `row cites ${DIRTY_ID}\n`);
      git("add", ".");
      git("commit", "-qm", `dirty fixture message Refs ${DIRTY_ID}`);
      writeFileSync(join(root, "clean.txt"), "clean follow-up\n");
      git("add", ".");
      git("commit", "-qm", "clean follow-up");
      const head = git("rev-parse", "HEAD");
      process.chdir(root);
      const { log, error } = quiet();
      const exitCode = runPublicPushHygieneCheck({
        base,
        head,
        prefixes: PREFIXES,
        log: log as (...args: unknown[]) => void,
        error: error as (...args: unknown[]) => void,
      });
      expect(exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("message references"),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining("zz1.md"));
    } finally {
      process.chdir(prevCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("push workflow scans from merge-base and never uses the dangling event.before", () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL(
          "../../../.github/workflows/public-push-hygiene.yml",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(workflow).toContain("git merge-base origin/master");
    // The workflow comment explains why event.before is ignored; only an
    // actual `${{ ... }}` interpolation would wire the dangling delta back in.
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\.before/);
  });
});
