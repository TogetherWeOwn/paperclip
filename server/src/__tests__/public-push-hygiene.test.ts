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

function mockExec({
  log = "",
  diff = "",
  failOn = null,
}: {
  log?: string;
  diff?: string;
  failOn?: string | null;
} = {}) {
  return vi.fn((cmd: string) => {
    if (failOn && cmd.startsWith(failOn)) {
      throw new Error(`mock git failure: ${cmd}`);
    }
    if (cmd.startsWith("git rev-parse")) return "";
    if (cmd.includes(" -p ")) return diff;
    if (cmd.startsWith("git log")) return log;
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
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`references: ${DIRTY_ID}`),
    );
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
      expect.stringContaining(
        `ops/paperclip/FORK-TRACKING.md:17 references: ${DIRTY_ID}`,
      ),
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
    expect(resolvePrefixes({ extra: ["synth"], env: {} })).toEqual([
      "TOG",
      "PAP",
      "PAPA",
      "SYNTH",
    ]);
    expect(
      resolvePrefixes({
        extra: [],
        env: { PUBLIC_HYGIENE_PREFIXES: "tog, ZED " },
      }),
    ).toEqual(["TOG", "PAP", "PAPA", "ZED"]);
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
    // Guards the explicit-base full-delta contract at the script level: only
    // the last delta is clean, so a delta-scoped scan would exit 0 and hide the
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

  it("push workflow scopes by public lines and never uses the dangling event.before", () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL(
          "../../../.github/workflows/public-push-hygiene.yml",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(workflow).toContain("--self-ref");
    expect(workflow).not.toContain("git merge-base origin/master");
    // The workflow comment explains why event.before is ignored; only an
    // actual `${{ ... }}` interpolation would wire the dangling delta back in.
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\.before/);
  });
});

function withFixtureRepo(
  run: (git: (...args: string[]) => string, root: string) => void,
) {
  const root = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
        process.env.PAPERCLIP_SCRATCH_DIR ??
        tmpdir(),
      "public-push-hygiene-line-",
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
    process.chdir(root);
    run(git, root);
  } finally {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function commitFixtureFile(
  git: (...args: string[]) => string,
  root: string,
  file: string,
  message: string,
  content = `${file} fixture\n`,
) {
  writeFileSync(join(root, file), content);
  git("add", ".");
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

// master at the base commit; the deploy line carries an already-public dirty
// commit on top of it. HEAD is left at the deploy tip.
function publicLayout(git: (...args: string[]) => string, root: string) {
  const master = commitFixtureFile(git, root, "base.txt", "fixture base");
  git("update-ref", "refs/remotes/origin/master", master);
  const legacy = commitFixtureFile(
    git,
    root,
    "legacy.md",
    `legacy public line Refs ${DIRTY_ID}`,
  );
  git("update-ref", "refs/remotes/origin/deploy/tog6", legacy);
  return { master, legacy };
}

describe("public push hygiene scope on non-master lines", () => {
  it("scans only a branch's own commits when it is cut from a public deploy line", () => {
    withFixtureRepo((git, root) => {
      publicLayout(git, root);
      commitFixtureFile(git, root, "port.txt", "clean port follow-up");
      const selfRef = "refs/remotes/origin/port/x";
      git("update-ref", selfRef, "HEAD");

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(0);
      expect(error).not.toHaveBeenCalled();
    });
  });

  it("merging master into a branch does not rescan master or the deploy line", () => {
    withFixtureRepo((git, root) => {
      const { master } = publicLayout(git, root);
      const port = commitFixtureFile(
        git,
        root,
        "port.txt",
        "clean port follow-up",
      );
      git("checkout", "-q", "--detach", master);
      commitFixtureFile(git, root, "master-next.txt", "master follow-up");
      const masterTip = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/master", masterTip);
      git("checkout", "-q", "--detach", port);
      git("merge", "-q", "--no-edit", masterTip);
      const selfRef = "refs/remotes/origin/port/x";
      git("update-ref", selfRef, "HEAD");

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(0);
      expect(error).not.toHaveBeenCalled();
    });
  });

  it("flags a clean commit stacked on another branch's flagged commit", () => {
    withFixtureRepo((git, root) => {
      const { legacy } = publicLayout(git, root);
      const flagged = commitFixtureFile(
        git,
        root,
        "feat.md",
        `feature commit Refs ${DIRTY_ID}`,
      );
      git("update-ref", "refs/remotes/origin/feat/a", flagged);
      commitFixtureFile(git, root, "stacked.txt", "clean commit on feat/b");
      const selfRef = "refs/remotes/origin/feat/b";
      git("update-ref", selfRef, "HEAD");

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `commit ${flagged.slice(0, 12)} message references`,
        ),
      );
      expect(error).not.toHaveBeenCalledWith(
        expect.stringContaining(legacy.slice(0, 12)),
      );
    });
  });

  it("flags a dirty line that is added and then removed within the push", () => {
    withFixtureRepo((git, root) => {
      publicLayout(git, root);
      commitFixtureFile(
        git,
        root,
        "ledger.md",
        "add ledger row",
        `- row: already-equivalent. Refs ${DIRTY_ID}.\n`,
      );
      git("rm", "-q", "ledger.md");
      git("commit", "-qm", "remove ledger row");
      const selfRef = "refs/remotes/origin/feat/ledger";
      git("update-ref", selfRef, "HEAD");

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`ledger.md:1 references: ${DIRTY_ID}`),
      );
    });
  });

  it("names only the dirty commit on top of a public line", () => {
    withFixtureRepo((git, root) => {
      const { legacy } = publicLayout(git, root);
      commitFixtureFile(git, root, "port.txt", "clean port follow-up");
      const dirty = commitFixtureFile(
        git,
        root,
        "dirty.md",
        `new dirty follow-up Refs ${DIRTY_ID}`,
      );
      const selfRef = "refs/remotes/origin/port/x";
      git("update-ref", selfRef, "HEAD");

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `commit ${dirty.slice(0, 12)} message references`,
        ),
      );
      expect(error).not.toHaveBeenCalledWith(
        expect.stringContaining(legacy.slice(0, 12)),
      );
    });
  });

  it("scans the deploy line's own history against master on a push to the deploy line", () => {
    withFixtureRepo((git, root) => {
      const { legacy } = publicLayout(git, root);
      const selfRef = "refs/remotes/origin/deploy/tog6";

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `commit ${legacy.slice(0, 12)} message references`,
        ),
      );
    });
  });

  it("refuses to scope a push whose self ref is not a resolvable origin ref", () => {
    withFixtureRepo((git, root) => {
      publicLayout(git, root);

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef: "origin/feat",
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(2);
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef: "refs/remotes/origin/missing",
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(2);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Refusing to pass an unscoped scan"),
      );
    });
  });

  it("scans a branch that shares no history with any public line in full", () => {
    withFixtureRepo((git, root) => {
      publicLayout(git, root);
      const orphan = git(
        "commit-tree",
        "HEAD^{tree}",
        "-m",
        `orphan fixture Refs ${DIRTY_ID}`,
      );
      const selfRef = "refs/remotes/origin/orphan-line";
      git("update-ref", selfRef, orphan);

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: orphan,
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `commit ${orphan.slice(0, 12)} message references`,
        ),
      );
    });
  });

  it("does not flag master-owned content brought in by merging master", () => {
    withFixtureRepo((git, root) => {
      const { master } = publicLayout(git, root);
      const port = commitFixtureFile(
        git,
        root,
        "port.txt",
        "clean port follow-up",
      );
      git("checkout", "-q", "--detach", master);
      commitFixtureFile(
        git,
        root,
        "master-note.md",
        "master note",
        `master-owned note Refs ${DIRTY_ID}\n`,
      );
      const masterTip = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/master", masterTip);
      git("checkout", "-q", "--detach", port);
      git("merge", "-q", "--no-edit", masterTip);
      const selfRef = "refs/remotes/origin/port/x";
      git("update-ref", selfRef, "HEAD");

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(0);
      expect(error).not.toHaveBeenCalled();
    });
  });

  it("does not flag legacy content on the deploy line brought in by merging master", () => {
    withFixtureRepo((git, root) => {
      const { master } = publicLayout(git, root);
      git("checkout", "-q", "--detach", master);
      const deployBody = commitFixtureFile(
        git,
        root,
        "legacy-body.md",
        "legacy body",
        `legacy body Refs ${DIRTY_ID}\n`,
      );
      git("update-ref", "refs/remotes/origin/deploy/tog6", deployBody);
      const port = commitFixtureFile(
        git,
        root,
        "port.txt",
        "clean port follow-up",
      );
      git("checkout", "-q", "--detach", master);
      commitFixtureFile(git, root, "master-next.txt", "master follow-up");
      const masterTip = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/master", masterTip);
      git("checkout", "-q", "--detach", port);
      git("merge", "-q", "--no-edit", masterTip);
      const selfRef = "refs/remotes/origin/port/x";
      git("update-ref", selfRef, "HEAD");

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(0);
    });
  });

  it("flags a tracker id written into a merge conflict resolution", () => {
    withFixtureRepo((git, root) => {
      commitFixtureFile(git, root, "shared.txt", "shared base", "one\n");
      const base = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/master", base);
      git("checkout", "-q", "--detach", base);
      commitFixtureFile(git, root, "shared.txt", "master edit", "two\n");
      const masterTip = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/master", masterTip);
      git("checkout", "-q", "--detach", base);
      commitFixtureFile(git, root, "shared.txt", "port edit", "three\n");
      try {
        git("merge", "-q", "--no-edit", masterTip);
      } catch {
        // expected conflict; resolved below
      }
      writeFileSync(join(root, "shared.txt"), `resolved ${DIRTY_ID}\n`);
      git("add", "shared.txt");
      git("commit", "-qm", "resolve merge conflict");
      const selfRef = "refs/remotes/origin/port/x";
      git("update-ref", selfRef, "HEAD");

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `shared.txt (merge resolution) references: ${DIRTY_ID}`,
        ),
      );
    });
  });

  it("does not exempt a commit merely because a branch named like a deploy line carries it", () => {
    withFixtureRepo((git, root) => {
      publicLayout(git, root);
      const dirty = commitFixtureFile(
        git,
        root,
        "dirty.md",
        `throwaway deploy carries Refs ${DIRTY_ID}`,
      );
      git("update-ref", "refs/remotes/origin/deploy/throwaway", dirty);
      commitFixtureFile(git, root, "port.txt", "clean follow-up on feature");
      const selfRef = "refs/remotes/origin/port/x";
      git("update-ref", selfRef, "HEAD");

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef,
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `commit ${dirty.slice(0, 12)} message references`,
        ),
      );
    });
  });

  it("refuses revision expressions and negations that would otherwise produce an empty range", () => {
    withFixtureRepo((git, root) => {
      publicLayout(git, root);
      commitFixtureFile(
        git,
        root,
        "dirty.md",
        `new dirty follow-up Refs ${DIRTY_ID}`,
      );
      git("update-ref", "refs/remotes/origin/port/x", "HEAD");
      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          head: "^HEAD",
          selfRef: "refs/remotes/origin/port/x",
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(2);
      expect(
        runPublicPushHygieneCheck({
          head: "HEAD",
          selfRef: "refs/remotes/origin/port/x^",
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(2);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Refusing to pass an unscoped scan"),
      );
    });
  });

  it("pins the regression: a master-only base would flag the already-public line", () => {
    withFixtureRepo((git, root) => {
      publicLayout(git, root);
      commitFixtureFile(git, root, "port.txt", "clean port follow-up");
      git("update-ref", "refs/remotes/origin/port/x", "HEAD");
      const masterBase = git(
        "merge-base",
        "refs/remotes/origin/master",
        "HEAD",
      );

      const { log, error } = quiet();
      expect(
        runPublicPushHygieneCheck({
          base: masterBase,
          head: "HEAD",
          prefixes: PREFIXES,
          log,
          error,
        }),
      ).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`references: ${DIRTY_ID}`),
      );
    });
  });
});
