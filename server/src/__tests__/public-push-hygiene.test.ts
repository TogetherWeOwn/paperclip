import { describe, expect, it, vi } from "vitest";

const {
  DEFAULT_PREFIXES,
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
});
