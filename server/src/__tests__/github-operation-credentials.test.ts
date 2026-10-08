import { createNativeGitHubAccess } from "../services/native-runtime/native-github-access.js";
import express from "express";
import request from "supertest";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
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
  issueComments,
  issues,
  projects,
  runIdentityContexts,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  initializeRunIdentity,
  reserveSteeredIdentity,
  acceptSteeredIdentity,
} from "../services/run-identity.js";
import {
  resolveGitHubOperationCredentials,
  withGitHubOperationCredential,
} from "../services/github-operation-credentials.js";
import {
  filterResolvedGitHubConnectionsForRun,
  resolveManagedGitHubIdentitySelection,
} from "../services/git-credentials.js";

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(
    async (_company: string, input: { responsibleUserId: string }) => ({
      value: `test-token-${input.responsibleUserId}`,
    }),
  ),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "operation-time GitHub credential resolution",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      vi.stubEnv(
        "PAPERCLIP_AGENT_JWT_SECRET",
        "test-github-broker-signing-secret",
      );
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-github-operation-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
    }, 60_000);
    async function seed() {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        runId = randomUUID(),
        issueId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: companyId,
        issuePrefix: companyId.slice(0, 8),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Shared",
        role: "engineer",
        adapterType: "codex_local",
      });
      await db
        .insert(issues)
        .values({ id: issueId, companyId, title: "Identity test" });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });
      await db.insert(companyMemberships).values(
        ["A", "B"].map((principalId) => ({
          companyId,
          principalType: "user",
          principalId,
          status: "active",
          membershipRole: "member",
        })),
      );
      await initializeRunIdentity(db, {
        companyId,
        runId,
        responsibleUserId: "A",
        cause: "instruction",
      });
      return { companyId, agentId, runId, issueId };
    }
    async function grant(
      input: Awaited<ReturnType<typeof seed>>,
      user: string,
      dedicated = false,
    ) {
      const applicationId = randomUUID(),
        connectionId = randomUUID(),
        secretId = randomUUID(),
        definitionId = randomUUID(),
        id = randomUUID();
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
        credentialPolicy: dedicated ? "per_agent" : "per_user",
        config: { sourceTemplateKey: "github" },
      });
      await db.insert(toolConnectionInstalls).values({
        companyId: input.companyId,
        connectionId,
        targetType: "agent",
        targetId: input.agentId,
      });
      if (!dedicated)
        await db.insert(userSecretDefinitions).values({
          id: definitionId,
          companyId: input.companyId,
          key: definitionId,
          name: "Test GitHub",
        });
      await db.insert(companySecrets).values({
        id: secretId,
        companyId: input.companyId,
        key: secretId,
        name: `Test token ${secretId}`,
        scope: dedicated ? "company" : "user",
        ownerUserId: dedicated ? null : user,
        userSecretDefinitionId: dedicated ? null : definitionId,
      });
      await db.insert(connectionGrants).values({
        id,
        companyId: input.companyId,
        connectionId,
        kind: dedicated ? "agent" : "user",
        subjectUserId: dedicated ? null : user,
        subjectAgentId: dedicated ? input.agentId : null,
        status: "active",
        credentialSecretRefs: [
          {
            secretId,
            configPath: "oauth.access_token",
            versionSelector: "latest",
          },
        ],
        providerTenant: {
          github: {
            userId: user,
            login: user,
            installationCount: 1,
            repositoryCount: 1,
            repositorySelection: "selected",
            installationIds: ["1"],
            installationOwnerLogins: [user],
          },
        },
      });
      return { id, connectionId, secretId, definitionId };
    }
    async function switchTo(
      input: Awaited<ReturnType<typeof seed>>,
      user: string,
    ) {
      const id = randomUUID();
      await db.insert(issueComments).values({
        id,
        companyId: input.companyId,
        issueId: input.issueId,
        authorUserId: user,
        body: "Next instruction",
      });
      const context = await reserveSteeredIdentity(db, {
        ...input,
        messageId: id,
      });
      await acceptSteeredIdentity(db, context!);
    }
    it("resolves A → B → A without retaining tokens, and records only redacted diagnostics", async () => {
      const input = await seed();
      await grant(input, "A");
      await grant(input, "B");
      for (const user of ["A", "B", "A"]) {
        await switchTo(input, user);
        const result = await resolveGitHubOperationCredentials(db, input);
        expect(result).toMatchObject({
          status: "available",
          login: user,
          source: "personal",
        });
        expect(result.env.GH_TOKEN).toBe(`test-token-${user}`);
        expect(result.env.GIT_AUTHOR_EMAIL).toBe(
          `${user}+${user}@users.noreply.github.com`,
        );
      }
      const history = await db
        .select()
        .from(runIdentityContexts)
        .where(eq(runIdentityContexts.runId, input.runId));
      expect(JSON.stringify(history)).not.toContain("test-token-");
    });
    it("returns no credential for unconnected users, removed membership, or ambiguous personal accounts", async () => {
      const input = await seed();
      await grant(input, "A");
      await switchTo(input, "B");
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual(
        {},
      );
      await switchTo(input, "A");
      await db
        .update(companyMemberships)
        .set({ status: "inactive" })
        .where(eq(companyMemberships.companyId, input.companyId));
      expect((await resolveGitHubOperationCredentials(db, input)).status).toBe(
        "unavailable",
      );
      await db
        .update(companyMemberships)
        .set({ status: "active" })
        .where(eq(companyMemberships.companyId, input.companyId));
      const differentAccount = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({
          providerTenant: {
            github: {
              userId: "other-github-id",
              login: "A",
              installationCount: 1,
              repositoryCount: 1,
              repositorySelection: "selected",
              installationIds: ["1"],
              installationOwnerLogins: ["A"],
            },
          },
        })
        .where(eq(connectionGrants.id, differentAccount.id));
      expect(
        (await resolveGitHubOperationCredentials(db, input)).reason,
      ).toMatch(/More than one/);
      await expect(
        resolveGitHubOperationCredentials(db, {
          ...input,
          companyId: randomUUID(),
        }),
      ).rejects.toThrow();
    });
    it.each([true, false])(
      "prefers the healthy duplicate regardless of grant age (%s)",
      async (healthyNewer) => {
        const input = await seed();
        const healthy = await grant(input, "A");
        const broken = await grant(input, "A");
        await db
          .update(toolConnections)
          .set({ healthStatus: "ok" })
          .where(eq(toolConnections.id, healthy.connectionId));
        await db
          .update(toolConnections)
          .set({
            healthStatus: "error",
            healthMessage: "GitHub access changed during refresh. Try again.",
          })
          .where(eq(toolConnections.id, broken.connectionId));
        await db
          .update(connectionGrants)
          .set({
            createdAt: new Date(healthyNewer ? "2026-02-01" : "2026-01-01"),
          })
          .where(eq(connectionGrants.id, healthy.id));
        await db
          .update(connectionGrants)
          .set({
            createdAt: new Date(healthyNewer ? "2026-01-01" : "2026-02-01"),
          })
          .where(eq(connectionGrants.id, broken.id));
        expect(
          await resolveGitHubOperationCredentials(db, input),
        ).toMatchObject({
          status: "available",
          connectionId: healthy.connectionId,
          grantId: healthy.id,
          authenticationMode: "managed",
        });
      },
    );

    it("retries credential acquisition once using another grant for the same account", async () => {
      const input = await seed();
      const older = await grant(input, "A");
      const newer = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({ createdAt: new Date("2026-01-01") })
        .where(eq(connectionGrants.id, older.id));
      await db
        .update(connectionGrants)
        .set({ createdAt: new Date("2026-02-01") })
        .where(eq(connectionGrants.id, newer.id));
      vault.resolveUserSecretValue.mockRejectedValueOnce(
        new Error("secret provider failed"),
      );
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        grantId: older.id,
      });
    });

    it("does not try another grant when a diagnostics credential read fails", async () => {
      const input = await seed();
      await grant(input, "A");
      await grant(input, "A");
      vault.resolveUserSecretValue.mockClear();
      vault.resolveUserSecretValue.mockRejectedValueOnce(
        new Error("secret provider failed"),
      );
      const operation = vi.fn(async () => "unreachable");

      await expect(
        withGitHubOperationCredential(db, input, operation),
      ).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled();
      expect(vault.resolveUserSecretValue).toHaveBeenCalledTimes(1);
    });

    it("uses one stable grant when the same person connects the same GitHub account twice", async () => {
      const input = await seed();
      const first = await grant(input, "A");
      const second = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2027-01-01"),
        })
        .where(eq(connectionGrants.id, first.id));
      await db
        .update(connectionGrants)
        .set({ createdAt: new Date("2026-02-01") })
        .where(eq(connectionGrants.id, second.id));
      const context = { ...input, responsibleUserId: "A" };
      expect(
        (
          await resolveManagedGitHubIdentitySelection(
            db,
            input.companyId,
            context,
          )
        ).grant?.id,
      ).toBe(second.id);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        login: "A",
        source: "personal",
      });
      const connections = [first, second].map((row) => ({
        id: row.connectionId,
        config: { sourceTemplateKey: "github" },
      }));
      expect(
        await filterResolvedGitHubConnectionsForRun({
          db,
          ...context,
          connections,
        }),
      ).toEqual([connections[1]]);
      // A newer webhook on the old connection must not change the selected policy.
      await db
        .update(connectionGrants)
        .set({ updatedAt: new Date("2028-01-01") })
        .where(eq(connectionGrants.id, first.id));
      expect(
        (
          await resolveManagedGitHubIdentitySelection(
            db,
            input.companyId,
            context,
          )
        ).grant?.id,
      ).toBe(second.id);
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, second.id));
      expect(
        (
          await resolveManagedGitHubIdentitySelection(
            db,
            input.companyId,
            context,
          )
        ).grant?.id,
      ).toBe(first.id);
      await db
        .update(toolConnections)
        .set({ enabled: false })
        .where(eq(toolConnections.id, first.connectionId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
    });
    it("does not conflate missing GitHub account IDs or another agent's connection audience", async () => {
      const input = await seed();
      const first = await grant(input, "A");
      const duplicate = await grant(input, "A");
      await db
        .update(connectionGrants)
        .set({ providerTenant: null })
        .where(eq(connectionGrants.id, duplicate.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
      await db
        .update(toolConnectionInstalls)
        .set({ targetId: randomUUID() })
        .where(eq(toolConnectionInstalls.connectionId, duplicate.connectionId));
      expect(
        (
          await resolveManagedGitHubIdentitySelection(db, input.companyId, {
            ...input,
            responsibleUserId: "A",
          })
        ).grant?.id,
      ).toBe(first.id);
      await switchTo(input, "B");
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual(
        {},
      );
    });
    it.each([
      "missing-ref",
      "disabled-secret",
      "missing-secret",
      "wrong-owner",
      "disabled-definition",
      "no-repositories",
    ])(
      "ignores an incomplete newer duplicate when the same account has an eligible grant (%s)",
      async (problem) => {
        const input = await seed();
        const first = await grant(input, "A");
        const second = await grant(input, "A");
        await db
          .update(connectionGrants)
          .set({ createdAt: new Date("2026-01-01") })
          .where(eq(connectionGrants.id, first.id));
        await db
          .update(connectionGrants)
          .set({ createdAt: new Date("2026-02-01") })
          .where(eq(connectionGrants.id, second.id));
        if (problem === "missing-ref")
          await db
            .update(connectionGrants)
            .set({ credentialSecretRefs: [] })
            .where(eq(connectionGrants.id, second.id));
        if (problem === "disabled-secret")
          await db
            .update(companySecrets)
            .set({ status: "disabled" })
            .where(eq(companySecrets.id, second.secretId));
        if (problem === "disabled-definition")
          await db
            .update(userSecretDefinitions)
            .set({ status: "disabled" })
            .where(eq(userSecretDefinitions.id, second.definitionId));
        if (problem === "missing-secret")
          await db
            .delete(companySecrets)
            .where(eq(companySecrets.id, second.secretId));
        if (problem === "wrong-owner")
          await db
            .update(companySecrets)
            .set({ ownerUserId: "B" })
            .where(eq(companySecrets.id, second.secretId));
        if (problem === "no-repositories")
          await db
            .update(connectionGrants)
            .set({
              providerTenant: {
                github: {
                  userId: "A",
                  login: "A",
                  installationCount: 0,
                  repositoryCount: 0,
                  repositorySelection: "none",
                  installationIds: [],
                  installationOwnerLogins: [],
                },
              },
            })
            .where(eq(connectionGrants.id, second.id));
        expect(
          (
            await resolveManagedGitHubIdentitySelection(db, input.companyId, {
              ...input,
              responsibleUserId: "A",
            })
          ).grant?.id,
        ).toBe(first.id);
        expect(
          await resolveGitHubOperationCredentials(db, input),
        ).toMatchObject({ status: "available", login: "A" });
        const connections = [first, second].map((row) => ({
          id: row.connectionId,
          config: { sourceTemplateKey: "github" },
        }));
        expect(
          await filterResolvedGitHubConnectionsForRun({
            db,
            ...input,
            responsibleUserId: "A",
            connections,
          }),
        ).toEqual([connections[0]]);
      },
    );
    it("retains dedicated override semantics when the dedicated account has duplicate grants", async () => {
      const input = await seed();
      await grant(input, "A");
      const first = await grant(input, "robot", true);
      const second = await grant(input, "robot", true);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, first.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, second.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        source: "dedicated",
        env: {},
      });
    });
    it("honors dedicated overrides and never substitutes personal credentials when revoked or disabled", async () => {
      const input = await seed();
      await grant(input, "A");
      const dedicated = await grant(input, "robot", true);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
      await db
        .update(connectionGrants)
        .set({ status: "revoked" })
        .where(eq(connectionGrants.id, dedicated.id));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        source: "dedicated",
        env: {},
      });
      await db
        .update(connectionGrants)
        .set({ status: "active" })
        .where(eq(connectionGrants.id, dedicated.id));
      await db
        .update(toolConnections)
        .set({ enabled: false })
        .where(eq(toolConnections.id, dedicated.connectionId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        source: "dedicated",
        env: {},
      });
    });
    it("does not resolve the company default person's GitHub", async () => {
      const input = await seed();
      await grant(input, "A");
      await db
        .update(runIdentityContexts)
        .set({ cause: "company_default" })
        .where(eq(runIdentityContexts.runId, input.runId));
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual(
        {},
      );
    });
    it.each([false, true])(
      "withholds sponsor and dedicated credentials from every low-trust policy source (dedicated=%s)",
      async (dedicated) => {
        for (const source of [
          "issue",
          "run",
          "agent",
          "project",
          "quarantined",
          "invalid",
          "missing_issue",
        ] as const) {
          const input = await seed();
          await grant(input, "A");
          if (dedicated) await grant(input, "robot", true);
          // Sponsor attribution is deliberately retained: it must not become a
          // credential grant just because the shared agent was dispatched for them.
          await db
            .update(issues)
            .set({
              originKind: "chat_channel",
              responsibleUserId: "A",
              createdByUserId: "A",
            })
            .where(eq(issues.id, input.issueId));
          const policy = {
            authorizationPolicy: {
              trustPreset: LOW_TRUST_REVIEW_PRESET,
              trustBoundary: {
                mode: LOW_TRUST_REVIEW_PRESET,
                companyId: input.companyId,
                rootIssueId: input.issueId,
                issueIds: [input.issueId],
                allowedAgentIds: [input.agentId],
                allowedToolClasses: ["git.read", "github.pr.read"],
              },
            },
          };
          if (source === "issue")
            await db
              .update(issues)
              .set({ executionPolicy: policy })
              .where(eq(issues.id, input.issueId));
          if (source === "run")
            await db
              .update(heartbeatRuns)
              .set({
                contextSnapshot: {
                  issueId: input.issueId,
                  executionPolicy: policy,
                },
              })
              .where(eq(heartbeatRuns.id, input.runId));
          if (source === "agent")
            await db
              .update(agents)
              .set({ permissions: policy })
              .where(eq(agents.id, input.agentId));
          if (source === "project") {
            const projectId = randomUUID();
            await db.insert(projects).values({
              id: projectId,
              companyId: input.companyId,
              name: "Restricted",
              executionWorkspacePolicy: policy,
            });
            await db
              .update(issues)
              .set({ projectId })
              .where(eq(issues.id, input.issueId));
          }
          if (source === "quarantined")
            await db
              .update(issues)
              .set({
                sourceTrust: {
                  preset: LOW_TRUST_REVIEW_PRESET,
                  disposition: "quarantined",
                  sourceIssueId: input.issueId,
                },
              })
              .where(eq(issues.id, input.issueId));
          if (source === "invalid")
            await db
              .update(heartbeatRuns)
              .set({
                contextSnapshot: {
                  issueId: input.issueId,
                  executionPolicy: {
                    authorizationPolicy: { trustPreset: "unknown" },
                  },
                },
              })
              .where(eq(heartbeatRuns.id, input.runId));
          if (source === "missing_issue")
            await db
              .update(heartbeatRuns)
              .set({ contextSnapshot: { issueId: randomUUID() } })
              .where(eq(heartbeatRuns.id, input.runId));
          vault.resolveSecretValue.mockClear();
          vault.resolveUserSecretValue.mockClear();
          expect(
            await resolveGitHubOperationCredentials(db, input),
            source,
          ).toMatchObject({
            status: "unavailable",
            env: {},
            reason: expect.stringContaining("low-trust"),
          });
          expect(vault.resolveSecretValue, source).not.toHaveBeenCalled();
          expect(vault.resolveUserSecretValue, source).not.toHaveBeenCalled();
          const [history] = await db
            .select()
            .from(runIdentityContexts)
            .where(eq(runIdentityContexts.runId, input.runId));
          expect(history.github, source).toMatchObject({
            status: "unavailable",
          });
          expect(JSON.stringify(history), source).not.toContain("test-token-");
        }
      },
    );
    it("rechecks a taskless run's current project policy before exporting credentials", async () => {
      const input = await seed();
      await grant(input, "A");
      const projectId = randomUUID();
      await db.insert(projects).values({
        id: projectId,
        companyId: input.companyId,
        name: "Taskless project",
      });
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { projectId } })
        .where(eq(heartbeatRuns.id, input.runId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        login: "A",
      });
      await db
        .update(projects)
        .set({
          executionWorkspacePolicy: {
            authorizationPolicy: {
              trustPreset: LOW_TRUST_REVIEW_PRESET,
              trustBoundary: {
                mode: LOW_TRUST_REVIEW_PRESET,
                companyId: input.companyId,
                projectIds: [projectId],
                allowedAgentIds: [input.agentId],
              },
            },
          },
        })
        .where(eq(projects.id, projectId));
      vault.resolveSecretValue.mockClear();
      vault.resolveUserSecretValue.mockClear();
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
      expect(vault.resolveSecretValue).not.toHaveBeenCalled();
      expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    });

    it("fails closed for missing or malformed bound task/project references", async () => {
      const input = await seed();
      await grant(input, "A");
      for (const contextSnapshot of [
        { projectId: randomUUID() },
        { projectId: "" },
        { projectId: false },
        { issueId: "" },
        { issueId: false },
      ]) {
        await db
          .update(heartbeatRuns)
          .set({ contextSnapshot })
          .where(eq(heartbeatRuns.id, input.runId));
        vault.resolveUserSecretValue.mockClear();
        if (Object.hasOwn(contextSnapshot, "issueId")) {
          await expect(
            resolveGitHubOperationCredentials(db, input),
          ).rejects.toMatchObject({
            status: 403,
            message: "Run task identity is invalid",
          });
        } else {
          expect(
            await resolveGitHubOperationCredentials(db, input),
          ).toMatchObject({ status: "unavailable", env: {} });
        }
        expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
      }
    });

    it("reuses a session broker across runs while rechecking live-run identity and revocation", async () => {
      const input = await seed();
      await grant(input, "A");
      await grant(input, "B");
      const broker = await createNativeGitHubAccess({
        scope: input, target: null, cwd: process.cwd(), env: { PATH: process.env.PATH },
        resolveCredentials: (binding) => resolveGitHubOperationCredentials(db, binding),
      });
      const post = () => fetch(`${broker.env.PAPERCLIP_GITHUB_BROKER_URL}/runtime-tools/github/credentials`, {
        method: "POST", headers: { authorization: `Bearer ${broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}` },
      });
      try {
        const releaseA = broker.activate(input);
        const a = await post();
        expect(a.status).toBe(200);
        expect((await a.json()).login).toBe("A");
        await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.runId));
        // Even a delayed controller release cannot authorize a finished DB run.
        expect((await post()).status).toBe(403);
        releaseA();
        const next = { ...input, runId: randomUUID() };
        await db.insert(heartbeatRuns).values({ id: next.runId, companyId: next.companyId, agentId: next.agentId, status: "running", contextSnapshot: { issueId: input.issueId } });
        await initializeRunIdentity(db, { companyId: input.companyId, runId: next.runId, responsibleUserId: "B", cause: "instruction" });
        broker.activate(next);
        const b = await post();
        expect(b.status).toBe(200);
        expect((await b.json()).login).toBe("B");
        await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.companyId, input.companyId));
        const revoked = await post();
        expect((await revoked.json()).env).toEqual({});
      } finally { await broker.stop(); }
    });

    it("requires a run-scoped runtime capability and never accepts browser authentication or supplied identities", async () => {
      const input = await seed();
      await grant(input, "A");
      const app = express();
      app.use(express.json());
      app.use(runtimeConnectionIntentRoutes(db));
      app.use(errorHandler);
      const tokenInput = {
        ...input,
        responsibleUserId: "A",
        scope: "github_credentials" as const,
      };
      const token = createRuntimeToolsToken(tokenInput)!.token;
      const post = () => request(app).post("/runtime-tools/github/credentials");
      const a = await post()
        .set("Authorization", `Bearer ${token}`)
        .send({ responsibleUserId: "B" });
      expect(
        (
          await post()
            .set("Authorization", `Bearer ${token}`)
            .set("Sec-Fetch-Mode", "cors")
        ).status,
      ).toBe(200);
      expect(a.status).toBe(200);
      expect(a.body.login).toBe("A");
      expect(a.headers["cache-control"]).toBe("no-store");
      for (const [header, value] of [
        ["Origin", "http://127.0.0.1"],
        ["Cookie", "session=test"],
        ["Sec-Fetch-Site", "same-origin"],
      ]) {
        expect(
          (
            await post()
              .set("Authorization", `Bearer ${token}`)
              .set(header!, value!)
          ).status,
        ).toBe(403);
      }
      const wrongScope = createRuntimeToolsToken({
        ...tokenInput,
        scope: "connection_intents",
      })!.token;
      expect(
        (await post().set("Authorization", `Bearer ${wrongScope}`)).status,
      ).toBe(401);
      const wrongAgent = createRuntimeToolsToken({
        ...tokenInput,
        agentId: randomUUID(),
      })!.token;
      expect(
        (await post().set("Authorization", `Bearer ${wrongAgent}`)).status,
      ).toBe(403);
      // The runner bridge replaces Authorization, but forwards the separate run capability.
      expect(
        (
          await post()
            .set("Authorization", "Bearer bridge-host-token")
            .set("x-paperclip-github-capability", token)
        ).status,
      ).toBe(200);
      await switchTo(input, "B");
      const b = await post().set("Authorization", `Bearer ${token}`);
      expect(b.status).toBe(200);
      expect(b.body.env).toEqual({});
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, input.runId));
      expect(
        (await post().set("Authorization", `Bearer ${token}`)).status,
      ).toBe(403);
    });

    it("mediates only pinned GitHub GET reads and sanitizes fixture responses", async () => {
      const input = await seed();
      await grant(input, "A");
      await db
        .update(issues)
        .set({ assigneeAgentId: input.agentId, status: "in_progress" })
        .where(eq(issues.id, input.issueId));

      const app = express();
      app.use(express.json());
      app.use(runtimeConnectionIntentRoutes(db));
      app.use(errorHandler);
      const token = createRuntimeToolsToken({
        ...input,
        responsibleUserId: "A",
      })!.token;
      const call = (name: string, args: unknown) =>
        request(app)
          .post("/mcp/runtime-tools")
          .set("Authorization", `Bearer ${token}`)
          .send({
            jsonrpc: "2.0",
            id: "fixture",
            method: "tools/call",
            params: { name, arguments: args },
          });
      const apiJobUrl = "https://api.github.com/repos/TogetherWeOwn/two-bot-next/actions/jobs/42/logs";
      const safeDownloadUrl = "https://productionresultssa0.blob.core.windows.net/actions-results/job.txt?sig=fixture-signature";
      let redirectLocation = safeDownloadUrl;
      const requests: Array<{
        url: string;
        method: string;
        authorization: string | null;
        redirect: RequestRedirect | undefined;
      }> = [];
      const webhookFixture = [{
        id: 9,
        name: "build",
        type: "Repository",
        active: true,
        events: ["push"],
        config: {
          url: "https://hooks.example.test/receive?secret=url-secret",
          content_type: "json",
          secret: "webhook-secret-fixture",
          insecure_ssl: "0",
        },
        url: "https://api.github.com/repos/TogetherWeOwn/two-bot-next/hooks/9",
        test_url: "https://api.github.com/repos/TogetherWeOwn/two-bot-next/hooks/9/test",
        ping_url: "https://api.github.com/repos/TogetherWeOwn/two-bot-next/hooks/9/pings",
        deliveries_url: "https://api.github.com/repos/TogetherWeOwn/two-bot-next/hooks/9/deliveries",
        created_at: "2026-10-08T00:00:00Z",
        updated_at: "2026-10-08T00:00:00Z",
      }];
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, init) => {
        const url = resource instanceof Request
          ? resource.url
          : resource instanceof URL
            ? resource.toString()
            : resource;
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          method: init?.method ?? "GET",
          authorization: headers.get("authorization"),
          redirect: init?.redirect,
        });
        if (url === apiJobUrl) {
          return new Response(null, {
            status: 302,
            headers: { location: redirectLocation },
          });
        }
        if (url === safeDownloadUrl) {
          return new Response(
            "token=test-token-A\nGH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz123456\nhttps://example.test/log?access_token=url-secret\n",
            { status: 200, headers: { "content-type": "text/plain" } },
          );
        }
        if (url === "https://api.github.com/repos/TogetherWeOwn/two-bot-next/hooks?per_page=100&page=1") {
          return new Response(JSON.stringify(webhookFixture), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("Unexpected fixture request");
      });

      try {
        const listedTools = await request(app)
          .post("/mcp/runtime-tools")
          .set("Authorization", `Bearer ${token}`)
          .send({ jsonrpc: "2.0", id: "list", method: "tools/list" });
        expect(listedTools.status).toBe(200);
        expect(listedTools.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
          "connections_search",
          "connection_request",
          "github_actions_job_logs",
          "github_repository_webhooks",
        ]);

        const logs = await call("github_actions_job_logs", {
          repositoryId: "1396224242",
          jobId: "42",
        });
        expect(logs.status).toBe(200);
        expect(logs.headers["cache-control"]).toBe("no-store");
        expect(logs.body.result.structuredContent).toMatchObject({
          repositoryId: "1396224242",
          repository: "TogetherWeOwn/two-bot-next",
          jobId: "42",
          truncated: false,
        });
        const serializedLogs = JSON.stringify(logs.body.result.structuredContent);
        expect(serializedLogs).not.toContain("test-token-A");
        expect(serializedLogs).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
        expect(serializedLogs).not.toContain("access_token=url-secret");
        expect(requests.slice(0, 2)).toMatchObject([
          {
            url: apiJobUrl,
            method: "GET",
            authorization: "Bearer test-token-A",
            redirect: "manual",
          },
          {
            url: safeDownloadUrl,
            method: "GET",
            authorization: null,
            redirect: "manual",
          },
        ]);

        const webhooks = await call("github_repository_webhooks", {
          repositoryId: "1396224242",
        });
        expect(webhooks.status).toBe(200);
        const webhookResult = webhooks.body.result.structuredContent;
        expect(webhookResult).toMatchObject({
          repositoryId: "1396224242",
          webhooks: [{
            id: 9,
            name: "build",
            active: true,
            events: ["push"],
            config: { contentType: "json", insecureSsl: false },
          }],
        });
        const serializedWebhooks = JSON.stringify(webhookResult);
        for (const secretOrUrl of [
          "webhook-secret-fixture",
          "url-secret",
          "hooks.example.test",
          "ping_url",
          "deliveries_url",
        ]) expect(serializedWebhooks).not.toContain(secretOrUrl);

        const requestCount = requests.length;
        for (const [tool, args] of [
          ["github_actions_job_logs", { repositoryId: "1396224242", jobId: "42", owner: "attacker" }],
          ["github_actions_job_logs", { repositoryId: "9999999999", jobId: "42" }],
          ["github_actions_job_logs", { repositoryId: "1396224242", jobId: "42", method: "POST", path: "/repos/TogetherWeOwn/two-bot-next/hooks/9/pings" }],
          ["github_repository_webhooks", { repositoryId: "1396224242", repo: "attacker/repo", url: "https://attacker.example" }],
          ["github_repository_webhooks", { repositoryId: "1396224242", path: "/repos/TogetherWeOwn/two-bot-next/hooks/9/tests" }],
        ] as const) {
          expect((await call(tool, args)).status).not.toBe(200);
        }
        expect(requests).toHaveLength(requestCount);
        expect((await call("github_repository_webhook_ping", { repositoryId: "1396224242" })).status).toBe(404);
        expect(requests).toHaveLength(requestCount);

        redirectLocation = "https://attacker.example/log.txt?sig=must-not-be-fetched";
        const beforeUnsafeRedirect = requests.length;
        expect((await call("github_actions_job_logs", {
          repositoryId: "1396224242",
          jobId: "42",
        })).status).toBe(403);
        expect(requests).toHaveLength(beforeUnsafeRedirect + 1);
        expect(requests.at(-1)?.url).toBe(apiJobUrl);
        expect(requests.some((entry) => entry.url.includes("attacker.example"))).toBe(false);

        await db
          .update(issues)
          .set({
            sourceTrust: {
              preset: LOW_TRUST_REVIEW_PRESET,
              disposition: "quarantined",
              sourceIssueId: input.issueId,
            },
          })
          .where(eq(issues.id, input.issueId));
        vault.resolveUserSecretValue.mockClear();
        const beforeQuarantine = requests.length;
        expect((await call("github_repository_webhooks", {
          repositoryId: "1396224242",
        })).status).toBe(403);
        expect(requests).toHaveLength(beforeQuarantine);
        expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();

        await db
          .update(heartbeatRuns)
          .set({ status: "succeeded" })
          .where(eq(heartbeatRuns.id, input.runId));
        const beforeFinishedRun = requests.length;
        expect((await call("github_repository_webhooks", {
          repositoryId: "1396224242",
        })).status).toBe(403);
        expect(requests).toHaveLength(beforeFinishedRun);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  },
);
