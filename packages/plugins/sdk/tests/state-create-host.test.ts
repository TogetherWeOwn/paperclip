import { describe, expect, it, vi } from "vitest";
import {
  createHostClientHandlers,
  type HostServices,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";

const input = {
  scopeKind: "company",
  scopeId: "company-a",
  stateKey: "run-a",
  value: null,
} as const;
const context = { invocationScope: { companyId: "company-a" } };

function requireCreate<T>(create: T | undefined): T {
  if (create === undefined) throw new Error("atomic create unavailable");
  return create;
}

function makeHost(state: unknown) {
  return createHostClientHandlers({
    pluginId: "test.state",
    capabilities: ["plugin.state.write"],
    services: { state } as HostServices,
  });
}

describe("atomic state host adapter compatibility", () => {
  it("does not advertise create for a legacy adapter", () => {
    const handlers = makeHost({ set: vi.fn() });
    expect(handlers["state.create"]).toBeUndefined();
    expect(
      Object.entries(handlers)
        .filter(([, handler]) => typeof handler === "function")
        .map(([method]) => method),
    ).not.toContain("state.create");
  });

  it.each([null, undefined, 0, 1, "true", {}])(
    "rejects a non-boolean adapter result %j",
    async (result) => {
      const handlers = makeHost({ create: async () => result });
      await expect(
        requireCreate(handlers["state.create"])(input, context),
      ).rejects.toThrow("non-boolean");
    },
  );

  it.each([" %s", "%s ", "\t%s\n"])(
    "rejects a padded company scope %j before calling the adapter",
    async (padding) => {
      const companyId = "4b940f0f-5cc4-46ea-8ab8-a278bccf8c88";
      const create = vi.fn(async () => true);
      const handlers = makeHost({ create });
      await expect(
        requireCreate(handlers["state.create"])(
          { ...input, scopeId: padding.replace("%s", companyId) },
          { invocationScope: { companyId } },
        ),
      ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("preserves legacy set company-scope handling", async () => {
    const set = vi.fn(async () => {});
    const handlers = makeHost({ set });
    const padded = { ...input, scopeId: " company-a " };
    await handlers["state.set"](padded, context);
    expect(set).toHaveBeenCalledExactlyOnceWith(padded);
  });

  it("passes an exactly authorized company key to the adapter unchanged", async () => {
    const create = vi.fn(async () => true);
    const handlers = makeHost({ create });
    await expect(
      requireCreate(handlers["state.create"])(input, context),
    ).resolves.toBe(true);
    expect(create).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("cannot authorize another company's key using an extraneous companyId", async () => {
    const create = vi.fn(async () => true);
    const handlers = makeHost({ create });
    const forged = { ...input, scopeId: "company-b", companyId: "company-a" };
    await expect(
      requireCreate(handlers["state.create"])(forged, context),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(create).not.toHaveBeenCalled();
  });
});
