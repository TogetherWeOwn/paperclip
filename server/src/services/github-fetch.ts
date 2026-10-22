import { unprocessable } from "../errors.js";

export function normalizeGitHubHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function isGitHubDotCom(hostname: string) {
  const h = normalizeGitHubHostname(hostname);
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

/**
 * Operator-configured GitHub Enterprise hostnames (comma-separated hostnames).
 * github.com is always allowed; every other GitHub host a caller fetches must be
 * listed here. Callers enforce this with `assertAllowedGitHubHost` before they
 * build an API/raw URL from an operator- or member-supplied hostname.
 */
export const GITHUB_ENTERPRISE_HOSTS_ENV_VAR =
  "PAPERCLIP_GITHUB_ENTERPRISE_HOSTS";

export function getAdditionalGitHubHosts(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env[GITHUB_ENTERPRISE_HOSTS_ENV_VAR];
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((entry) => normalizeGitHubHostname(entry))
        .filter((entry) => entry.length > 0),
    ),
  ];
}

export function isAllowedGitHubHost(
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalized = normalizeGitHubHostname(hostname);
  if (!normalized) return false;
  if (isGitHubDotCom(normalized)) return true;
  return getAdditionalGitHubHosts(env).includes(normalized);
}

export function disallowedGitHubHostMessage(hostname: string): string {
  return `GitHub host "${hostname}" is not allowed. Add it to ${GITHUB_ENTERPRISE_HOSTS_ENV_VAR} (comma-separated) to permit GitHub Enterprise hosts.`;
}

export function assertAllowedGitHubHost(
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isAllowedGitHubHost(hostname, env)) return;
  throw unprocessable(disallowedGitHubHostMessage(hostname));
}

// ghFetch itself stays a generic fetch wrapper on purpose: acceptance tests
// fetch loopback stub servers through it, and GitHub Enterprise hosts are
// arbitrary customer hostnames, so no honest sink-side allowlist exists here.
// URL provenance is enforced at the callers instead — every caller that builds
// a URL from an operator- or member-supplied hostname pins it with
// `assertAllowedGitHubHost` (arbitrary hosts) or a github.com runtime guard
// (auth-bearing resolvers) before fetching.
export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
