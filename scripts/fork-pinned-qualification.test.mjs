import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/fork-pinned-qualification.yml",
    import.meta.url,
  ),
  "utf8",
);
const sourceSha = "321499c232ea4e1966367b85763ad0c53969ffac";
const workflowSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const otherSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const repoUrl = "https://github.com/TogetherWeOwn/paperclip";
const commandSpecs = [
  ["typecheck", "pnpm -r typecheck"],
  ["tests", "pnpm test:run"],
  ["build", "pnpm build"],
  ["migrations", "pnpm --filter @paperclipai/db check:migrations"],
];
const summaries = [
  "Test Files  2 passed | 1 skipped (3)",
  "Tests  7 passed | 2 skipped (9)",
];

// Read only this workflow's small block-YAML subset. Unknown shapes must fail,
// not disappear from the production control-flow assertions or script fixtures.
function qualificationJob(text) {
  const sections = text.split(/^jobs:\n/m);
  assert.equal(sections.length, 2, "expected one jobs mapping");
  const jobs = sections[1].split(/^\S/m)[0];
  const matches = [...jobs.matchAll(/^ {2}qualify:\n/gm)];
  assert.equal(matches.length, 1, "expected one qualify job");
  return jobs
    .slice(matches[0].index + matches[0][0].length)
    .split(/^ {2}\S/m)[0];
}

function jobEligibility(text) {
  const header = qualificationJob(text).split(/^ {4}steps:\n/m)[0];
  const conditions = [...header.matchAll(/^ {4}if:(.*)$/gm)];
  assert.equal(
    conditions.length,
    1,
    "qualify: expected one explicit job eligibility condition",
  );
  const following = header
    .slice(conditions[0].index + conditions[0][0].length)
    .split("\n")
    .find((line) => line.trim() && !line.trimStart().startsWith("#"));
  assert.ok(
    !following?.startsWith("      "),
    "unsupported multiline job eligibility",
  );
  let expression = conditions[0][1].trim();
  if (expression.startsWith("${{")) {
    assert.ok(expression.endsWith("}}"), "unsupported job eligibility wrapper");
    expression = expression.slice(3, -2).trim();
  }
  assert.ok(
    expression.length <= 1024,
    "job eligibility expression exceeds bounded grammar",
  );
  const clauses = expression.split(/\s*&&\s*/);
  assert.ok(clauses.length <= 8, "job eligibility has too many clauses");
  // This intentionally supports only conjunctions of context/string equalities.
  // Parse every clause before evaluating, including otherwise unreachable text.
  const comparisons = clauses.map((clause) => {
    const match = clause.match(
      /^github\.(repository|event_name|ref)\s*==\s*'([^'\n]+)'$/,
    );
    assert.ok(match, `unsupported job eligibility syntax: ${clause}`);
    return [match[1], match[2].toLowerCase()];
  });
  return (github) =>
    comparisons.every(([key, value]) => {
      assert.equal(typeof github[key], "string", `missing github.${key}`);
      // GitHub string equality is case-insensitive.
      return github[key].toLowerCase() === value;
    });
}

function steps(text) {
  const sections = qualificationJob(text).split(/^ {4}steps:\n/m);
  assert.equal(
    sections.length,
    2,
    "qualify: expected one block steps sequence",
  );
  const [prefix, ...blocks] = sections[1].split(/^ {6}- /m);
  assert.equal(prefix.trim(), "", "unsupported steps sequence shape");
  assert.ok(blocks.length > 0, "qualify: missing steps");
  const result = new Map();
  const names = new Set();
  for (const block of blocks) {
    const lines = block.split("\n");
    const name = lines.shift().match(/^name: (.+)$/)?.[1];
    assert.ok(name, "every step must have a plain name");
    assert.ok(!names.has(name), `duplicate step name: ${name}`);
    names.add(name);
    const fields = { name };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const field = line.match(/^ {8}([\w-]+):(?: (.+))?$/);
      assert.ok(field, `${name}: unsupported step shape: ${line}`);
      const [, key, value] = field;
      assert.ok(!Object.hasOwn(fields, key), `${name}: duplicate ${key}`);
      assert.ok(
        [
          "id",
          "if",
          "uses",
          "working-directory",
          "timeout-minutes",
          "env",
          "with",
          "run",
        ].includes(key),
        `${name}: unsupported step field ${key}`,
      );
      if (key === "run") {
        assert.equal(value, "|", `${name}: expected literal run block`);
        const script = [];
        while (
          i + 1 < lines.length &&
          (!lines[i + 1].trim() || lines[i + 1].startsWith("          "))
        ) {
          script.push(lines[++i].slice(10));
        }
        assert.ok(
          script.some((entry) => entry.trim()),
          `${name}: missing literal run block`,
        );
        fields.run = script.join("\n");
      } else if (key === "env" || key === "with") {
        assert.equal(
          value,
          undefined,
          `${name}: expected block ${key} mapping`,
        );
        const entries = {};
        while (i + 1 < lines.length && lines[i + 1].startsWith("          ")) {
          const entry = lines[++i].match(/^ {10}([\w-]+): (.+)$/);
          assert.ok(entry, `${name}: unsupported ${key} entry`);
          assert.ok(
            !Object.hasOwn(entries, entry[1]),
            `${name}: duplicate ${key}.${entry[1]}`,
          );
          entries[entry[1]] = entry[2];
        }
        fields[key] = entries;
      } else {
        assert.ok(value, `${name}: missing ${key}`);
        fields[key] = key === "uses" ? value.split(" #")[0] : value;
      }
    }
    const id = fields.id ?? name;
    assert.ok(!result.has(id), `duplicate step id: ${id}`);
    assert.notEqual(
      Boolean(fields.run),
      Boolean(fields.uses),
      `${id}: expected exactly one run or uses`,
    );
    result.set(id, {
      ...fields,
      script: fields.run,
      env: fields.env ?? {},
      cwd: fields["working-directory"],
    });
  }
  return result;
}

function assertJobEligibility(text) {
  const eligible = jobEligibility(text);
  for (const repository of [
    "TogetherWeOwn/paperclip",
    "paperclipai/paperclip",
    "example/paperclip",
    "TogetherWeOwn/other",
  ]) {
    for (const event_name of [
      "workflow_dispatch",
      "push",
      "pull_request",
      "schedule",
      "workflow_call",
    ]) {
      for (const ref of [
        "refs/heads/master",
        "refs/heads/main",
        "refs/heads/feature",
        "refs/tags/master",
        "refs/tags/v1",
        "",
      ]) {
        assert.equal(
          eligible({ repository, event_name, ref }),
          repository === "TogetherWeOwn/paperclip" &&
            event_name === "workflow_dispatch" &&
            ref === "refs/heads/master",
          `job eligibility: ${repository}/${event_name}/${ref || "missing ref"}`,
        );
      }
    }
  }
}

function assertSourceOrder(text) {
  const ordered = steps(text);
  const required = [
    "initialize",
    "checkout",
    "source",
    "integrity",
    "node",
    "pnpm",
    "native",
    "install",
    "commands",
    "report",
    "upload",
    gateName,
  ];
  assert.deepEqual(
    [...ordered.keys()].sort(),
    [...required].sort(),
    "required steps must exist uniquely; review unknown steps explicitly",
  );
  for (const id of required) {
    const step = ordered.get(id);
    assert.equal(
      Boolean(step.uses),
      ["checkout", "node", "pnpm", "upload"].includes(id),
      `${id}: unexpected run/action shape`,
    );
    assert.equal(
      step.if,
      ["report", "upload", gateName].includes(id) ? "always()" : undefined,
      `${id}: unsupported step condition`,
    );
  }
  const checkout = ordered.get("checkout");
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(checkout.with?.repository, "TogetherWeOwn/paperclip");
  assert.equal(checkout.with?.ref, sourceSha);
  assert.equal(checkout.with?.path, "source");
  assert.equal(ordered.get("source").cwd, "source");
  assert.equal(
    ordered.get("pnpm").with?.package_json_file,
    "source/package.json",
  );
  const ids = [...ordered.keys()];
  const before = (first, second) =>
    assert.ok(
      ids.indexOf(first) < ids.indexOf(second),
      `source ordering: ${first} must precede ${second}`,
    );
  before("initialize", "checkout");
  before("checkout", "source");
  before("source", "integrity");
  // Includes action-only setup: pnpm reads source/package.json before install.
  for (const id of ["node", "pnpm", "native", "install", "commands"]) {
    before("source", id);
    before("integrity", id);
  }
}

const gateName = "Require complete green evidence and artifact upload";
const tools = new Map();
function tool(name) {
  if (!tools.has(name)) {
    const found = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-c", 'command -v "$1"', "resolve-tool", name],
      { encoding: "utf8" },
    );
    assert.equal(found.status, 0, `${name}: ${found.error || found.stderr}`);
    assert.ok(
      found.stdout.trim().startsWith("/"),
      `${name}: expected an absolute executable path`,
    );
    tools.set(name, found.stdout.trim());
  }
  return tools.get(name);
}

function fixture(t, text = workflow, options = {}) {
  const scratch =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ||
    process.env.PAPERCLIP_SCRATCH_DIR ||
    process.env.RUNNER_TEMP ||
    tmpdir();
  const root = mkdtempSync(join(scratch, "fork-qualification-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const temp = join(root, "temp");
  for (const dir of [bin, temp, join(root, "source")]) mkdirSync(dir);
  // Deliberately do not inherit PATH or credentials. Only hosted standard tools
  // and strict doubles are available; no source checkout, install or network.
  for (const name of [
    "bash",
    "python3",
    "mkdir",
    "sha256sum",
    "timeout",
    "tee",
    "cat",
  ])
    symlinkSync(tool(name), join(bin, name));
  const stub = (name, body) =>
    writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, {
      mode: 0o755,
    });
  stub(
    "git",
    `case "$*" in
  'rev-parse HEAD') printf '%s\\n' "$FIXTURE_SOURCE_SHA" ;;
  'remote get-url origin') printf '%s\\n' "$FIXTURE_REMOTE" ;;
  *) printf 'Unexpected git invocation: %s\\n' "$*" >&2; exit 97 ;;
esac`,
  );
  stub(
    "node",
    `test "$*" = --version || exit 97
printf 'v24.11.0\\n'`,
  );
  stub(
    "pnpm",
    `case "$*" in
  --version) printf '9.15.0\\n'; exit 0 ;;
  'install --frozen-lockfile') name=install ;;
  '-r typecheck') name=typecheck ;;
  'test:run') name=tests ;;
  build) name=build ;;
  '--filter @paperclipai/db check:migrations') name=migrations ;;
  *) printf 'Unexpected pnpm invocation: %s\\n' "$*" >&2; exit 97 ;;
esac
printf '%s\\n' "$name" >> "$FIXTURE_CALLS"
printf 'fixture %s stdout\\n' "$name"
printf 'fixture %s stderr\\n' "$name" >&2
if test "$name" = tests; then
  printf '\\033[32m Test Files  2 passed | 1 skipped (3)\\033[0m\\n Tests  7 passed | 2 skipped (9)\\n'
fi
if test "$name" = "$FIXTURE_FAIL_COMMAND"; then exit 23; fi`,
  );
  const blocks = steps(text);
  const states = new Map();
  const env = {
    PATH: bin,
    HOME: root,
    RUNNER_TEMP: temp,
    GITHUB_ENV: join(root, "github-env"),
    GITHUB_STEP_SUMMARY: join(root, "step-summary"),
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "TogetherWeOwn/paperclip",
    GITHUB_RUN_ID: "123456",
    GITHUB_RUN_ATTEMPT: "2",
    FIXTURE_SOURCE_SHA: options.sourceSha ?? sourceSha,
    FIXTURE_REMOTE: options.remote ?? repoUrl,
    FIXTURE_FAIL_COMMAND: options.failCommand ?? "",
    FIXTURE_CALLS: join(root, "calls"),
    CI: "true",
    NO_COLOR: "1",
    PAPERCLIP_TELEMETRY_DISABLED: "1",
  };
  const github = {
    workflow_sha: workflowSha,
    workflow_ref:
      "TogetherWeOwn/paperclip/.github/workflows/fork-pinned-qualification.yml@refs/heads/master",
    ref: "refs/heads/master",
  };
  function resolve(value) {
    if (!value.includes("${{")) return value.replace(/^"(.*)"$/, "$1");
    const githubKey = value.match(/^\$\{\{ github\.(\w+) \}\}$/)?.[1];
    if (githubKey) {
      assert.ok(
        Object.hasOwn(github, githubKey),
        `unknown github context: ${value}`,
      );
      return github[githubKey];
    }
    const step = value.match(
      /^\$\{\{ steps\.([\w-]+)\.(outcome|outputs\.\w+) \}\}$/,
    );
    assert.ok(step, `unsupported workflow expression: ${value}`);
    const state = states.get(step[1]);
    return step[2] === "outcome"
      ? (state?.outcome ?? "skipped")
      : (state?.outputs[step[2].slice(8)] ?? "");
  }
  function run(id, overrides = {}) {
    const block = blocks.get(id);
    assert.ok(block, `missing checked-in step ${id}`);
    const output = join(root, `${id}.output`);
    writeFileSync(output, "");
    const result = spawnSync(
      tool("bash"),
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", block.script],
      {
        cwd: block.cwd ? join(root, block.cwd) : root,
        env: {
          ...env,
          GITHUB_OUTPUT: output,
          ...Object.fromEntries(
            Object.entries(block.env).map(([key, value]) => [
              key,
              resolve(value),
            ]),
          ),
          ...overrides,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${id}: unexpectedly signalled`);
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const split = line.indexOf("=");
          assert.ok(split > 0, `unsupported step output: ${line}`);
          return [line.slice(0, split), line.slice(split + 1)];
        }),
    );
    const state = {
      ...result,
      outputs,
      outcome: result.status === 0 ? "success" : "failure",
    };
    states.set(id, state);
    return state;
  }
  const file = (name) => join(temp, "fork-qualification", name);
  const read = (name) => readFileSync(file(name), "utf8");
  const report = () => JSON.parse(read("qualification.json"));
  const ok = (id) => {
    const result = run(id);
    assert.equal(result.status, 0, `${id}: ${result.stdout}${result.stderr}`);
    return result;
  };
  function capture() {
    // Script-block probe only, not a GitHub scheduler. Actions are not executed.
    // assertSourceOrder separately checks the actual production sequence.
    ok("initialize");
    const source = run("source");
    if (source.status !== 0) return source;
    ok("integrity");
    const install = run("install");
    if (install.status === 0) ok("commands");
    return source;
  }
  function gate(overrides = {}) {
    // Artifact upload is an external GitHub action, not executed by this suite.
    states.set("upload", { outcome: "success", outputs: {} });
    return run(gateName, overrides);
  }
  return {
    root,
    temp,
    env,
    file,
    read,
    report,
    run,
    ok,
    capture,
    gate,
    states,
    calls: () =>
      existsSync(env.FIXTURE_CALLS)
        ? readFileSync(env.FIXTURE_CALLS, "utf8").trim().split("\n")
        : [],
  };
}

test("actual job eligibility admits only same-repository master dispatches", () => {
  assertJobEligibility(workflow);
});

test("actual source ordering verifies and snapshots before every setup or source-executing step", () => {
  assertSourceOrder(workflow);
});

const eligibilityLine = workflow.match(/^ {4}if: .+$/m)?.[0];
function replaceEligibility(value) {
  assert.ok(eligibilityLine, "expected checked-in eligibility fixture");
  return mutateOnce(eligibilityLine, `    if: ${value}`);
}

test("mutation sensitivity: bounded eligibility parser supports reordered and wrapped conjunctions", () => {
  const condition =
    "github.ref == 'refs/heads/master' && github.repository == 'TogetherWeOwn/paperclip' && github.event_name == 'workflow_dispatch'";
  assertJobEligibility(replaceEligibility(`\${{ ${condition} }}`));
  assert.equal(
    jobEligibility(workflow)({
      repository: "togetherweown/paperclip",
      event_name: "workflow_dispatch",
      ref: "refs/heads/master",
    }),
    true,
    "GitHub case-insensitive string comparison",
  );
});

for (const value of [
  "true",
  `\${{ true }}`,
  "always()",
  "",
  ">-",
  "github.repository != 'paperclipai/paperclip'",
  "github.repository == 'TogetherWeOwn/paperclip' || true",
  "github.repository == 'never' && contains(github.ref, 'master')",
  "github.unknown == 'value'",
  "github.repository == 'x'; process.exit(0)",
  "github.repository == 'TogetherWeOwn/paperclip'\n      || true",
]) {
  test(`mutation sensitivity: unsupported eligibility fails closed: ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => assertJobEligibility(replaceEligibility(value)),
      /unsupported.*(?:eligibility|syntax)/,
    );
  });
}

// Mutate only disposable text; the checked-in workflow is never rewritten.
function stepBlocks() {
  const [header, ...blocks] = workflow.split(/(?=^ {6}- name: )/m);
  assert.equal(
    blocks.length,
    12,
    "expected all production step fixtures including actions",
  );
  return { header, blocks };
}
function moveVerificationAfter(id) {
  const { header, blocks } = stepBlocks();
  const guards = blocks.filter((block) =>
    /^ {8}id: (source|integrity)$/m.test(block),
  );
  assert.equal(guards.length, 2);
  const rest = blocks.filter((block) => !guards.includes(block));
  const index = rest.findIndex((block) =>
    block.includes(`        id: ${id}\n`),
  );
  assert.ok(index >= 0, `missing mutation target: ${id}`);
  rest.splice(index + 1, 0, ...guards);
  return header + rest.join("");
}

function moveStepBefore(id, target) {
  const { header, blocks } = stepBlocks();
  const index = blocks.findIndex((block) =>
    block.includes(`        id: ${id}\n`),
  );
  assert.ok(index >= 0, `missing mutation step: ${id}`);
  const [step] = blocks.splice(index, 1);
  const destination = blocks.findIndex((block) =>
    block.includes(`        id: ${target}\n`),
  );
  assert.ok(destination >= 0, `missing mutation destination: ${target}`);
  blocks.splice(destination, 0, step);
  return header + blocks.join("");
}

test("mutation sensitivity: source ordering rejects missing or duplicate steps including action-only setup", () => {
  const { header, blocks } = stepBlocks();
  for (const block of blocks) {
    assert.throws(
      () =>
        assertSourceOrder(
          header + blocks.filter((entry) => entry !== block).join(""),
        ),
      /required steps must exist uniquely/,
    );
    assert.throws(
      () => assertSourceOrder(header + blocks.join("") + block),
      /duplicate step (?:name|id)/,
    );
  }
  assert.throws(
    () => assertSourceOrder(mutateOnce("        id: pnpm", "        id: node")),
    /duplicate step id: node/,
  );
});

test("mutation sensitivity: source ordering rejects unsupported step shapes rather than dropping them", () => {
  for (const [from, to] of [
    [
      "      - name: Set up Node without shared caches",
      "      - uses: unsupported/action@v1",
    ],
    ["        id: pnpm", "        id: pnpm\n        continue-on-error: true"],
    [
      "        run: |\n          evidence=",
      "        run: >-\n          evidence=",
    ],
    [
      "          package_json_file: source/package.json",
      "          package_json_file: {file: source/package.json}",
    ],
    ["        id: native", "        id: native\n        if: always()"],
    [
      "        id: commands",
      "        id: commands\n        uses: unknown/action@v1",
    ],
  ]) {
    // The literal-run prefix occurs more than once; change the first only.
    assert.ok(
      workflow.includes(from),
      `missing shape mutation target: ${from}`,
    );
    assert.throws(() => assertSourceOrder(workflow.replace(from, to)), {
      code: "ERR_ASSERTION",
    });
  }
});

for (const [name, mutant, probe, message] of [
  [
    "missing eligibility",
    () => mutateOnce(`${eligibilityLine}\n`, ""),
    assertJobEligibility,
    "explicit job eligibility condition",
  ],
  [
    "unconditional eligibility",
    () => replaceEligibility("true"),
    assertJobEligibility,
    "unsupported job eligibility syntax",
  ],
  ...["repository", "event_name", "ref"].map((key) => [
    `missing ${key} clause`,
    () =>
      replaceEligibility(
        eligibilityLine
          .slice("    if: ".length)
          .split(" && ")
          .filter((clause) => !clause.startsWith(`github.${key} `))
          .join(" && "),
      ),
    assertJobEligibility,
    "job eligibility:",
  ]),
  [
    "pnpm action before verification",
    () => moveStepBefore("pnpm", "source"),
    assertSourceOrder,
    "source must precede pnpm",
  ],
  [
    "pnpm action before integrity",
    () => moveStepBefore("pnpm", "integrity"),
    assertSourceOrder,
    "integrity must precede pnpm",
  ],
  [
    "verification before checkout",
    () => moveStepBefore("source", "checkout"),
    assertSourceOrder,
    "checkout must precede source",
  ],
  [
    "integrity before verification",
    () => moveStepBefore("integrity", "source"),
    assertSourceOrder,
    "source must precede integrity",
  ],
  ...["node", "pnpm", "install"].map((id) => [
    `verification after ${id}`,
    () => moveVerificationAfter(id),
    assertSourceOrder,
    "source must precede node",
  ]),
]) {
  test(`mutation sensitivity: ${name} is killed by ordinary control-flow assertions`, (t) => {
    assert.throws(
      () => probe(mutant()),
      (error) =>
        error.code === "ERR_ASSERTION" && error.message.includes(message),
    );
    t.diagnostic(`KILLED ${name}: ${message}`);
  });
}

function assertSourceRejected(f) {
  const source = f.capture();
  assert.notEqual(
    source.status,
    0,
    "source mismatch must fail before source commands",
  );
  assert.equal(source.outputs.verified, undefined);
  assert.deepEqual(
    f.calls(),
    [],
    "rejected source must not execute install or qualification commands",
  );
  f.ok("report");
  assert.equal(f.report().source_verified, false);
  assert.equal(f.report().qualified, false);
  assert.notEqual(f.gate().status, 0);
}

function assertFailedCommandRejected(f, failed) {
  f.capture();
  assert.deepEqual(
    f.calls(),
    ["install", "typecheck", "tests", "build", "migrations"],
    "every command must run once, in order, even after failure",
  );
  f.ok("report");
  const data = f.report();
  assert.equal(
    data.commands_outcome,
    "success",
    "capture step succeeds independently of source command exits",
  );
  assert.equal(data.source_verified, true);
  assert.equal(data.evidence_integrity, true);
  assert.equal(data.counts_available, true);
  assert.equal(data.counts_partial, failed === "tests");
  for (const [name, command] of commandSpecs) {
    const expected = name === failed ? 23 : 0;
    assert.equal(f.read(`${name}.exit-code`), `${expected}\n`);
    assert.equal(f.read(`${name}.log-exit-code`), "0\n");
    assert.equal(f.read(`${name}.command`), `${command}\n`);
    const entry = data.commands.find((item) => item.name === name);
    assert.equal(entry.exit_code, expected);
    assert.equal(entry.log_exit_code, 0);
    assert.equal(entry.command_matches, true);
    assert.equal(entry.log_bytes, Buffer.byteLength(f.read(`${name}.log`)));
    assert.match(
      f.read(`${name}.log`),
      new RegExp(`fixture ${name} stdout\\nfixture ${name} stderr`),
    );
  }
  assert.equal(
    data.qualified,
    false,
    "a nonzero command exit must not qualify",
  );
  assert.equal(f.states.get("report").outputs.qualified, "false");
  assert.notEqual(
    f.gate().status,
    0,
    "unqualified evidence must fail the final gate",
  );
}

function assertFinalRejected(f) {
  assert.notEqual(
    f.gate({
      QUALIFIED: "false",
      REPORT_OUTCOME: "success",
      UPLOAD_OUTCOME: "success",
    }).status,
    0,
    "unqualified evidence must fail the final gate",
  );
}

test("exact source pin captures four commands and qualifies only with a successful report and upload", (t) => {
  const f = fixture(t);
  f.capture();
  assert.equal(f.read("checked-out-source-sha.txt"), `${sourceSha}\n`);
  assert.equal(f.states.get("source").outputs.verified, "true");
  const manifest = readFileSync(
    join(f.temp, "fork-qualification-integrity/manifest.sha256"),
    "utf8",
  );
  for (const name of ["provenance.json", "checked-out-source-sha.txt"]) {
    assert.ok(
      manifest.includes(
        `${createHash("sha256").update(f.read(name)).digest("hex")}  ${name}\n`,
      ),
    );
  }
  assert.deepEqual(f.calls(), [
    "install",
    "typecheck",
    "tests",
    "build",
    "migrations",
  ]);
  f.ok("report");
  const data = f.report();
  assert.equal(data.schema_version, 1);
  assert.equal(data.expected_source_sha, sourceSha);
  assert.equal(data.verified_source_sha, sourceSha);
  assert.equal(data.source_url, `${repoUrl}/commit/${sourceSha}`);
  assert.equal(data.workflow_sha, workflowSha);
  assert.notEqual(data.workflow_sha, data.verified_source_sha);
  assert.equal(
    data.workflow_ref,
    "TogetherWeOwn/paperclip/.github/workflows/fork-pinned-qualification.yml@refs/heads/master",
  );
  assert.equal(
    data.workflow_url,
    `${repoUrl}/blob/${workflowSha}/.github/workflows/fork-pinned-qualification.yml`,
  );
  assert.equal(data.dispatch_ref, "refs/heads/master");
  assert.equal(data.run_url, `${repoUrl}/actions/runs/123456`);
  assert.equal(data.run_id, "123456");
  assert.equal(data.run_attempt, "2");
  assert.equal(data.source_verified, true);
  assert.equal(data.evidence_integrity, true);
  assert.equal(data.install_outcome, "success");
  assert.equal(data.commands_outcome, "success");
  assert.deepEqual(data.suite_test_summaries, summaries);
  assert.equal(data.counts_available, true);
  assert.equal(data.counts_partial, false);
  assert.deepEqual(
    data.commands,
    commandSpecs.map(([name, command]) => ({
      name,
      command,
      exit_code: 0,
      log_exit_code: 0,
      log: `${name}.log`,
      log_bytes: Buffer.byteLength(f.read(`${name}.log`)),
      command_matches: true,
    })),
  );
  for (const [name, command] of commandSpecs) {
    assert.equal(f.read(`${name}.command`), `${command}\n`);
    assert.equal(f.read(`${name}.exit-code`), "0\n");
    assert.equal(f.read(`${name}.log-exit-code`), "0\n");
    assert.match(
      f.read(`${name}.log`),
      new RegExp(`fixture ${name} stdout\\nfixture ${name} stderr`),
    );
  }
  assert.equal(data.qualified, true);
  assert.equal(f.states.get("report").outputs.qualified, "true");
  assert.match(data.next_action, /release gates remain separate/);
  assert.match(f.read("summary.md"), /Result: QUALIFIED/);
  assert.ok(f.read("summary.md").includes(summaries.join("\n")));
  assert.equal(f.gate().status, 0);
  assert.equal(
    readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8"),
    f.read("summary.md"),
  );
});

test("source script rejects mismatched SHA before fixture command execution", (t) =>
  assertSourceRejected(fixture(t, workflow, { sourceSha: otherSha })));
test("source script rejects wrong remote before fixture command execution", (t) =>
  assertSourceRejected(
    fixture(t, workflow, { remote: "https://github.com/example/wrong" }),
  ));

for (const [name] of commandSpecs) {
  test(`${name} nonzero exit preserves every result and rejects qualification`, (t) =>
    assertFailedCommandRejected(
      fixture(t, workflow, { failCommand: name }),
      name,
    ));
}

test("failed install skips source commands but still reports and rejects qualification", (t) => {
  const f = fixture(t, workflow, { failCommand: "install" });
  f.capture();
  assert.equal(f.states.get("install").status, 1);
  assert.equal(f.read("install.exit-code"), "23\n");
  assert.equal(f.read("install.log-exit-code"), "0\n");
  assert.match(f.read("install.log"), /fixture install stdout/);
  assert.deepEqual(f.calls(), ["install"]);
  f.ok("report");
  assert.equal(f.report().install_outcome, "failure");
  assert.equal(f.report().commands_outcome, "skipped");
  assert.equal(f.report().qualified, false);
  assert.notEqual(f.gate().status, 0);
});

const evidenceCases = [
  [
    "missing command exit",
    "build.exit-code",
    null,
    (d) => assert.equal(d.commands[2].exit_code, null),
  ],
  [
    "malformed command exit",
    "build.exit-code",
    "not-a-code\n",
    (d) => assert.equal(d.commands[2].exit_code, null),
  ],
  [
    "negative command exit",
    "build.exit-code",
    "-1\n",
    (d) => assert.equal(d.commands[2].exit_code, null),
  ],
  [
    "oversized command exit",
    "build.exit-code",
    "1000\n",
    (d) => assert.equal(d.commands[2].exit_code, null),
  ],
  [
    "missing log capture exit",
    "build.log-exit-code",
    null,
    (d) => assert.equal(d.commands[2].log_exit_code, null),
  ],
  [
    "malformed log capture exit",
    "build.log-exit-code",
    "\n",
    (d) => assert.equal(d.commands[2].log_exit_code, null),
  ],
  [
    "failed log capture",
    "build.log-exit-code",
    "1\n",
    (d) => assert.equal(d.commands[2].log_exit_code, 1),
  ],
  [
    "empty log",
    "build.log",
    "",
    (d) => assert.equal(d.commands[2].log_bytes, 0),
  ],
  [
    "missing log",
    "build.log",
    null,
    (d) => assert.equal(d.commands[2].log_bytes, 0),
  ],
  [
    "missing command",
    "build.command",
    null,
    (d) => assert.equal(d.commands[2].command_matches, false),
  ],
  [
    "mismatched command",
    "build.command",
    "pnpm wrong\n",
    (d) => assert.equal(d.commands[2].command_matches, false),
  ],
  [
    "unavailable counts",
    "tests.log",
    "No test summary available\n",
    (d) => {
      assert.equal(d.counts_available, false);
      assert.deepEqual(d.suite_test_summaries, []);
    },
  ],
  [
    "missing integrity",
    "../fork-qualification-integrity/manifest.sha256",
    null,
    (d) => assert.equal(d.evidence_integrity, false),
  ],
  [
    "empty integrity",
    "../fork-qualification-integrity/manifest.sha256",
    "",
    (d) => assert.equal(d.evidence_integrity, false),
  ],
  [
    "malformed integrity",
    "../fork-qualification-integrity/manifest.sha256",
    "invalid manifest line\n",
    (d) => assert.equal(d.evidence_integrity, false),
  ],
  [
    "mismatched integrity",
    "../fork-qualification-integrity/manifest.sha256",
    `${"0".repeat(64)}  provenance.json\n`,
    (d) => assert.equal(d.evidence_integrity, false),
  ],
  [
    "missing verified SHA",
    "checked-out-source-sha.txt",
    null,
    (d) => {
      assert.equal(d.verified_source_sha, null);
      assert.equal(d.source_verified, false);
      assert.equal(d.evidence_integrity, false);
    },
  ],
  [
    "tampered verified SHA",
    "checked-out-source-sha.txt",
    `${otherSha}\n`,
    (d) => {
      assert.equal(d.verified_source_sha, otherSha);
      assert.equal(d.source_verified, false);
      assert.equal(d.evidence_integrity, false);
    },
  ],
  [
    "missing provenance",
    "provenance.json",
    null,
    (d) => assert.equal(d.evidence_integrity, false),
  ],
];
for (const [name, path, content, check] of evidenceCases) {
  test(`${name} fails closed with an inspectable negative report`, (t) => {
    const f = fixture(t);
    f.capture();
    if (content === null) rmSync(f.file(path));
    else writeFileSync(f.file(path), content);
    f.ok("report");
    const data = f.report();
    check(data);
    assert.equal(data.qualified, false);
    assert.equal(f.states.get("report").outputs.qualified, "false");
    assert.match(f.read("summary.md"), /Result: NOT QUALIFIED/);
    assert.match(data.next_action, /Not qualified/);
    assert.notEqual(f.gate().status, 0);
  });
}

test("tampered provenance fails integrity even when valid JSON", (t) => {
  const f = fixture(t);
  f.capture();
  const data = JSON.parse(f.read("provenance.json"));
  data.workflow_sha = otherSha;
  writeFileSync(f.file("provenance.json"), JSON.stringify(data));
  f.ok("report");
  assert.equal(f.report().workflow_sha, otherSha);
  assert.equal(f.report().evidence_integrity, false);
  assert.equal(f.report().qualified, false);
  assert.notEqual(f.gate().status, 0);
});

test("report failure rejects the final gate even with a qualified output and successful upload", (t) => {
  const f = fixture(t);
  f.capture();
  writeFileSync(f.file("provenance.json"), "{invalid json");
  const result = f.run("report");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JSONDecodeError/);
  assert.equal(existsSync(f.file("qualification.json")), false);
  assert.equal(result.outputs.qualified, undefined);
  assert.notEqual(f.gate({ QUALIFIED: "true" }).status, 0);
});

test("missing report output rejects the final gate even after a successful report and upload", (t) => {
  const f = fixture(t);
  f.capture();
  f.ok("report");
  assert.equal(f.report().qualified, true);
  delete f.states.get("report").outputs.qualified;
  assert.notEqual(f.gate().status, 0);
});

for (const outcome of ["failure", "cancelled", "skipped", ""]) {
  test(`upload outcome ${outcome || "missing"} rejects otherwise qualified evidence`, (t) => {
    const f = fixture(t);
    f.capture();
    f.ok("report");
    assert.equal(f.report().qualified, true);
    assert.equal(f.states.get("report").outcome, "success");
    assert.notEqual(f.gate({ UPLOAD_OUTCOME: outcome }).status, 0);
  });
}

test("false qualified output rejects the final gate independently of report/upload success", (t) =>
  assertFinalRejected(fixture(t)));

function mutateOnce(from, to) {
  assert.equal(
    workflow.split(from).length,
    2,
    "mutation must replace exactly one checked-in guard",
  );
  return workflow.replace(from, to);
}

// Run each mutant directly through the same behavioral assertion. No nested
// node --test invocations, retries, or writes to the real workflow are needed.
for (const [name, from, to, probe, message] of [
  [
    "source equality",
    `test "$actual" = ${sourceSha}`,
    ":",
    (f) => assertSourceRejected(f),
    "source mismatch must fail before source commands",
  ],
  [
    "command exit",
    "c['exit_code'] == 0 and ",
    "",
    (f) => assertFailedCommandRejected(f, "build"),
    "a nonzero command exit must not qualify",
  ],
  [
    "qualified gate",
    'test "$QUALIFIED" = true',
    ":",
    (f) => assertFinalRejected(f),
    "unqualified evidence must fail the final gate",
  ],
]) {
  test(`mutation sensitivity: removing ${name} guard is killed by behavioral assertions`, (t) => {
    const f = fixture(t, mutateOnce(from, to), {
      sourceSha: name === "source equality" ? otherSha : sourceSha,
      failCommand: name === "command exit" ? "build" : "",
    });
    assert.throws(
      () => probe(f),
      (error) =>
        error.code === "ERR_ASSERTION" && error.message.includes(message),
    );
    t.diagnostic(`KILLED ${name}: ${message}`);
  });
}
