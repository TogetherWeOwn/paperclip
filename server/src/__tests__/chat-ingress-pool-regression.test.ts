import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

// Regression coverage for TOG-28619.
//
// Live incident: every paperclip pool connection was occupied while one
// backend sat idle-in-transaction holding the chat_endpoints row lock and the
// rest queued behind it. The chat ingress task-mutation transaction takes the
// endpoint FOR UPDATE lock and then calls issueService.create/update with its
// transaction handle — but those helpers re-entered the outer pool for the
// instance-settings read and the assignee checks. Under concurrent ingress
// each open transaction needs a second pooled connection while holding its
// first, so a bounded pool (production default: 10) exhausts and health,
// model-capacity reads and task finalization stall behind it.
//
// The fixed contract: every read inside create/update/addComment stays on the
// caller's connection (dbOrTx). These tests pin that contract with a tiny
// pool (maxConnections 3, well under the production 10): concurrent outer
// transactions that hold a row lock — the stand-in for the endpoint lock —
// and then create/update/comment through the service must all finish without
// waiting on a second pooled connection.
describeEmbeddedPostgres(
  "chat ingress bounded-pool regression (TOG-28619)",
  () => {
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    function withTimeout<T>(
      promise: Promise<T>,
      ms: number,
      label: string,
    ): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${label} did not finish within ${ms}ms: a nested pooled read is likely waiting on an exhausted pool while holding its transaction connection`,
              ),
            ),
          ms,
        );
        timer.unref?.();
      });
      return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }

    async function seedCompanyWithAgent(db: ReturnType<typeof createDb>) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "IngressAgent",
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

    it("concurrent creates inside lock-holding transactions share one pool", async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-chat-ingress-pool-",
      );
      const db = createDb(tempDb.connectionString);
      // Bounded pool: production runs at 10; this test uses 3 to prove the
      // fix holds with far less headroom than production has.
      const smallDb = createDb(tempDb.connectionString, {
        maxConnections: 3,
      });
      const { companyId, agentId } = await seedCompanyWithAgent(db);
      const svc = issueService(smallDb);

      const concurrency = 6;
      const creations = Array.from({ length: concurrency }, (_, index) =>
        smallDb.transaction(async (tx) => {
          // Stand-in for the chat task-mutation transaction's endpoint
          // FOR UPDATE lock: the row lock is held for the whole body.
          const [fence] = await tx
            .select({ id: companies.id })
            .from(companies)
            .where(eq(companies.id, companyId))
            .for("update");
          expect(fence?.id).toBe(companyId);
          const issue = await svc.create(
            companyId,
            {
              title: `Ingress message ${index} ${randomUUID()}`,
              description: "Started from chat ingress",
              status: "todo",
              priority: "medium",
              assigneeAgentId: agentId,
              idempotencyKey: `chat:pool-regression:${companyId}:${index}`,
            },
            tx,
          );
          const comment = await svc.addComment(
            issue.id,
            `Inbound body ${index}`,
            {},
            undefined,
            tx,
          );
          return { issueId: issue.id, commentId: comment.id };
        }),
      );

      // A health/model-capacity style read must stay responsive while the
      // ingress fanout runs: it needs only one free connection, which the
      // fix guarantees because transactions never hold two at once.
      const healthRead = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return smallDb
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0]?.id ?? null);
      })();

      const [results, healthCompanyId] = await withTimeout(
        Promise.all([Promise.all(creations), healthRead]) as Promise<
          [Array<{ issueId: string; commentId: string }>, string | null]
        >,
        25_000,
        "concurrent lock-holding creates + health read",
      );
      expect(healthCompanyId).toBe(companyId);
      expect(results).toHaveLength(concurrency);
      expect(new Set(results.map((row) => row.issueId)).size).toBe(concurrency);
    }, 40_000);

    it("updates with assignee changes stay on the caller transaction", async () => {
      tempDb ??= await startEmbeddedPostgresTestDatabase(
        "paperclip-chat-ingress-pool-",
      );
      const db = createDb(tempDb.connectionString);
      // Single-connection pool: the transaction holds the only connection,
      // so any nested pooled read hangs until withTimeout fires. With two
      // connections a stray pooled read takes the free second one and the
      // test can never catch pool re-entry.
      const smallDb = createDb(tempDb.connectionString, {
        maxConnections: 1,
      });
      const { companyId } = await seedCompanyWithAgent(db);
      const svc = issueService(smallDb);
      const projectId = randomUUID();
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Ingress project",
        status: "in_progress",
      });
      const projectWorkspaceId = randomUUID();
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Primary workspace",
        isPrimary: true,
      });
      const executionWorkspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Issue worktree",
        status: "active",
      });
      const issue = await svc.create(companyId, {
        title: `Reopen target ${randomUUID()}`,
        description: null,
        status: "todo",
        priority: "medium",
      });

      await withTimeout(
        smallDb.transaction(async (tx) => {
          await tx
            .select({ id: companies.id })
            .from(companies)
            .where(eq(companies.id, companyId))
            .for("update");
          // Touching assigneeUserId exercises the membership check and the
          // isolated-workspaces settings read inside update; patching the
          // workspace ids pins the update workspace validations on the
          // caller transaction too.
          const updated = await svc.update(
            issue.id,
            {
              assigneeUserId: "board-user",
              projectWorkspaceId,
              executionWorkspaceId,
            },
            tx,
          );
          expect(updated?.assigneeUserId).toBe("board-user");
          expect(updated?.projectWorkspaceId).toBe(projectWorkspaceId);
          expect(updated?.executionWorkspaceId).toBe(executionWorkspaceId);
          // With the project now resolved from the workspaces, a second
          // update exercises the project-scoped workspace validation
          // branch as well, so all four update validators run on this
          // single connection.
          const revalidated = await svc.update(
            issue.id,
            { projectWorkspaceId, executionWorkspaceId },
            tx,
          );
          expect(revalidated?.projectWorkspaceId).toBe(projectWorkspaceId);
          expect(revalidated?.executionWorkspaceId).toBe(executionWorkspaceId);
        }),
        15_000,
        "lock-holding update with assignee change",
      );
    }, 30_000);

    it("rolled-back ingress leaves nothing behind and retry is idempotent", async () => {
      tempDb ??= await startEmbeddedPostgresTestDatabase(
        "paperclip-chat-ingress-pool-",
      );
      const db = createDb(tempDb.connectionString);
      const smallDb = createDb(tempDb.connectionString, {
        maxConnections: 2,
      });
      const { companyId, agentId } = await seedCompanyWithAgent(db);
      const svc = issueService(smallDb);
      const idempotencyKey = `chat:pool-regression-rollback:${randomUUID()}`;
      const countIssues = () =>
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(issues)
          .where(eq(issues.companyId, companyId))
          .then((rows) => rows[0]?.count ?? 0);
      const beforeCount = await countIssues();

      // An interrupted uncommitted request (lock timeout, crash, deploy)
      // must not leave a partial issue behind.
      await expect(
        smallDb.transaction(async (tx) => {
          await tx
            .select({ id: companies.id })
            .from(companies)
            .where(eq(companies.id, companyId))
            .for("update");
          await svc.create(
            companyId,
            {
              title: `Interrupted ingress ${randomUUID()}`,
              description: null,
              status: "todo",
              priority: "medium",
              assigneeAgentId: agentId,
              idempotencyKey,
            },
            tx,
          );
          throw new Error("simulated ingress interruption");
        }),
      ).rejects.toThrow("simulated ingress interruption");

      expect(await countIssues()).toBe(beforeCount);

      // Retrying the same durable delivery reuses the idempotency key and
      // converges on exactly one issue.
      const first = await svc.create(companyId, {
        title: `Retried ingress ${randomUUID()}`,
        description: null,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        idempotencyKey,
      });
      const second = await svc.create(companyId, {
        title: `Retried ingress ${randomUUID()}`,
        description: null,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        idempotencyKey,
      });
      expect(second.id).toBe(first.id);
    }, 30_000);
  },
);
