#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIRROR_BASE_REF = /^(?:mirror\/base-|mirror-base\/|mirror\/upstream-)/;

export function isMirrorBaseRef(baseRef) {
  return MIRROR_BASE_REF.test(baseRef);
}

export function readHeadGroups(headRoot) {
  try {
    const output = execFileSync(
      process.execPath,
      ["scripts/run-vitest-stable.mjs", "--mode", "general", "--dry-run"],
      { cwd: headRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const plan = JSON.parse(output);
    if (!Array.isArray(plan.availableGeneralGroups)) {
      return {
        ok: false,
        error: "dry-run output has no availableGeneralGroups",
      };
    }
    return { ok: true, groups: plan.availableGeneralGroups };
  } catch (error) {
    return { ok: false, error: error.message.split("\n")[0] };
  }
}

export function decideGroup({ baseRef, group, probe }) {
  if (!isMirrorBaseRef(baseRef)) {
    return { run: true, message: `ordinary pull request; running ${group}` };
  }
  if (!probe.ok) {
    return {
      run: true,
      message: `PR head group list unreadable (${probe.error}); running ${group}`,
    };
  }
  if (probe.groups.includes(group)) {
    return { run: true, message: `PR head defines ${group}; running it` };
  }
  return {
    run: false,
    message: `PR head does not define ${group}; skipped, not passed`,
  };
}

function escapeWorkflowCommand(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function parseArgs(argv) {
  const args = { baseRef: "", group: "", headRoot: "." };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`${key} needs a value`);
    }
    if (key === "--base-ref") args.baseRef = value;
    else if (key === "--group") args.group = value;
    else if (key === "--head-root") args.headRoot = value;
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!args.group) {
    throw new Error("--group is required");
  }
  return args;
}

function main() {
  const { baseRef, group, headRoot } = parseArgs(process.argv.slice(2));
  const probe = isMirrorBaseRef(baseRef)
    ? readHeadGroups(headRoot)
    : { ok: true, groups: [] };
  const decision = decideGroup({ baseRef, group, probe });

  console.log(
    `::notice title=General tests (${group})::${escapeWorkflowCommand(decision.message)}`,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `- \`${group}\`: ${decision.message}\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `::error title=General group resolver::${escapeWorkflowCommand(error.message)}`,
    );
    process.exit(1);
  }
}
