import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  connectionGrantDelegations,
  connectionGrants,
  createDb,
  principalPermissionGrants,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, companyId: string, userId: string) {
  return createAppForActor(db, {
    type: "board",
    userId,
    source: "local_implicit",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
  });
}

async function createAgentApp(db: Db, companyId: string, agentId: string) {
  return createAppForActor(db, {
    type: "agent",
    agentId,
    companyId,
    runId: null,
    source: "agent_key",
  });
}

async function createAppForActor(db: Db, actor: Record<string, unknown>) {
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as any;
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createCompanyWithOwner(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Access Routes ${randomUUID()}`,
      issuePrefix: `AR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const owner = await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    })
    .returning()
    .then((rows) => rows[0]!);
  return { company, owner };
}

async function insertAgentMembership(db: Db, companyId: string, name: string) {
  const agent = await db.insert(agents).values({
    companyId,
    name,
    role: "manager",
    adapterType: "process",
    adapterConfig: {},
  }).returning().then((rows) => rows[0]!);
  const membership = await db.insert(companyMemberships).values({
    companyId,
    principalType: "agent",
    principalId: agent.id,
    status: "active",
    membershipRole: "member",
  }).returning().then((rows) => rows[0]!);
  return { agent, membership };
}

describeEmbeddedPostgres("access routes permissions upgrade compatibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Load the large router graph during setup so a cold CI transform does not
  // consume the first permission assertion's timeout budget.
  beforeAll(async () => {
    await import("../routes/access.js");
  }, 30_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-routes-permissions-upgrade-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connectionGrantDelegations);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects owner self-lockout through the member route after the permissions upgrade", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${owner.id}`)
      .send({ membershipRole: "admin" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("You cannot remove yourself");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.membershipRole).toBe("owner");
  }, 10_000);

  it("keeps custom grants when the role-only member route changes a member role", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `admin-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);
    const customScope = { projectIds: ["project-1"] };
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.principalId,
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ membershipRole: "operator" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.membershipRole).toBe("operator");

    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, company.id),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, member.principalId),
        ),
      );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });
  });

  it("adds and removes one scoped agent grant without overwriting unrelated grants", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Scoped grant target",
      role: "manager",
      adapterType: "process",
      adapterConfig: {},
    }).returning().then((rows) => rows[0]!);
    const membership = await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      status: "active",
      membershipRole: "member",
    }).returning().then((rows) => rows[0]!);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "tasks:assign",
      scope: null,
      grantedByUserId: owner.principalId,
    });
    const scope = { managedSubtreeAgentIds: [agent.id] };

    const granted = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${membership.id}/permissions/agents:suggest-changes`)
      .send({ enabled: true, scope });

    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body).toMatchObject({
      id: membership.id,
      principalType: "agent",
      principalId: agent.id,
      status: "active",
      grants: expect.arrayContaining([
        expect.objectContaining({ permissionKey: "tasks:assign", scope: null }),
        expect.objectContaining({ permissionKey: "agents:suggest-changes", scope }),
      ]),
    });

    const revoked = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${membership.id}/permissions/agents:suggest-changes`)
      .send({ enabled: false });

    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.grants).toEqual([
      expect.objectContaining({ permissionKey: "tasks:assign", scope: null }),
    ]);
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, membership.id)))
      .toEqual([expect.objectContaining({ status: "active", membershipRole: "member" })]);
  });

  it("lets an agent steward delegate only narrow grants to a peer, never to itself", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const steward = await insertAgentMembership(db, company.id, "Grant steward");
    const target = await insertAgentMembership(db, company.id, "Grant target");
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: steward.agent.id,
      permissionKey: "users:manage_permissions",
      scope: null,
      grantedByUserId: owner.principalId,
    });
    const app = await createAgentApp(db, company.id, steward.agent.id);
    const route = (membershipId: string) =>
      `/api/companies/${company.id}/members/${membershipId}/permissions/agents:suggest-changes`;
    const suggestGrants = () => db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.permissionKey, "agents:suggest-changes"));

    const selfGrant = await request(app)
      .patch(route(steward.membership.id))
      .send({ enabled: true, scope: { managedSubtreeAgentIds: [steward.agent.id] } });
    const unscopedPeerGrant = await request(app).patch(route(target.membership.id)).send({ enabled: true });
    const emptyScopePeerGrant = await request(app)
      .patch(route(target.membership.id))
      .send({ enabled: true, scope: { managedSubtreeAgentIds: [] } });

    expect(selfGrant.status, JSON.stringify(selfGrant.body)).toBe(403);
    expect(unscopedPeerGrant.status, JSON.stringify(unscopedPeerGrant.body)).toBe(403);
    expect(emptyScopePeerGrant.status, JSON.stringify(emptyScopePeerGrant.body)).toBe(403);
    expect(await suggestGrants()).toEqual([]);

    const scope = { managedSubtreeAgentIds: [steward.agent.id] };
    const scopedPeerGrant = await request(app).patch(route(target.membership.id)).send({ enabled: true, scope });
    expect(scopedPeerGrant.status, JSON.stringify(scopedPeerGrant.body)).toBe(200);
    expect(await suggestGrants()).toEqual([
      expect.objectContaining({ principalId: target.agent.id, scope }),
    ]);

    const revoke = await request(app).patch(route(target.membership.id)).send({ enabled: false });
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    expect(await suggestGrants()).toEqual([]);
  });

  it("rejects junk scopes, outside roots, and board-issued revokes for agent stewards", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const steward = await insertAgentMembership(db, company.id, "Scope steward");
    const target = await insertAgentMembership(db, company.id, "Scope target");
    const outsider = await insertAgentMembership(db, company.id, "Outsider manager");
    const outsiderReport = await insertAgentMembership(db, company.id, "Outsider report");
    await db.update(agents).set({ reportsTo: outsider.agent.id }).where(eq(agents.id, outsiderReport.agent.id));
    const stewardReport = await insertAgentMembership(db, company.id, "Steward report");
    await db.update(agents).set({ reportsTo: steward.agent.id }).where(eq(agents.id, stewardReport.agent.id));
    const topLevel = await insertAgentMembership(db, company.id, "Top-level agent");
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: steward.agent.id,
      permissionKey: "users:manage_permissions",
      scope: null,
      grantedByUserId: owner.principalId,
    });
    const app = await createAgentApp(db, company.id, steward.agent.id);
    const boardApp = await createApp(db, company.id, owner.principalId);
    const route = (membershipId: string) =>
      `/api/companies/${company.id}/members/${membershipId}/permissions/agents:suggest-changes`;
    const suggestGrants = () => db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.permissionKey, "agents:suggest-changes"));

    for (const scope of [
      { managedSubtreeAgentIds: [""] },
      { managedSubtreeAgentIds: [null] },
      { managedSubtreeAgentIds: [123] },
      { managedSubtreeAgentIds: ["   "] },
      { managedSubtreeAgentIds: [steward.agent.id], extra: "x" },
      { managedSubtreeAgentIds: [randomUUID()] },
    ]) {
      const res = await request(app).patch(route(target.membership.id)).send({ enabled: true, scope });
      expect(res.status, JSON.stringify({ scope, body: res.body })).toBe(403);
    }
    expect(await suggestGrants()).toEqual([]);

    for (const rootId of [outsider.agent.id, outsiderReport.agent.id, topLevel.agent.id]) {
      const res = await request(app).patch(route(target.membership.id))
        .send({ enabled: true, scope: { managedSubtreeAgentIds: [rootId] } });
      expect(res.status, JSON.stringify({ rootId, body: res.body })).toBe(403);
    }
    expect(await suggestGrants()).toEqual([]);

    const validDescendant = await request(app).patch(route(target.membership.id))
      .send({ enabled: true, scope: { managedSubtreeAgentIds: [stewardReport.agent.id] } });
    expect(validDescendant.status, JSON.stringify(validDescendant.body)).toBe(200);
    const cleanup = await request(app).patch(route(target.membership.id)).send({ enabled: false });
    expect(cleanup.status, JSON.stringify(cleanup.body)).toBe(200);
    expect(await suggestGrants()).toEqual([]);

    const boardScoped = await request(boardApp).patch(route(target.membership.id))
      .send({ enabled: true, scope: { managedSubtreeAgentIds: [target.agent.id] } });
    expect(boardScoped.status, JSON.stringify(boardScoped.body)).toBe(200);
    const stewardRevokeBoardScoped = await request(app).patch(route(target.membership.id)).send({ enabled: false });
    expect(stewardRevokeBoardScoped.status, JSON.stringify(stewardRevokeBoardScoped.body)).toBe(403);
    expect(await suggestGrants()).toHaveLength(1);

    const boardUnscoped = await request(boardApp).patch(route(target.membership.id))
      .send({ enabled: true, scope: null });
    expect(boardUnscoped.status, JSON.stringify(boardUnscoped.body)).toBe(200);
    const stewardRevokeBoardUnscoped = await request(app).patch(route(target.membership.id)).send({ enabled: false });
    expect(stewardRevokeBoardUnscoped.status, JSON.stringify(stewardRevokeBoardUnscoped.body)).toBe(403);
    expect(await suggestGrants()).toHaveLength(1);
  }, 20_000);

  it("refuses an agent enable that would overwrite a board-issued grant", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const steward = await insertAgentMembership(db, company.id, "Overwrite steward");
    const target = await insertAgentMembership(db, company.id, "Overwrite target");
    const stewardReport = await insertAgentMembership(db, company.id, "Overwrite report");
    await db.update(agents).set({ reportsTo: steward.agent.id }).where(eq(agents.id, stewardReport.agent.id));
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: steward.agent.id,
      permissionKey: "users:manage_permissions",
      scope: null,
      grantedByUserId: owner.principalId,
    });
    const app = await createAgentApp(db, company.id, steward.agent.id);
    const boardApp = await createApp(db, company.id, owner.principalId);
    const route = (membershipId: string) =>
      `/api/companies/${company.id}/members/${membershipId}/permissions/agents:suggest-changes`;
    const suggestGrants = () => db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.permissionKey, "agents:suggest-changes"));
    const narrowOverwrite = { enabled: true, scope: { managedSubtreeAgentIds: [stewardReport.agent.id] } };

    const boardUnscoped = await request(boardApp).patch(route(target.membership.id))
      .send({ enabled: true, scope: null });
    expect(boardUnscoped.status, JSON.stringify(boardUnscoped.body)).toBe(200);

    const overwriteUnscoped = await request(app).patch(route(target.membership.id)).send(narrowOverwrite);
    expect(overwriteUnscoped.status, JSON.stringify(overwriteUnscoped.body)).toBe(403);
    expect(await suggestGrants()).toEqual([
      expect.objectContaining({
        principalId: target.agent.id,
        scope: null,
        grantedByUserId: owner.principalId,
      }),
    ]);

    const revokeAfterFailedOverwrite = await request(app).patch(route(target.membership.id))
      .send({ enabled: false });
    expect(revokeAfterFailedOverwrite.status, JSON.stringify(revokeAfterFailedOverwrite.body)).toBe(403);
    expect(await suggestGrants()).toHaveLength(1);

    const boardScoped = await request(boardApp).patch(route(target.membership.id))
      .send({ enabled: true, scope: { managedSubtreeAgentIds: [target.agent.id] } });
    expect(boardScoped.status, JSON.stringify(boardScoped.body)).toBe(200);

    const overwriteScoped = await request(app).patch(route(target.membership.id)).send(narrowOverwrite);
    expect(overwriteScoped.status, JSON.stringify(overwriteScoped.body)).toBe(403);
    expect(await suggestGrants()).toEqual([
      expect.objectContaining({
        principalId: target.agent.id,
        scope: { managedSubtreeAgentIds: [target.agent.id] },
        grantedByUserId: owner.principalId,
      }),
    ]);
  }, 20_000);

  it("rejects the targeted grant route for human memberships", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `member-${randomUUID()}`,
      status: "active",
      membershipRole: "operator",
    }).returning().then((rows) => rows[0]!);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}/permissions/agents:suggest-changes`)
      .send({ enabled: true, scope: { managedSubtreeAgentIds: [randomUUID()] } });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain("only manages existing agent memberships");
  });

  it("sweeps personal connection access when the member route suspends a user", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `member-${randomUUID()}`,
      status: "active",
      membershipRole: "member",
    }).returning().then((rows) => rows[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Delegated route agent",
      role: "worker",
      adapterType: "process",
      adapterConfig: {},
    }).returning().then((rows) => rows[0]!);
    const application = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `route-app-${randomUUID()}`,
      name: "Route personal app",
      type: "mcp",
      status: "active",
    }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Route personal connection",
      uid: `route-connection-${randomUUID()}`,
      connectionKind: "managed",
      ownership: "customer",
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
    }).returning().then((rows) => rows[0]!);
    const grant = await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: connection.id,
      kind: "user",
      subjectUserId: member.principalId,
      status: "active",
    }).returning().then((rows) => rows[0]!);
    await db.insert(connectionGrantDelegations).values({
      companyId: company.id,
      grantId: grant.id,
      agentId: agent.id,
      createdByUserId: member.principalId,
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ status: "suspended" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("suspended");
    expect(await db.select().from(connectionGrantDelegations)).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))
      .toEqual([expect.objectContaining({ status: "revoked" })]);

    await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}/role-and-grants`)
      .send({ status: "active", grants: [] })
      .expect(200);
    await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, grant.id));
    await db.insert(connectionGrantDelegations).values({
      companyId: company.id,
      grantId: grant.id,
      agentId: agent.id,
      createdByUserId: member.principalId,
    });

    const permissionsRoute = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}/role-and-grants`)
      .send({ status: "suspended", grants: [] });
    expect(permissionsRoute.status, JSON.stringify(permissionsRoute.body)).toBe(200);
    expect(await db.select().from(connectionGrantDelegations)).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))
      .toEqual([expect.objectContaining({ status: "revoked" })]);
  });
});
