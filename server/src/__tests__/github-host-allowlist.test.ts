import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGitHubSourceUrl as parsePortabilityGitHubSourceUrl } from "../services/company-portability.js";
import { parseGitHubSourceUrl as parseSkillGitHubSourceUrl } from "../services/company-skills.js";
import {
  assertAllowedGitHubHost,
  disallowedGitHubHostMessage,
  GITHUB_ENTERPRISE_HOSTS_ENV_VAR,
  getAdditionalGitHubHosts,
  isAllowedGitHubHost,
} from "../services/github-fetch.js";

describe("GitHub host allowlist", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses the operator-configured enterprise hosts", () => {
    expect(getAdditionalGitHubHosts({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(
      getAdditionalGitHubHosts({
        [GITHUB_ENTERPRISE_HOSTS_ENV_VAR]:
          "ghe.example.com, GHE2.EXAMPLE.COM.,, ghe.example.com",
      } as NodeJS.ProcessEnv),
    ).toEqual(["ghe.example.com", "ghe2.example.com"]);
  });

  it("always allows github.com and denies everything else by default", () => {
    for (const host of [
      "github.com",
      "GitHub.com",
      "www.github.com",
      "github.com.",
      " www.GITHUB.com ",
    ]) {
      expect(isAllowedGitHubHost(host, {} as NodeJS.ProcessEnv)).toBe(true);
    }
    for (const host of [
      "",
      "  ",
      "evil.example.com",
      "github.com.evil.com",
      "api.github.com",
      "raw.githubusercontent.com",
      "127.0.0.1",
    ]) {
      expect(isAllowedGitHubHost(host, {} as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it("allows operator-configured enterprise hosts case-insensitively", () => {
    const env = {
      [GITHUB_ENTERPRISE_HOSTS_ENV_VAR]: "Ghe.Example.com",
    } as NodeJS.ProcessEnv;
    expect(isAllowedGitHubHost("ghe.example.com", env)).toBe(true);
    expect(isAllowedGitHubHost("GHE.EXAMPLE.COM", env)).toBe(true);
    expect(isAllowedGitHubHost("other.example.com", env)).toBe(false);
  });

  it("asserts with an actionable operator message", () => {
    expect(() =>
      assertAllowedGitHubHost("github.com", {} as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(() =>
      assertAllowedGitHubHost("evil.example.com", {} as NodeJS.ProcessEnv),
    ).toThrow(disallowedGitHubHostMessage("evil.example.com"));
    expect(disallowedGitHubHostMessage("evil.example.com")).toContain(
      "PAPERCLIP_GITHUB_ENTERPRISE_HOSTS",
    );
  });

  it("pins skill import source hosts to the allowlist", () => {
    expect(
      parseSkillGitHubSourceUrl("https://github.com/acme/app").hostname,
    ).toBe("github.com");
    expect(() =>
      parseSkillGitHubSourceUrl("https://evil.example.com/acme/app"),
    ).toThrow(/GitHub host "evil\.example\.com" is not allowed/);
    vi.stubEnv(GITHUB_ENTERPRISE_HOSTS_ENV_VAR, "ghe.example.com");
    expect(
      parseSkillGitHubSourceUrl(
        "https://ghe.example.com/acme/app/tree/main/skills",
      ).hostname,
    ).toBe("ghe.example.com");
  });

  it("pins company import source hosts to the allowlist", () => {
    expect(
      parsePortabilityGitHubSourceUrl("https://github.com/acme/app").hostname,
    ).toBe("github.com");
    expect(() =>
      parsePortabilityGitHubSourceUrl("https://evil.example.com/acme/app"),
    ).toThrow(/GitHub host "evil\.example\.com" is not allowed/);
    vi.stubEnv(GITHUB_ENTERPRISE_HOSTS_ENV_VAR, "ghe.example.com");
    expect(
      parsePortabilityGitHubSourceUrl("https://ghe.example.com/acme/app")
        .hostname,
    ).toBe("ghe.example.com");
  });
});
