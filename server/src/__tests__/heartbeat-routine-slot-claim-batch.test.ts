import { randomUUID } from "node:crypto";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;
const ADAPTER = "routine_slot_claim_batch_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine-slot claim batch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

describeEmbeddedPostgres(
  "dispatch claim batch with a conflicting routine slot",
  () => {
    let db!: ReturnType<typeof createDb>;
    let heartbeat!: ReturnType<typeof heartbeatService>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const startedRunIds: string[] = [];
    let releaseAdapter!: () => void;
    let adapterGate!: Promise<void>;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-heartbeat-routine-slot-claim-",
      );
      db = createDb(tempDb.connectionString);
      heartbeat = heartbeatService(db);
      registerServerAdapter({
        type: ADAPTER,
        execute: async (input) => {
          startedRunIds.push(input.runId);
          await adapterGate;
          return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
        },
        testEnvironment: async () => ({
          adapterType: ADAPTER,
          status: "pass",
          checks: [],
          testedAt: new Date().toISOString(),
        }),
      });
    }, 20_000);

    afterEach(async () => {
      releaseAdapter?.();
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(heartbeatRuns.status, "running"));
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      await db.execute(
        sql`drop trigger if exists claim_batch_test_explode on issues`,
      );
      await db.execute(
        sql`drop trigger if exists claim_batch_test_explode on agent_wakeup_requests`,
      );
      await db.execute(sql`drop function if exists claim_batch_test_explode()`);
      await db.execute(sql`drop sequence if exists claim_batch_test_fired`);
      await db.delete(activityLog);
      await db.delete(issueComments);
      await db.delete(issueRelations);
      await db.delete(issues);
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(agentRuntimeState);
      await db.delete(agents);
      await db.delete(companySkills);
      await db.delete(companies);
      startedRunIds.length = 0;
    });

    afterAll(async () => {
      unregisterServerAdapter(ADAPTER);
      await tempDb?.cleanup();
    });

    async function seed(
      issueSpecs: Array<{ routine: boolean; title?: string }>,
    ) {
      adapterGate = new Promise<void>((resolve) => {
        releaseAdapter = resolve;
      });
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const routineId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "RoutineCoo",
        role: "ceo",
        status: "idle",
        adapterType: ADAPTER,
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 },
        },
        permissions: {},
      });
      const issueIds: string[] = [];
      const runIds: string[] = [];
      const base = Date.now() - 60_000;
      for (const [index, spec] of issueSpecs.entries()) {
        const issueId = randomUUID();
        const runId = randomUUID();
        const createdAt = new Date(base + index * 1000);
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: spec.title ?? `Routine issue ${index + 1}`,
          status: "todo",
          priority: "medium",
          responsibleUserId: "responsible-user",
          assigneeAgentId: agentId,
          ...(spec.routine
            ? {
                originKind: "routine_execution",
                originId: routineId,
                originFingerprint: "same-fingerprint",
              }
            : {}),
          issueNumber: index + 1,
          identifier: `${issuePrefix}-${index + 1}`,
        });
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "queued",
          contextSnapshot: { issueId, wakeReason: "issue_assigned" },
          createdAt,
          updatedAt: createdAt,
        });
        issueIds.push(issueId);
        runIds.push(runId);
      }
      return { companyId, agentId, issueIds, runIds };
    }

    async function runStatus(runId: string) {
      return db
        .select({
          status: heartbeatRuns.status,
          error: heartbeatRuns.errorCode,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);
    }

    async function issueExecutionRunId(issueId: string) {
      return db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]?.executionRunId ?? null);
    }

    it("dispatches the committed claim and leaves the routine-slot conflict queued", async () => {
      const fixture = await seed([{ routine: true }, { routine: true }]);

      await heartbeat.resumeQueuedRuns();

      await waitFor(() => startedRunIds.includes(fixture.runIds[0]!));
      expect(startedRunIds).toEqual([fixture.runIds[0]]);
      expect((await runStatus(fixture.runIds[0]!))?.status).toBe("running");
      expect(await issueExecutionRunId(fixture.issueIds[0]!)).toBe(
        fixture.runIds[0],
      );
      // The conflicting claim rolled back whole: still queued, issue unlocked.
      expect((await runStatus(fixture.runIds[1]!))?.status).toBe("queued");
      expect(await issueExecutionRunId(fixture.issueIds[1]!)).toBeNull();

      // Once the slot holder finishes, the deferred run becomes eligible again.
      releaseAdapter();
      await waitFor(async () => startedRunIds.includes(fixture.runIds[1]!));
      expect(new Set(startedRunIds).size).toBe(startedRunIds.length);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect((await runStatus(fixture.runIds[0]!))?.status).toBe("succeeded");
      expect((await runStatus(fixture.runIds[1]!))?.status).toBe("succeeded");
    });

    it("skips a routine conflict and still claims later runs in the same batch", async () => {
      const fixture = await seed([
        { routine: true },
        { routine: true },
        { routine: false, title: "Plain issue" },
      ]);

      await heartbeat.resumeQueuedRuns();

      await waitFor(() => startedRunIds.length >= 1);
      // maxConcurrentRuns is 2: the first routine run and the plain run start.
      // Wait for both adapters before asserting because their setup is concurrent.
      await waitFor(
        () =>
          startedRunIds.includes(fixture.runIds[0]!) &&
          startedRunIds.includes(fixture.runIds[2]!),
      );
      expect(new Set(startedRunIds)).toEqual(
        new Set([fixture.runIds[0], fixture.runIds[2]]),
      );
      expect((await runStatus(fixture.runIds[1]!))?.status).toBe("queued");
    });

    it("dispatches earlier committed claims when a later claim fails unexpectedly", async () => {
      const fixture = await seed([
        { routine: false, title: "First issue" },
        { routine: false, title: "explode" },
      ]);
      await db.execute(sql`
      create function claim_batch_test_explode() returns trigger as $$
      begin
        if new.title = 'explode' and new.execution_run_id is not null
           and old.execution_run_id is distinct from new.execution_run_id then
          raise exception 'claim batch test failure';
        end if;
        return new;
      end;
      $$ language plpgsql
    `);
      await db.execute(sql`
      create trigger claim_batch_test_explode before update on issues
      for each row execute function claim_batch_test_explode()
    `);

      // The second claim throws. The first claim already committed and must
      // still start.
      await heartbeat.resumeQueuedRuns().catch(() => undefined);

      await waitFor(() => startedRunIds.includes(fixture.runIds[0]!));
      expect(startedRunIds).toEqual([fixture.runIds[0]]);
      expect((await runStatus(fixture.runIds[0]!))?.status).toBe("running");
      expect((await runStatus(fixture.runIds[1]!))?.status).toBe("queued");
    });

    it("rethrows and stops when the first claim fails unexpectedly", async () => {
      const fixture = await seed([
        { routine: false, title: "explode" },
        { routine: false, title: "Second issue" },
        { routine: false, title: "Third issue" },
      ]);
      await db.execute(sql`
      create function claim_batch_test_explode() returns trigger as $$
      begin
        if new.title = 'explode' and new.execution_run_id is not null
           and old.execution_run_id is distinct from new.execution_run_id then
          raise exception 'claim batch test failure';
        end if;
        return new;
      end;
      $$ language plpgsql
    `);
      await db.execute(sql`
      create trigger claim_batch_test_explode before update on issues
      for each row execute function claim_batch_test_explode()
    `);

      // Nothing was claimed before the failure, so the error must propagate
      // and later runs must not be claimed in the same batch.
      await expect(heartbeat.resumeQueuedRuns()).rejects.toThrow();

      expect(startedRunIds).toEqual([]);
      expect((await runStatus(fixture.runIds[0]!))?.status).toBe("queued");
      expect((await runStatus(fixture.runIds[1]!))?.status).toBe("queued");
      expect((await runStatus(fixture.runIds[2]!))?.status).toBe("queued");
    });

    it("dispatches a run whose claim threw after its transaction committed", async () => {
      const fixture = await seed([{ routine: false, title: "postcommit" }]);
      const wakeupId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupId,
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        status: "queued",
      });
      await db
        .update(heartbeatRuns)
        .set({ wakeupRequestId: wakeupId })
        .where(eq(heartbeatRuns.id, fixture.runIds[0]!));
      // The claim marks the wake `claimed` after its transaction commits. Fail
      // that step once; a sequence is non-transactional, so the count survives
      // the rollback.
      await db.execute(sql`create sequence claim_batch_test_fired`);
      await db.execute(sql`
      create function claim_batch_test_explode() returns trigger as $$
      begin
        if new.status = 'claimed' and nextval('claim_batch_test_fired') = 1 then
          raise exception 'post-commit claim step failure';
        end if;
        return new;
      end;
      $$ language plpgsql
    `);
      await db.execute(sql`
      create trigger claim_batch_test_explode before update on agent_wakeup_requests
      for each row execute function claim_batch_test_explode()
    `);

      await heartbeat.resumeQueuedRuns().catch(() => undefined);

      await waitFor(() => startedRunIds.includes(fixture.runIds[0]!));
      expect(startedRunIds).toEqual([fixture.runIds[0]]);
    });
  },
);
