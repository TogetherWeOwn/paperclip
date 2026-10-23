import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not finish within ${ms}ms; a read inside the transaction waited for a second pool connection`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

describeEmbeddedPostgres("issue writes inside a caller transaction on a bounded pool", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: TestDb;
  const pools: TestDb[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-issue-tx-pool-");
    db = createDb(database.connectionString);
  });

  afterAll(async () => {
    for (const pool of pools) await pool.$client.end({ timeout: 1 });
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  function boundedPool(maxConnections: number) {
    const pool = createDb(database.connectionString, { maxConnections });
    pools.push(pool);
    return pool;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pool",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ingress agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
    });
    return { companyId, agentId };
  }

  async function lockCompany(tx: Parameters<Parameters<TestDb["transaction"]>[0]>[0], companyId: string) {
    const [row] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update");
    expect(row?.id).toBe(companyId);
  }

  it("creates an agent-assigned issue with one pool connection", async () => {
    const { companyId, agentId } = await seedCompany();
    const pool = boundedPool(1);
    const svc = issueService(pool);
    const created = await withTimeout(
      pool.transaction(async (tx) => {
        await lockCompany(tx, companyId);
        return svc.create(
          companyId,
          {
            title: `Agent task ${randomUUID()}`,
            description: "Started from a chat message",
            status: "todo",
            priority: "medium",
            assigneeAgentId: agentId,
          },
          tx,
        );
      }),
      15_000,
      "create with an agent assignee",
    );
    expect(created.assigneeAgentId).toBe(agentId);
  }, 30_000);

  it("creates a user-assigned issue with one pool connection", async () => {
    const { companyId } = await seedCompany();
    const pool = boundedPool(1);
    const svc = issueService(pool);
    const created = await withTimeout(
      pool.transaction(async (tx) => {
        await lockCompany(tx, companyId);
        return svc.create(
          companyId,
          {
            title: `User task ${randomUUID()}`,
            description: null,
            status: "todo",
            priority: "medium",
            assigneeUserId: "board-user",
          },
          tx,
        );
      }),
      15_000,
      "create with a user assignee",
    );
    expect(created.assigneeUserId).toBe("board-user");
  }, 30_000);

  it("reopens and reassigns an issue with one pool connection", async () => {
    const { companyId } = await seedCompany();
    const issue = await issueService(db).create(companyId, {
      title: `Reopen target ${randomUUID()}`,
      description: null,
      status: "done",
      priority: "medium",
    });
    const pool = boundedPool(1);
    const svc = issueService(pool);
    const updated = await withTimeout(
      pool.transaction(async (tx) => {
        await lockCompany(tx, companyId);
        return svc.update(issue.id, { status: "todo", assigneeUserId: "board-user" }, tx);
      }),
      15_000,
      "update with a user assignee",
    );
    expect(updated?.status).toBe("todo");
    expect(updated?.assigneeUserId).toBe("board-user");
  }, 30_000);

  it("finishes concurrent lock-holding creates and keeps a free connection for other reads", async () => {
    const { companyId, agentId } = await seedCompany();
    const pool = boundedPool(3);
    const svc = issueService(pool);
    const creates = Array.from({ length: 6 }, (_, index) =>
      pool.transaction(async (tx) => {
        await lockCompany(tx, companyId);
        const issue = await svc.create(
          companyId,
          {
            title: `Concurrent task ${index} ${randomUUID()}`,
            description: "Started from a chat message",
            status: "todo",
            priority: "medium",
            assigneeAgentId: agentId,
            idempotencyKey: `pool-test:${companyId}:${index}`,
          },
          tx,
        );
        return issue.id;
      }),
    );
    const read = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const [row] = await pool.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
      return row?.id ?? null;
    })();
    const [ids, readId] = await withTimeout(
      Promise.all([Promise.all(creates), read]),
      25_000,
      "concurrent creates and a plain read",
    );
    expect(readId).toBe(companyId);
    expect(new Set(ids).size).toBe(6);
  }, 40_000);
});
