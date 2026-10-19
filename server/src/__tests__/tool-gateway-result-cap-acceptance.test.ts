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
} from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
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

  async function fixture(toolName: string, content: string, structuredContent?: Record<string, unknown>) {
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
          : { content: [{ type: "text", text: content }], ...(structuredContent ? { structuredContent } : {}) },
      }), { headers: { "content-type": "application/json" } });
    });
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "result-cap-test-only", remoteHttpRequest });
    const scope = { companyId: company.id, agentId: agent.id, runId: run.id };
    const session = await gateway.createSession(scope);
    const tool = (await gateway.listToolsForSession(session.token)).find((item) => item.catalogEntryId === entry.id)!;
    expect(tool).toBeDefined();
    const execute = (parameters: Record<string, unknown> = {}) => gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters });
    return { scope, profile, entry, execute, dispatched, gateway, session, tool };
  }

  async function enableSpills(scope: { companyId: string; agentId: string; runId: string }) {
    // Dynamic only so baseline dispatch/audit assertions can run before this
    // new helper exists; missing-helper errors are not counted as behavioral red.
    const modulePath = "../services/tool-result-delivery.js";
    const { registerToolResultSpillWriter, createToolResultSpillWriter } = await import(modulePath) as typeof import("../services/tool-result-delivery.js");
    cleanups.push(registerToolResultSpillWriter(scope, createToolResultSpillWriter({ scope, target: null, cwd: scratch, scratchDir: scratch })));
  }

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
