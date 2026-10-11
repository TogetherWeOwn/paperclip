import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { githubBotRepositoryToken } from "./chat-github-client.js";
import { githubGreenReviewContext } from "./chat-github-green-gate.js";

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

beforeEach(() => {
  mocks.resolveSecretValue.mockReset();
  mocks.resolveSecretValue.mockImplementation(async (_company, key: string) => credentials[key]);
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
