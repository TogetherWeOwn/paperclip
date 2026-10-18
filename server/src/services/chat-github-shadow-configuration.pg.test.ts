import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents, chatEndpoints, chatGitHubReviews,
  companies, companyMemberships, createDb, getEmbeddedPostgresTestSupport,
  issues, startEmbeddedPostgresTestDatabase, toolApplications, toolConnections,
  toolConnectionInstalls,
} from "@paperclipai/db";
import { githubChatManagementService } from "./chat-github-management.js";
import { chatChannelService } from "./chat-channels.js";
import { normalizeExperimentalSettings, applyExperimentalSettingsPatch, instanceSettingsService } from "./instance-settings.js";

// Always disposable, never a shared application DB. Do not turn unsupported
// hosts into passing acceptance evidence.
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;

suite("GitHub shadow route persistence (A11, real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-shadow-config-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const endpointId = randomUUID();
    const agentId = randomUUID();
    const candidateId = randomUUID();
    const connectionId = randomUUID();
    const applicationId = randomUUID();
    const userId = "shadow-config-owner";
    await db.insert(companies).values({ id: companyId, name: "Shadow route fixture", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Primary", adapterType: "process" },
      { id: candidateId, companyId, name: "Candidate", adapterType: "process", status: "paused" },
    ]);
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "GitHub", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, uid: randomUUID(), name: "GitHub", transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, provider: "github", publicId: randomUUID(), status: "active" });
    const service = githubChatManagementService(db, async () => { throw new Error("Configuration must not call GitHub"); });
    const initial = await service.configuration(endpointId, userId);
    // Start with pre-v2 stored JSON, not just the default response.
    const { shadowRoutes: _routes, ...legacy } = initial.configuration as typeof initial.configuration & { shadowRoutes?: unknown };
    await service.saveConfiguration(endpointId, { expectedRevision: 0, configuration: legacy }, userId);
    const route = { label: "candidate-low", agentId: candidateId };
    const save = async (shadowRoutes: unknown, revision?: number) => {
      const current = await service.configuration(endpointId, userId);
      return service.saveConfiguration(endpointId, { expectedRevision: revision ?? current.revision, configuration: { ...current.configuration, shadowRoutes } }, userId);
    };
    const arms = () => db.execute(sql`select * from chat_github_review_arms where company_id = ${companyId} and endpoint_id = ${endpointId} order by label`);
    return { companyId, endpointId, agentId, candidateId, connectionId, userId, service, route, save, arms };
  }

  it("persists a disabled route and stable server arm without changing primary identity or resuming the clone", async () => {
    const f = await fixture();
    const [before] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const saved = await f.save([f.route]);
    expect(saved.configuration).toMatchObject({ toolsEnabled: false, shadowRoutes: [{ ...f.route, enabled: false, sampleRate: 1 }] });
    expect(saved.configuration).not.toHaveProperty("shadow");
    const arms = await f.arms();
    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatchObject({ company_id: f.companyId, endpoint_id: f.endpointId, agent_id: f.candidateId, label: f.route.label, configuration_revision: 2, retired_at: null });
    expect(arms[0].id).toMatch(/^[a-f0-9-]{36}$/);
    await f.save([{ ...f.route, sampleRate: 0.5 }]);
    expect((await f.arms())[0].id).toBe(arms[0].id);
    expect((await f.arms())[0].configuration_revision).toBe(2);
    const [primary] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(primary).toEqual(before);
    const [candidate] = await db.select().from(agents).where(eq(agents.id, f.candidateId));
    expect(candidate.status).toBe("paused");
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId));
    expect(endpoint.assignedAgentId).toBe(f.agentId);
    expect(endpoint.connectionId).toBe(f.connectionId);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.targetId, f.candidateId))).toHaveLength(0);
  });

  it("rejects unknown, wrong-company, primary, and terminated targets without any configuration or arm change", async () => {
    const f = await fixture();
    const foreign = await fixture();
    const dead = randomUUID();
    await db.insert(agents).values({ id: dead, companyId: f.companyId, name: "Terminated", status: "terminated" });
    for (const agentId of [randomUUID(), foreign.candidateId, f.agentId, dead]) {
      await expect(f.save([{ ...f.route, agentId }])).rejects.toThrow(/shadow route/i);
      expect((await f.service.configuration(f.endpointId, f.userId)).revision).toBe(1);
      expect(await f.arms()).toHaveLength(0);
    }
  });

  async function otherEndpoint(f: Awaited<ReturnType<typeof fixture>>, assignedAgentId: string) {
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connectionId));
    const [otherConnection] = await db.insert(toolConnections).values({ ...connection!, id: randomUUID(), uid: randomUUID() }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.companyId, connectionId: otherConnection!.id,
      assignedAgentId, provider: "github", publicId: randomUUID(), status: "active" }).returning();
    return endpoint!;
  }

  it("rejects a primary reviewer assigned to another endpoint without changing either bot", async () => {
    const f = await fixture();
    const other = await otherEndpoint(f, f.candidateId);
    await expect(f.save([f.route])).rejects.toThrow(/dedicated|primary|endpoint/i);
    expect((await f.service.configuration(f.endpointId, f.userId)).revision).toBe(1);
    expect(await f.arms()).toHaveLength(0);
    expect((await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, other.id)))[0]!.assignedAgentId).toBe(f.candidateId);
  });

  it("rejects an agent already serving an active shadow arm on another endpoint", async () => {
    const f = await fixture();
    await f.save([f.route]);
    const other = await otherEndpoint(f, f.agentId);
    const config = await f.service.configuration(other.id, f.userId);
    await expect(f.service.saveConfiguration(other.id, { expectedRevision: config.revision,
      configuration: { ...config.configuration, shadowRoutes: [f.route] } }, f.userId)).rejects.toThrow(/dedicated|another|arm/i);
    expect((await f.service.configuration(other.id, f.userId)).revision).toBe(0);
    expect(await f.arms()).toHaveLength(1);
  });

  it("serializes concurrent cross-endpoint assignments of the same shadow agent", async () => {
    const f = await fixture();
    const other = await otherEndpoint(f, f.agentId);
    const config = await f.service.configuration(other.id, f.userId);
    const results = await Promise.allSettled([
      f.save([f.route]),
      f.service.saveConfiguration(other.id, { expectedRevision: config.revision,
        configuration: { ...config.configuration, shadowRoutes: [f.route] } }, f.userId),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect([...await db.execute(sql`select id from chat_github_review_arms where company_id = ${f.companyId} and agent_id = ${f.candidateId} and retired_at is null`)]).toHaveLength(1);
  });

  function endpointService() {
    return chatChannelService(db, {
      heartbeat: { wakeup: async () => { throw new Error("Endpoint creation must not wake an agent"); } },
      fetch: async () => { throw new Error("Endpoint creation must not call a provider"); },
      publicBaseUrl: "https://paperclip.example",
    });
  }

  it("rejects GitHub endpoint creation for an active shadow arm without leaving connector rows", async () => {
    const f = await fixture();
    // Only this disposable fixture is made invokable; no real agent is resumed.
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.candidateId));
    await f.save([f.route]); // Disabled routes still reserve their dedicated identity.
    const beforeApplications = await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId));
    const beforeConnections = await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId));
    await expect(endpointService().create(f.companyId, { provider: "github", assignedAgentId: f.candidateId }, f.userId))
      .rejects.toThrow(/shadow arm|dedicated/i);
    expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId))).toEqual(beforeApplications);
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toEqual(beforeConnections);
    expect((await f.arms())[0].retired_at).toBeNull();
  });

  it("allows non-GitHub endpoints and a GitHub endpoint after the shadow arm is retired", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.candidateId));
    await f.save([f.route]);
    const service = endpointService();
    expect(await service.create(f.companyId, { provider: "slack", assignedAgentId: f.candidateId }, f.userId)).toBeDefined();
    await f.save([]);
    expect(await service.create(f.companyId, { provider: "github", assignedAgentId: f.candidateId }, f.userId)).toBeDefined();
    expect((await f.arms())[0].retired_at).not.toBeNull();
  });

  it("serializes GitHub endpoint creation against concurrent shadow arm assignment", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.candidateId));
    let creation!: Promise<{ error?: unknown; endpoint?: unknown }>;
    try {
      await db.transaction(async tx => {
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        await tx.select().from(agents).where(eq(agents.id, f.candidateId)).for("update");
        // Hold an uncommitted arm so the endpoint creator must wait for the agent
        // lock, then re-read arms after commit rather than miss this assignment.
        await tx.execute(sql`insert into chat_github_review_arms
          (company_id, endpoint_id, agent_id, label, configuration_revision)
          values (${f.companyId}, ${f.endpointId}, ${f.candidateId}, ${f.route.label}, 2)`);
        creation = endpointService().create(f.companyId,
          { provider: "github", assignedAgentId: f.candidateId }, f.userId)
          .then(endpoint => ({ endpoint }), error => ({ error }));
        await expect.poll(async () => [...await db.execute(sql`
          select pid from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and ${Number(backend!.pid)} = any(pg_blocking_pids(pid))
            and query ilike '%select%from "agents"%for update%'
        `)].length, { timeout: 10_000 }).toBe(1);
      }); // Only now expose the arm to the blocked endpoint transaction.
      const result = await creation;
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toMatch(/shadow arm/i);
      expect(result.endpoint).toBeUndefined();
      expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.companyId, f.companyId))).toHaveLength(1);
      expect(await f.arms()).toHaveLength(1);
    } finally {
      // A failed lock assertion rolls back the manual transaction; always drain
      // the competing creator before fixture/database teardown, including mutants.
      await creation;
    }
  });

  it("revision-fences concurrent saves and does not create arms for a stale revision", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.save([f.route], 1), f.save([f.route], 1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await f.arms()).toHaveLength(1);
    await expect(f.save([], 1)).rejects.toThrow("Refresh before saving");
    expect((await f.arms())[0].retired_at).toBeNull();
  });

  it("tombstones removed routes and refuses label rebinding or resurrection", async () => {
    const f = await fixture();
    await f.save([f.route]);
    const second = randomUUID();
    await db.insert(agents).values({ id: second, companyId: f.companyId, name: "Other clone" });
    await expect(f.save([{ ...f.route, agentId: second }])).rejects.toThrow(/new label/i);
    await f.save([]);
    const [retired] = await f.arms();
    expect(retired.retired_at).not.toBeNull();
    await expect(f.save([f.route])).rejects.toThrow(/new label/i);
    await expect(f.save([{ ...f.route, agentId: second }])).rejects.toThrow(/new label/i);
    await f.save([{ ...f.route, label: "candidate-v2" }]);
    const arms = await f.arms();
    expect(arms).toHaveLength(2);
    expect(arms.find((arm) => arm.label === "candidate-v2")!.id).not.toBe(retired.id);
  });

  it("enforces company foreign keys and immutable arm identity in the database", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await f.save([f.route]);
    const [arm] = await f.arms();
    await expect(db.execute(sql`insert into chat_github_review_arms (company_id, endpoint_id, agent_id, label, configuration_revision) values (${f.companyId}, ${f.endpointId}, ${foreign.candidateId}, 'foreign', 1)`)).rejects.toThrow();
    await expect(db.execute(sql`insert into chat_github_review_arms (company_id, endpoint_id, agent_id, label, configuration_revision) values (${foreign.companyId}, ${f.endpointId}, ${foreign.candidateId}, 'foreign-endpoint', 1)`)).rejects.toThrow();
    await expect(db.execute(sql`update chat_github_review_arms set agent_id = ${f.agentId} where id = ${arm.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update chat_github_review_arms set label = 'rewritten' where id = ${arm.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update chat_github_review_arms set configuration_revision = 99 where id = ${arm.id}`)).rejects.toThrow();
    await f.save([]);
    await expect(db.execute(sql`update chat_github_review_arms set retired_at = null where id = ${arm.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from chat_github_review_arms where id = ${arm.id}`)).rejects.toThrow();
    expect(await f.arms()).toHaveLength(1);
  });

  it("keeps legacy configurations and labeled reviews intact", async () => {
    const f = await fixture();
    const current = await f.service.configuration(f.endpointId, f.userId);
    await f.service.saveConfiguration(f.endpointId, { expectedRevision: current.revision, configuration: { ...current.configuration, shadow: { enabled: true, label: "legacy-shadow" } } }, f.userId);
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Legacy review" }).returning();
    const [review] = await db.insert(chatGitHubReviews).values({ companyId: f.companyId, endpointId: f.endpointId, issueId: issue.id, repositoryId: "1", repository: "example/repo", pullNumber: 1, headSha: "a".repeat(40), deliveryId: randomUUID(), configurationRevision: 1, policySnapshot: current.configuration.defaults, event: {} as never, shadowLabel: "legacy-shadow" }).returning();
    await f.save([f.route]);
    expect((await f.service.configuration(f.endpointId, f.userId)).configuration).toHaveProperty("shadow", { enabled: true, label: "legacy-shadow" });
    expect((await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, review.id)))[0]).toEqual(review);
    await expect(f.save([{ ...f.route, enabled: true }])).rejects.toThrow();
  });

  it("persists an explicit global switch and can turn it off without removing arm evidence", async () => {
    const f = await fixture();
    const settings = instanceSettingsService(db, { runtimeEnv: {} });
    expect(await settings.getExperimental()).toHaveProperty("githubReviewShadowEnabled", false);
    await settings.updateExperimental({ githubReviewShadowEnabled: true });
    expect(await settings.getExperimental()).toHaveProperty("githubReviewShadowEnabled", true);
    await f.save([f.route]);
    await settings.updateExperimental({ githubReviewShadowEnabled: false });
    expect(await settings.getExperimental()).toHaveProperty("githubReviewShadowEnabled", false);
    expect(await f.arms()).toHaveLength(1);
  });
});

describe("shadow kill switch normalization", () => {
  it.each([undefined, null, {}, { githubReviewShadowEnabled: "true" }, { githubReviewShadowEnabled: null }])("fails closed on absent or malformed stored settings %s", (raw) => {
    expect(normalizeExperimentalSettings(raw)).toHaveProperty("githubReviewShadowEnabled", false);
  });
  it("fails closed on a malformed shadow flag without resetting primary runtime settings", () => {
    expect(normalizeExperimentalSettings({
      enableChatConnectors: true,
      enableNativeRunner: false,
      githubReviewShadowEnabled: "true",
    })).toMatchObject({
      enableChatConnectors: true,
      enableNativeRunner: false,
      githubReviewShadowEnabled: false,
    });
  });
  it("preserves an explicit enabled value through unrelated patches", () => {
    expect(applyExperimentalSettingsPatch({ githubReviewShadowEnabled: true }, { enableEnvironments: true })).toHaveProperty("githubReviewShadowEnabled", true);
  });
});
