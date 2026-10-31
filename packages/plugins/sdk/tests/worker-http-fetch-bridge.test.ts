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
  type JsonRpcRequest,
  type JsonRpcResponse,
  PLUGIN_RPC_ERROR_CODES,
  parseMessage,
  serializeMessage,
} from "../src/protocol.js";
import type { PluginHttpFetchInit } from "../src/types.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

/**
 * TWO-424 — the worker bridge for `ctx.http.fetch` forwards `redirect`,
 * `maxResponseBytes` and `signal` to the host instead of dropping them.
 */

type HostFetchHandler = (
  request: JsonRpcRequest,
  reply: (response: JsonRpcResponse) => void,
) => void;

async function withFetchWorker(
  makeInit: () => PluginHttpFetchInit,
  onHostRequest: HostFetchHandler,
  run: (callFetch: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const hostReadline = createInterface({ input: workerToHost });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  let nextRequestId = 1;

  const plugin = definePlugin({
    async setup(ctx) {
      ctx.actions.register("fetch", async () => {
        try {
          const res = await ctx.http.fetch(
            "https://example.test/data",
            makeInit(),
          );
          return { status: res.status, body: await res.text() };
        } catch (err) {
          return {
            error: (err as Error).name,
            code: (err as { code?: unknown }).code ?? null,
          };
        }
      });
    },
  });
  const worker = startWorkerRpcHost({
    plugin,
    stdin: hostToWorker,
    stdout: workerToHost,
  });

  const reply = (response: JsonRpcResponse) =>
    hostToWorker.write(serializeMessage(response));

  function callWorker(method: string, params: unknown) {
    const id = `host-${nextRequestId++}`;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, (response) => {
        if ("error" in response && response.error) {
          reject(new Error(response.error.message));
          return;
        }
        resolve((response as { result?: unknown }).result);
      });
    });
    hostToWorker.write(serializeMessage(createRequest(method, params, id)));
    return result;
  }

  hostReadline.on("line", (line) => {
    const message = parseMessage(line);
    if (isJsonRpcResponse(message)) {
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    } else if (isJsonRpcRequest(message)) {
      onHostRequest(message, reply);
    }
  });

  try {
    await callWorker("initialize", {
      manifest: {
        id: "paperclip.test-http-fetch-bridge",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "HTTP Fetch Bridge Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["http.outbound"],
        entrypoints: {},
      },
      config: {},
      databaseNamespace: null,
    });
    await run(() => callWorker("performAction", { key: "fetch", params: {} }));
  } finally {
    worker.stop();
    hostReadline.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }
}

const okResult = { status: 200, statusText: "OK", headers: {}, body: "ok" };

describe("worker ctx.http.fetch bridge", () => {
  it("forwards redirect and maxResponseBytes, with no fetch id when there is no signal", async () => {
    const seen: unknown[] = [];
    await withFetchWorker(
      () => ({
        method: "POST",
        body: "x",
        redirect: "manual",
        maxResponseBytes: 4096,
      }),
      (request, reply) => {
        seen.push(request.params);
        reply(createSuccessResponse(request.id, okResult));
      },
      async (callFetch) => {
        await expect(callFetch()).resolves.toEqual({ status: 200, body: "ok" });
      },
    );
    expect(seen).toEqual([
      {
        url: "https://example.test/data",
        init: { method: "POST", body: "x", redirect: "manual" },
        maxResponseBytes: 4096,
      },
    ]);
  });

  it("passes the host's typed too-large error through to the plugin", async () => {
    await withFetchWorker(
      () => ({ maxResponseBytes: 10 }),
      (request, reply) => {
        reply(
          createErrorResponse(
            request.id,
            PLUGIN_RPC_ERROR_CODES.HTTP_RESPONSE_TOO_LARGE,
            "Response body exceeded 10 bytes (while streaming)",
          ),
        );
      },
      async (callFetch) => {
        await expect(callFetch()).resolves.toEqual({
          error: "JsonRpcCallError",
          code: PLUGIN_RPC_ERROR_CODES.HTTP_RESPONSE_TOO_LARGE,
        });
      },
    );
  });

  it("rejects on abort and asks the host to cancel the same fetch id", async () => {
    const controller = new AbortController();
    const requests: JsonRpcRequest[] = [];
    let cancelled!: () => void;
    const cancelSeen = new Promise<void>((resolve) => {
      cancelled = resolve;
    });

    await withFetchWorker(
      () => ({ signal: controller.signal }),
      (request, reply) => {
        requests.push(request);
        if (request.method === "http.fetch") {
          // Never answer the fetch itself; the abort must settle the call.
          controller.abort();
        } else if (request.method === "http.fetch.cancel") {
          reply(createSuccessResponse(request.id, null));
          cancelled();
        }
      },
      async (callFetch) => {
        await expect(callFetch()).resolves.toEqual({
          error: "AbortError",
          code: 20,
        });
        await cancelSeen;
      },
    );

    const [fetchRequest, cancelRequest] = requests;
    expect(fetchRequest?.method).toBe("http.fetch");
    const fetchId = (fetchRequest?.params as { fetchId?: string } | undefined)
      ?.fetchId;
    expect(fetchId).toEqual(expect.any(String));
    expect(cancelRequest?.method).toBe("http.fetch.cancel");
    expect(cancelRequest?.params).toEqual({ fetchId });
  });

  it("does not call the host when the signal is already aborted", async () => {
    const requests: JsonRpcRequest[] = [];
    await withFetchWorker(
      () => ({ signal: AbortSignal.abort() }),
      (request) => {
        requests.push(request);
      },
      async (callFetch) => {
        await expect(callFetch()).resolves.toMatchObject({
          error: "AbortError",
        });
      },
    );
    expect(requests).toEqual([]);
  });

  it("ignores an older host that does not know http.fetch.cancel", async () => {
    const controller = new AbortController();
    await withFetchWorker(
      () => ({ signal: controller.signal }),
      (request, reply) => {
        if (request.method === "http.fetch") {
          controller.abort();
        } else {
          reply(
            createErrorResponse(
              request.id,
              -32601,
              `Host does not handle method "${request.method}"`,
            ),
          );
        }
      },
      async (callFetch) => {
        await expect(callFetch()).resolves.toMatchObject({
          error: "AbortError",
        });
        // Let the cancel's METHOD_NOT_FOUND arrive; it must not surface anywhere.
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    );
  });
});
