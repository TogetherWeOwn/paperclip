import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createApp } from "../app.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

const lifecycle = vi.hoisted(() => ({
  targets: new Map<
    string,
    { phase: "setup" | "finalizer"; runId?: string; release?: () => void }
  >(),
}));

// Only scheduling is controlled: every selected method is called through with
// its original arguments and result. Actor middleware, routes, heartbeat wake,
// PostgreSQL and process execution are not replaced.
vi.mock(
  "../services/environment-run-orchestrator.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../services/environment-run-orchestrator.js")
      >();
    return {
      ...original,
      environmentRunOrchestrator(
        ...args: Parameters<typeof original.environmentRunOrchestrator>
      ) {
        const service = original.environmentRunOrchestrator(...args);
        return {
          ...service,
          async realizeForRun(
            input: Parameters<typeof service.realizeForRun>[0],
          ) {
            await lifecycleGate("setup", input);
            const result = await service.realizeForRun(input);
            trace("setup-call-through-complete", {
              runId: input.heartbeatRunId,
              companyId: input.companyId,
            });
            return result;
          },
          async releaseForRun(
            input: Parameters<typeof service.releaseForRun>[0],
          ) {
            if (!input.cancelActiveWork)
              await lifecycleGate("finalizer", input);
            const result = await service.releaseForRun(input);
            trace("finalizer-call-through-complete", {
              runId: input.heartbeatRunId,
              companyId: input.companyId,
              result,
            });
            return result;
          },
        };
      },
    };
  },
);

async function lifecycleGate(
  phase: "setup" | "finalizer",
  input: { companyId: string; heartbeatRunId: string },
) {
  const target = lifecycle.targets.get(input.companyId);
  if (!target || target.phase !== phase || target.runId) return;
  if (phase === "finalizer") {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.heartbeatRunId));
    if (!["cancelled", "succeeded", "failed"].includes(run.status)) return;
  }
  target.runId = input.heartbeatRunId;
  trace("lifecycle-rendezvous", { phase, ...input });
  await new Promise<void>((resolve) => {
    target.release = resolve;
  });
  trace("lifecycle-released", { phase, ...input });
}

// Breaks caught: admitted-but-unbound reviewer wakes, wrong issue/agent receipt
// adoption, board fallback after failed agent authentication, and verdict gates
// bypassed by a missing comment or a nonparticipant. This is diagnostic evidence,
// not a claim that the original intermittent CI failure must reproduce.
const tracePath = (() => {
  const value = process.env.SIGNOFF_HTTP_TRACE;
  if (!value)
    throw new Error("Run via tests/fixtures/signoff-http-admission-run.mjs");
  return value;
})();
const credentials = new Set<string>();
const traceSession = randomUUID();
function redact(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    for (const credential of credentials)
      value = (value as string).replaceAll(credential, "[REDACTED]");
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(token|authorization|keyHash|key_hash|authToken|paperclipSecretRedactions)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redact(item),
      ]),
    );
  }
  return value;
}
function trace(event: string, data: unknown) {
  appendFileSync(
    tracePath,
    `${JSON.stringify(redact({ traceSession, at: new Date().toISOString(), event, data }))}\n`,
  );
}

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let app: Awaited<ReturnType<typeof createApp>>;
let apiUrl: string;
const http = createServer();
const gates = new Map<string, ServerResponse>();
const arrivals: Array<{
  phase: string;
  companyId: string;
  agentId: string;
  runId: string;
}> = [];
let releaseAll = false;
const control = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const identity = JSON.parse(Buffer.concat(chunks).toString());
  const arrival = { phase: (req.url ?? "/invalid").slice(1), ...identity };
  arrivals.push(arrival);
  trace("process-rendezvous", arrival);
  if (releaseAll) res.end("release");
  else gates.set(`${identity.runId}:${arrival.phase}`, res);
});
function release(runId: string, phase: string) {
  const key = `${runId}:${phase}`;
  const response = gates.get(key);
  if (response) {
    response.end("release");
    gates.delete(key);
  }
}

// Observation only: never reissues HTTP mutations or adopts a recent/stale run.
// Same 3-second acquisition bound as the immutable source suite.
async function observe<T>(
  label: string,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 3_000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  trace("observation-deadline", { label, arrivals });
  throw new Error(`No ${label} within unchanged 3000ms acquisition budget`);
}
async function arrived(runId: string, phase: string) {
  return observe(`${runId}:${phase} rendezvous`, async () =>
    arrivals.find((entry) => entry.runId === runId && entry.phase === phase),
  );
}
async function snapshot(companyId: string, label: string) {
  const result: Record<string, unknown> = {};
  for (const name of [
    "issues",
    "agent_wakeup_requests",
    "heartbeat_runs",
    "heartbeat_run_events",
    "issue_execution_decisions",
    "issue_recovery_actions",
    "issue_tree_holds",
    "issue_tree_hold_members",
    "environment_leases",
    "activity_log",
  ]) {
    result[name] = await db.execute(
      sql.raw(
        `select to_jsonb(t) as row from ${name} t where company_id = '${companyId}' order by id`,
      ),
    );
  }
  result.lockGraph = await db.execute(sql`
    select a.pid, a.state, a.wait_event_type, a.wait_event,
      pg_blocking_pids(a.pid) as blocking_pids,
      coalesce((select jsonb_agg(jsonb_build_object('locktype', l.locktype, 'mode', l.mode,
        'granted', l.granted, 'relation', l.relation::regclass::text, 'transactionid', l.transactionid::text))
        from pg_locks l where l.pid = a.pid), '[]'::jsonb) as locks
    from pg_stat_activity a where a.datname = current_database() and a.pid <> pg_backend_pid()
    order by a.pid
  `);
  result.agents = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  trace("snapshot", { label, companyId, state: result });
  return result;
}

interface Auth {
  agentId: string;
  token: string;
}
async function request<T = Record<string, unknown>>(
  label: string,
  method: string,
  route: string,
  body?: unknown,
  auth?: Auth,
  runId?: string,
  companyId?: string,
): Promise<{ status: number; body: T }> {
  const before = companyId
    ? await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))
    : [];
  trace("request", {
    label,
    method,
    route,
    body,
    actor: auth
      ? { type: "agent", agentId: auth.agentId, companyId, runId }
      : { type: "local_trusted_board" },
    beforeReceiptIds: before.map((receipt) => receipt.id),
  });
  const response = await fetch(`${apiUrl}/api${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
      ...(runId ? { "X-Paperclip-Run-Id": runId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(3_000),
  });
  const result = {
    status: response.status,
    body: (await response.json()) as T,
  };
  if (
    route.endsWith("/keys") &&
    typeof (result.body as Record<string, unknown>).token === "string"
  ) {
    credentials.add((result.body as Record<string, string>).token);
  }
  const after = companyId
    ? await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))
    : [];
  const changedReceipts = after.filter((receipt) => {
    const old = before.find((entry) => entry.id === receipt.id);
    return !old || JSON.stringify(old) !== JSON.stringify(receipt);
  });
  trace("response", {
    label,
    ...result,
    changedReceipts,
    newReceiptIds: after
      .filter((entry) => !before.some((old) => old.id === entry.id))
      .map((entry) => entry.id),
  });
  if (companyId) await snapshot(companyId, label);
  return result;
}

beforeAll(async () => {
  trace("contract", {
    sourceBase: "28211c5be108f5aa3beb1399141038486e20e0eb",
    sourceHead: process.env.SIGNOFF_HTTP_SOURCE_HEAD,
    middleware: "actual createApp actorMiddleware",
    credentials:
      "disposable HTTP-issued API keys + exact persisted run headers",
    browserRequired: false,
  });
  database = await startEmbeddedPostgresTestDatabase("signoff-http-admission-");
  db = createDb(database.connectionString);
  // CLI onboarding normally persists this identity. createApp alone does not;
  // seed the disposable equivalent, not an injected request actor.
  await db.insert(authUsers).values({
    id: "local-board",
    name: "Disposable local board",
    email: "local-board@fixture.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const home = process.env.PAPERCLIP_HOME;
  if (!home) throw new Error("Disposable PAPERCLIP_HOME is required");
  app = await createApp(db, {
    uiMode: "none",
    serverPort: 0,
    storageService: createStorageService(
      createLocalDiskStorageProvider(path.join(home, "storage")),
    ),
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    allowedHostnames: ["127.0.0.1"],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: false,
    instanceId: `http-admission-${randomUUID()}`,
    localPluginDir: path.join(home, "plugins"),
    managedPluginAutoInstall: [],
    decisionServiceOptions: { wakeOriginAgent: async () => undefined },
  });
  http.on("request", app);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("No diagnostic HTTP address");
  apiUrl = `http://127.0.0.1:${address.port}`;
  process.env.PAPERCLIP_API_URL = apiUrl;
});

afterAll(async () => {
  releaseAll = true;
  for (const target of lifecycle.targets.values()) target.release?.();
  lifecycle.targets.clear();
  for (const response of gates.values()) response.end("release");
  gates.clear();
  if (db && apiUrl) {
    for (const issue of await db.select().from(issues)) {
      await request("cleanup-cancel", "PATCH", `/issues/${issue.id}`, {
        status: "cancelled",
        comment: "Disposable HTTP fixture teardown",
      });
    }
    await heartbeatService(db).drainActiveRunExecutions();
    trace("executions-drained", {});
  }
  if (app) await app.locals.paperclipShutdown();
  http.closeAllConnections();
  control.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => http.close(() => resolve())),
    new Promise<void>((resolve) => control.close(() => resolve())),
  ]);
  if (database) await database.cleanup();
});

async function setup(label: string, hold?: "setup" | "finalizer") {
  const company = await request<{ id: string }>(
    `${label}:company`,
    "POST",
    "/companies",
    { name: `HTTP admission ${label}` },
  );
  expect(company.status).toBe(201);
  const companyId = company.body.id;
  await db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      membershipRole: "owner",
    })
    .onConflictDoNothing();
  const controlAddress = control.address();
  if (!controlAddress || typeof controlAddress === "string")
    throw new Error("No control address");
  const controlUrl = `http://127.0.0.1:${controlAddress.port}`;
  async function agent(name: string): Promise<Auth> {
    const hire = await request<{
      agent: { id: string };
      approval?: { id: string };
    }>(
      `${label}:hire:${name}`,
      "POST",
      `/companies/${companyId}/agent-hires`,
      {
        name,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: [
            path.resolve("tests/fixtures/signoff-http-admission-agent.mjs"),
          ],
          cwd: process.env.PAPERCLIP_HOME,
          env: {
            SIGNOFF_HTTP_CONTROL: controlUrl,
          },
        },
        runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 } },
      },
      undefined,
      undefined,
      companyId,
    );
    expect(hire.status).toBe(201);
    if (hire.body.approval) {
      const approval = await request(
        `${label}:approve-hire`,
        "POST",
        `/approvals/${hire.body.approval.id}/approve`,
        { decisionNote: "Disposable HTTP fixture" },
        undefined,
        undefined,
        companyId,
      );
      expect(approval.status).toBe(200);
    }
    const key = await request<{ token: string }>(
      `${label}:key:${name}`,
      "POST",
      `/agents/${hire.body.agent.id}/keys`,
      { name: "disposable HTTP fixture" },
      undefined,
      undefined,
      companyId,
    );
    expect(key.status).toBe(201);
    return { agentId: hire.body.agent.id, token: key.body.token };
  }
  const executor = await agent("Executor");
  const reviewer = await agent("Reviewer");
  const nonparticipant = await agent("Nonparticipant");
  if (hold) lifecycle.targets.set(companyId, { phase: hold });
  const issue = await request<{ id: string }>(
    `${label}:issue`,
    "POST",
    `/companies/${companyId}/issues`,
    {
      title: `HTTP admission ${label}`,
      status: "in_progress",
      assigneeAgentId: executor.agentId,
      executionPolicy: {
        stages: [
          {
            type: "review",
            participants: [{ type: "agent", agentId: reviewer.agentId }],
          },
        ],
      },
    },
    undefined,
    undefined,
    companyId,
  );
  expect(issue.status).toBe(201);
  return {
    companyId,
    issueId: issue.body.id,
    executor,
    reviewer,
    nonparticipant,
  };
}

async function invoke(
  label: string,
  companyId: string,
  agentId: string,
  issueId: string,
  afterResponse?: () => Promise<void>,
) {
  const idempotencyKey = `http-admission:${randomUUID()}`;
  const result = await request(
    label,
    "POST",
    `/agents/${agentId}/heartbeat/invoke`,
    {
      reason: "issue_assigned",
      payload: { issueId, taskId: issueId, taskKey: issueId },
      idempotencyKey,
    },
    undefined,
    undefined,
    companyId,
  );
  expect(result.status).toBe(202);
  const receipt = await db
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      ),
    );
  trace("invoke-correlation", {
    label,
    companyId,
    issueId,
    agentId,
    idempotencyKey,
    http: result,
    exactReceipts: receipt,
  });
  expect(receipt).toHaveLength(1);
  expect(receipt[0]).toMatchObject({ agentId, payload: { issueId } });
  await afterResponse?.();
  const run = await observe(`${label} exact receipt run`, async () => {
    const [current] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, receipt[0].id));
    if (current.runId) {
      const [bound] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, current.runId));
      return bound;
    }
    // A deferred receipt need not mint a second run. Follow only this exact
    // issue's ownership pointer, and require its reciprocal automatic receipt;
    // never search the agent's recent runs or accept a stale terminal run.
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId));
    const pointer = issue.executionRunId ?? issue.checkoutRunId;
    if (!pointer) return undefined;
    const [bound] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, pointer));
    if (
      !bound ||
      bound.agentId !== agentId ||
      !["queued", "running"].includes(bound.status)
    )
      return undefined;
    const [automatic] = bound.wakeupRequestId
      ? await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, bound.wakeupRequestId))
      : [];
    if (
      !automatic ||
      automatic.runId !== bound.id ||
      automatic.payload?.issueId !== issueId ||
      automatic.agentId !== agentId ||
      automatic.companyId !== companyId
    )
      return undefined;
    trace("deferred-to-exact-owner", {
      label,
      explicitReceipt: current,
      automaticReceipt: automatic,
      pointer,
      run: bound,
    });
    return bound;
  });
  expect(run.companyId).toBe(companyId);
  expect(run.agentId).toBe(agentId);
  expect(run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId).toBe(
    issueId,
  );
  if (typeof result.body.id === "string") expect(run.id).toBe(result.body.id);
  trace("receipt-run-bound", { label, receiptId: receipt[0].id, run });
  return run.id;
}

test.each(["adapter", "setup", "finalizer"] as const)(
  "real HTTP reviewer admission at outgoing %s boundary",
  async (schedule) => {
    const ctx = await setup(
      `${schedule}-boundary`,
      schedule === "adapter" ? undefined : schedule,
    );
    const executorRun = await invoke(
      "executor-invoke",
      ctx.companyId,
      ctx.executor.agentId,
      ctx.issueId,
    );
    if (schedule === "setup") {
      await observe(
        "outgoing setup held",
        async () => lifecycle.targets.get(ctx.companyId)?.runId,
      );
    } else {
      await arrived(executorRun, "adapter");
    }
    const donePromise = request(
      "executor-done",
      "PATCH",
      `/issues/${ctx.issueId}`,
      { status: "done", comment: "Ready for independent review" },
      ctx.executor,
      executorRun,
      ctx.companyId,
    );
    if (schedule !== "setup") {
      await arrived(executorRun, "cancel");
      if (schedule === "finalizer") {
        release(executorRun, "cancel");
        release(executorRun, "adapter");
        await observe(
          "outgoing terminal finalizer held",
          async () => lifecycle.targets.get(ctx.companyId)?.runId,
        );
      }
    } else {
      await observe("stage committed while outgoing setup held", async () => {
        const [issue] = await db
          .select()
          .from(issues)
          .where(eq(issues.id, ctx.issueId));
        return issue.status === "in_review" ? issue : undefined;
      });
    }
    await snapshot(ctx.companyId, `outgoing-${schedule}-held`);
    const reviewerRun = await invoke(
      "reviewer-invoke-outgoing-unreleased",
      ctx.companyId,
      ctx.reviewer.agentId,
      ctx.issueId,
      async () => {
        lifecycle.targets.get(ctx.companyId)?.release?.();
        release(executorRun, "cancel");
        release(executorRun, "adapter");
        const done = await donePromise;
        expect(done.status).toBe(200);
        expect(done.body.status).toBe("in_review");
        expect(done.body.assigneeAgentId).toBe(ctx.reviewer.agentId);
      },
    );
    await arrived(reviewerRun, "adapter");
    const automaticStageReceipts = await observe(
      "exact automatic stage receipt",
      async () => {
        const receipts = (
          await db
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, ctx.companyId),
                eq(agentWakeupRequests.agentId, ctx.reviewer.agentId),
                eq(agentWakeupRequests.source, "assignment"),
              ),
            )
        ).filter(
          (receipt) =>
            receipt.payload?.issueId === ctx.issueId &&
            (receipt.reason === "execution_review_requested" ||
              receipt.payload?.requestedReason ===
                "execution_review_requested"),
        );
        return receipts.length > 0 ? receipts : undefined;
      },
    );
    expect(automaticStageReceipts).toHaveLength(1);
    expect(automaticStageReceipts[0].payload?.executionStage).toMatchObject({
      currentParticipant: { agentId: ctx.reviewer.agentId },
      wakeRole: "reviewer",
    });
    if (automaticStageReceipts[0].status === "coalesced") {
      expect(automaticStageReceipts[0].runId).toBe(reviewerRun);
      expect(automaticStageReceipts[0].coalescedCount).toBe(1);
    }
    trace("automatic-stage-wake", {
      schedule,
      issueId: ctx.issueId,
      reviewerRun,
      exactReceipts: automaticStageReceipts,
    });
    const missingComment = await request(
      "reviewer-missing-comment",
      "PATCH",
      `/issues/${ctx.issueId}`,
      { status: "done" },
      ctx.reviewer,
      reviewerRun,
      ctx.companyId,
    );
    expect(missingComment.status).toBe(422);
    expect(JSON.stringify(missingComment.body)).toContain("comment");
    const forged = await request(
      "invalid-credential-no-board-fallback",
      "PATCH",
      `/issues/${ctx.issueId}`,
      { status: "done", comment: "Must never advance" },
      { agentId: ctx.reviewer.agentId, token: "invalid-disposable-key" },
      reviewerRun,
      ctx.companyId,
    );
    expect(forged.status).toBe(401);
    const wrongActor = await request(
      "nonparticipant-cannot-borrow-reviewer-run",
      "PATCH",
      `/issues/${ctx.issueId}`,
      { status: "done", comment: "Must never advance" },
      ctx.nonparticipant,
      reviewerRun,
      ctx.companyId,
    );
    expect(wrongActor.status).toBe(403);
    const noRun = await request(
      "reviewer-missing-run-binding",
      "PATCH",
      `/issues/${ctx.issueId}`,
      { status: "done", comment: "Must never advance" },
      ctx.reviewer,
      undefined,
      ctx.companyId,
    );
    expect(noRun.status).toBe(403);
    expect(JSON.stringify(noRun.body)).toMatch(/run/i);
    const selfKey = `http-admission-agent:${randomUUID()}`;
    const selfInvoke = await request(
      "credentialed-reviewer-self-invoke",
      "POST",
      `/agents/${ctx.reviewer.agentId}/heartbeat/invoke`,
      {
        reason: "issue_assigned",
        payload: {
          issueId: ctx.issueId,
          taskId: ctx.issueId,
          taskKey: ctx.issueId,
        },
        idempotencyKey: selfKey,
      },
      ctx.reviewer,
      reviewerRun,
      ctx.companyId,
    );
    expect(selfInvoke.status).toBe(202);
    const selfReceipt = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, ctx.companyId),
          eq(agentWakeupRequests.idempotencyKey, selfKey),
        ),
      );
    expect(selfReceipt).toHaveLength(1);
    expect(selfReceipt[0]).toMatchObject({
      companyId: ctx.companyId,
      agentId: ctx.reviewer.agentId,
      requestedByActorType: "agent",
      requestedByActorId: ctx.reviewer.agentId,
      payload: { issueId: ctx.issueId },
    });
    trace("credentialed-invoke-correlation", {
      schedule,
      reviewerRun,
      http: selfInvoke,
      exactReceipt: selfReceipt[0],
    });
    const otherInvoke = await request(
      "nonparticipant-cannot-invoke-reviewer",
      "POST",
      `/agents/${ctx.reviewer.agentId}/heartbeat/invoke`,
      { payload: { issueId: ctx.issueId } },
      ctx.nonparticipant,
      undefined,
      ctx.companyId,
    );
    expect(otherInvoke.status).toBe(403);
    const before = await db
      .select()
      .from(issues)
      .where(eq(issues.id, ctx.issueId));
    expect(before[0].status).toBe("in_review");
    expect(before[0].assigneeAgentId).toBe(ctx.reviewer.agentId);
    release(executorRun, "cancel");
    release(executorRun, "adapter");
    const changesPromise = request(
      "reviewer-changes-requested",
      "PATCH",
      `/issues/${ctx.issueId}`,
      { status: "in_progress", comment: "Needs another pass on edge cases" },
      ctx.reviewer,
      reviewerRun,
      ctx.companyId,
    );
    await arrived(reviewerRun, "cancel");
    release(reviewerRun, "cancel");
    release(reviewerRun, "adapter");
    const changes = await changesPromise;
    expect(changes.status).toBe(200);
    expect(changes.body.status).toBe("in_progress");
    expect(changes.body.assigneeAgentId).toBe(ctx.executor.agentId);
    expect(changes.body.executionState).toMatchObject({
      status: "changes_requested",
      lastDecisionOutcome: "changes_requested",
    });
    release(reviewerRun, "cancel");
    release(reviewerRun, "adapter");
    lifecycle.targets.delete(ctx.companyId);
    trace("schedule-complete", {
      schedule,
      ...ctx,
      executor: { agentId: ctx.executor.agentId },
      reviewer: { agentId: ctx.reviewer.agentId },
      nonparticipant: { agentId: ctx.nonparticipant.agentId },
    });
  },
);
