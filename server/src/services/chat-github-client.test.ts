import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  __clearGithubBotTokenCacheForTests,
  githubBotRepositoryRequest,
  githubBotRepositoryToken,
} from "./chat-github-client.js";
import { githubGreenReviewContext } from "./chat-github-green-gate.js";
import { readGitHubReviewProvenance } from "./chat-github-review-trust.js";

const mocks = vi.hoisted(() => ({ resolveSecretValue: vi.fn() }));
vi.mock("./secrets.js", () => ({
  secretService: () => ({ resolveSecretValue: mocks.resolveSecretValue }),
}));

// Disposable signing material generated locally; no configured credentials or network.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const HEAD = "b".repeat(40);
const REPOSITORY_ID = "42";
const credentials: Record<string, string> = {
  appId: "123",
  installationId: "456",
  privateKey,
};

function fixture(reviewRows: unknown[] = [], deliveryRows: unknown[] = []) {
  const connection = {
    id: "connection",
    enabled: true,
    status: "active",
    credentialSecretRefs: Object.keys(credentials).map((key) => ({
      configPath: `credentials.${key}`,
      secretId: key,
    })),
  };
  const where = vi.fn()
    .mockResolvedValueOnce([{ endpoint: { status: "active" }, connection }])
    .mockResolvedValueOnce(reviewRows)
    .mockResolvedValueOnce(deliveryRows);
  const query = { from: vi.fn(), innerJoin: vi.fn(), where };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  const db = { select: vi.fn().mockReturnValue(query) } as unknown as Db;
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/app/installations/456/access_tokens") {
      return Response.json({ token: "test-installation-token" });
    }
    if (path === "/repos/acme/app/pulls/7") {
      return Response.json({
        state: "open", draft: false, number: 7, title: "Test PR", body: null,
        base: { sha: "a".repeat(40), ref: "main" }, head: { sha: HEAD },
        user: { id: 99, login: "author" }, labels: [],
      });
    }
    if (path === "/repos/acme/app/rules/branches/main") {
      return Response.json([{
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci-ok" }] },
      }]);
    }
    if (path === `/repos/acme/app/commits/${HEAD}/check-runs`) {
      return Response.json({
        total_count: 1,
        check_runs: [{ name: "ci-ok", status: "completed", conclusion: "success" }],
      });
    }
    throw new Error(`Unexpected test request: ${path}`);
  });
  return { db, fetchImpl, connection };
}

// DB stub for token/helper tests: every credential lookup resolves, so any
// number of token issuances (retries, concurrent, bound-fill) works without
// counting `where` calls. Callers that also query review/delivery rows use
// fixture() above instead.
function tokenFixture() {
  const connection = {
    id: "connection",
    enabled: true,
    status: "active",
    credentialSecretRefs: Object.keys(credentials).map((key) => ({
      configPath: `credentials.${key}`,
      secretId: key,
    })),
  };
  const where = vi.fn().mockResolvedValue([{ endpoint: { status: "active" }, connection }]);
  const query = { from: vi.fn(), innerJoin: vi.fn(), where };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  const db = { select: vi.fn().mockReturnValue(query) } as unknown as Db;
  return { db, connection };
}

const FUTURE_EXPIRY = new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  mocks.resolveSecretValue.mockReset();
  mocks.resolveSecretValue.mockImplementation(async (_company, key: string) => credentials[key]);
  // The installation token cache is module-level: clear it so each test's
  // fetch-count assertions observe a fresh issuance instead of a hit cached
  // by an earlier test in this file.
  __clearGithubBotTokenCacheForTests();
});

describe("repository App token permissions", () => {
  it("keeps the publisher's default write permissions scoped to one repository", async () => {
    const f = fixture();
    await githubBotRepositoryToken(f.db, "company", "endpoint", REPOSITORY_ID, f.fetchImpl);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = f.fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({
      repository_ids: [42],
      permissions: {
        contents: "read", metadata: "read", issues: "write",
        pull_requests: "write", checks: "write",
      },
    });
  });

  it("green eligibility requests only metadata, PRs and checks read access", async () => {
    const f = fixture();
    const result = await githubGreenReviewContext({
      db: f.db, fetchImpl: f.fetchImpl, companyId: "company", endpointId: "endpoint",
      repositoryId: REPOSITORY_ID, repository: "acme/app", pullNumber: 7,
    });
    expect(result.ready).toBe(true);
    expect(JSON.parse(String(f.fetchImpl.mock.calls[0]![1]?.body))).toEqual({
      repository_ids: [42],
      permissions: { metadata: "read", pull_requests: "read", checks: "read" },
    });
    expect(f.fetchImpl.mock.calls.slice(1).map(([, request]) => request?.method)).toEqual([
      "GET", "GET", "GET",
    ]);
  });

  it("does not mint a token for an inactive connection", async () => {
    const f = fixture();
    f.connection.enabled = false;
    await expect(githubBotRepositoryToken(
      f.db, "company", "endpoint", REPOSITORY_ID, f.fetchImpl, "read",
    )).rejects.toThrow("GitHub bot connection is not active");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not fall back to write access when GitHub rejects the read token", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(githubBotRepositoryToken(
      f.db, "company", "endpoint", REPOSITORY_ID, f.fetchImpl, "read",
    )).rejects.toThrow("GitHub rejected this operation (HTTP 403)");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("green review exhaustion outcome", () => {
  it.each(["error", "incomplete"])(
    "reports already_reviewed after three %s attempts without checking CI again",
    async (state) => {
      const base = `checks-green:${REPOSITORY_ID}:7:${HEAD}`;
      const deliveryRows = [1, 2, 3].map((attempt) => ({
        id: `delivery-row-${attempt}`,
        state: "processed",
        deliveryId: attempt === 1 ? base : `${base}:attempt-${attempt}`,
      }));
      const reviewRows = deliveryRows.map(({ id }) => ({ state, deliveryId: id }));
      const f = fixture(reviewRows, deliveryRows);
      expect(await githubGreenReviewContext({
        db: f.db, fetchImpl: f.fetchImpl, companyId: "company", endpointId: "endpoint",
        repositoryId: REPOSITORY_ID, repository: "acme/app", pullNumber: 7,
      })).toEqual({ ready: false, outcome: { status: "already_reviewed", headSha: HEAD } });
      expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
});

describe("installation token cache wiring through the public function", () => {
  it("serves the second sequential call from cache with one issuance POST", async () => {
    const f = tokenFixture();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ token: "ghs-seq-only", expires_at: FUTURE_EXPIRY }),
    );
    const first = await githubBotRepositoryToken(f.db, "company", "endpoint", REPOSITORY_ID, fetchImpl);
    const second = await githubBotRepositoryToken(f.db, "company", "endpoint", REPOSITORY_ID, fetchImpl);
    expect(first).toBe("ghs-seq-only");
    expect(second).toBe("ghs-seq-only");
    // Deleting the `if (cached) return cached` lookup mints per call again
    // (the original 16s p50 / 504 bug) and this count becomes 2.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares one issuance POST across concurrent callers (single-flight)", async () => {
    const f = tokenFixture();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ token: "ghs-flight-only", expires_at: FUTURE_EXPIRY });
    });
    const [a, b] = await Promise.all([
      githubBotRepositoryToken(f.db, "company", "endpoint", REPOSITORY_ID, fetchImpl),
      githubBotRepositoryToken(f.db, "company", "endpoint", REPOSITORY_ID, fetchImpl),
    ]);
    expect(a).toBe("ghs-flight-only");
    expect(b).toBe("ghs-flight-only");
    // Deleting the inflight block issues twice; the delay guarantees overlap.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest entry through the public function at the 500-entry bound", async () => {
    const f = tokenFixture();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String((init as { body?: unknown })?.body));
      return Response.json({ token: `ghs-${body.repository_ids[0]}`, expires_at: FUTURE_EXPIRY });
    });
    for (let i = 0; i < 500; i++) {
      await githubBotRepositoryToken(f.db, "company", "endpoint", String(100000 + i), fetchImpl);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(500);
    await githubBotRepositoryToken(f.db, "company", "endpoint", "100500", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(501);
    // Oldest evicted: re-issues. Newest still cached: no new POST. Deleting
    // the bound loop keeps the oldest cached and the next count stays 501.
    await githubBotRepositoryToken(f.db, "company", "endpoint", "100000", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(502);
    await githubBotRepositoryToken(f.db, "company", "endpoint", "100500", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(502);
  }, 30000);
});

describe("repository request 401 recovery", () => {
  it("evicts and retries once with a fresh token after a 401", async () => {
    const f = tokenFixture();
    let tokenPosts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app/installations/456/access_tokens") {
        tokenPosts += 1;
        return Response.json({ token: `ghs-retry-${tokenPosts}`, expires_at: FUTURE_EXPIRY });
      }
      if (path === "/repos/acme/app/pulls/7") {
        const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
        if (auth === "Bearer ghs-retry-1") return new Response(null, { status: 401 });
        return Response.json({ ok: true, auth });
      }
      throw new Error(`Unexpected test request: ${path}`);
    });
    const result = await githubBotRepositoryRequest<{ ok: boolean; auth: string }>(
      f.db, "company", "endpoint", REPOSITORY_ID, "/repos/acme/app/pulls/7", {}, fetchImpl,
    );
    expect(result).toEqual({ ok: true, auth: "Bearer ghs-retry-2" });
    expect(tokenPosts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // The fresh token is cached: the next request is one GET, no new POST.
    // Reverting the catch block to a plain rethrow throws the 401 here instead.
    await githubBotRepositoryRequest(f.db, "company", "endpoint", REPOSITORY_ID, "/repos/acme/app/pulls/7", {}, fetchImpl);
    expect(tokenPosts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("propagates a second consecutive 401 without a third issuance", async () => {
    const f = tokenFixture();
    let tokenPosts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app/installations/456/access_tokens") {
        tokenPosts += 1;
        return Response.json({ token: `ghs-retry-${tokenPosts}`, expires_at: FUTURE_EXPIRY });
      }
      if (path === "/repos/acme/app/pulls/7") return new Response(null, { status: 401 });
      throw new Error(`Unexpected test request: ${path}`);
    });
    await expect(
      githubBotRepositoryRequest(f.db, "company", "endpoint", REPOSITORY_ID, "/repos/acme/app/pulls/7", {}, fetchImpl),
    ).rejects.toThrow("GitHub rejected this operation (HTTP 401)");
    expect(tokenPosts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("green eligibility retries the PR read once after a 401", async () => {
    const connection = {
      id: "connection",
      enabled: true,
      status: "active",
      credentialSecretRefs: Object.keys(credentials).map((key) => ({
        configPath: `credentials.${key}`,
        secretId: key,
      })),
    };
    const credRow = [{ endpoint: { status: "active" }, connection }];
    // Two credential resolutions (initial + post-401 refresh), then the
    // green-attempt review/delivery rows.
    const where = vi.fn()
      .mockResolvedValueOnce(credRow)
      .mockResolvedValueOnce(credRow)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const query = { from: vi.fn(), innerJoin: vi.fn(), where };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    const db = { select: vi.fn().mockReturnValue(query) } as unknown as Db;
    let tokenPosts = 0;
    let prGets = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app/installations/456/access_tokens") {
        tokenPosts += 1;
        return Response.json({ token: `ghs-green-${tokenPosts}` });
      }
      if (path === "/repos/acme/app/pulls/7") {
        prGets += 1;
        if (prGets === 1) return new Response(null, { status: 401 });
        return Response.json({
          state: "open", draft: false, number: 7, title: "Test PR", body: null,
          base: { sha: "a".repeat(40), ref: "main" }, head: { sha: HEAD },
          user: { id: 99, login: "author" }, labels: [],
        });
      }
      if (path === "/repos/acme/app/rules/branches/main") {
        return Response.json([{
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci-ok" }] },
        }]);
      }
      if (path === `/repos/acme/app/commits/${HEAD}/check-runs`) {
        return Response.json({
          total_count: 1,
          check_runs: [{ name: "ci-ok", status: "completed", conclusion: "success" }],
        });
      }
      throw new Error(`Unexpected test request: ${path}`);
    });
    const result = await githubGreenReviewContext({
      db, fetchImpl, companyId: "company", endpointId: "endpoint",
      repositoryId: REPOSITORY_ID, repository: "acme/app", pullNumber: 7,
    });
    expect(result.ready).toBe(true);
    expect(tokenPosts).toBe(2);
    expect(prGets).toBe(2);
  });

  it("review provenance retries once after a 401 instead of forcing low-trust", async () => {
    const f = tokenFixture();
    let tokenPosts = 0;
    let prGets = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app/installations/456/access_tokens") {
        tokenPosts += 1;
        return Response.json({ token: `ghs-trust-${tokenPosts}` });
      }
      if (path === "/repos/acme/app/pulls/7") {
        prGets += 1;
        if (prGets === 1) return new Response(null, { status: 401 });
        return Response.json({
          number: 7,
          base: { repo: { id: "42" } },
          head: { repo: { id: "42" }, sha: HEAD },
          user: { id: "99", type: "User" },
        });
      }
      throw new Error(`Unexpected test request: ${path}`);
    });
    const provenance = await readGitHubReviewProvenance(f.db, {
      companyId: "company", endpointId: "endpoint", repositoryId: "42",
      repository: "acme/app", threadId: "github:acme/app:7",
    }, fetchImpl);
    // Without the retry this returns null and every execution is forced to
    // lowTrust provenance_unavailable.
    expect(provenance).toEqual({
      baseRepositoryId: "42",
      headRepositoryId: "42",
      authorId: "99",
      authorIsBot: false,
      headSha: HEAD,
    });
    expect(tokenPosts).toBe(2);
    expect(prGets).toBe(2);
  });
});
