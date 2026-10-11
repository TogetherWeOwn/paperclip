/**
 * Isolated controls for the native bounded read-only observation scope
 * for the held cap-zero flow.
 *
 * No production, no live issuance, no real credentials: every scope under test
 * is a synthetic fixture for a fixture company (never a real instance id).
 * Positive controls
 * cover all three permitted read paths with consumer-shaped queries;
 * negative controls cover writes, unused reads, cross-company access,
 * invalid scopes, expiry, revocation-shaped denial and role-elevation bypass.
 * Forbidden requests are asserted to stop before mutation handlers (spies),
 * and permitted reads are asserted to issue zero recovery/business-state
 * writes (handlers expose only pure read deps).
 */
import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companyMemberships,
} from "@paperclipai/db";
import { normalizeAgentApiKeyScope } from "@paperclipai/shared";
import { actorMiddleware } from "../middleware/auth.js";
import { observerCeiling } from "../middleware/observer-ceiling.js";
import {
  handleObserverHeartbeatRuns,
  handleObserverIssuesList,
  handleObserverLiveRuns,
} from "../routes/observer.js";
import {
  asObserverActor,
  checkObserverCeiling,
  parseObserverHeartbeatQuery,
  parseObserverIssuesQuery,
  parseObserverLiveQuery,
  projectObserverIssue,
  projectObserverRun,
  readObserverRunIssueId,
  validateObserverScope,
} from "../services/observer-scope.js";

// Synthetic fixture companies (never a real instance id). The ceiling binds
// the scope company to the key company and the route company on every
// request; no company is pinned in shared code.
const COMPANY = "c0ffee00-1234-4abc-8def-000000000001";
const OTHER_COMPANY = "11111111-2222-4333-8444-555555555555";

function validScope(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    kind: "observer",
    companyId: COMPANY,
    purpose: "held-cap-zero-observation",
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

function observerActor(scope: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: "agent-1",
    companyId: COMPANY,
    keyScope: scope,
    source: "agent_key",
    ...extra,
  };
}

describe("validateObserverScope", () => {
  it("accepts a live synthetic fixture scope", () => {
    const check = validateObserverScope(validScope());
    expect(check.ok).toBe(true);
  });

  it("accepts any well-formed company id; the ceiling binds it to the key and route", () => {
    const check = validateObserverScope(validScope({ companyId: OTHER_COMPANY }));
    expect(check.ok).toBe(true);
  });

  it("denies malformed scopes without falling back to standard", () => {
    for (const malformed of [
      null,
      undefined,
      "observer",
      { kind: "observer" },
      { kind: "standard" },
      validScope({ purpose: "something-else" }),
      validScope({ kind: "standard" }),
      { ...validScope(), extraKey: "nope" },
    ]) {
      expect(validateObserverScope(malformed).ok).toBe(false);
    }
  });

  it("denies windows longer than 35 minutes", () => {
    const now = Date.now();
    const check = validateObserverScope({
      kind: "observer",
      companyId: COMPANY,
      purpose: "held-cap-zero-observation",
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 36 * 60_000).toISOString(),
    });
    expect(check.ok).toBe(false);
  });

  it("denies expired and not-yet-valid scopes (non-sliding)", () => {
    const now = Date.now();
    expect(
      validateObserverScope(
        validScope({
          issuedAt: new Date(now - 20 * 60_000).toISOString(),
          expiresAt: new Date(now - 60_000).toISOString(),
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateObserverScope(
        validScope({
          issuedAt: new Date(now + 60_000).toISOString(),
          expiresAt: new Date(now + 10 * 60_000).toISOString(),
        }),
      ).ok,
    ).toBe(false);
  });
});

describe("normalizeAgentApiKeyScope fail-closed", () => {
  it("parses a valid observer fixture", () => {
    expect(normalizeAgentApiKeyScope(validScope())).toMatchObject({ kind: "observer" });
  });

  it("throws on malformed scopes instead of returning standard", () => {
    expect(() => normalizeAgentApiKeyScope({ kind: "nope" })).toThrow();
    expect(() => normalizeAgentApiKeyScope(validScope({ purpose: "x" }))).toThrow();
  });

  it("keeps legacy nullish scopes as standard", () => {
    expect(normalizeAgentApiKeyScope(null)).toEqual({ kind: "standard" });
    expect(normalizeAgentApiKeyScope(undefined)).toEqual({ kind: "standard" });
  });
});

describe("checkObserverCeiling", () => {
  const paths = [
    `/api/companies/${COMPANY}/issues`,
    `/api/companies/${COMPANY}/heartbeat-runs`,
    `/api/companies/${COMPANY}/live-runs`,
  ];

  it("ignores non-observer actors", () => {
    expect(
      checkObserverCeiling({ actor: { type: "board" }, method: "GET", path: paths[0] }),
    ).toBeNull();
    expect(
      checkObserverCeiling({
        actor: observerActor({ kind: "standard" }),
        method: "GET",
        path: paths[0],
      }),
    ).toBeNull();
  });

  it("permits GET on all three read templates", () => {
    for (const path of paths) {
      const check = checkObserverCeiling({
        actor: observerActor(validScope()),
        method: "GET",
        path,
      });
      expect(check?.ok).toBe(true);
    }
  });

  it("denies other verbs including HEAD and OPTIONS", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const check = checkObserverCeiling({
        actor: observerActor(validScope()),
        method,
        path: paths[0],
      });
      expect(check?.ok).toBe(false);
      if (check && !check.ok) expect(check.code).toBe("OBSERVER_METHOD_DENIED");
    }
  });

  it("denies unused reads, single-issue reads, key/runtime/secret/log paths", () => {
    const denied = [
      `/api/companies/${COMPANY}/issues/count`,
      `/api/companies/${COMPANY}/issues/some-id`,
      `/api/companies/${COMPANY}/execution-workspaces`,
      `/api/companies/${COMPANY}/heartbeat-runs/some-id`,
      `/api/companies/${COMPANY}/agent-keys`,
      `/api/companies/${COMPANY}/secrets`,
      `/api/companies/${COMPANY}/activity`,
      `/api/board-api-keys`,
      `/api/issues/some-id`,
      `/api/health`,
    ];
    for (const path of denied) {
      const check = checkObserverCeiling({
        actor: observerActor(validScope()),
        method: "GET",
        path,
      });
      expect(check?.ok).toBe(false);
    }
    // Non-allowlisted query keys (e.g. view=compact) pass the path ceiling
    // and fail closed at the bounded query parser instead.
    expect(
      checkObserverCeiling({
        actor: observerActor(validScope()),
        method: "GET",
        path: `/api/companies/${COMPANY}/issues`,
      })?.ok,
    ).toBe(true);
    expect(parseObserverIssuesQuery({ view: "compact" }).ok).toBe(false);
  });

  it("denies cross-company reads", () => {
    const check = checkObserverCeiling({
      actor: observerActor(validScope()),
      method: "GET",
      path: `/api/companies/${OTHER_COMPANY}/issues`,
    });
    expect(check?.ok).toBe(false);
    if (check && !check.ok) expect(check.code).toBe("OBSERVER_COMPANY_DENIED");
  });

  it("denies when the key company drifts from the scope company", () => {
    const check = checkObserverCeiling({
      actor: observerActor(validScope(), { companyId: OTHER_COMPANY }),
      method: "GET",
      path: `/api/companies/${COMPANY}/issues`,
    });
    expect(check?.ok).toBe(false);
  });

  it("denies when the scope company drifts from the key and route company", () => {
    const check = checkObserverCeiling({
      actor: observerActor(validScope({ companyId: OTHER_COMPANY })),
      method: "GET",
      path: `/api/companies/${COMPANY}/issues`,
    });
    expect(check?.ok).toBe(false);
    if (check && !check.ok) expect(check.code).toBe("OBSERVER_COMPANY_DENIED");
  });

  it("denies expired scopes and never elevates instance admins", () => {
    const now = Date.now();
    const expired = validScope({
      issuedAt: new Date(now - 20 * 60_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString(),
    });
    const check = checkObserverCeiling({
      actor: observerActor(expired, { isInstanceAdmin: true }),
      method: "GET",
      path: `/api/companies/${COMPANY}/issues`,
    });
    expect(check?.ok).toBe(false);
  });

  it("role elevation cannot widen the ceiling", () => {
    const actor = observerActor(validScope(), {
      isInstanceAdmin: true,
      memberships: [{ companyId: OTHER_COMPANY, membershipRole: "owner", status: "active" }],
      onBehalfOfMemberships: [{ companyId: COMPANY, membershipRole: "owner", status: "active" }],
    });
    expect(
      checkObserverCeiling({ actor, method: "GET", path: `/api/companies/${COMPANY}/issues` })?.ok,
    ).toBe(true);
    const widened = checkObserverCeiling({
      actor,
      method: "GET",
      path: `/api/companies/${OTHER_COMPANY}/issues`,
    });
    expect(widened?.ok).toBe(false);
    const elevatedWrite = checkObserverCeiling({
      actor,
      method: "POST",
      path: `/api/companies/${COMPANY}/issues`,
    });
    expect(elevatedWrite?.ok).toBe(false);
  });
});

describe("observer query allowlists", () => {
  it("accepts the pinned consumer issue page shape", () => {
    const parsed = parseObserverIssuesQuery({ status: "todo", limit: "1000", offset: "0" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.filters).toMatchObject({ limit: 1000, offset: 0 });
    }
  });

  it("accepts multi-status and sort params with complete pagination", () => {
    const parsed = parseObserverIssuesQuery({
      status: ["todo", "in_progress"],
      limit: "500",
      offset: "500",
      sortField: "updated",
      sortDir: "desc",
    });
    expect(parsed.ok).toBe(true);
  });

  it("denies non-allowlisted issue params and bad values", () => {
    const bad: Array<Record<string, unknown>> = [
      { status: "todo", view: "compact" },
      { status: "todo", q: "prune" },
      { status: "todo", assigneeAgentId: "x" },
      { status: "todo", projectId: "x" },
      { status: "todo", attention: "blocked" },
      { status: "bogus" },
      { status: "" },
      { limit: "0" },
      { limit: "1001" },
      { limit: "abc" },
      { offset: "-1" },
      { sortField: "created" },
      { sortDir: "sideways" },
    ];
    for (const query of bad) {
      expect(parseObserverIssuesQuery(query).ok, JSON.stringify(query)).toBe(false);
    }
  });

  it("accepts the pinned consumer heartbeat shape", () => {
    expect(parseObserverHeartbeatQuery({ limit: "200" }).ok).toBe(true);
    expect(parseObserverHeartbeatQuery({}).ok).toBe(true);
  });

  it("denies heartbeat overreach", () => {
    expect(parseObserverHeartbeatQuery({ limit: "0" }).ok).toBe(false);
    expect(parseObserverHeartbeatQuery({ limit: "1001" }).ok).toBe(false);
    expect(parseObserverHeartbeatQuery({ agentId: "not-a-uuid" }).ok).toBe(false);
    expect(parseObserverHeartbeatQuery({ summary: "maybe" }).ok).toBe(false);
    expect(parseObserverHeartbeatQuery({ limit: "200", include: "all" }).ok).toBe(false);
  });

  it("accepts live defaults and bounds, denies extras", () => {
    expect(parseObserverLiveQuery({}).ok).toBe(true);
    expect(parseObserverLiveQuery({ limit: "50", minCount: "50" }).ok).toBe(true);
    expect(parseObserverLiveQuery({ limit: "51" }).ok).toBe(false);
    expect(parseObserverLiveQuery({ limit: "0" }).ok).toBe(false);
    expect(parseObserverLiveQuery({ minCount: "-1" }).ok).toBe(false);
    expect(parseObserverLiveQuery({ minCount: "51" }).ok).toBe(false);
    expect(parseObserverLiveQuery({ limit: "abc" }).ok).toBe(false);
    expect(parseObserverLiveQuery({ agentId: "x" }).ok).toBe(false);
  });
});

describe("observer projections", () => {
  it("keeps issue identity/status and safety joins, drops snapshots and blobs", () => {
    const projected = projectObserverIssue({
      id: "issue-1",
      identifier: "TEST-1",
      title: "t",
      status: "todo",
      priority: "high",
      projectId: "p",
      parentId: null,
      assigneeAgentId: "a",
      assigneeUserId: null,
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
      contextSnapshot: { issueId: "issue-1", secret: "x" },
      output: "arbitrary",
      env: { TOKEN: "x" },
      activeRecoveryAction: {
        id: "ra-1",
        status: "active",
        kind: "k",
        cause: "c",
        attemptCount: 1,
        maxAttempts: 3,
        evidence: { snapshot: "drop me" },
        fingerprint: "drop me",
        wakePolicy: {},
      },
      successfulRunHandoff: {
        state: "required",
        sourceRunId: "run-1",
        detectedProgressSummary: "drop me",
        details: { drop: true },
      },
    });
    expect(projected.id).toBe("issue-1");
    expect(projected.status).toBe("todo");
    expect(projected).not.toHaveProperty("contextSnapshot");
    expect(projected).not.toHaveProperty("output");
    expect(projected).not.toHaveProperty("env");
    expect(projected.activeRecoveryAction).toMatchObject({ id: "ra-1", status: "active" });
    expect(projected.activeRecoveryAction).not.toHaveProperty("evidence");
    expect(projected.activeRecoveryAction).not.toHaveProperty("fingerprint");
    expect(projected.successfulRunHandoff).toMatchObject({ state: "required" });
    expect(projected.successfulRunHandoff).not.toHaveProperty("detectedProgressSummary");
    expect(projected.successfulRunHandoff).not.toHaveProperty("details");
  });

  it("keeps run status/time/retry metadata, drops outputs and log/session fields", () => {
    const projected = projectObserverRun(
      {
        id: "run-1",
        status: "running",
        startedAt: "2026-10-11T00:00:00.000Z",
        scheduledRetryAt: null,
        scheduledRetryAttempt: 0,
        scheduledRetryReason: null,
        continuationAttempt: 0,
        livenessState: "live",
        contextIssueId: "issue-1",
        contextSnapshot: { issueId: "issue-1", everything: "drop" },
        resultJson: { summary: "drop" },
        resultSummary: "drop",
        usageJson: {},
        logRef: "drop",
        logBytes: 10,
        sessionIdBefore: "drop",
        stdoutExcerpt: "drop",
        execution: {
          phase: "working",
          label: "Working",
          attempt: 2,
          cause: "free text with sk-ant-secret",
          nextAction: "free text with sk-ant-secret",
        },
      },
      null,
    );
    expect(projected.issueId).toBe("issue-1");
    expect(projected.status).toBe("running");
    expect(projected.execution).toMatchObject({ phase: "working", attempt: 2 });
    expect(projected.execution).not.toHaveProperty("cause");
    expect(projected.execution).not.toHaveProperty("nextAction");
    for (const dropped of [
      "contextSnapshot",
      "resultJson",
      "resultSummary",
      "usageJson",
      "logRef",
      "logBytes",
      "sessionIdBefore",
      "stdoutExcerpt",
    ]) {
      expect(projected).not.toHaveProperty(dropped);
    }
  });

  it("resolves the run issue reference from every served row shape", () => {
    // heartbeat.list rows: summarized snapshot object.
    expect(
      readObserverRunIssueId({ id: "r", contextSnapshot: { issueId: "i-snap" } }),
    ).toBe("i-snap");
    // Observer live rows: flat column.
    expect(readObserverRunIssueId({ id: "r", issueId: "i-flat" })).toBe("i-flat");
    // Legacy flat column fallback.
    expect(readObserverRunIssueId({ id: "r", contextIssueId: "i-legacy" })).toBe("i-legacy");
    expect(readObserverRunIssueId({ id: "r" })).toBeNull();
    expect(readObserverRunIssueId(null)).toBeNull();
  });
});

describe("observerCeiling middleware", () => {
  function ceilingApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = (req.header("x-test-actor") ?? "") === "observer"
        ? (observerActor(
            req.header("x-test-scope") === "expired"
              ? validScope({
                  issuedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
                  expiresAt: new Date(Date.now() - 60_000).toISOString(),
                })
              : validScope(),
          ) as never)
        : ({ type: "board" }) as never;
      next();
    });
    app.use(observerCeiling());
    const mutation = vi.fn((_req, res) => res.json({ mutated: true }));
    const read = vi.fn((_req, res) => res.json({ read: true }));
    app.get(`/api/companies/${COMPANY}/issues`, read);
    app.post(`/api/companies/${COMPANY}/issues`, mutation);
    app.get(`/api/companies/${COMPANY}/execution-workspaces`, mutation);
    app.get(`/api/companies/${COMPANY}/issues/count`, mutation);
    return { app, mutation, read };
  }

  it("lets observer GETs on the allowed path reach the handler", async () => {
    const { app, read, mutation } = ceilingApp();
    const res = await request(app)
      .get(`/api/companies/${COMPANY}/issues`)
      .set("x-test-actor", "observer");
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("stops observer writes, unused reads and expired scopes before handlers", async () => {
    const cases: Array<{ method: "post" | "get"; path: string; scope?: string }> = [
      { method: "post", path: `/api/companies/${COMPANY}/issues` },
      { method: "get", path: `/api/companies/${COMPANY}/execution-workspaces` },
      { method: "get", path: `/api/companies/${COMPANY}/issues/count` },
      { method: "get", path: `/api/companies/${COMPANY}/issues`, scope: "expired" },
    ];
    for (const item of cases) {
      const { app, mutation, read } = ceilingApp();
      const res = await (item.method === "post" ? request(app).post(item.path) : request(app).get(item.path))
        .set("x-test-actor", "observer")
        .set("x-test-scope", item.scope ?? "live");
      expect(res.status, `${item.method} ${item.path}`).toBe(403);
      expect(mutation).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("does not gate non-observer actors", async () => {
    const { app } = ceilingApp();
    const res = await request(app).post(`/api/companies/${COMPANY}/issues`);
    expect(res.status).toBe(200);
  });
});

function fakeReqRes(input: {
  actor: unknown;
  method?: string;
  query?: Record<string, unknown>;
}) {
  const req = {
    actor: input.actor,
    method: input.method ?? "GET",
    query: input.query ?? {},
  } as never;
  const body: { status: number; payload: unknown } = { status: 200, payload: undefined };
  const res = {
    status(code: number) {
      body.status = code;
      return this;
    },
    json(payload: unknown) {
      body.payload = payload;
      return this;
    },
  } as never;
  return { req, res, body };
}

describe("observer handlers with injected read deps", () => {
  const scope = validScope();
  const actor = observerActor(scope);

  it("serves the issues projection from pure reads only", async () => {
    const listIssues = vi.fn(async () => [
      { id: "i1", status: "todo", title: "t", contextSnapshot: { x: 1 } },
    ]);
    const listActiveRecoveries = vi.fn(async () => new Map([["i1", { id: "ra", status: "active", evidence: {} }]]));
    const listHandoffs = vi.fn(async () => new Map());
    const { req, res, body } = fakeReqRes({ actor, query: { status: "todo", limit: "100", offset: "0" } });
    await handleObserverIssuesList(req, res, COMPANY, {
      listIssues,
      listActiveRecoveries,
      listHandoffs,
    });
    expect(body.status).toBe(200);
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith(COMPANY, {
      status: ["todo"],
      limit: 100,
      offset: 0,
      sortField: undefined,
      sortDir: undefined,
    });
    expect(listActiveRecoveries).toHaveBeenCalledWith(COMPANY, ["i1"]);
    expect(listHandoffs).toHaveBeenCalledWith(COMPANY, ["i1"]);
    const rows = body.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "i1", status: "todo" });
    expect(rows[0]).not.toHaveProperty("contextSnapshot");
    expect(rows[0].activeRecoveryAction).toMatchObject({ id: "ra" });
    expect(rows[0].activeRecoveryAction).not.toHaveProperty("evidence");
  });

  it("rejects invalid issue queries without touching read deps", async () => {
    const listIssues = vi.fn(async () => []);
    const listActiveRecoveries = vi.fn(async () => new Map());
    const listHandoffs = vi.fn(async () => new Map());
    const { req, res, body } = fakeReqRes({ actor, query: { status: "todo", view: "compact" } });
    await handleObserverIssuesList(req, res, COMPANY, {
      listIssues,
      listActiveRecoveries,
      listHandoffs,
    });
    expect(body.status).toBe(400);
    expect(listIssues).not.toHaveBeenCalled();
    expect(listActiveRecoveries).not.toHaveBeenCalled();
    expect(listHandoffs).not.toHaveBeenCalled();
  });

  it("denies non-GET and cross-company handler access without reads", async () => {
    const listIssues = vi.fn(async () => []);
    const { req, res, body } = fakeReqRes({ actor, method: "POST", query: {} });
    await handleObserverIssuesList(req, res, COMPANY, {
      listIssues,
      listActiveRecoveries: async () => new Map(),
      listHandoffs: async () => new Map(),
    });
    expect(body.status).toBe(403);
    expect(listIssues).not.toHaveBeenCalled();

    const cross = fakeReqRes({ actor, query: {} });
    await handleObserverIssuesList(cross.req, cross.res, OTHER_COMPANY, {
      listIssues,
      listActiveRecoveries: async () => new Map(),
      listHandoffs: async () => new Map(),
    });
    expect(cross.body.status).toBe(403);
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("serves heartbeat runs with consumer pagination intact", async () => {
    // Fixture mirrors the real heartbeat.list shape: the issue reference
    // lives inside the summarized contextSnapshot object; there is no flat
    // contextIssueId column on these rows.
    const listHeartbeatRuns = vi.fn(async () => [
      {
        id: "r1",
        status: "running",
        startedAt: "2026-10-11T00:00:00.000Z",
        contextSnapshot: { issueId: "i1", taskId: null, wakeReason: "x" },
        resultSummary: "drop",
        usageJson: { drop: true },
      },
    ]);
    const { req, res, body } = fakeReqRes({ actor, query: { limit: "200" } });
    await handleObserverHeartbeatRuns(req, res, COMPANY, { listHeartbeatRuns });
    expect(body.status).toBe(200);
    expect(listHeartbeatRuns).toHaveBeenCalledWith(COMPANY, undefined, 200, { summary: false });
    const rows = body.payload as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ id: "r1", issueId: "i1" });
    expect(rows[0]).not.toHaveProperty("contextSnapshot");
    expect(rows[0]).not.toHaveProperty("resultSummary");
    expect(rows[0]).not.toHaveProperty("usageJson");
  });

  it("rejects heartbeat overreach without reads", async () => {
    const listHeartbeatRuns = vi.fn(async () => []);
    const { req, res, body } = fakeReqRes({ actor, query: { limit: "200", agentId: "x" } });
    await handleObserverHeartbeatRuns(req, res, COMPANY, { listHeartbeatRuns });
    expect(body.status).toBe(400);
    expect(listHeartbeatRuns).not.toHaveBeenCalled();
  });

  it("serves live runs with the execution safety join", async () => {
    const queryLiveRuns = vi.fn(async () => [
      { id: "r1", status: "running", issueId: "i1", agentName: "drop me" },
    ]);
    const getExecutionProjections = vi.fn(
      async () =>
        new Map([
          [
            "r1",
            {
              phase: "working",
              label: "Working",
              attempt: 1,
              maxAttempts: 3,
              retryAt: null,
              permittedActions: ["inspect_run"],
              // Free text that may echo secrets or output: never forwarded.
              cause: "Next action: use sk-ant-secret",
              nextAction: "Next action: use sk-ant-secret",
            },
          ],
        ]),
    );
    const { req, res, body } = fakeReqRes({ actor, query: {} });
    await handleObserverLiveRuns(req, res, COMPANY, {
      queryLiveRuns,
      getExecutionProjections,
    });
    expect(body.status).toBe(200);
    expect(queryLiveRuns).toHaveBeenCalledWith(COMPANY, { limit: 50, minCount: 0 });
    expect(getExecutionProjections).toHaveBeenCalledWith(COMPANY, ["r1"]);
    const rows = body.payload as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      id: "r1",
      issueId: "i1",
      execution: { phase: "working", attempt: 1 },
    });
    expect(rows[0]).not.toHaveProperty("agentName");
    const execution = rows[0].execution as Record<string, unknown>;
    expect(execution).not.toHaveProperty("cause");
    expect(execution).not.toHaveProperty("nextAction");
  });

  it("rejects live overreach without reads", async () => {
    const queryLiveRuns = vi.fn(async () => []);
    const getExecutionProjections = vi.fn(async () => new Map());
    const { req, res, body } = fakeReqRes({ actor, query: { limit: "5000" } });
    await handleObserverLiveRuns(req, res, COMPANY, {
      queryLiveRuns,
      getExecutionProjections,
    });
    expect(body.status).toBe(400);
    expect(queryLiveRuns).not.toHaveBeenCalled();
    expect(getExecutionProjections).not.toHaveBeenCalled();
  });

  it("asObserverActor ignores non-agent and non-observer actors", () => {
    expect(asObserverActor({ type: "board" })).toBeNull();
    expect(asObserverActor(observerActor({ kind: "standard" }))).toBeNull();
    expect(asObserverActor(null)).toBeNull();
  });
});

describe("auth middleware fail-closed scope parsing", () => {
  const agentId = "aaaaaaaa-1111-4111-8111-111111111111";
  const token = "malformed-scope-token";

  function storedKeyDb(scopeConfig: unknown) {
    const keyRow = {
      id: "key-1",
      agentId,
      companyId: COMPANY,
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId: "user-1",
      scopeConfig,
      revokedAt: null,
    };
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === boardApiKeys) return Promise.resolve([]);
            if (table === agentApiKeys) return Promise.resolve([keyRow]);
            if (table === agents) {
              return Promise.resolve([{ id: agentId, companyId: COMPANY, status: "active" }]);
            }
            if (table === authUsers) return Promise.resolve([{ id: "user-1" }]);
            if (table === companyMemberships) {
              return Promise.resolve([
                { companyId: COMPANY, membershipRole: "owner", status: "active" },
              ]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
      update: () => ({
        set: () => ({ where: () => Promise.resolve([]) }),
      }),
      insert: () => ({
        values: () => Promise.resolve([]),
      }),
    } as never;
    return db;
  }

  async function runActorMiddleware(scopeConfig: unknown) {
    const req: {
      method: string;
      path: string;
      actor?: unknown;
      header(name: string): string | undefined;
    } = {
      method: "GET",
      path: "/actor",
      header: (name) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined),
    };
    const next = await new Promise<unknown>((resolve) => {
      actorMiddleware(storedKeyDb(scopeConfig), { deploymentMode: "authenticated" })(
        req as never,
        {} as never,
        (err?: unknown) => resolve(err),
      );
    });
    return { next, actor: req.actor };
  }

  it("denies a stored key with a malformed scope instead of standard", async () => {
    const { next } = await runActorMiddleware({ kind: "nope" });
    expect(next).toMatchObject({ status: 403 });
  });

  it("authenticates a stored observer fixture scope", async () => {
    const { next, actor } = await runActorMiddleware(validScope());
    expect(next).toBeUndefined();
    expect(actor).toMatchObject({ type: "agent", keyScope: { kind: "observer" } });
  });
});
