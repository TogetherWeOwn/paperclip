import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hasPermission = vi.fn();
vi.mock("../services/access.js", () => ({
  accessService: () => ({ hasPermission }),
}));

const { errorHandler } = await import("../middleware/error-handler.js");
const { chatChannelRoutes } = await import("../routes/chat-channels.js");
type ChatChannelService = import("../services/chat-channels.js").ChatChannelService;

const companyId = "11111111-1111-4111-8111-111111111111";
const endpointId = "33333333-3333-4333-8333-333333333333";
const path = `/api/chat-endpoints/${endpointId}/github/review-on-green`;
const manager: Express.Request["actor"] = {
  type: "board",
  source: "session",
  userId: "manager-user",
  companyIds: [companyId],
};
const chat = { get: vi.fn(), requestGitHubReviewOnGreen: vi.fn() };

function app(actor: Express.Request["actor"]) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  instance.use(
    "/api",
    chatChannelRoutes({} as Db, {
      service: chat as unknown as ChatChannelService,
      heartbeat: { wakeup: vi.fn() },
    }),
  );
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  vi.resetAllMocks();
  chat.get.mockResolvedValue({ id: endpointId, companyId });
  chat.requestGitHubReviewOnGreen.mockResolvedValue({
    status: "requested",
    headSha: "b".repeat(40),
    reason: "automatic_review",
  });
  hasPermission.mockResolvedValue(true);
});

describe("POST /chat-endpoints/:endpointId/github/review-on-green", () => {
  it("lets a connection manager request a review and returns the outcome", async () => {
    await request(app(manager))
      .post(path)
      .send({ repository: "acme/app", pullNumber: 7 })
      .expect(200, {
        status: "requested",
        headSha: "b".repeat(40),
        reason: "automatic_review",
      });
    expect(hasPermission).toHaveBeenCalledWith(
      companyId,
      "user",
      "manager-user",
      "tools:manage_connections",
    );
    expect(chat.requestGitHubReviewOnGreen).toHaveBeenCalledWith(
      endpointId,
      "acme/app",
      7,
    );
  });

  it("rejects agent actors before touching the endpoint", async () => {
    await request(
      app({
        type: "agent",
        source: "agent_key",
        agentId: "agent-1",
        companyId,
      } as Express.Request["actor"]),
    )
      .post(path)
      .send({ repository: "acme/app", pullNumber: 7 })
      .expect(403);
    expect(chat.requestGitHubReviewOnGreen).not.toHaveBeenCalled();
  });

  it("rejects a board member without the connection-management permission", async () => {
    hasPermission.mockResolvedValue(false);
    await request(app(manager))
      .post(path)
      .send({ repository: "acme/app", pullNumber: 7 })
      .expect(403);
    expect(chat.requestGitHubReviewOnGreen).not.toHaveBeenCalled();
  });

  it("keeps the non-member 404 boundary", async () => {
    await request(app({ ...manager, companyIds: [] }))
      .post(path)
      .send({ repository: "acme/app", pullNumber: 7 })
      .expect(404);
    expect(chat.requestGitHubReviewOnGreen).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { repository: "acme/app" },
    { repository: "acme", pullNumber: 7 },
    { repository: "acme/app/../x", pullNumber: 7 },
    { repository: "acme/app", pullNumber: 0 },
    { repository: "acme/app", pullNumber: "7" },
    { repository: "acme/app", pullNumber: 1.5 },
  ])("rejects malformed body %j", async (body) => {
    await request(app(manager)).post(path).send(body).expect(400);
    expect(chat.requestGitHubReviewOnGreen).not.toHaveBeenCalled();
  });
});
