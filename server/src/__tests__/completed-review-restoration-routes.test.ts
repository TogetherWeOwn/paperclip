import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, issues } from "@paperclipai/db";
import type { CompletedReviewRestorationAuthorization, CompletedReviewRestorationInput } from "../services/completed-review-restoration.js";
import { forbidden } from "../errors.js";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(), restore: vi.fn(), access: vi.fn(), decide: vi.fn(), review: vi.fn(),
}));
vi.mock("../services/issues.js", () => ({ issueService: () => ({ getById: mocks.getById }) }));
vi.mock("../services/completed-review-restoration.js", () => ({ completedReviewRestorationService: () => ({ restore: mocks.restore }) }));
vi.mock("../services/access.js", () => ({ accessService: mocks.access }));
vi.mock("../services/issue-review-policy.js", () => ({ assertIssueReviewVerdictActorAllowed: mocks.review }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body = { completionActivityId: id(10), wakeupRequestId: id(11) };
const path = `/api/issues/${id(2)}/completed-review/restore`;
const db = { name: "outer-db" } as unknown as Db;
const tx = { name: "locked-transaction" } as unknown as Db;
const agent = { type: "agent", agentId: id(3), companyId: id(1), runId: id(4), source: "agent_jwt" };
const user = { type: "board", userId: "existing-user", companyIds: [id(1)], source: "session" };
let routeError: unknown;
let issue: typeof issues.$inferSelect;
let lockedIssue: typeof issues.$inferSelect;

async function app(actor: Record<string, unknown> = agent) {
  const [{ completedReviewRestorationRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/completed-review-restoration.js"), import("../middleware/error-handler.js"),
  ]);
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  server.use("/api", completedReviewRestorationRoutes(db));
  server.use(((error, _req, _res, next) => { routeError = error; next(error); }) as express.ErrorRequestHandler);
  server.use(errorHandler);
  return server;
}

beforeEach(() => {
  vi.resetAllMocks();
  routeError = undefined;
  issue = { id: id(2), companyId: id(1), projectId: id(5), parentId: null, status: "in_review",
    assigneeAgentId: id(3), assigneeUserId: null, reviewPolicy: "anyone" } as typeof issues.$inferSelect;
  lockedIssue = { ...issue };
  mocks.getById.mockResolvedValue(issue);
  mocks.access.mockReturnValue({ decide: mocks.decide });
  mocks.decide.mockResolvedValue({ allowed: true });
  mocks.review.mockResolvedValue(undefined);
  mocks.restore.mockImplementation(async (input: CompletedReviewRestorationInput, authorize: CompletedReviewRestorationAuthorization) => {
    await authorize.issue(tx, lockedIssue);
    await authorize.assignment(tx, lockedIssue, { type: "agent", agentId: id(6), userId: null });
    return { outcome: "restore", completionActivityId: input.completionActivityId, issue: { ...lockedIssue, status: "done" } };
  });
});

describe("completed-review restoration HTTP authorization (mock service)", () => {
  it("accepts only evidence locators, derives actor and scope, and reauthorizes locked facts", async () => {
    const response = await request(await app()).post(path).send(body);
    expect(response.status, String(routeError)).toBe(200);
    expect(response.body).toMatchObject({ outcome: "restore", completionActivityId: id(10), issue: { status: "done" } });
    expect(mocks.restore).toHaveBeenCalledWith({ ...body, companyId: id(1), issueId: id(2),
      actor: { actorType: "agent", actorId: id(3), agentId: id(3), runId: id(4), agentApiKeyId: null, actorSource: "agent_jwt" },
    }, expect.objectContaining({ issue: expect.any(Function), assignment: expect.any(Function) }));
    expect(mocks.access.mock.calls.map(([connection]) => connection)).toEqual([db, tx, tx]);
    expect(mocks.decide.mock.calls.map(([input]) => input.action)).toEqual(["issue:mutate", "issue:mutate", "tasks:assign"]);
    expect(mocks.review).toHaveBeenLastCalledWith(tx, { issue: lockedIssue, actor: { type: "agent", id: id(3) } });
    expect(mocks.decide).toHaveBeenLastCalledWith(expect.objectContaining({
      actor: agent, resource: expect.objectContaining({ companyId: id(1), issueId: id(2), projectId: id(5), assigneeAgentId: id(6) }),
    }));
  });

  it("allows an authenticated existing company user only through the same write/review/assignment checks", async () => {
    const response = await request(await app(user)).post(path).send(body);
    expect(response.status, String(routeError)).toBe(200);
    expect(mocks.review).toHaveBeenLastCalledWith(tx, { issue: lockedIssue, actor: { type: "user", id: "existing-user" } });
  });

  it("rejects unauthenticated requests before resource lookup", async () => {
    expect((await request(await app({ type: "none" })).post(path).send(body)).status).toBe(401);
    expect(mocks.getById).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it.each(["missing", "foreign-agent", "foreign-user", "invalid-id"])("returns the same inaccessible 404 for %s", async (kind) => {
    if (kind === "missing") mocks.getById.mockResolvedValue(null);
    const actor = kind === "foreign-agent" ? { ...agent, companyId: id(99) }
      : kind === "foreign-user" ? { ...user, companyIds: [id(99)] } : agent;
    const response = await request(await app(actor)).post(kind === "invalid-id" ? path.replace(id(2), "not-an-id") : path).send(body);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Issue not found" });
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("denies viewer company membership", async () => {
    const actor = { ...user, memberships: [{ companyId: id(1), membershipRole: "viewer", status: "active" }] };
    expect((await request(await app(actor)).post(path).send(body)).status).toBe(403);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it.each(["skill_test", "task_bridge"])("does not extend the %s key capability scope", async (kind) => {
    expect((await request(await app({ ...agent, source: "agent_key", keyScope: { kind } })).post(path).send(body)).status).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("requires agent run attribution before restoration", async () => {
    expect((await request(await app({ ...agent, runId: undefined })).post(path).send(body)).status).toBe(401);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it.each(["executionState", "actor", "companyId", "issueId", "decisionIds", "assigneeAgentId", "resume", "comment"])(
    "rejects client-supplied %s rather than stripping it", async (field) => {
      expect((await request(await app()).post(path).send({ ...body, [field]: {} })).status).toBe(400);
      expect(mocks.restore).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { ...body, completionActivityId: "not-a-uuid" }, { ...body, wakeupRequestId: null }])("rejects invalid locators %j", async (input) => {
    expect((await request(await app()).post(path).send(input)).status).toBe(400);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("propagates ordinary write denial without entering restoration", async () => {
    mocks.decide.mockResolvedValue({ allowed: false, reason: "deny_scope", explanation: "Denied" });
    expect((await request(await app()).post(path).send(body)).status).toBe(403);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("rechecks policy on the locked current row, not the preflight snapshot", async () => {
    lockedIssue = { ...issue, reviewPolicy: "human_only" };
    mocks.review.mockImplementation(async (_tx, input) => {
      if (input.issue.reviewPolicy === "human_only") throw forbidden("Human review required");
    });
    expect((await request(await app()).post(path).send(body)).status).toBe(403);
    expect(mocks.decide.mock.calls.map(([input]) => input.action)).toEqual(["issue:mutate", "issue:mutate"]);
  });

  it("rechecks issue write scope after locking", async () => {
    lockedIssue = { ...issue, projectId: id(99) };
    mocks.decide.mockImplementation(async (input) => ({ allowed: input.resource.projectId !== id(99), reason: "deny_scope" }));
    expect((await request(await app()).post(path).send(body)).status).toBe(403);
    expect(mocks.decide).toHaveBeenLastCalledWith(expect.objectContaining({ resource: expect.objectContaining({ projectId: id(99) }) }));
  });

  it("does not bypass protected original-target assignment authorization", async () => {
    mocks.decide.mockImplementation(async (input) => ({ allowed: input.action !== "tasks:assign", reason: "deny_scope" }));
    expect((await request(await app()).post(path).send(body)).status).toBe(403);
  });

  it("does not turn a low-trust write denial into restoration authority", async () => {
    mocks.decide.mockResolvedValue({ allowed: false, reason: "deny_low_trust", explanation: "Low trust denied" });
    expect((await request(await app()).post(path).send(body)).status).toBe(403);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
