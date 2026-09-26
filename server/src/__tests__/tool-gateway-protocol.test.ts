import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { ToolMcpGatewayTokenAction } from "@paperclipai/shared";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import type { ToolGatewayService } from "../services/tool-gateway.js";

type StubListResult = {
  tools: Array<{ name: string; displayName?: string; description?: string; parametersSchema?: Record<string, unknown> }>;
  allowedActions: ToolMcpGatewayTokenAction[];
};

function createProtocolApp(stub: {
  listResult: StubListResult;
  executeToolResult?: unknown;
  executeContextResult?: Record<string, unknown>;
}) {
  const service = {
    initializeNamedGatewayProtocol: async () => ({}),
    listToolsForNamedGateway: async () => stub.listResult,
    executeTool: async () => ({
      invocationId: "test-invocation",
      status: "completed" as const,
      tool: "stub-tool",
      result: stub.executeToolResult,
    }),
    executeContextForNamedGateway: async () => stub.executeContextResult ?? {},
  } as unknown as ToolGatewayService;
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(service));
  return app;
}

const FULL_CONTEXT_ACTIONS: ToolMcpGatewayTokenAction[] = [
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
];

const HEARTBEAT_ACTIONS: ToolMcpGatewayTokenAction[] = ["tools/list", "tools/call"];

describe("named gateway MCP protocol response shaping", () => {
  it("omits structuredContent when a plugin tool returns only content", async () => {
    const app = createProtocolApp({
      listResult: { tools: [], allowedActions: FULL_CONTEXT_ACTIONS },
      executeToolResult: { content: "recall body" },
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hindsight_recall", arguments: {} } })
      .expect(200);
    expect(response.body.result.content).toEqual([{ type: "text", text: "recall body" }]);
    expect("structuredContent" in response.body.result).toBe(false);
  });

  it("omits structuredContent when the tool result is a plain value", async () => {
    const app = createProtocolApp({
      listResult: { tools: [], allowedActions: FULL_CONTEXT_ACTIONS },
      executeToolResult: "plain string result",
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stub-tool", arguments: {} } })
      .expect(200);
    expect("structuredContent" in response.body.result).toBe(false);
  });

  it("omits structuredContent when data is not a plain object", async () => {
    const app = createProtocolApp({
      listResult: { tools: [], allowedActions: FULL_CONTEXT_ACTIONS },
      executeToolResult: { content: "list", data: ["not", "an", "object"] },
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stub-tool", arguments: {} } })
      .expect(200);
    expect("structuredContent" in response.body.result).toBe(false);
  });

  it("keeps structuredContent when data is a plain object", async () => {
    const app = createProtocolApp({
      listResult: { tools: [], allowedActions: FULL_CONTEXT_ACTIONS },
      executeToolResult: { content: "ok", data: { echoed: "hello" } },
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stub-tool", arguments: {} } })
      .expect(200);
    expect(response.body.result.structuredContent).toEqual({ echoed: "hello" });
  });

  it("hides context wrappers the gateway token cannot perform", async () => {
    const app = createProtocolApp({
      listResult: {
        tools: [{ name: "assigned_tool", displayName: "Assigned", description: "Assigned tool" }],
        allowedActions: HEARTBEAT_ACTIONS,
      },
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(200);
    const names = response.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("assigned_tool");
    expect(names).not.toContain("paperclip_list_resources");
    expect(names).not.toContain("paperclip_read_resource");
    expect(names).not.toContain("paperclip_list_prompts");
    expect(names).not.toContain("paperclip_get_prompt");
  });

  it("advertises context wrappers when the token allows context actions", async () => {
    const app = createProtocolApp({
      listResult: { tools: [], allowedActions: FULL_CONTEXT_ACTIONS },
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(200);
    const names = response.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("paperclip_list_resources");
    expect(names).toContain("paperclip_read_resource");
    expect(names).toContain("paperclip_list_prompts");
    expect(names).toContain("paperclip_get_prompt");
  });

  it("unwraps the plugin ToolExecutionResult: text is the inner content, not wrapper JSON", async () => {
    // Real dispatcher/registry shape: { pluginId, toolName, result: ToolResult }.
    const app = createProtocolApp({
      listResult: { tools: [], allowedActions: FULL_CONTEXT_ACTIONS },
      executeToolResult: {
        pluginId: "hindsight",
        toolName: "hindsight_recall",
        result: { content: "recall body" },
      },
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hindsight:hindsight_recall", arguments: {} } })
      .expect(200);
    expect(response.body.result.content).toEqual([{ type: "text", text: "recall body" }]);
    expect("structuredContent" in response.body.result).toBe(false);
  });

  it("forwards the plugin inner data as structuredContent through the wrapper", async () => {
    const app = createProtocolApp({
      listResult: { tools: [], allowedActions: FULL_CONTEXT_ACTIONS },
      executeToolResult: {
        pluginId: "model-selection",
        toolName: "model_selection_aa_drift_report",
        result: { content: "drift summary", data: { drift: 0.12, window: "7d" } },
      },
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "model-selection:model_selection_aa_drift_report", arguments: {} } })
      .expect(200);
    expect(response.body.result.content).toEqual([{ type: "text", text: "drift summary" }]);
    expect(response.body.result.structuredContent).toEqual({ drift: 0.12, window: "7d" });
  });

  it("still reads content/data directly for non-plugin results", async () => {
    const app = createProtocolApp({
      listResult: { tools: [], allowedActions: FULL_CONTEXT_ACTIONS },
      executeToolResult: { content: "11", data: { result: 11 } },
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mcp-remote-fixture:add", arguments: {} } })
      .expect(200);
    expect(response.body.result.content).toEqual([{ type: "text", text: "11" }]);
    expect(response.body.result.structuredContent).toEqual({ result: 11 });
  });

  it("advertises only the context wrappers covered by a partial scope", async () => {
    const app = createProtocolApp({
      listResult: {
        tools: [],
        allowedActions: ["tools/list", "tools/call", "resources/list", "resources/read"],
      },
    });
    const response = await request(app)
      .post("/mcp/gateways/gw_test")
      .set("authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(200);
    const names = response.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("paperclip_list_resources");
    expect(names).toContain("paperclip_read_resource");
    expect(names).not.toContain("paperclip_list_prompts");
    expect(names).not.toContain("paperclip_get_prompt");
  });
});
