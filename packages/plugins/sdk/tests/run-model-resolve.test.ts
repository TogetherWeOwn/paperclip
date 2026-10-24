import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";
import { createRequest, isJsonRpcResponse, parseMessage, serializeMessage, PLUGIN_RPC_ERROR_CODES, type JsonRpcResponse, type ResolveRunModelResult } from "../src/protocol.js";

async function withWorker(answer: ResolveRunModelResult | undefined, test: (call: (method: string, params: unknown) => Promise<unknown>, hook: ReturnType<typeof vi.fn>) => Promise<void>) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const reader = createInterface({ input: stdout });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  const hook = vi.fn(async () => answer!);
  const plugin = definePlugin({ async setup() {}, ...(answer ? { onResolveRunModel: hook } : {}) });
  const worker = startWorkerRpcHost({ plugin, stdin, stdout });
  reader.on("line", line => {
    const response = parseMessage(line);
    if (isJsonRpcResponse(response)) {
      pending.get(String(response.id))?.(response); pending.delete(String(response.id));
    }
  });
  let sequence = 0;
  const call = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, response => {
      if ("error" in response) reject(response.error);
      else resolve(response.result);
    });
    stdin.write(serializeMessage(createRequest(method, params, id)));
  });
  try { await test(call, hook); }
  finally { worker.stop(); reader.close(); stdin.destroy(); stdout.destroy(); }
}
const initialize = {
  manifest: { id: "fixture.model-router", apiVersion: 1, version: "1.0.0", displayName: "Model resolver", description: "Tests", author: "Tests", categories: ["connector"], capabilities: ["run.model.resolve"], entrypoints: { worker: "worker.mjs" } },
  config: {}, databaseNamespace: null,
};

describe("resolveRunModel worker RPC", () => {
  it.each<ResolveRunModelResult>([
    { kind: "keep" },
    { kind: "defer", retryAfterMs: 5000, reason: "capacity" },
    { kind: "decide", decisionId: "decision", model: "chosen", effort: "high", env: { MODEL_CONTEXT_LIMIT: "32000" }, source: "fixture" },
  ])("advertises and dispatches the optional hook for $kind", async answer => {
    await withWorker(answer, async (call, hook) => {
      await expect(call("initialize", initialize)).resolves.toMatchObject({ ok: true, supportedMethods: expect.arrayContaining(["resolveRunModel"]) });
      const params = { runId: "run", companyId: "company", agentId: "agent", issueId: "issue", adapterType: "local", invocationSource: "on_demand", wakeReason: null, agentDefaultModel: "default", issueOverrideModel: null, previous: null, deadlineMs: 1500 };
      await expect(call("resolveRunModel", params)).resolves.toEqual(answer);
      expect(hook).toHaveBeenCalledWith(params);
    });
  });
  it("keeps older plugins compatible and reports a missing optional method", async () => {
    await withWorker(undefined, async call => {
      await expect(call("initialize", initialize)).resolves.toMatchObject({ ok: true, supportedMethods: expect.not.arrayContaining(["resolveRunModel"]) });
      await expect(call("resolveRunModel", {})).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED });
    });
  });
});
