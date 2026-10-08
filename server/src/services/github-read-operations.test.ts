import { beforeEach, describe, expect, it, vi } from "vitest";
import { forbidden } from "../errors.js";
import { githubReadOperationsService, type GitHubReadRunClaims } from "./github-read-operations.js";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  withCredential: vi.fn(),
}));

vi.mock("./connection-intents.js", () => ({
  connectionIntentService: () => ({ validate: mocks.validate }),
}));

vi.mock("./github-operation-credentials.js", () => ({
  withGitHubOperationCredential: mocks.withCredential,
}));

vi.mock("./run-secret-redaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-secret-redaction.js")>()),
  createRunSecretRedactionRegistry: () => ({
    redactForRun: async (_companyId: string, _runId: string, value: unknown) => value,
  }),
}));

const claims: GitHubReadRunClaims = {
  sub: "agent",
  company_id: "company",
  run_id: "run",
  responsible_user_id: "user",
};
const TOKEN = "ghs_unitfixturetoken0123456789abcd";
const REPO_ID = "1396224242";
const API_LOGS = "https://api.github.com/repos/TogetherWeOwn/two-bot-next/actions/jobs/42/logs";
const SAFE_DOWNLOAD = "https://productionresultssa7.blob.core.windows.net/actions-results/job.txt?sig=x";

function redirect(location: string | null) {
  return new Response(null, { status: 302, headers: location ? { location } : {} });
}

function textStream(totalBytes: number, chunkBytes = 64 * 1024) {
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) return controller.close();
        const size = Math.min(chunkBytes, totalBytes - sent);
        controller.enqueue(new Uint8Array(size).fill(97));
        sent += size;
      },
    }),
    { status: 200, headers: { "content-type": "text/plain" } },
  );
}

function service(fetchImpl: typeof fetch) {
  return githubReadOperationsService({} as never, { fetch: fetchImpl });
}

describe("githubReadOperationsService", () => {
  beforeEach(() => {
    mocks.validate.mockReset().mockResolvedValue(undefined);
    mocks.withCredential
      .mockReset()
      .mockImplementation(async (_db, _input, operation) => operation({ token: TOKEN }));
  });

  it("sends only GET requests and strips authorization from the log download", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return calls.length === 1 ? redirect(SAFE_DOWNLOAD) : new Response(`ok ${TOKEN}`, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await service(fetchImpl).actionsJobLogs(claims, { repositoryId: REPO_ID, jobId: "42" });

    expect(calls.map((call) => call.url)).toEqual([API_LOGS, SAFE_DOWNLOAD]);
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("manual");
    }
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBeNull();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it.each([
    ["plain http", "http://productionresultssa7.blob.core.windows.net/a"],
    ["suffix lookalike", "https://productionresultssa7.blob.core.windows.net.attacker.test/a"],
    ["prefix lookalike", "https://attacker-productionresultssa7.blob.core.windows.net/a"],
    ["host in path", "https://attacker.test/productionresultssa7.blob.core.windows.net"],
    ["userinfo", "https://user:pw@productionresultssa7.blob.core.windows.net/a"],
    ["explicit port", "https://productionresultssa7.blob.core.windows.net:8443/a"],
    ["fragment", "https://productionresultssa7.blob.core.windows.net/a#x"],
    ["missing shard number", "https://productionresultssa.blob.core.windows.net/a"],
    ["GitHub API host", "https://api.github.com/repos/TogetherWeOwn/two-bot-next"],
    ["relative URL", "/actions-results/job.txt"],
  ])("rejects a %s log redirect without a second request", async (_label, location) => {
    const fetchImpl = vi.fn(async () => redirect(location)) as unknown as typeof fetch;

    await expect(
      service(fetchImpl).actionsJobLogs(claims, { repositoryId: REPO_ID, jobId: "42" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a missing redirect, a non-redirect, a chained redirect, and a wrong content type", async () => {
    const missing = vi.fn(async () => redirect(null)) as unknown as typeof fetch;
    await expect(
      service(missing).actionsJobLogs(claims, { repositoryId: REPO_ID, jobId: "42" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(missing).toHaveBeenCalledTimes(1);

    const direct = vi.fn(async () => new Response("log body", { status: 200 })) as unknown as typeof fetch;
    await expect(
      service(direct).actionsJobLogs(claims, { repositoryId: REPO_ID, jobId: "42" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(direct).toHaveBeenCalledTimes(1);

    let calls = 0;
    const chained = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? redirect(SAFE_DOWNLOAD) : redirect("https://attacker.test/next");
    }) as unknown as typeof fetch;
    await expect(
      service(chained).actionsJobLogs(claims, { repositoryId: REPO_ID, jobId: "42" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(chained).toHaveBeenCalledTimes(2);

    let typed = 0;
    const html = vi.fn(async () => {
      typed += 1;
      return typed === 1
        ? redirect(SAFE_DOWNLOAD)
        : new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    await expect(
      service(html).actionsJobLogs(claims, { repositoryId: REPO_ID, jobId: "42" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("truncates a log stream at 1 MiB while it streams", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? redirect(SAFE_DOWNLOAD) : textStream(8 * 1024 * 1024);
    }) as unknown as typeof fetch;

    const result = await service(fetchImpl).actionsJobLogs(claims, { repositoryId: REPO_ID, jobId: "42" });

    expect(result.truncated).toBe(true);
    expect(result.logs.length).toBe(1024 * 1024);
  });

  it.each([
    ["unknown repository ID", { repositoryId: "1", jobId: "42" }],
    ["numeric repository ID", { repositoryId: 1396224242, jobId: "42" }],
    ["repository name", { repositoryId: "two-bot-next", jobId: "42" }],
    ["zero job ID", { repositoryId: REPO_ID, jobId: "0" }],
    ["padded job ID", { repositoryId: REPO_ID, jobId: "042" }],
    ["path-like job ID", { repositoryId: REPO_ID, jobId: "42/rerun" }],
    ["oversize job ID", { repositoryId: REPO_ID, jobId: "1".repeat(21) }],
    ["extra owner field", { repositoryId: REPO_ID, jobId: "42", owner: "attacker" }],
    ["extra method field", { repositoryId: REPO_ID, jobId: "42", method: "POST" }],
  ])("rejects %s before any credential or network use", async (_label, input) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(service(fetchImpl).actionsJobLogs(claims, input)).rejects.toThrow();
    expect(mocks.withCredential).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops before the credential when the run is no longer valid", async () => {
    mocks.validate.mockRejectedValueOnce(forbidden("Run is not active"));
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      service(fetchImpl).repositoryWebhooks(claims, { repositoryId: REPO_ID }),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.withCredential).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lists webhooks with one GET that refuses redirects and drops URLs and secrets", async () => {
    const hooks = Array.from({ length: 150 }, (_value, index) => ({
      id: index + 1,
      name: "web",
      type: "Repository",
      active: true,
      events: ["push"],
      config: { url: "https://hooks.example.test/x?token=abc", secret: "s3cret", content_type: "json", insecure_ssl: "0" },
      url: `https://api.github.com/repos/TogetherWeOwn/two-bot-next/hooks/${index + 1}`,
      ping_url: "https://api.github.com/ping",
    }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(hooks), { status: 200 })) as unknown as typeof fetch;

    const result = await service(fetchImpl).repositoryWebhooks(claims, { repositoryId: REPO_ID }) as {
      webhooks: unknown[];
      pageLimitReached: boolean;
    };

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/TogetherWeOwn/two-bot-next/hooks?per_page=100&page=1");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(result.webhooks).toHaveLength(100);
    expect(result.pageLimitReached).toBe(true);
    const serialized = JSON.stringify(result);
    for (const leaked of ["hooks.example.test", "s3cret", "ping_url", "api.github.com"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("rejects a webhook response above 512 KiB and a malformed one", async () => {
    const huge = vi.fn(async () => textStream(2 * 1024 * 1024)) as unknown as typeof fetch;
    await expect(
      service(huge).repositoryWebhooks(claims, { repositoryId: REPO_ID }),
    ).rejects.toMatchObject({ status: 413 });

    const object = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(
      service(object).repositoryWebhooks(claims, { repositoryId: REPO_ID }),
    ).rejects.toMatchObject({ status: 422 });

    const denied = vi.fn(async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(
      service(denied).repositoryWebhooks(claims, { repositoryId: REPO_ID }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("does not surface provider or network error text", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed with ${TOKEN}`);
    }) as unknown as typeof fetch;

    const failure = await service(fetchImpl)
      .repositoryWebhooks(claims, { repositoryId: REPO_ID })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 422 });
    expect(String((failure as Error).message)).not.toContain(TOKEN);
  });
});
