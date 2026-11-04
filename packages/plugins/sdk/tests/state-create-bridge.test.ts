import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import {
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcResponse,
  PLUGIN_RPC_ERROR_CODES,
  parseMessage,
  serializeMessage,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

async function withWorker(
  supportedHostMethods: unknown,
  result: unknown,
  run: (
    call: (key: string) => Promise<unknown>,
    requests: string[],
  ) => Promise<void>,
  capabilities = ["plugin.state.write"],
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createInterface({ input: output });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  const requests: string[] = [];
  let id = 0;
  const worker = startWorkerRpcHost({
    stdin: input,
    stdout: output,
    rpcTimeoutMs: 100,
    plugin: definePlugin({
      async setup(ctx) {
        ctx.actions.register(
          "available",
          async () => typeof ctx.state.create === "function",
        );
        ctx.actions.register("create", async () => {
          if (!ctx.state.create) throw new Error("unavailable");
          return ctx.state.create(
            { scopeKind: "company", scopeId: "company-a", stateKey: "run-a" },
            null,
          );
        });
        ctx.actions.register("legacy", async () => {
          await ctx.state.set({ scopeKind: "instance", stateKey: "old" }, 1);
          return ctx.state.get({ scopeKind: "instance", stateKey: "old" });
        });
      },
    }),
  });
  const call = (method: string, params: unknown) => {
    const requestId = String(++id);
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, (response) => {
        if ("error" in response && response.error)
          reject(new Error(response.error.message));
        else resolve((response as { result?: unknown }).result);
      });
    });
    input.write(serializeMessage(createRequest(method, params, requestId)));
    return promise;
  };
  reader.on("line", (line) => {
    const message = parseMessage(line);
    if (isJsonRpcResponse(message)) {
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    } else if (isJsonRpcRequest(message)) {
      requests.push(message.method);
      if (result === "lost") return;
      const response =
        result === "unsupported"
          ? createErrorResponse(
              message.id,
              PLUGIN_RPC_ERROR_CODES.METHOD_NOT_FOUND,
              "unsupported",
            )
          : result === "storage-error"
            ? createErrorResponse(
                message.id,
                PLUGIN_RPC_ERROR_CODES.INTERNAL_ERROR,
                "storage failed",
              )
            : createSuccessResponse(message.id, result);
      if (message.method === "state.create") {
        expect(message.params).toEqual({
          scopeKind: "company",
          scopeId: "company-a",
          stateKey: "run-a",
          value: null,
        });
      }
      input.write(serializeMessage(response));
    }
  });
  try {
    await call("initialize", {
      manifest: { id: "test.state", capabilities },
      config: {},
      supportedHostMethods,
    });
    await run((key) => call("performAction", { key, params: {} }), requests);
  } finally {
    worker.stop();
    reader.close();
    input.destroy();
    output.destroy();
  }
}

describe("state.create negotiation and wire semantics", () => {
  it.each([
    undefined,
    null,
    [],
    ["state.set"],
    ["state.create.v2"],
    ["state.create", null],
    ["state.create", 1],
    "state.create",
  ])(
    "keeps create unavailable for unsupported negotiation %j without writing",
    async (methods) => {
      await withWorker(methods, true, async (call, requests) => {
        expect(await call("available")).toBe(false);
        await expect(call("create")).rejects.toThrow("unavailable");
        expect(requests).toEqual([]);
      });
    },
  );

  it("does not expose create without the write capability", async () => {
    await withWorker(
      ["state.create"],
      true,
      async (call, requests) => {
        expect(await call("available")).toBe(false);
        expect(requests).toEqual([]);
      },
      [],
    );
  });

  it.each([true, false])(
    "round-trips the strict boolean %j",
    async (result) => {
      await withWorker(["state.create"], result, async (call, requests) => {
        expect(await call("available")).toBe(true);
        expect(requests).toEqual([]);
        expect(await call("create")).toBe(result);
        expect(requests).toEqual(["state.create"]);
      });
    },
  );

  it.each([null, 0, 1, "true", {}, undefined])(
    "rejects a non-boolean response %j",
    async (result) => {
      await withWorker(["state.create"], result, async (call) => {
        await expect(call("create")).rejects.toThrow(
          result === undefined ? "timed out" : "non-boolean",
        );
      });
    },
  );

  it.each(["unsupported", "storage-error", "lost"])(
    "throws on %s without fallback",
    async (result) => {
      await withWorker(["state.create"], result, async (call, requests) => {
        await expect(call("create")).rejects.toThrow(
          result === "lost"
            ? "timed out"
            : result === "unsupported"
              ? "unsupported"
              : "storage failed",
        );
        expect(requests).toEqual(["state.create"]);
      });
    },
  );

  it("preserves legacy get/set when a new host advertises additive methods", async () => {
    await withWorker(
      ["state.create", "unknown.future"],
      1,
      async (call, requests) => {
        expect(await call("legacy")).toBe(1);
        expect(requests).toEqual(["state.set", "state.get"]);
      },
    );
  });
});
