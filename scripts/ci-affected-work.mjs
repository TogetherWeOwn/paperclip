import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const docsOnly = (file) => /^doc\/.+\.md$/.test(file) || /^(README|CONTRIBUTING)\.md$/.test(file);

export function affectedWork(event, scope, files) {
  if (!["docker", "smoke", "release", "workflows", "pr"].includes(scope)) throw new Error(`Unknown CI scope: ${scope}`);
  // Master pushes, schedules, and explicitly selected reusable/dispatch runs
  // verify the full scope. Only PRs may omit unaffected work.
  if (event !== "pull_request") return true;
  // Fail closed: only docs-only diffs skip, for every scope; an empty diff cannot be verified.
  return files.length === 0 || !files.every(docsOnly);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.CI_EVENT;
  let files = [];
  if (event === "pull_request") {
    const { CI_BASE_SHA: base, CI_HEAD_SHA: head } = process.env;
    if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha || ""))) throw new Error("PR scope requires immutable base/head SHAs");
    files = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`], { encoding: "utf8" }).split("\0").filter(Boolean);
  }
  const affected = affectedWork(event, process.env.CI_SCOPE, files);
  appendFileSync(process.env.GITHUB_OUTPUT, `affected=${affected}\n`);
  console.log(`${process.env.CI_SCOPE}: affected=${affected} (${event})`);
}
