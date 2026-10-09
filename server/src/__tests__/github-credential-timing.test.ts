import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  runIdentityContexts,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(async () => ({ value: "test-timing-token" })),
  resolveSecretValue: vi.fn(async () => "test-timing-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "github credential stage timing (TOG-19457)",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;

    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase("paperclip-github-timing-");
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
    }, 60_000);

    async function seed() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const issueId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: companyId,
        issuePrefix: companyId.slice(0, 8),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Timing",
        role: "engineer",
        adapterType: "codex_local",
      });
      await db.insert(issues).values({ id: issueId, companyId, title: "Timing" });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "A",
        status: "active",
        membershipRole: "member",
      });
      await initializeRunIdentity(db, {
        companyId,
        runId,
        responsibleUserId: "A",
        cause: "instruction",
      });
      return { companyId, agentId, runId, issueId };
    }

    async function grantDedicated(input: Awaited<ReturnType<typeof seed>>) {
      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const secretId = randomUUID();
      const id = randomUUID();
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId: input.companyId,
        name: applicationId,
        type: "mcp_http",
      });
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId: input.companyId,
        applicationId,
        name: connectionId,
        uid: connectionId,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        credentialPolicy: "per_agent",
        config: { sourceTemplateKey: "github" },
      });
      await db.insert(toolConnectionInstalls).values({
        companyId: input.companyId,
        connectionId,
        targetType: "agent",
        targetId: input.agentId,
      });
      await db.insert(companySecrets).values({
        id: secretId,
        companyId: input.companyId,
        key: secretId,
        name: `Timing token ${secretId}`,
        scope: "company",
        ownerUserId: null,
        userSecretDefinitionId: null,
      });
      await db.insert(connectionGrants).values({
        id,
        companyId: input.companyId,
        connectionId,
        kind: "agent",
        subjectUserId: null,
        subjectAgentId: input.agentId,
        status: "active",
        credentialSecretRefs: [
          { secretId, configPath: "oauth.access_token", versionSelector: "latest" },
        ],
        providerTenant: {
          github: {
            userId: "robot",
            login: "robot",
            installationCount: 1,
            repositoryCount: 1,
            repositorySelection: "selected",
            installationIds: ["1"],
            installationOwnerLogins: ["robot"],
          },
        },
      });
    }

    it("emits nonsecret stage timing with a bounded local total", async () => {
      const input = await seed();
      await grantDedicated(input);
      const startedAt = Date.now();
      const result = await resolveGitHubOperationCredentials(db, input);
      const wallMs = Date.now() - startedAt;
      expect(result.status).toBe("available");
      expect(result.timingMs).toMatchObject({
        identityMs: expect.any(Number),
        policyMs: expect.any(Number),
        credentialMs: expect.any(Number),
        persistMs: expect.any(Number),
        totalMs: expect.any(Number),
      });
      const t = result.timingMs!;
      for (const value of [t.identityMs, t.policyMs, t.credentialMs, t.persistMs, t.totalMs]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      // Sequential stages: total covers at least the slowest stage and the
      // wall clock covers the reported total (allow scheduling slack).
      expect(t.totalMs).toBeGreaterThanOrEqual(Math.max(t.identityMs, t.policyMs, t.credentialMs, t.persistMs));
      expect(t.identityMs + t.policyMs + t.credentialMs + t.persistMs).toBeLessThanOrEqual(t.totalMs + 50);
      expect(wallMs).toBeLessThan(15_000);
      expect(t.totalMs).toBeLessThan(15_000);
      // Timing carries no credential material.
      expect(JSON.stringify(t)).not.toContain("test-timing-token");
      const [history] = await db
        .select()
        .from(runIdentityContexts)
        .where(eq(runIdentityContexts.runId, input.runId));
      expect(JSON.stringify(history)).not.toContain("test-timing-token");
      expect(history.github).toMatchObject({ status: "available" });
      expect(history.github as Record<string, unknown>).not.toHaveProperty("timingMs");
    }, 30_000);

    it("attributes a slow secret-store stage to credentialMs, not identity/policy", async () => {
      const input = await seed();
      await grantDedicated(input);
      vault.resolveSecretValue.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return "test-timing-token";
      });
      const result = await resolveGitHubOperationCredentials(db, input);
      expect(result.status).toBe("available");
      const t = result.timingMs!;
      // The injected 150ms secret delay must land in the credential bucket.
      expect(t.credentialMs).toBeGreaterThanOrEqual(120);
      // Identity/policy/persist stay bounded locally; a host 5-10s wrapper
      // timeout with small local buckets points outside the resolver
      // (queue/file transfer, pool wait under contention, or GitHub refresh).
      expect(t.identityMs).toBeLessThan(5_000);
      expect(t.policyMs).toBeLessThan(5_000);
      expect(t.persistMs).toBeLessThan(5_000);
      expect(JSON.stringify(t)).not.toContain("test-timing-token");
    }, 30_000);
  },
);
