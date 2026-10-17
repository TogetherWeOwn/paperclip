/**
 * Route tests for `POST /api/issues/:id/transport-validation`.
 *
 * The route is exercised with injected operation dependencies; the actor
 * middleware proves the principal and company come from the authenticated
 * agent actor, never from the request body. No wake, checkout, workspace
 * realization or runtime service is reachable from this route.
 */

import type { Db } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { sourceTransportValidationRoutes } from "../routes/source-transport-validation.js";
import type { SourceBoundTransportValidationDeps } from "../services/source-bound-transport-validation-operation.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const ASSIGNEE_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const DIGEST = `sha256:${"b".repeat(64)}`;

function deps(
  overrides: Partial<SourceBoundTransportValidationDeps> = {},
): SourceBoundTransportValidationDeps {
  return {
    resolveSourceIssue: async () => ({
      id: SOURCE_ISSUE_ID,
      companyId: COMPANY_ID,
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      projectId: null,
      executionPolicy: null,
      executionWorkspaceId: WORKSPACE_ID,
    }),
    resolveUnresolvedBlockerIssueIds: async () => [],
    resolveIsLowTrust: async () => false,
    resolveWorkspace: async () => ({
      id: WORKSPACE_ID,
      companyId: COMPANY_ID,
      transport: "local_fs",
      sourceIssueId: SOURCE_ISSUE_ID,
    }),
    resolveDeployedImageAttestation: () => ({
      sourceRevision: "a".repeat(40),
      imageReference: `registry.example.com/paperclip-server@${DIGEST}`,
      expectedDigest: DIGEST,
    }),
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>, routeDeps = deps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    sourceTransportValidationRoutes({} as Db, { deps: routeDeps }),
  );
  app.use(errorHandler);
  return app;
}

const agentActor = {
  type: "agent",
  agentId: ASSIGNEE_AGENT_ID,
  companyId: COMPANY_ID,
  source: "agent_key",
};

describe("POST /api/issues/:id/transport-validation", () => {
  it("returns 200 with a transport-only receipt for the source assignee", async () => {
    const res = await request(createApp(agentActor))
      .post(`/api/issues/${SOURCE_ISSUE_ID}/transport-validation`)
      .send({ workspaceId: WORKSPACE_ID, transport: "local_fs" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      boundary: "transport-only",
      runtimeInvoked: false,
      sourceIssueId: SOURCE_ISSUE_ID,
      principalAgentId: ASSIGNEE_AGENT_ID,
      transport: { ok: true, validatedWorkspaceId: WORKSPACE_ID },
      attestation: { ok: true, digest: DIGEST },
    });
  });

  it("returns 403 when the authenticated principal is not the source assignee", async () => {
    const res = await request(
      createApp({
        ...agentActor,
        agentId: "44444444-4444-4444-8444-444444444444",
      }),
    )
      .post(`/api/issues/${SOURCE_ISSUE_ID}/transport-validation`)
      // A forged principal in the body must be ignored.
      .send({
        workspaceId: WORKSPACE_ID,
        transport: "local_fs",
        principalAgentId: ASSIGNEE_AGENT_ID,
      });
    expect(res.status).toBe(403);
    expect(res.body.transport).toMatchObject({
      ok: false,
      errorCode: "unauthorized_principal",
    });
  });

  it("returns 403 for a board actor (no agent principal)", async () => {
    const res = await request(
      createApp({
        type: "board",
        userId: "user-1",
        companyIds: [COMPANY_ID],
        source: "session",
      }),
    )
      .post(`/api/issues/${SOURCE_ISSUE_ID}/transport-validation`)
      .send({ workspaceId: WORKSPACE_ID, transport: "local_fs" });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it("returns 409 when dependencies are blocked", async () => {
    const res = await request(
      createApp(
        agentActor,
        deps({
          resolveUnresolvedBlockerIssueIds: async () => [
            "66666666-6666-4666-8666-666666666666",
          ],
        }),
      ),
    )
      .post(`/api/issues/${SOURCE_ISSUE_ID}/transport-validation`)
      .send({ workspaceId: WORKSPACE_ID, transport: "local_fs" });
    expect(res.status).toBe(409);
    expect(res.body.transport).toMatchObject({
      ok: false,
      errorCode: "issue_dependencies_blocked",
    });
  });

  it("returns 422 when the deployed-image attestation record is unavailable", async () => {
    const res = await request(
      createApp(
        agentActor,
        deps({ resolveDeployedImageAttestation: () => null }),
      ),
    )
      .post(`/api/issues/${SOURCE_ISSUE_ID}/transport-validation`)
      .send({ workspaceId: WORKSPACE_ID, transport: "local_fs" });
    expect(res.status).toBe(422);
    expect(res.body.attestation).toEqual({
      ok: false,
      errorCode: "image_attestation_unavailable",
    });
  });

  it("rejects a malformed body", async () => {
    const res = await request(createApp(agentActor))
      .post(`/api/issues/${SOURCE_ISSUE_ID}/transport-validation`)
      .send({ transport: "local_fs" });
    expect(res.status).toBe(400);
  });
});
