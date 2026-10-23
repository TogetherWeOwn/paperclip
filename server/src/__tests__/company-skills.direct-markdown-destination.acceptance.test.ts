import { randomUUID } from "node:crypto";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { companies, companySkills, type Db } from "@paperclipai/db";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { companySkillService } from "../services/company-skills.js";

// Folder organization is persistence-only, unrelated to remote source policy.
// Avoid advisory DB locks while keeping the complete import path real.
vi.mock("../services/folders.js", () => ({
  folderService: () => ({
    ensureBundledCategory: async (companyId: string, name: string) => ({
      id: "26189409-df9b-4fda-9ef5-b72c89455013",
      companyId,
      name,
      kind: "skill",
      slug: "fixture",
      parentId: null,
      systemKey: "bundled:fixture",
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    pruneEmptyBundledCategories: async () => {},
  }),
}));

/**
 * Frozen tests-first contract: Builders must not edit, skip, or weaken this file.
 * Exercise importFromSource, including the real direct-.md branch, source parser,
 * content parsing, and ghFetch. Only persistence, DNS, and transport are doubles.
 * No HTTP server, real DNS, sockets, credentials, or application DB is needed.
 *
 * An exact approved-origin policy OR safe arbitrary-URL fetching is admissible.
 * Arbitrary-name DNS fixtures may be rejected before DNS; no resolver subsystem
 * is required for names that the source policy excludes. Supporting arbitrary
 * names additionally requires independent connection-pinning/egress evidence;
 * this fetch-boundary suite does not prove a live connection's destination.
 * Enterprise compatibility is deliberate: the existing operator host setting
 * may admit the exact configured HTTPS origin. Sibling/suffix/port fixtures
 * resolve to private addresses, so neither admissible design may fetch them.
 * Removing validation, allowing an unsafe hop, or forwarding credentials must
 * fail these tests. Rejecting every import must fail the positive controls.
 */
const MARKDOWN =
  "---\nname: destination-fixture\ndescription: Synthetic offline import\n---\n# Destination fixture\n\nRead the supplied fixture.\n";
const RAW_URL =
  "https://raw.githubusercontent.com/example/skills/main/SKILL.md";
const GITHUB_URL = "https://github.com/example/skills/raw/main/SKILL.md";
const ENTERPRISE_URL =
  "https://ghe.example.test/example/skills/raw/main/SKILL.md";
const COMPANY_ID = "8a614381-38d9-4247-86b6-b19c49163acd";

type Address = { address: string; family: number };
type Connection = {
  url: string;
  authorization: string | null;
  cookie: string | null;
};
type Reply = { status: number; location?: string; body?: string };

// Empty company inventory with real insert results. No import/parser/fetch or
// policy function is mocked. Reads return no installed skills/folders/releases;
// bundled inventory writes are separate from sourceType=url imports under test.
function emptyCompanyDatabase() {
  const importedRows: Record<string, unknown>[] = [];
  const failures: string[] = [];
  function selection(fields?: Record<string, unknown>) {
    let table: unknown;
    const rows = Promise.resolve().then(() =>
      table === companies
        ? [{ id: COMPANY_ID }]
        : fields?.nextRevision
          ? [{ nextRevision: 1 }]
          : [],
    );
    const query = Object.assign(rows, {
      from(value: unknown) {
        table = value;
        return query;
      },
      where() {
        return query;
      },
      orderBy() {
        return query;
      },
      limit() {
        return query;
      },
      leftJoin() {
        return query;
      },
    });
    return query;
  }
  const database = {
    select: selection,
    transaction(callback: (tx: Db) => Promise<unknown>) {
      return callback(db);
    },
    execute: async () => [],
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          const row = {
            id: randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            currentVersionId: null,
            starCount: 0,
            forkCount: 0,
            forkedFromSkillId: null,
            forkedFromCompanyId: null,
            publicShareToken: null,
            ...value,
          };
          if (table === companySkills && value.sourceType === "url")
            importedRows.push(row);
          const query = {
            onConflictDoNothing() {
              return query;
            },
            onConflictDoUpdate() {
              return query;
            },
            returning: async () => [row],
          };
          return query;
        },
      };
    },
  };
  const db = new Proxy(database, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      failures.push(String(property));
      throw new Error(`Unexpected database operation: ${String(property)}`);
    },
  }) as unknown as Db;
  return { db, importedRows, failures };
}

describe("direct Markdown skill import destination acceptance (offline)", () => {
  let database: ReturnType<typeof emptyCompanyDatabase>;
  let service: ReturnType<typeof companySkillService>;
  let home: string;
  let connections: Connection[];
  let unexpectedTransport: string[];
  let dnsQueries: string[];
  let answers: Map<string, Address[] | Error>;
  let replies: Map<string, Reply>;
  const evidence: Array<{
    test: string;
    dnsQueries: string[];
    connections: Connection[];
    imported: number;
    unexpectedTransport: string[];
  }> = [];

  afterAll(async () => {
    if (process.env.DIRECT_MARKDOWN_EVIDENCE) {
      await fs.writeFile(
        process.env.DIRECT_MARKDOWN_EVIDENCE,
        JSON.stringify(evidence, null, 2),
      );
    }
  });

  function resolveFixture(hostname: string): Address[] {
    dnsQueries.push(hostname);
    const answer = answers.get(hostname);
    if (answer instanceof Error) throw answer;
    if (answer) return answer;
    // All addresses are synthetic. This default never invokes the OS resolver.
    return [{ address: "93.184.216.34", family: 4 }];
  }

  // Model standard fetch redirect semantics instead of relying on the product
  // to perform a second fetch call: automatic follow is itself an unsafe hop.
  async function fetchFixture(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const redirect =
      init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    return visit(url, headers, redirect, 0);
  }

  function visit(
    url: URL,
    headers: Headers,
    redirect: RequestRedirect,
    hops: number,
  ): Response {
    connections.push({
      url: url.href,
      authorization: headers.get("authorization"),
      cookie: headers.get("cookie"),
    });
    const reply = replies.get(url.href);
    if (!reply) {
      unexpectedTransport.push(url.href);
      throw new Error("Unscripted offline fetch");
    }
    if (reply.location && [301, 302, 303, 307, 308].includes(reply.status)) {
      if (redirect === "error")
        throw new TypeError("Redirect refused by fetch");
      if (redirect === "follow") {
        if (hops >= 20) throw new TypeError("Too many redirects");
        const next = new URL(reply.location, url);
        const nextHeaders = new Headers(headers);
        if (next.origin !== url.origin) {
          nextHeaders.delete("authorization");
          nextHeaders.delete("cookie");
        }
        return visit(next, nextHeaders, redirect, hops + 1);
      }
    }
    return new Response(reply.body ?? (reply.location ? null : MARKDOWN), {
      status: reply.status,
      headers: reply.location
        ? { location: reply.location }
        : { "content-type": "text/markdown" },
    });
  }

  async function attempt(source: string) {
    try {
      return {
        result: await service.importFromSource(COMPANY_ID, source),
        error: null,
      };
    } catch (error) {
      return { result: null, error };
    }
  }

  async function expectDeniedBeforeFetch(source: string) {
    replies.set(new URL(source).href, { status: 200 });
    const outcome = await attempt(source);
    expect({
      rejected: outcome.error instanceof Error,
      connections,
      imported: database.importedRows.length,
    }).toEqual({ rejected: true, connections: [], imported: 0 });
  }

  beforeEach(async () => {
    home = await fs.mkdtemp(
      path.join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(),
        "direct-markdown-test-",
      ),
    );
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("PAPERCLIP_GITHUB_ENTERPRISE_HOSTS", "");
    vi.stubEnv("GITHUB_TOKEN", "synthetic-offline-github-canary");
    vi.stubEnv("GH_TOKEN", "synthetic-offline-cli-canary");
    connections = [];
    unexpectedTransport = [];
    dnsQueries = [];
    answers = new Map();
    replies = new Map([
      [RAW_URL, { status: 200 }],
      [GITHUB_URL, { status: 200 }],
    ]);
    database = emptyCompanyDatabase();
    service = companySkillService(database.db);
    vi.stubGlobal("fetch", vi.fn(fetchFixture));
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      unexpectedTransport.push("socket.connect");
      throw new Error("Real sockets are prohibited in this offline suite");
    });
    vi.spyOn(dnsPromises, "lookup").mockImplementation(
      async (hostname, options) => {
        const rows = resolveFixture(hostname);
        return (
          typeof options === "object" && options.all ? rows : rows[0]
        ) as never;
      },
    );
    vi.spyOn(dns, "lookup").mockImplementation(((
      hostname: string,
      options: unknown,
      callback?: (...args: unknown[]) => void,
    ) => {
      const done = typeof options === "function" ? options : callback;
      try {
        const rows = resolveFixture(hostname);
        if (
          typeof options === "object" &&
          options !== null &&
          "all" in options &&
          options.all
        )
          done?.(null, rows);
        else done?.(null, rows[0].address, rows[0].family);
      } catch (error) {
        done?.(error);
      }
    }) as typeof dns.lookup);
    vi.spyOn(dnsPromises, "resolve4").mockImplementation(
      async (hostname) =>
        resolveFixture(hostname)
          .filter((row) => row.family === 4)
          .map((row) => row.address) as never,
    );
    vi.spyOn(dnsPromises, "resolve6").mockImplementation(
      async (hostname) =>
        resolveFixture(hostname)
          .filter((row) => row.family === 6)
          .map((row) => row.address) as never,
    );
    for (const [method, family] of [
      ["resolve4", 4],
      ["resolve6", 6],
    ] as const) {
      vi.spyOn(dns, method).mockImplementation(((
        hostname: string,
        options: unknown,
        callback?: (...args: unknown[]) => void,
      ) => {
        const done = typeof options === "function" ? options : callback;
        try {
          done?.(
            null,
            resolveFixture(hostname)
              .filter((row) => row.family === family)
              .map((row) => row.address),
          );
        } catch (error) {
          done?.(error);
        }
      }) as typeof dns.resolve4);
    }
  });

  afterEach(async (context) => {
    evidence.push({
      test: context.task.name,
      dnsQueries,
      connections,
      imported: database.importedRows.length,
      unexpectedTransport,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
    expect(
      unexpectedTransport,
      "No unplanned fetch or real socket may masquerade as policy rejection",
    ).toEqual([]);
    expect(
      database.failures,
      "Persistence fixture must not cause a false rejection",
    ).toEqual([]);
    expect(
      connections.filter(
        (entry) => entry.authorization !== null || entry.cookie !== null,
      ),
      "Direct imports must not attach ambient credentials",
    ).toEqual([]);
  });

  it.each([RAW_URL, GITHUB_URL])(
    "positive: imports a public direct Markdown file: %s",
    async (source) => {
      const { result, error } = await attempt(source);
      if (error) throw error;
      expect(result?.imported).toHaveLength(1);
      expect(result?.imported[0]).toMatchObject({
        slug: "destination-fixture",
        markdown: MARKDOWN,
        sourceType: "url",
        sourceLocator: source,
      });
      expect(database.importedRows).toHaveLength(1);
      expect(connections.map((entry) => entry.url)).toEqual([source]);
      expect(
        connections.every(
          (entry) => entry.authorization === null && entry.cookie === null,
        ),
      ).toBe(true);
    },
  );

  it("positive: deliberately supports the exact configured Enterprise HTTPS host", async () => {
    vi.stubEnv("PAPERCLIP_GITHUB_ENTERPRISE_HOSTS", "ghe.example.test");
    replies.set(ENTERPRISE_URL, { status: 200 });
    const { result, error } = await attempt(ENTERPRISE_URL);
    if (error) throw error;
    expect(result?.imported[0]).toMatchObject({
      markdown: MARKDOWN,
      sourceType: "url",
      sourceLocator: ENTERPRISE_URL,
    });
    expect(connections.map((entry) => entry.url)).toEqual([ENTERPRISE_URL]);
  });

  it.each([
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0177.0.0.1",
    "0x7f000001",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "[::]",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:10.0.0.1]",
    "[fc00::1]",
    "[fe80::1]",
    "[fec0::1]",
    "[ff02::1]",
    "[2001:db8::1]",
  ])(
    "denies unsafe or alternate address before transport: %s",
    async (host) => {
      await expectDeniedBeforeFetch(`https://${host}/SKILL.md`);
    },
  );

  it.each([
    "localhost",
    "sub.localhost",
    "github.com.evil.test",
    "raw.githubusercontent.com.evil.test",
    "raw-githubusercontent.com",
  ])("denies local or source-origin lookalike name: %s", async (host) => {
    answers.set(host, [{ address: "127.0.0.1", family: 4 }]);
    await expectDeniedBeforeFetch(`https://${host}/SKILL.md`);
  });

  it.each([
    { label: "private IPv4", rows: [{ address: "10.1.2.3", family: 4 }] },
    { label: "link-local", rows: [{ address: "169.254.169.254", family: 4 }] },
    { label: "private IPv6", rows: [{ address: "fd00::1", family: 6 }] },
    {
      label: "public then private",
      rows: [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    },
    {
      label: "private then public",
      rows: [
        { address: "127.0.0.1", family: 4 },
        { address: "93.184.216.34", family: 4 },
      ],
    },
    {
      label: "public IPv4 then private IPv6",
      rows: [
        { address: "93.184.216.34", family: 4 },
        { address: "::1", family: 6 },
      ],
    },
  ])(
    "denies arbitrary name with $label DNS answers (or rejects its origin before DNS)",
    async ({ rows }) => {
      answers.set("download.example.test", rows);
      await expectDeniedBeforeFetch("https://download.example.test/SKILL.md");
    },
  );

  it("denies an unresolvable arbitrary name without falling back to an unvalidated fetch", async () => {
    answers.set("unresolved.example.test", new Error("Synthetic ENOTFOUND"));
    await expectDeniedBeforeFetch("https://unresolved.example.test/SKILL.md");
  });

  it.each([
    "https://ghe.example.test.evil.test/example/skills/raw/main/SKILL.md",
    "https://other.example.test/example/skills/raw/main/SKILL.md",
    "https://ghe.example.test:8443/example/skills/raw/main/SKILL.md",
  ])(
    "Enterprise approval does not expand to a different origin: %s",
    async (source) => {
      vi.stubEnv("PAPERCLIP_GITHUB_ENTERPRISE_HOSTS", "ghe.example.test");
      answers.set(new URL(source).hostname, [
        { address: "10.1.2.3", family: 4 },
      ]);
      await expectDeniedBeforeFetch(source);
    },
  );

  it.each([
    "https://synthetic-user:synthetic-password@raw.githubusercontent.com/example/skills/main/SKILL.md",
    "https://raw.githubusercontent.com:8443/example/skills/main/SKILL.md",
  ])(
    "denies userinfo or an unsafe nondefault-port destination before transport: %s",
    async (source) => {
      answers.set("raw.githubusercontent.com", [
        { address: "127.0.0.1", family: 4 },
      ]);
      await expectDeniedBeforeFetch(source);
    },
  );

  it.each([301, 302, 303, 307, 308])(
    "denies allowed-to-loopback redirect status %s before the unsafe hop",
    async (status) => {
      const target = "https://127.0.0.1/SKILL.md";
      replies.set(RAW_URL, { status, location: target });
      replies.set(target, { status: 200 });
      const outcome = await attempt(RAW_URL);
      expect({
        rejected: outcome.error instanceof Error,
        unsafeHops: connections.filter((entry) => entry.url !== RAW_URL),
        imported: database.importedRows.length,
      }).toEqual({ rejected: true, unsafeHops: [], imported: 0 });
    },
  );

  it.each([
    "https://[::1]/SKILL.md",
    "https://10.0.0.1/SKILL.md",
    "https://169.254.169.254/SKILL.md",
    "https://download.example.test/SKILL.md",
    "http://raw.githubusercontent.com/example/skills/main/SKILL.md",
    "//127.0.0.1/SKILL.md",
    "https://synthetic-user:synthetic-password@127.0.0.1/SKILL.md",
  ])(
    "rejects forbidden redirect destination without connecting or leaking credentials: %s",
    async (location) => {
      const target = new URL(location, RAW_URL).href;
      answers.set("download.example.test", [
        { address: "10.1.2.3", family: 4 },
      ]);
      replies.set(RAW_URL, { status: 307, location });
      replies.set(target, { status: 200 });
      const outcome = await attempt(RAW_URL);
      const forbiddenHops = connections.filter(
        (entry) => entry.url !== RAW_URL,
      );
      expect({
        rejected: outcome.error instanceof Error,
        forbiddenHops,
        imported: database.importedRows.length,
      }).toEqual({ rejected: true, forbiddenHops: [], imported: 0 });
    },
  );

  it("does not trust a permitted intermediate redirect as authority for a forbidden final hop", async () => {
    const intermediate =
      "https://raw.githubusercontent.com/example/skills/other/SKILL.md";
    const target = "https://169.254.169.254/SKILL.md";
    replies.set(RAW_URL, { status: 302, location: intermediate });
    replies.set(intermediate, { status: 308, location: target });
    replies.set(target, { status: 200 });
    const outcome = await attempt(RAW_URL);
    expect({
      rejected: outcome.error instanceof Error,
      unsafeHops: connections.filter((entry) => entry.url === target),
      imported: database.importedRows.length,
    }).toEqual({ rejected: true, unsafeHops: [], imported: 0 });
  });
});
