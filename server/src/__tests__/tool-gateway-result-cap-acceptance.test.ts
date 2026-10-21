import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, connectionGrants, createDb, heartbeatRuns, issues,
  toolApplications, toolCallEvents, toolCatalogEntries, toolConnections,
  toolInvocations, toolProfileBindings, toolProfileEntries, toolProfiles,
  toolActionRequests, toolPolicies,
} from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { heartbeatService } from "../services/heartbeat.js";
import { registerServerAdapter, unregisterServerAdapter, type ServerAdapterModule } from "../adapters/index.js";
import { createToolResultSpillWriter, prepareToolResultDelivery, registerToolResultSpillWriter } from "../services/tool-result-delivery.js";
import { HEARTBEAT_RUN_SCRATCH_MARKER } from "../services/run-scratch.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
async function completion(db: ReturnType<typeof createDb>, invocationId: string) {
  const rows = await db.select().from(toolCallEvents).where(eq(toolCallEvents.invocationId, invocationId));
  const event = rows.find((row) => row.eventType === "call_completed");
  expect(event, "gateway must persist a completion audit event").toBeDefined();
  return event!;
}

// Keep the normalization expectation independent of the implementation's cap:
// MCP transport duplicates text in content/data before agent-facing delivery.
function normalized(content: string, structuredContent?: Record<string, unknown>) {
  return {
    content,
    data: {
      content: [{ type: "text", text: content }],
      ...(structuredContent ? { structuredContent } : {}),
      isError: false, transport: "mcp_http", spawnedLocalProcess: false,
    },
  };
}

describeDatabase("gateway result cap integration acceptance", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let scratch: string;
  const cleanups: Array<() => void> = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-result-cap-acceptance-");
    db = createDb(database.connectionString);
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-result-cap-"));
  }, 30_000);

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await database?.cleanup();
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  });

  async function fixture(toolName: string, content: string, structuredContent?: Record<string, unknown>, isError = false) {
    vi.stubEnv("PAPERCLIP_TOOL_RESULT_CAPS", "{}");
    vi.stubEnv("PAPERCLIP_TOOL_RESULT_MAX_BYTES", "16384");
    const [company] = await db.insert(companies).values({ name: "Result cap acceptance", issuePrefix: `RC${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Result cap fixture", role: "engineer", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Result cap fixture", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id } }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId: company.id, profileKey: `result-cap-${randomUUID()}`, name: "Acceptance tools", defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: company.id, profileId: profile.id, targetType: "agent", targetId: agent.id });
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: `cap-${randomUUID()}`, name: "Fixture MCP", type: "mcp_http", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id, applicationId: application.id, name: "Fixture connection", uid: `test/${randomUUID()}`,
      transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "shared",
      config: { url: "https://8.8.8.8/mcp" }, transportConfig: { url: "https://8.8.8.8/mcp" },
    }).returning();
    await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection.id, kind: "organization", status: "active", isDefault: true, credentialSecretRefs: [] });
    const [entry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id, applicationId: application.id, connectionId: connection.id, entryKind: "tool", name: toolName, toolName,
      title: toolName, riskLevel: "read", isReadOnly: true, status: "active", versionHash: randomUUID(), inputSchema: { type: "object", additionalProperties: true },
    }).returning();
    const dispatched: Array<Record<string, unknown>> = [];
    const remoteHttpRequest = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/call") dispatched.push(request.params.arguments);
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        result: request.method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "cap-fixture", version: "1" } }
          : { content: [{ type: "text", text: content }], ...(isError ? { isError: true } : {}), ...(structuredContent ? { structuredContent } : {}) },
      }), { headers: { "content-type": "application/json" } });
    });
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "result-cap-test-only", remoteHttpRequest });
    const scope = { companyId: company.id, agentId: agent.id, runId: run.id };
    const session = await gateway.createSession(scope);
    const tool = (await gateway.listToolsForSession(session.token)).find((item) => item.catalogEntryId === entry.id)!;
    expect(tool).toBeDefined();
    const execute = (parameters: Record<string, unknown> = {}) => gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters });
    return { scope, issue, profile, entry, execute, dispatched, gateway, session, tool };
  }

  async function enableSpills(scope: { companyId: string; agentId: string; runId: string }) {
    cleanups.push(registerToolResultSpillWriter(scope, createToolResultSpillWriter({ scope, target: null, cwd: scratch, scratchDir: scratch })));
  }

  it.each(["executeTool", "executeApprovedAgentInvocation"])("caps and spills an MCP error through %s without retrying the provider", async (executionPath) => {
    const token = "ghp_" + "q".repeat(36);
    const content = `BEGIN ${token}\n${"x".repeat(201 * 1024)}\nEND ${token}`;
    const sanitized = content.replaceAll(token, REDACTED_EVENT_VALUE);
    const f = await fixture("read_report", content, undefined, true);
    await enableSpills(f.scope);
    if (executionPath === "executeApprovedAgentInvocation") {
      await initializeRunIdentity(db, {
        companyId: f.scope.companyId, runId: f.scope.runId, issueId: f.issue.id,
        responsibleUserId: null, cause: "company_default",
      });
      await db.insert(toolPolicies).values({
        companyId: f.scope.companyId, name: "Ask before report", policyType: "require_approval", selectors: { toolName: f.tool.name },
      });
      await expect(f.execute()).rejects.toMatchObject({ reasonCode: "approval_required" });
      expect(f.dispatched).toHaveLength(0);
      const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.scope.companyId));
      expect(request.signedArguments).toEqual(expect.any(String));
      // Fixture-only decision: keep the real signed payload and route the next
      // matching call through executeApprovedAgentInvocation, not the normal path.
      await db.update(toolActionRequests).set({ status: "approved", decidedAt: new Date(), resolvedByUserId: "board-user" })
        .where(eq(toolActionRequests.id, request.id));
    }
    const error = await f.execute().then(() => { throw new Error("MCP isError must reject"); }, (error: unknown) => error) as Error;
    expect.soft(error).toMatchObject({ status: 502, reasonCode: "tool_error" });
    expect.soft(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(16_384);
    expect.soft(error.message.includes(token), "agent-facing errors must be sanitized").toBe(false);
    expect(f.dispatched).toEqual([{}]);
    const saved = error.message.match(/full result saved to (.+); read it with a ranged read/);
    expect(saved, "MCP errors must pass through delivery before being thrown").not.toBeNull();
    const normalizedError = (text: string) => ({
      content: text,
      data: { content: [{ type: "text", text }], isError: true, transport: "mcp_http", spawnedLocalProcess: false },
      error: "MCP tool returned an error result",
    });
    expect(JSON.parse(await fs.readFile(saved![1]!, "utf8"))).toEqual(normalizedError(sanitized));
    expect(path.relative(scratch, saved![1]!)).not.toMatch(/^\.\./);
    expect((await fs.stat(saved![1]!)).mode & 0o777).toBe(0o600);
    // Existing audit semantics measure the full sanitized result before capping.
    const originalSize = bytes(normalizedError(sanitized));
    expect(error.message).toContain(`${originalSize} bytes total`);
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, f.scope.companyId));
    expect(invocation).toMatchObject({ status: "failed", errorCode: "tool_error", resultSizeBytes: originalSize });
    const events = await db.select().from(toolCallEvents).where(eq(toolCallEvents.invocationId, invocation.id));
    expect(events.filter((event) => event.eventType === "call_completed")).toHaveLength(0);
    const failed = events.filter((event) => event.eventType === "call_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      reasonCode: "tool_error", resultSizeBytes: originalSize,
      metadata: { truncated: true, deliveredSizeBytes: expect.any(Number) },
    });
    expect(Number(failed[0].metadata?.deliveredSizeBytes)).toBeLessThanOrEqual(16_384);
    expect(Number(failed[0].metadata?.deliveredSizeBytes)).toBeGreaterThanOrEqual(Buffer.byteLength(error.message, "utf8"));
  });

  it.each(["short", "cap-disabled"])("preserves %s MCP error semantics", async (kind) => {
    const content = kind === "short" ? "Report unavailable" : "x".repeat(201 * 1024);
    const f = await fixture("read_report", content, undefined, true);
    if (kind === "cap-disabled") vi.stubEnv("PAPERCLIP_TOOL_RESULT_CAPS", JSON.stringify({ read_report: 0 }));
    await enableSpills(f.scope);
    const error = await f.execute().catch((error: Error) => error);
    expect(error).toMatchObject({ status: 502, reasonCode: "tool_error", message: content });
    expect(f.dispatched).toEqual([{}]);
  });

  it("caps a dispatched plugin result without dropping the plugin envelope", async () => {
    const f = await fixture("unused_remote", "unused");
    await enableSpills(f.scope);
    const token = "ghp_" + "q".repeat(36);
    const content = `BEGIN ${token}\n${"x".repeat(201 * 1024)}\nEND ${token}`;
    const full = { pluginId: "fixture-plugin", toolName: "read_report", result: { content, data: { complete: content } } };
    const executeTool = vi.fn(async () => full);
    const pluginToolDispatcher: PluginToolDispatcher = {
      initialize: async () => {}, teardown: () => {},
      listToolsForAgent: () => [{ name: "fixture:read_report", pluginId: full.pluginId, displayName: "Read report", description: "Read a synthetic report", parametersSchema: { type: "object" } }],
      getTool: () => null, executeTool, registerPluginTools: () => {}, unregisterPluginTools: () => {}, toolCount: () => 1,
      getRegistry: () => { throw new Error("not used"); },
    };
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "result-cap-test-only", pluginToolDispatcher });
    await db.insert(toolPolicies).values({ companyId: f.scope.companyId, name: "Allow plugin report", policyType: "allow", selectors: { toolName: "fixture:read_report" } });
    const session = await gateway.createSession(f.scope);
    const response = await gateway.executeTool({ sessionToken: session.token, tool: "fixture:read_report", parameters: {} });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(Object.keys(response.result as object).sort()).toEqual(["pluginId", "result", "toolName"]);
    expect(response.result).toMatchObject({ pluginId: full.pluginId, toolName: full.toolName });
    expect(bytes(response.result)).toBeLessThanOrEqual(16_384);
    expect(JSON.stringify(response.result)).not.toContain(token);
    const delivered = (response.result as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    const saved = delivered.match(/full result saved to (.+); read it with a ranged read/);
    expect(saved).not.toBeNull();
    const sanitized = content.replaceAll(token, REDACTED_EVENT_VALUE);
    expect(JSON.parse(await fs.readFile(saved![1]!, "utf8"))).toEqual({ ...full, result: { content: sanitized, data: { complete: sanitized } } });
    const event = await completion(db, response.invocationId);
    const fullSanitized = { ...full, result: { content: sanitized, data: { complete: sanitized } } };
    expect(event).toMatchObject({ resultSizeBytes: bytes(fullSanitized), metadata: { truncated: true, deliveredSizeBytes: bytes(response.result) } });
  });

  it("registers the exact spill scope in real heartbeat execution and removes it on completion", async () => {
    const content = "BEGIN\n" + "x".repeat(201 * 1024) + "\nEND";
    const f = await fixture("read_report", content);
    // Replace the gateway fixture's synthetic run with one created by the real
    // heartbeat controller. No test-side writer registration is used here.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.scope.runId));
    await db.update(companies).set({ defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false })
      .where(eq(companies.id, f.scope.companyId));
    await db.update(agents).set({ status: "idle", adapterType: "codex_local", adapterConfig: { cwd: scratch }, runtimeConfig: {} })
      .where(eq(agents.id, f.scope.agentId));
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    let observedScope: typeof f.scope | undefined;
    let runScratch: string | undefined;
    let observedResult: unknown;
    let adapterError: unknown;
    const execute = vi.fn<ServerAdapterModule["execute"]>(async (ctx) => {
      try {
        observedScope = { companyId: ctx.agent.companyId, agentId: ctx.agent.id, runId: ctx.runId };
        runScratch = (ctx.context.paperclipScratch as { dir: string }).dir;
        expect((ctx.config.env as Record<string, unknown>).PAPERCLIP_RUN_SCRATCH_DIR).toBe(runScratch);
        const marker = JSON.parse(await fs.readFile(path.join(runScratch, HEARTBEAT_RUN_SCRATCH_MARKER), "utf8"));
        expect(marker).toMatchObject(observedScope);
        const session = await f.gateway.createSession(observedScope);
        const response = await f.gateway.executeTool({ sessionToken: session.token, tool: f.tool.name, parameters: {} });
        observedResult = response.result;
        expect(bytes(response.result)).toBeLessThanOrEqual(16_384);
        const delivered = (response.result as { content: Array<{ text: string }> }).content[0].text;
        const file = delivered.match(/full result saved to (.+); read it with a ranged read/);
        expect(file).not.toBeNull();
        expect(path.relative(runScratch, file![1]!)).not.toMatch(/^\.\./);
        expect(path.isAbsolute(file![1]!)).toBe(true);
        expect(JSON.parse(await fs.readFile(file![1]!, "utf8"))).toEqual(normalized(content));
        expect((await fs.stat(file![1]!)).mode & 0o777).toBe(0o600);
        for (const key of ["companyId", "agentId", "runId"] as const) {
          const wrongScope = { ...observedScope, [key]: randomUUID() };
          const wrong = await prepareToolResultDelivery({ scope: wrongScope, invocationId: randomUUID(), tool: f.tool, value: content, originalSizeBytes: bytes(content) });
          expect(wrong.metadata).toMatchObject({ truncated: false, resultCapSkipped: "spill_writer_unavailable" });
        }
        return { exitCode: 0, signal: null, timedOut: false, provider: "test", model: "fixture", summary: "Spill lifecycle verified", resultJson: {} };
      } catch (error) {
        adapterError = error;
        throw error;
      }
    });
    registerServerAdapter({
      type: "codex_local", supportsLocalAgentJwt: false, execute,
      testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
    });
    try {
      const queued = await heartbeat.invoke(f.scope.agentId, "on_demand", {}, "manual");
      expect(queued).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      expect(adapterError).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await heartbeat.getRun(queued!.id)).toMatchObject({ status: "succeeded" });
      expect(observedScope).toEqual({ ...f.scope, runId: queued!.id });
      expect(bytes(observedResult)).toBeLessThanOrEqual(16_384);
      expect(f.dispatched).toEqual([{}]);
      const after = await prepareToolResultDelivery({ scope: observedScope!, invocationId: randomUUID(), tool: f.tool, value: content, originalSizeBytes: bytes(content) });
      expect(after.metadata).toMatchObject({ truncated: false, resultCapSkipped: "spill_writer_unavailable" });
      await expect(fs.stat(runScratch!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter("codex_local");
    }
  }, 30_000);

  it("defaults failed_only=true at actual remote dispatch", async () => {
    const f = await fixture("get-job-logs", "ok");
    await f.execute({ run_id: 123 });
    expect(f.dispatched).toEqual([{ run_id: 123, failed_only: true }]);
  });

  it("does not override explicit failed_only=false at remote dispatch", async () => {
    const f = await fixture("get-job-logs", "ok");
    await f.execute({ run_id: 123, failed_only: false });
    expect(f.dispatched).toEqual([{ run_id: 123, failed_only: false }]);
  });

  it("preserves a small result and audits truncated=false", async () => {
    const f = await fixture("list-commits", "small result");
    const response = await f.execute();
    expect(response.result).toEqual(normalized("small result"));
    const event = await completion(db, response.invocationId);
    expect(event.resultSizeBytes).toBe(bytes(normalized("small result")));
    expect(event.metadata).toMatchObject({ truncated: false });
  });

  it("records the original 200 KiB provider result size even when no spill target exists", async () => {
    const content = "x".repeat(200 * 1024);
    const f = await fixture("list-commits", content);
    const response = await f.execute();
    const event = await completion(db, response.invocationId);
    expect(event.resultSizeBytes).toBe(bytes(normalized(content)));
    expect(event.metadata).toMatchObject({ truncated: false, resultCapSkipped: expect.any(String) });
    expect(JSON.stringify(response.result)).not.toContain("full result saved to");
  });

  it("caps the actual MCP envelope, removes duplicated structuredContent and audits original bytes", async () => {
    const content = "BEGIN\n" + "x".repeat(200 * 1024 - 10) + "\nEND";
    const structured = { full: content };
    const f = await fixture("list-commits", content, structured);
    await enableSpills(f.scope);
    const response = await f.execute();
    expect(bytes(response.result)).toBeLessThanOrEqual(16_384);
    expect(response.result).not.toHaveProperty("data.structuredContent.full");
    const contentBlocks = (response.result as { content: string | Array<{ type: string; text: string }> }).content;
    const delivered = typeof contentBlocks === "string" ? contentBlocks : contentBlocks.map((block) => block.text).join("\n");
    const file = delivered.match(/full result saved to (.+); read it with a ranged read/);
    expect(file).not.toBeNull();
    expect(JSON.parse(await fs.readFile(file![1]!, "utf8"))).toEqual(normalized(content, structured));
    const originalSize = bytes(normalized(content, structured));
    const event = await completion(db, response.invocationId);
    expect(event.resultSizeBytes).toBe(originalSize);
    expect(event.resultSizeBytes).toBeGreaterThan(bytes(response.result));
    expect(event.metadata).toMatchObject({ truncated: true, deliveredSizeBytes: bytes(response.result) });
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, response.invocationId));
    expect(invocation.resultSizeBytes).toBe(originalSize);
  });

  it("applies a matching tool-profile conditions.resultMaxBytes override, not a global environment override", async () => {
    const content = "x".repeat(10 * 1024);
    const f = await fixture("list-commits", content);
    await enableSpills(f.scope);
    const before = await f.execute();
    expect(bytes(before.result)).toBeLessThanOrEqual(16_384);
    expect((await completion(db, before.invocationId)).metadata).toMatchObject({ truncated: true });
    await db.insert(toolProfileEntries).values({ companyId: f.scope.companyId, profileId: f.profile.id, selectorType: "tool_name", toolName: f.tool.name, effect: "include", conditions: { resultMaxBytes: 32_768 } });
    const response = await f.execute();
    expect(bytes(normalized(content))).toBeGreaterThan(16_384);
    expect(bytes(normalized(content))).toBeLessThan(32_768);
    expect(bytes(response.result)).toBe(bytes(normalized(content)));
    expect(response.result).toEqual(normalized(content));
    expect((await completion(db, response.invocationId)).metadata).toMatchObject({ truncated: false });
  });
});
