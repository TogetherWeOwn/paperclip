import { fileURLToPath } from "node:url";
import {
  createHostClientHandlers,
  type HostServices,
} from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "test.state",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "State fixture",
  description: "State negotiation fixture",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["plugin.state.write"],
  entrypoints: {},
};

function options(
  services: HostServices,
  fixture = "plugin-worker-state-create.mjs",
) {
  return {
    entrypointPath: fileURLToPath(
      new URL(`./fixtures/${fixture}`, import.meta.url),
    ),
    manifest,
    config: {},
    instanceInfo: { instanceId: "test", hostVersion: "0.3.1" },
    apiVersion: 1,
    hostHandlers: createHostClientHandlers({
      pluginId: manifest.id,
      capabilities: manifest.capabilities,
      services,
    }),
    rpcTimeoutMs: 2_000,
    execArgv: ["--import", import.meta.resolve("tsx")],
  };
}

describe("host-supported state method negotiation through the worker manager", () => {
  it("advertises a concrete create adapter to a new SDK worker", async () => {
    const create = vi.fn(async () => true);
    const handle = createPluginWorkerHandle(
      manifest.id,
      options({ state: { create } } as unknown as HostServices),
    );
    try {
      await handle.start();
      expect(
        await handle.call("performAction", { key: "available", params: {} }),
      ).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(
        await handle.call("performAction", { key: "create", params: {} }),
      ).toBe(true);
      expect(create).toHaveBeenCalledExactlyOnceWith({
        scopeKind: "instance",
        stateKey: "test",
        value: null,
      });
    } finally {
      await handle.stop();
    }
  });

  it("does not advertise a local wrapper backed by an old adapter", async () => {
    const set = vi.fn(async () => {});
    const handle = createPluginWorkerHandle(
      manifest.id,
      options({ state: { set } } as unknown as HostServices),
    );
    try {
      await handle.start();
      expect(
        await handle.call("performAction", { key: "available", params: {} }),
      ).toBe(false);
      await expect(
        handle.call("performAction", { key: "create", params: {} }),
      ).rejects.toThrow("unavailable");
      expect(set).not.toHaveBeenCalled();
    } finally {
      await handle.stop();
    }
  });

  it("keeps the pre-negotiation worker protocol working on a new host", async () => {
    const get = vi.fn(async () => "legacy-value");
    const opts = options(
      { state: { get, create: async () => true } } as unknown as HostServices,
      "plugin-worker-invocation-scope.cjs",
    );
    opts.manifest = {
      ...manifest,
      capabilities: ["plugin.state.read", "plugin.state.write"],
    };
    opts.hostHandlers = createHostClientHandlers({
      pluginId: manifest.id,
      capabilities: opts.manifest.capabilities,
      services: {
        state: { get, create: async () => true },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle(manifest.id, opts);
    try {
      await handle.start();
      expect(
        await handle.call("performAction", {
          key: "legacy",
          companyId: "company-a",
          params: {
            mode: "echo",
            hostMethod: "state.get",
            requestedCompanyId: "company-a",
          },
        }),
      ).toBe("legacy-value");
      expect(get).toHaveBeenCalledOnce();
    } finally {
      await handle.stop();
    }
  });
});
