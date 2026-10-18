/**
 * DB-backed tests for the source-bound transport validation operation.
 *
 * Unlike the injected-deps suites, these go through
 * `createDbSourceBoundTransportValidationDeps` against embedded Postgres, so
 * the real company-scoped resolvers are exercised: issue identifiers resolve
 * like on sibling `/issues/:id` routes, non-UUID ids deny instead of raising
 * a Postgres uuid-parse error, and closed workspaces never produce an
 * `ok:true` receipt. All identifiers are synthetic.
 */
import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  executionWorkspaces,
  issues,
  projects,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import {
  createDbSourceBoundTransportValidationDeps,
  runSourceBoundTransportValidation,
} from "../services/source-bound-transport-validation-operation.js";
import {
  describeEmbeddedPostgres,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const DIGEST = `sha256:${"b".repeat(64)}`;
const ATTESTATION_ENV = {
  PAPERCLIP_SOURCE_REVISION: "a".repeat(40),
  PAPERCLIP_DEPLOYED_IMAGE_REFERENCE: `registry.example.com/paperclip-server@${DIGEST}`,
  PAPERCLIP_EXPECTED_IMAGE_DIGEST: DIGEST,
};

describeEmbeddedPostgres(
  "source-bound transport validation (DB-backed deps)",
  () => {
    const ctx = useEmbeddedPostgres("paperclip-source-bound-transport-");

    afterEach(async () => {
      await ctx.db.delete(issues);
      await ctx.db.delete(executionWorkspaces);
      await ctx.db.delete(agents);
      await ctx.db.delete(projects);
      await ctx.db.delete(companies);
    });

    async function seed(
      opts: { workspaceStatus?: string; workspaceClosedAt?: Date | null } = {},
    ) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const projectId = randomUUID();
      const issueId = randomUUID();
      const workspaceId = randomUUID();
      const identifier = `TST-${Math.floor(Math.random() * 900_000) + 100_000}`;
      await ctx.db.insert(companies).values({
        id: companyId,
        name: "Source-bound transport test",
        issuePrefix: "TST",
        requireBoardApprovalForNewAgents: false,
      });
      await ctx.db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await ctx.db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Source-bound transport project",
        status: "in_progress",
      });
      await ctx.db.insert(issues).values({
        id: issueId,
        companyId,
        projectId,
        identifier,
        issueNumber: Number(identifier.split("-")[1]),
        title: "Validate my transport",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      });
      await ctx.db.insert(executionWorkspaces).values({
        id: workspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "project_primary",
        name: "source-bound-workspace",
        status: opts.workspaceStatus ?? "active",
        providerType: "local_fs",
        cwd: "/tmp/paperclip-source-bound-transport",
        closedAt: opts.workspaceClosedAt ?? null,
      });
      await ctx.db
        .update(issues)
        .set({ executionWorkspaceId: workspaceId })
        .where(eq(issues.id, issueId));
      return { companyId, agentId, issueId, workspaceId, identifier };
    }

    function run(
      input: Parameters<typeof runSourceBoundTransportValidation>[1],
    ) {
      return runSourceBoundTransportValidation(
        createDbSourceBoundTransportValidationDeps(ctx.db, {
          env: ATTESTATION_ENV,
        }),
        input,
      );
    }

    it("returns an ok receipt for the assignee addressed by issue identifier", async () => {
      const seeded = await seed();
      const receipt = await run({
        companyId: seeded.companyId,
        sourceIssueId: seeded.identifier,
        principalAgentId: seeded.agentId,
        workspaceId: seeded.workspaceId,
        transport: "local_fs",
      });
      expect(receipt.ok).toBe(true);
      // The receipt carries the canonical issue id, not the identifier alias.
      expect(receipt.sourceIssueId).toBe(seeded.issueId);
      expect(receipt.transport).toMatchObject({
        ok: true,
        validatedWorkspaceId: seeded.workspaceId,
      });
    });

    it("denies a non-UUID, non-identifier source id instead of throwing", async () => {
      const seeded = await seed();
      const receipt = await run({
        companyId: seeded.companyId,
        sourceIssueId: "nope",
        principalAgentId: seeded.agentId,
        workspaceId: seeded.workspaceId,
        transport: "local_fs",
      });
      expect(receipt.ok).toBe(false);
      expect(receipt.transport).toMatchObject({
        ok: false,
        errorCode: "unauthorized_principal",
      });
    });

    it("denies a non-UUID workspace id instead of throwing", async () => {
      const seeded = await seed();
      const receipt = await run({
        companyId: seeded.companyId,
        sourceIssueId: seeded.issueId,
        principalAgentId: seeded.agentId,
        workspaceId: "nope",
        transport: "local_fs",
      });
      expect(receipt.ok).toBe(false);
      expect(receipt.transport).toMatchObject({
        ok: false,
        errorCode: "workspace_transport_mismatch",
      });
    });

    it("denies a closed (archived) workspace instead of returning an ok receipt", async () => {
      const seeded = await seed({
        workspaceStatus: "archived",
        workspaceClosedAt: new Date(),
      });
      const receipt = await run({
        companyId: seeded.companyId,
        sourceIssueId: seeded.issueId,
        principalAgentId: seeded.agentId,
        workspaceId: seeded.workspaceId,
        transport: "local_fs",
      });
      expect(receipt.ok).toBe(false);
      expect(receipt.transport).toMatchObject({
        ok: false,
        errorCode: "workspace_transport_mismatch",
      });
    });
  },
);
