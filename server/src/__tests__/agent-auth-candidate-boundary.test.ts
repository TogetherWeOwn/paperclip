import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentApiKeys, agents, boardApiKeys, chatGitHubReviewCandidates, heartbeatRuns } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { withGitHubPrimaryBlindingAdmission } from "../services/chat-github-primary-blinding-state.js";

// The candidate boundary runs on EVERY agent request. Companies that never
// admitted a review candidate must not pay any candidate-boundary query.

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createDb(input: { companyId: string; agentId: string; keyHash: string | null; candidate: boolean }) {
  const selects: unknown[] = [];
  const rowsFor = (table: unknown): unknown[] => {
    if (table === boardApiKeys) return [];
    if (table === agentApiKeys) return input.keyHash === null ? [] : [{ id: "key-1", agentId: input.agentId, companyId: input.companyId,
      keyHash: input.keyHash, responsibleUserId: "user-key", revokedAt: null, scopeConfig: null }];
    if (table === agents) return [{ id: input.agentId, companyId: input.companyId, status: "active" }];
    if (table === chatGitHubReviewCandidates) return input.candidate ? [{ id: "candidate-1" }] : [];
    if (table === heartbeatRuns) return [];
    return [];
  };
  const db = {
    select: () => ({
      from(table: unknown) {
        selects.push(table);
        return {
          where() {
            const rows = rowsFor(table);
            return Object.assign(Promise.resolve(rows), {
              limit: (count: number) => Promise.resolve(rows.slice(0, count)),
            });
          },
        };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
    // Admission barrier visibility read: the projected candidate is present.
    execute: async () => [{ present: true }],
  } as any;
  return { db, candidateSelects: () => selects.filter((table) => table === chatGitHubReviewCandidates).length };
}

function createApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/actor", (req, res) => res.json({ type: req.actor.type, agentId: req.actor.agentId }));
  app.use(errorHandler);
  return app;
}

describe("agent auth candidate boundary", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "candidate-boundary-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  it("issues zero candidate-boundary queries for a never-enrolled company", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_never_enrolled";
    // The candidate table would deny if consulted; only the in-memory gate skips it.
    const { db, candidateSelects } = createDb({ companyId, agentId, keyHash: hashToken(token), candidate: true });
    const response = await request(createApp(db)).get("/actor").set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ type: "agent", agentId });
    expect(candidateSelects()).toBe(0);
  });

  it("queries and refuses an enrolled candidate's long-lived agent key", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_enrolled_candidate";
    const { db, candidateSelects } = createDb({ companyId, agentId, keyHash: hashToken(token), candidate: true });
    await withGitHubPrimaryBlindingAdmission(db, companyId, async () => undefined);
    const response = await request(createApp(db)).get("/actor").set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(response.body.code ?? response.body.details?.code).toBe("github_candidate_api_denied");
    expect(candidateSelects()).toBeGreaterThan(0);
  });

  it("queries and refuses an enrolled candidate's JWT without a verified native run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const { db, candidateSelects } = createDb({ companyId, agentId, keyHash: null, candidate: true });
    await withGitHubPrimaryBlindingAdmission(db, companyId, async () => undefined);
    const jwt = createLocalAgentJwt(agentId, companyId, "codex_local", randomUUID(), "user-1");
    const response = await request(createApp(db)).get("/actor").set("Authorization", `Bearer ${jwt}`);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).toContain("no verified native run capability");
    expect(candidateSelects()).toBeGreaterThan(0);
  });
});
