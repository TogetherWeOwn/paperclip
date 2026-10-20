import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Native SSH launch-authority seam presence gate.
//
// The pre-seam citation gate asserted the authority symbols were ABSENT
// ("not deployed" finding). With the seam merged, that finding is stale: the
// citations below are re-keyed to this release line's vocabulary and the
// expectation is flipped to PRESENT. Removing the seam trips this gate
// (exit-1-on-absent); the merged seam keeps it green (exit-0-on-present).
//
// The retired vocabulary (assertAssignedModel / launchAuthorization) must
// stay absent: this tree enforces through the executor/authority path, and
// the old symbols sneaking back would mean a second, unreviewed seam.

interface SeamCitation {
  /** Repo-relative file holding the seam site. */
  file: string;
  /** Substring that must occur in the file. */
  anchor: string;
  /**
   * Substring that must occur after the anchor within the same function
   * body (ordering pin), if any. The search is bounded to
   * mustPrecedeWithinLines lines so a distant, unrelated later site
   * (another function resolving ssh, another key-staging call) cannot
   * satisfy a guard that was reordered behind its own effect.
   */
  mustPrecede?: string;
  mustPrecedeWithinLines?: number;
  why: string;
}

const SEAM_CITATIONS: SeamCitation[] = [
  {
    file: "packages/adapter-utils/src/server-utils.ts",
    anchor: "async function resolveSpawnTarget(",
    why: "mediation point in front of every ssh dispatch",
  },
  {
    file: "packages/adapter-utils/src/server-utils.ts",
    anchor: "options.hostExecutor ?? getActiveNativeSshHostExecutor()",
    why: "run-scope executor fallback, no adapter forwarding needed",
  },
  {
    file: "packages/adapter-utils/src/server-utils.ts",
    anchor: "!hostExecutor && isNativeSshAuthorityRequired()",
    why: "fail-closed enforcement switch read from the server environment",
  },
  {
    file: "packages/adapter-utils/src/server-utils.ts",
    anchor: "authorizeLaunch(",
    mustPrecede: 'resolveCommandPath("ssh"',
    mustPrecedeWithinLines: 50,
    why: "the launch is authorized before ssh is resolved or a target built",
  },
  {
    file: "packages/adapter-utils/src/ssh.ts",
    anchor: "export async function buildSshSpawnTarget(",
    why: "the single agent-launch ssh target builder",
  },
  {
    file: "packages/adapter-utils/src/ssh.ts",
    anchor: "assertNativeSshLaunchAuthority(",
    mustPrecede: "await createSshAuthArgs(",
    mustPrecedeWithinLines: 50,
    why: "the builder asserts an issued authority before staging key material",
  },
  {
    file: "packages/adapter-utils/src/host-executor.ts",
    anchor: 'NATIVE_SSH_AUTHORITY_ENV = "PAPERCLIP_NATIVE_SSH_AUTHORITY"',
    why: "the server-owned enforcement switch name",
  },
  {
    file: "packages/adapter-utils/src/host-executor.ts",
    anchor: "export function isNativeSshAuthorityRequired(",
    why: "typo-safe switch reader: only unset, empty or off disables",
  },
  {
    file: "packages/adapter-utils/src/host-executor.ts",
    anchor: "export function createNativeSshHostExecutorTarget(",
    why: "signer issuance/verification behind the opaque request id",
  },
  {
    file: "packages/adapter-utils/src/host-executor.ts",
    anchor: "issuedProofs.add(proof)",
    why: "identity-checked proofs: hand-built envelopes never verify",
  },
  {
    file: "packages/adapter-utils/src/host-executor.ts",
    anchor: "export function runWithNativeSshHostExecutor<T>(",
    why: "run-scope binding without adapters forwarding executors",
  },
  {
    file: "server/src/services/native-ssh-authority.ts",
    anchor: "export function createNativeSshHostExecutorForRun(",
    why: "per-run issuer bound to the decided model, never adapter config",
  },
  {
    file: "server/src/services/heartbeat.ts",
    anchor: "createNativeSshHostExecutorForRun({",
    why: "the run builds its executor once, before any launch",
  },
  {
    file: "server/src/routes/agents.ts",
    anchor: "assertNativeSshProbeSupported(",
    why: "run-less probes refuse SSH targets while authority is required",
  },
];

/** Retired vocabulary: present means a second, unreviewed seam. */
const RETIRED_SYMBOLS: Array<{ file: string; symbol: string }> = [
  ...new Set(SEAM_CITATIONS.map((citation) => citation.file)),
].flatMap((file) =>
  ["assertAssignedModel", "launchAuthorization"].map((symbol) => ({ file, symbol })),
);

type CitationVerdict = "present" | "absent" | "misordered";

interface CitationResult extends SeamCitation {
  verdict: CitationVerdict;
  anchorLine: number | null;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function checkCitation(source: string, citation: SeamCitation): CitationResult {
  const at = source.indexOf(citation.anchor);
  if (at === -1) return { ...citation, verdict: "absent", anchorLine: null };
  if (citation.mustPrecede !== undefined) {
    const anchorLine = lineOf(source, at);
    const windowLines =
      citation.mustPrecedeWithinLines === undefined
        ? source.slice(at + citation.anchor.length).split("\n")
        : source
            .slice(at + citation.anchor.length)
            .split("\n")
            .slice(0, citation.mustPrecedeWithinLines);
    const preceded = windowLines.some((line) => line.includes(citation.mustPrecede!));
    if (!preceded)
      return { ...citation, verdict: "misordered", anchorLine };
  }
  return { ...citation, verdict: "present", anchorLine: lineOf(source, at) };
}

/** Code identifiers, not prose: comments are stripped so a refactor note
 *  naming a retired symbol does not trip the gate. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const commentAt = line.indexOf("//");
      if (commentAt === -1) return line;
      // Keep URL-looking values (protocol://) intact; seam files carry none
      // in positions that matter, and a miss only weakens one negative pin.
      return line.slice(0, commentAt);
    })
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function containsCodeIdentifier(source: string, symbol: string): boolean {
  const code = stripLineComments(source);
  return new RegExp(`(?<![A-Za-z0-9_$])${symbol}(?![A-Za-z0-9_$])`).test(code);
}

function assertNoRetiredSymbols(sources: Record<string, string>): void {
  for (const { file, symbol } of RETIRED_SYMBOLS) {
    if (containsCodeIdentifier(sources[file] ?? "", symbol)) {
      throw new Error(`${file} must not contain ${symbol}`);
    }
  }
}

function checkSeamSources(sources: Record<string, string>): CitationResult[] {
  return SEAM_CITATIONS.map((citation) =>
    checkCitation(sources[citation.file] ?? "", citation),
  );
}

/** Throws naming every non-present citation: the exit-1-on-absent path. */
function assertSeamPresent(sources: Record<string, string>): CitationResult[] {
  const results = checkSeamSources(sources);
  const failures = results.filter((result) => result.verdict !== "present");
  if (failures.length > 0) {
    const detail = failures
      .map((result) => `${result.verdict}: ${result.file} :: ${result.anchor} (${result.why})`)
      .join("\n");
    throw new Error(`Native SSH launch-authority seam is missing:\n${detail}`);
  }
  return results;
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

function readTreeSource(repoRelative: string): string {
  return readFileSync(path.join(REPO_ROOT, repoRelative), "utf8");
}

function readRealTree(): Record<string, string> {
  const files = [...new Set([...SEAM_CITATIONS.map((citation) => citation.file)])];
  return Object.fromEntries(files.map((file) => [file, readTreeSource(file)]));
}

describe("seam citation checker", () => {
  const citation: SeamCitation = {
    file: "server-utils.ts",
    anchor: "authorizeLaunch(",
    mustPrecede: 'resolveCommandPath("ssh"',
    why: "test citation",
  };

  it("reports present with the anchor line when the seam is intact", () => {
    const source = "async function resolveSpawnTarget(\n  await authorizeLaunch(x);\n  resolveCommandPath(\"ssh\"";
    const result = checkCitation(source, citation);
    expect(result.verdict).toBe("present");
    expect(result.anchorLine).toBe(2);
  });

  it("reports absent when the seam anchor is gone", () => {
    const source = "async function resolveSpawnTarget(\n  resolveCommandPath(\"ssh\"";
    expect(checkCitation(source, citation).verdict).toBe("absent");
  });

  it("reports misordered when the guard moved behind the effect", () => {
    const source = "resolveCommandPath(\"ssh\"\nawait authorizeLaunch(x);";
    expect(checkCitation(source, citation).verdict).toBe("misordered");
  });

  it("ignores an unrelated later site outside the ordering window", () => {
    const windowed: SeamCitation = { ...citation, mustPrecedeWithinLines: 3 };
    // The effect occurs, but only far below the guard: a reorder inside the
    // guarded function must still trip, not borrow the distant site.
    const far = ["await authorizeLaunch(x);", ...Array(9).fill("unrelated();"), 'resolveCommandPath("ssh"'].join(
      "\n",
    );
    expect(checkCitation(far, windowed).verdict).toBe("misordered");
    const near = ['await authorizeLaunch(x);', 'resolveCommandPath("ssh"'].join("\n");
    expect(checkCitation(near, windowed).verdict).toBe("present");
  });

  it("throws naming the missing citation, the exit-1-on-absent path", () => {
    const sources = { "packages/adapter-utils/src/server-utils.ts": "nothing seam-like here" };
    expect(() => assertSeamPresent(sources)).toThrow(
      /absent: packages\/adapter-utils\/src\/server-utils\.ts :: async function resolveSpawnTarget\(/,
    );
  });
});

describe("native SSH launch-authority seam is present (flipped gate)", () => {
  it("finds every re-keyed citation in the tree, exit-0-on-present", () => {
    const results = assertSeamPresent(readRealTree());
    expect(results).toHaveLength(SEAM_CITATIONS.length);
    expect(results.every((result) => result.verdict === "present")).toBe(true);
  });

  it("trips when the dispatch mediation is stripped, exit-1-on-absent", () => {
    const sources = readRealTree();
    const file = "packages/adapter-utils/src/server-utils.ts";
    // A revert that deletes the seam: every load-bearing anchor is gone.
    let stripped = sources[file];
    for (const anchor of [
      "async function resolveSpawnTarget(",
      "getActiveNativeSshHostExecutor()",
      "isNativeSshAuthorityRequired()",
      "authorizeLaunch(",
    ]) {
      stripped = stripped.split(anchor).join("REMOVED_SEAM");
    }
    expect(() => assertSeamPresent({ ...sources, [file]: stripped })).toThrow(
      /Native SSH launch-authority seam is missing/,
    );
  });

  it("trips when the builder assertion is stripped, exit-1-on-absent", () => {
    const sources = readRealTree();
    const file = "packages/adapter-utils/src/ssh.ts";
    const stripped = sources[file]
      .split("assertNativeSshLaunchAuthority(")
      .join("REMOVED_SEAM");
    expect(() => assertSeamPresent({ ...sources, [file]: stripped })).toThrow(
      /misordered|absent: packages\/adapter-utils\/src\/ssh\.ts/,
    );
  });

  it("keeps the retired vocabulary out of the seam files", () => {
    expect(() => assertNoRetiredSymbols(readRealTree())).not.toThrow();
  });

  it.each(
    [
      "packages/adapter-utils/src/server-utils.ts",
      "packages/adapter-utils/src/ssh.ts",
      "packages/adapter-utils/src/host-executor.ts",
      "server/src/services/native-ssh-authority.ts",
      "server/src/services/heartbeat.ts",
      "server/src/routes/agents.ts",
    ].flatMap((file) =>
      ["assertAssignedModel", "launchAuthorization"].map((symbol) => ({ file, symbol })),
    ),
  )("trips when $symbol returns in $file", ({ file, symbol }) => {
    const sources = readRealTree();
    sources[file] += `\nconst ${symbol} = null;\n`;
    expect(() => assertNoRetiredSymbols(sources)).toThrow(`${file} must not contain ${symbol}`);
  });

  it("ignores retired symbols named only in comments", () => {
    expect(containsCodeIdentifier("// replaced assertAssignedModel with the executor path", "assertAssignedModel")).toBe(
      false,
    );
    expect(containsCodeIdentifier("const assertAssignedModel = null;", "assertAssignedModel")).toBe(true);
  });
});
