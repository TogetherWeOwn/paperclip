import { describe, expect, it, beforeEach } from "vitest";
import {
  __clearGithubBotTokenCacheForTests,
  __installationTokenTestSeams,
  evictGithubBotRepositoryToken,
} from "./chat-github-client.js";

const base = {
  companyId: "company-test",
  endpointId: "endpoint-test",
  installationId: "12345",
  repositoryId: "678",
};

describe("github installation token cache", () => {
  beforeEach(() => {
    __clearGithubBotTokenCacheForTests();
  });

  it("reuses a fresh token without reissuing", () => {
    const key = __installationTokenTestSeams.key(base);
    __installationTokenTestSeams.store(key, "ghs-test-only", Date.now() + 3_600_000);
    expect(__installationTokenTestSeams.read(key, Date.now())).toBe("ghs-test-only");
  });

  it("treats tokens inside the expiry skew as expired", () => {
    const key = __installationTokenTestSeams.key(base);
    __installationTokenTestSeams.store(key, "ghs-test-only", Date.now() + 30_000);
    expect(__installationTokenTestSeams.read(key, Date.now())).toBeNull();
  });

  it("expires past tokens and scopes keys per repository", () => {
    const key = __installationTokenTestSeams.key(base);
    __installationTokenTestSeams.store(key, "ghs-test-only", Date.now() - 1_000);
    expect(__installationTokenTestSeams.read(key, Date.now())).toBeNull();
    const other = __installationTokenTestSeams.key({ ...base, repositoryId: "679" });
    __installationTokenTestSeams.store(other, "ghs-other", Date.now() + 3_600_000);
    expect(__installationTokenTestSeams.read(other, Date.now())).toBe("ghs-other");
    expect(__installationTokenTestSeams.read(key, Date.now())).toBeNull();
  });

  it("never stores token material in the key", () => {
    const key = __installationTokenTestSeams.key(base);
    expect(key).not.toContain("ghs-test-only");
  });

  it("evicts only the revoked repository without touching others", () => {
    const key = __installationTokenTestSeams.key(base);
    const sameRepoNewInstall = __installationTokenTestSeams.key({ ...base, installationId: "99999" });
    const otherRepo = __installationTokenTestSeams.key({ ...base, repositoryId: "679" });
    __installationTokenTestSeams.store(key, "ghs-test-only", Date.now() + 3_600_000);
    __installationTokenTestSeams.store(sameRepoNewInstall, "ghs-test-new", Date.now() + 3_600_000);
    __installationTokenTestSeams.store(otherRepo, "ghs-other", Date.now() + 3_600_000);
    expect(
      evictGithubBotRepositoryToken({
        companyId: base.companyId,
        endpointId: base.endpointId,
        repositoryId: base.repositoryId,
      }),
    ).toBe(2);
    expect(__installationTokenTestSeams.read(key, Date.now())).toBeNull();
    expect(__installationTokenTestSeams.read(sameRepoNewInstall, Date.now())).toBeNull();
    expect(__installationTokenTestSeams.read(otherRepo, Date.now())).toBe("ghs-other");
  });

  it("evicting an uncached repository is a no-op", () => {
    expect(
      evictGithubBotRepositoryToken({
        companyId: base.companyId,
        endpointId: base.endpointId,
        repositoryId: "000",
      }),
    ).toBe(0);
  });
});
