import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function affectedWork(event, scope, files) {
  if (!["docker", "smoke", "release", "workflows"].includes(scope)) throw new Error(`Unknown CI scope: ${scope}`);
  // Master pushes, schedules, and explicitly selected reusable/dispatch runs
  // verify the full scope. Only PRs may omit unaffected work.
  if (event !== "pull_request") return true;
  const all = (file) => file.startsWith(".github/") || file.startsWith("patches/") ||
    /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|Cargo\.(toml|lock)|rust-toolchain\.toml)$/.test(file);
  if (files.some(all)) return true;
  const product = /^(server|ui|cli|packages|docker|scripts|tests)\//;
  const docker = /^(Dockerfile|\.dockerignore|docker\/|server\/|ui\/|cli\/|packages\/|scripts\/)/;
  const workflows = /^scripts\/(ci-|source-onboard-smoke|docker-onboard-smoke|service-onboard-smoke)/;
  return files.some((file) => (scope === "workflows" ? workflows : scope === "docker" ? docker : product).test(file));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.CI_EVENT;
  let files = [];
  if (event === "pull_request") {
    const { CI_BASE_SHA: base, CI_HEAD_SHA: head } = process.env;
    if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha || ""))) throw new Error("PR scope requires immutable base/head SHAs");
    files = execFileSync("git", ["diff", "--name-only", "-z", `${base}...${head}`], { encoding: "utf8" }).split("\0").filter(Boolean);
  }
  const affected = affectedWork(event, process.env.CI_SCOPE, files);
  appendFileSync(process.env.GITHUB_OUTPUT, `affected=${affected}\n`);
  console.log(`${process.env.CI_SCOPE}: affected=${affected} (${event})`);
}
