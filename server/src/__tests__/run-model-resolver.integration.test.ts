import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, agents, createDb, heartbeatRuns, pluginCompanySettings, plugins } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { runModelResolverService } from "../services/run-model-resolver.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), pluginId = randomUUID();
const issueId = randomUUID(), otherIssueId = randomUUID();
const manifest: PaperclipPluginManifestV1 = {
  id: "fixture.model-resolver", apiVersion: 1, version: "1.0.0", displayName: "Resolver",
  description: "Synthetic resolver", author: "Tests", categories: ["connector"],
  capabilities: ["run.model.resolve"], entrypoints: { worker: "worker.mjs" },
};
const call = vi.fn(async () => ({ kind: "keep" }));
const worker = { isRunning: () => true, call };
const params = { runId: randomUUID(), companyId, agentId, issueId, adapterType: "claude_local", invocationSource: "on_demand", wakeReason: null, agentDefaultModel: "default", issueOverrideModel: null };

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("paperclip-model-resolver-");
  db = createDb(database.connectionString);
  await db.insert(companies).values([{ id: companyId, name: "Fixture", issuePrefix: "MRF" }, { id: otherCompanyId, name: "Other", issuePrefix: "MRO" }]);
  await db.insert(agents).values([{ id: agentId, companyId, name: "Fixture", adapterType: "claude_local" }, { id: otherAgentId, companyId: otherCompanyId, name: "Other", adapterType: "claude_local" }]);
  await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: manifest.id, version: "1.0.0", manifestJson: manifest, status: "ready" });
  await db.insert(pluginCompanySettings).values({ companyId: otherCompanyId, pluginId, enabled: false });
}, 90000);
afterAll(async () => { await database?.cleanup(); });

describe("company-scoped run model resolver", () => {
  it("uses company opt-outs without disabling a plugin for other companies", async () => {
    call.mockClear();
    const service = runModelResolverService(db, worker);
    expect((await service({ params: { ...params, companyId: otherCompanyId, agentId: otherAgentId }, baseEnv: {} })).record.reason).toBe("no_model_resolver");
    expect(call).not.toHaveBeenCalled();
    expect((await service({ params, baseEnv: {} })).record.outcome).toBe("kept");
    expect(call).toHaveBeenCalledOnce();
  });
  it("only supplies the previous decision for the same company, agent and issue", async () => {
    const matchingRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: matchingRunId, companyId, agentId, status: "succeeded", createdAt: new Date(1000), contextSnapshot: { issueId, modelDecision: { outcome: "decided", model: "previous", decisionId: "d1" } } },
      { companyId, agentId, status: "succeeded", createdAt: new Date(2000), contextSnapshot: { issueId: otherIssueId, modelDecision: { outcome: "decided", model: "wrong_issue" } } },
      { companyId: otherCompanyId, agentId: otherAgentId, status: "succeeded", createdAt: new Date(3000), contextSnapshot: { issueId, modelDecision: { outcome: "decided", model: "wrong_company" } } },
      { companyId, agentId, status: "cancelled", createdAt: new Date(4000), contextSnapshot: { issueId, modelDecision: { outcome: "deferred", model: null } } },
    ]);
    call.mockClear();
    await runModelResolverService(db, worker)({ params, baseEnv: {} });
    expect(call).toHaveBeenCalledWith(pluginId, "resolveRunModel", expect.objectContaining({ previous: { runId: matchingRunId, model: "previous", decisionId: "d1" } }), 1500);
  });
  it("skips non-issue, human-assigned and native-bound runs before reading plugin state", async () => {
    call.mockClear();
    const service = runModelResolverService(db, worker);
    expect((await service({ params: { ...params, issueId: null }, baseEnv: {} })).record.reason).toBe("non_issue_run");
    for (const skipReason of ["human_assignee", "explicit_ai_binding"]) {
      expect((await service({ params, baseEnv: {}, skipReason })).record.reason).toBe(skipReason);
    }
    expect(call).not.toHaveBeenCalled();
  });
});
