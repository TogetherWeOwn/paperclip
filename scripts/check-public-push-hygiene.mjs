#!/usr/bin/env node
/**
 * check-public-push-hygiene.mjs
 *
 * Fail-closed pre-publication check: blocks internal tracker references in
 * newly pushed commit messages and changed tracked text (including Markdown
 * audit ledgers).
 *
 * Context: CONTRIBUTING.md ("No Internal Issue References") requires that PR
 * titles, descriptions, commits and comments reference only public GitHub
 * issues/PRs. The deployed `check-forbidden-tokens.mjs` gate only matches
 * username-like tokens in the working tree at npm-build time: it never reads
 * commit messages and never matches tracker-id patterns, and no CI workflow
 * runs on branch pushes. A branch-only push therefore had zero automated
 * coverage on this path.
 *
 * Scope: the NEW publication population of a push is every commit reachable
 * from <head> and from no public line:
 *   messages: `git log <head> --not <public lines>`
 *   text:     lines added by each of those commits (`git log -p --cc`): for a
 *             merge, only lines new relative to every parent (conflict
 *             resolutions), never content brought in from a parent
 * Public lines are PUBLIC_LINE_REFS, matched by exact name. Their history is
 * already public and is never flagged. A branch's own unshared history is
 * always scanned, including commits that another feature branch already
 * carries. Per-commit diffs mean a line added and removed within the push is
 * still flagged. History is never rewritten.
 *
 * Exit codes (fail-closed, mirroring the public-comment hygiene gate):
 *   0 = clean, 1 = internal reference(s) found (blocked), 2 = scanner error.
 * Any git/resolution failure exits 2, never 0.
 *
 * The detector uses a closed prefix list (DEFAULT_PREFIXES). A new instance
 * prefix is registered with one reviewed line here or `--prefix`/`env`
 * addition -- there is deliberately no open `[A-Z]+-[0-9]+` pattern, which
 * would false-positive on tokens like UTF-8, HTTP-2 or CVE-2024-1234 and
 * train engineers to bypass the gate.
 *
 * Hermetic by construction: pure Node parsing, no shell-grep dependency, so
 * the proof cannot be bypassed by a PATH shim or an exported shell function.
 */

import { execFileSync, execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PREFIXES = ["TOG", "PAP", "PAPA"];

// Long-lived lines whose history is already public. A push never scans their
// commits. Matched by exact name: a prefix would let any pusher who can create a
// branch make content public-by-name. Feature branches are deliberately not
// listed: a flagged commit on a feature branch must stay flagged for every
// branch that carries it. Adding a line is a reviewed change here.
export const PUBLIC_LINE_REFS = ["refs/remotes/origin/master", "refs/remotes/origin/deploy/tog6"];

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_SCANNER_ERROR = 2;

// execSync caps stdout at 1 MiB by default (ENOBUFS). Branch deltas that merge
// master or cover weeks of history exceed that, so the scanner needs headroom.
export const EXEC_MAX_BUFFER = 256 * 1024 * 1024;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildTrackerPattern(prefixes) {
  const alts = prefixes.map(escapeRegExp).join("|");
  return new RegExp(`\\b(?:${alts})-\\d+\\b`, "g");
}

/** All internal tracker ids in `text` for the given prefixes (unique, in order). */
export function findInternalRefs(text, prefixes = DEFAULT_PREFIXES) {
  if (!text || prefixes.length === 0) return [];
  const pattern = buildTrackerPattern(prefixes);
  const seen = new Set();
  for (const match of text.matchAll(pattern)) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
    }
  }
  return [...seen];
}

export function resolvePrefixes({ extra = [], env = process.env } = {}) {
  const normalize = (values) =>
    values.map((value) => value.trim().toUpperCase()).filter(Boolean);
  const fromEnv = normalize((env.PUBLIC_HYGIENE_PREFIXES ?? "").split(","));
  return [...new Set([...DEFAULT_PREFIXES, ...normalize(extra), ...fromEnv])];
}

/**
 * Parse `git log --format=%H%x1f%B%x1e` output into [{ sha, body }].
 * Pure function over command output for hermetic testing.
 */
export function parseCommitRecords(logOutput) {
  return logOutput
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const sep = record.indexOf("\x1f");
      if (sep === -1) return null;
      return { sha: record.slice(0, sep).trim(), body: record.slice(sep + 1) };
    })
    .filter(Boolean);
}

/**
 * Parse `git log -p -U0 --cc --no-color` output, returning findings for lines
 * added relative to every parent: [{ file, line, refs }], or
 * [{ file, line: null, merge: true, refs }] for merge resolutions.
 * Pure function over command output.
 */
export function scanDiffForRefs(diffOutput, prefixes = DEFAULT_PREFIXES) {
  const findings = [];
  let file = null;
  let inHunk = false;
  let newLine = 0;
  let parents = 1;
  let merge = false;
  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
      file = null;
      inHunk = false;
      merge = line.startsWith("diff --cc ");
      continue;
    }
    // File headers only occur before the first hunk. Once inside a hunk, a
    // line starting with "+++" is added content (diff prefixes it with one
    // more "+"), so it must be scanned, not mistaken for a header.
    if (!inHunk && (line === "+++ /dev/null" || line.startsWith("+++ "))) {
      file = line === "+++ /dev/null" ? null : line.slice("+++ b/".length);
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      continue;
    }
    // Combined (merge) hunks use one extra "@" per parent and one marker column
    // per parent, so "@@@ ... @@@" has two marker columns.
    const hunk = line.match(/^(@@+) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @@+/);
    if (hunk) {
      inHunk = true;
      newLine = Number(hunk[2]);
      parents = hunk[1].length - 1;
      continue;
    }
    if (inHunk && file !== null && line.startsWith("+".repeat(parents))) {
      const refs = findInternalRefs(line.slice(parents), prefixes);
      if (refs.length > 0) {
        findings.push(merge ? { file, line: null, merge: true, refs } : { file, line: newLine, refs });
      }
      newLine += 1;
    }
  }
  return findings;
}

function defaultExec(cmd) {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: EXEC_MAX_BUFFER,
  });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function verifyRef(ref, execFn) {
  execFn(`git rev-parse --verify --quiet ${shellQuote(`${ref}^{commit}`)}`);
}

function gitOutputLines(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: EXEC_MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .split("\n")
    .filter(Boolean);
}

/** Public-line refs to exclude for a push to `selfRef` (the pushed branch's own origin ref). */
export function resolvePublicLineRefs({ selfRef }) {
  return gitOutputLines(["for-each-ref", "--format=%(refname)", ...PUBLIC_LINE_REFS]).filter(
    (ref) => ref !== selfRef,
  );
}

// Plain ref names and SHAs only: revision syntax (^, ~, .., @{...}) and option-like
// values would otherwise produce empty or unscoped ranges that still exit 0.
const PLAIN_REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isPlainRevision(value) {
  return PLAIN_REVISION.test(value) && !value.includes("..");
}

export function runPublicPushHygieneCheck({
  base,
  head,
  selfRef,
  prefixes = DEFAULT_PREFIXES,
  execFn = defaultExec,
  log = console.log,
  error = console.error,
}) {
  if (!head || (!base && !selfRef)) {
    error("ERROR: --head and one of --base or --self-ref are required (no resolvable default).");
    return EXIT_SCANNER_ERROR;
  }

  const inputs = [["--head", head], ["--base", base], ["--self-ref", selfRef]];
  for (const [flag, value] of inputs) {
    if (value !== undefined && !isPlainRevision(value)) {
      error(`ERROR: ${flag} '${value}' is not a plain ref or SHA. Refusing to pass an unscoped scan.`);
      return EXIT_SCANNER_ERROR;
    }
  }

  if (selfRef !== undefined && !selfRef.startsWith("refs/remotes/origin/")) {
    error(`ERROR: --self-ref '${selfRef}' must be a refs/remotes/origin/ ref. Refusing to pass an unscoped scan.`);
    return EXIT_SCANNER_ERROR;
  }

  let exclusions;
  try {
    if (base) {
      verifyRef(base, execFn);
      exclusions = [base];
    } else {
      verifyRef(selfRef, execFn);
      exclusions = resolvePublicLineRefs({ selfRef });
    }
  } catch (err) {
    error(`ERROR: cannot scope the publication range (${err.message}). Refusing to pass an unscoped scan.`);
    return EXIT_SCANNER_ERROR;
  }

  try {
    verifyRef(head, execFn);
  } catch {
    error(`ERROR: cannot resolve --head '${head}'. Refusing to pass an unscoped scan.`);
    return EXIT_SCANNER_ERROR;
  }

  const excludeClause =
    exclusions.length > 0 ? ` --not ${exclusions.map(shellQuote).join(" ")}` : "";
  const range = `${shellQuote(head)}${excludeClause} --`;
  let logOutput;
  let diffOutput;
  try {
    logOutput = execFn(`git log --format=%H%x1f%B%x1e ${range}`);
    diffOutput = execFn(`git log -p -U0 --cc --no-color --no-ext-diff --format= ${range}`);
  } catch (err) {
    error(`ERROR: failed to read the publication range for ${head}: ${err.message}`);
    return EXIT_SCANNER_ERROR;
  }

  const messageFindings = [];
  for (const { sha, body } of parseCommitRecords(logOutput)) {
    const refs = findInternalRefs(body, prefixes);
    if (refs.length > 0) {
      messageFindings.push({ sha, refs });
    }
  }

  const textFindings = scanDiffForRefs(diffOutput, prefixes);

  if (messageFindings.length === 0 && textFindings.length === 0) {
    log(`  ✓  No internal tracker references in ${head} (${exclusions.length} public ref(s) excluded).`);
    return EXIT_CLEAN;
  }

  for (const { sha, refs } of messageFindings) {
    error(`  commit ${sha.slice(0, 12)} message references: ${refs.join(", ")}`);
  }
  for (const { file, line, merge, refs } of textFindings) {
    const where = merge ? `${file} (merge resolution)` : `${file}:${line}`;
    error(`  ${where} references: ${refs.join(", ")}`);
  }
  error("\nBlocked: restate internal context in plain English and remove the reference(s).");
  return EXIT_FINDINGS;
}

function parseArgs(argv) {
  const args = { base: undefined, selfRef: undefined, head: "HEAD", extraPrefixes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base" && argv[i + 1]) {
      args.base = argv[(i += 1)];
    } else if (arg === "--self-ref" && argv[i + 1]) {
      args.selfRef = argv[(i += 1)];
    } else if (arg === "--head" && argv[i + 1]) {
      args.head = argv[(i += 1)];
    } else if (arg === "--prefix" && argv[i + 1]) {
      args.extraPrefixes.push(argv[(i += 1)].toUpperCase());
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      args.unknown = arg;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.unknown) {
    const out = args.help ? console.log : console.error;
    out("Usage: node scripts/check-public-push-hygiene.mjs [--self-ref <origin ref> | --base <ref>] [--head <ref>] [--prefix <PREFIX>]...");
    out("Defaults: --head HEAD; with neither --self-ref nor --base, --base origin/master. Prefixes default to TOG,PAP,PAPA plus $PUBLIC_HYGIENE_PREFIXES.");
    process.exit(args.help ? EXIT_CLEAN : EXIT_SCANNER_ERROR);
  }
  process.exit(
    runPublicPushHygieneCheck({
      base: args.base ?? (args.selfRef ? undefined : "origin/master"),
      selfRef: args.selfRef,
      head: args.head,
      prefixes: resolvePrefixes({ extra: args.extraPrefixes }),
    }),
  );
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
