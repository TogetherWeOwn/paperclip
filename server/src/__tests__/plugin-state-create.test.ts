import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { createDb, pluginState, plugins } from "@paperclipai/db";
import {
  CapabilityDeniedError,
  createErrorResponse,
  createHostClientHandlers,
  createRequest,
  createSuccessResponse,
  definePlugin,
  type HostClientHandlers,
  InvocationScopeDeniedError,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcResponse,
  parseMessage,
  type ScopeKey,
  serializeMessage,
  startWorkerRpcHost,
  type WorkerToHostMethods,
} from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginStateStore } from "../services/plugin-state-store.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

function requireCreate<T>(create: T | undefined): T {
  if (create === undefined) throw new Error("atomic create unavailable");
  return create;
}

const companyA = randomUUID();
const companyB = randomUUID();
const pluginA = randomUUID();
const pluginB = randomUUID();
const context = { invocationScope: { companyId: companyA } };
const key = (stateKey = randomUUID()): ScopeKey => ({
  scopeKind: "company",
  scopeId: companyA,
  stateKey,
});
const manifest: PaperclipPluginManifestV1 = {
  id: "test.atomic-state",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "State fixture",
  description: "Disposable state fixture",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["plugin.state.read", "plugin.state.write"],
  entrypoints: {},
};

describe("database-atomic plugin state create", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let dbA: ReturnType<typeof createDb>;
  let dbB: ReturnType<typeof createDb>;
  let servicesA: ReturnType<typeof buildHostServices>;
  let servicesB: ReturnType<typeof buildHostServices>;
  let hostA: HostClientHandlers;
  let hostB: HostClientHandlers;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase(
      "paperclip-atomic-state-",
    );
    dbA = createDb(database.connectionString, { maxConnections: 1 });
    dbB = createDb(database.connectionString, { maxConnections: 1 });
    for (const db of [dbA, dbB]) {
      await db.execute(sql`SET statement_timeout = '5s'`);
      await db.execute(sql`SET lock_timeout = '3s'`);
    }
    for (const id of [pluginA, pluginB]) {
      await dbA.insert(plugins).values({
        id,
        pluginKey: `test.state-${id}`,
        packageName: "test-state",
        version: "1.0.0",
        apiVersion: 1,
        categories: ["automation"],
        manifestJson: manifest,
        status: "installed",
        installOrder: 1,
      });
    }
    servicesA = buildHostServices(
      dbA,
      pluginA,
      "test.state-a",
      createPluginEventBus(),
    );
    servicesB = buildHostServices(
      dbB,
      pluginA,
      "test.state-a",
      createPluginEventBus(),
    );
    hostA = createHostClientHandlers({
      pluginId: pluginA,
      capabilities: manifest.capabilities,
      services: servicesA,
    });
    hostB = createHostClientHandlers({
      pluginId: pluginA,
      capabilities: manifest.capabilities,
      services: servicesB,
    });
  }, 60_000);

  afterAll(async () => {
    servicesA?.dispose();
    servicesB?.dispose();
    await database?.cleanup();
  });

  const rows = (stateKey: string) =>
    dbA.select().from(pluginState).where(eq(pluginState.stateKey, stateKey));

  it("uses the migrated NULLS NOT DISTINCT unique index on independent connections", async () => {
    const [a, b] = await Promise.all([
      dbA.execute(sql`SELECT pg_backend_pid() AS pid`),
      dbB.execute(sql`SELECT pg_backend_pid() AS pid`),
    ]);
    expect(a[0].pid).not.toBe(b[0].pid);
    const indexes = await dbA.execute(sql`
      SELECT i.indnullsnotdistinct, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'plugin_state_unique_entry_idx'
    `);
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indnullsnotdistinct).toBe(true);
    expect(indexes[0].definition).toContain(
      "(plugin_id, scope_kind, scope_id, namespace, state_key) NULLS NOT DISTINCT",
    );
  });

  it.each([true, false])(
    "concurrent independent hosts have exactly one winner (same values: %s)",
    async (same) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const input = key();
        const values = [
          { command: "a", digest: "first" },
          { command: same ? "a" : "b", digest: same ? "first" : "second" },
        ];
        const results = await Promise.all([
          requireCreate(hostA["state.create"])(
            { ...input, value: values[0] },
            context,
          ),
          requireCreate(hostB["state.create"])(
            { ...input, value: values[1] },
            context,
          ),
        ]);
        expect([...results].sort()).toEqual([false, true]);
        const before = await rows(input.stateKey);
        expect(before).toHaveLength(1);
        expect(before[0].valueJson).toEqual(values[results.indexOf(true)]);
        expect(
          await requireCreate(hostB["state.create"])(
            { ...input, value: { replacement: true } },
            context,
          ),
        ).toBe(false);
        expect(await rows(input.stateKey)).toEqual(before);
      }
    },
  );

  it("persists the winner after closing a client and rebuilding the host adapter", async () => {
    const input = key();
    const first = createDb(database.connectionString);
    expect(
      await pluginStateStore(first).create(pluginA, {
        ...input,
        value: "durable",
      }),
    ).toBe(true);
    await first.$client.end({ timeout: 1 });
    const reconnected = createDb(database.connectionString);
    const restarted = buildHostServices(
      reconnected,
      pluginA,
      "test.state-a",
      createPluginEventBus(),
    );
    try {
      expect(await restarted.state.get(input)).toBe("durable");
      expect(
        await requireCreate(restarted.state.create)({
          ...input,
          value: "replacement",
        }),
      ).toBe(false);
    } finally {
      restarted.dispose();
      await reconnected.$client.end({ timeout: 1 });
    }
  });

  it("treats stored JSON null as existing and canonicalizes null/omitted scope and namespace", async () => {
    const stateKey = randomUUID();
    const store = pluginStateStore(dbA);
    expect(
      await store.create(pluginA, {
        scopeKind: "instance",
        scopeId: null,
        namespace: null,
        stateKey,
        value: null,
      }),
    ).toBe(true);
    const before = await rows(stateKey);
    expect(before[0].valueJson).toBeNull();
    expect(
      await store.create(pluginA, {
        scopeKind: "instance",
        stateKey,
        value: 2,
      }),
    ).toBe(false);
    expect(
      await store.create(pluginA, {
        scopeKind: "instance",
        namespace: "default",
        stateKey,
        value: 3,
      }),
    ).toBe(false);
    expect(await rows(stateKey)).toEqual(before);
    expect(
      await dbA.execute(
        sql`SELECT value_json IS NULL AS sql_null FROM plugin_state WHERE state_key = ${stateKey}`,
      ),
    ).toMatchObject([{ sql_null: false }]);
  });

  it("keeps companies and host-supplied plugin identities isolated", async () => {
    const input = key();
    expect(
      await requireCreate(hostA["state.create"])(
        { ...input, value: "a" },
        context,
      ),
    ).toBe(true);
    expect(
      await requireCreate(hostA["state.create"])(
        { ...input, scopeId: companyB, value: "b" },
        { invocationScope: { companyId: companyB } },
      ),
    ).toBe(true);
    const other = buildHostServices(
      dbB,
      pluginB,
      "test.state-b",
      createPluginEventBus(),
    );
    try {
      // A synthetic worker's pluginId cannot override the host's bound identity.
      const forged = { ...input, pluginId: pluginA, value: "other-plugin" };
      expect(await requireCreate(other.state.create)(forged)).toBe(true);
      expect(await rows(input.stateKey)).toHaveLength(3);
      expect(await servicesA.state.get(input)).toBe("a");
      expect(await other.state.get(input)).toBe("other-plugin");
    } finally {
      other.dispose();
    }
  });

  it("denies missing write permission and invalid or cross-company invocation scopes before storage", async () => {
    const input = { ...key(), value: "denied" };
    const readOnly = createHostClientHandlers({
      pluginId: pluginA,
      capabilities: ["plugin.state.read"],
      services: servicesA,
    });
    await expect(
      requireCreate(readOnly["state.create"])(input, context),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    for (const scope of [
      undefined,
      { invalidInvocationScope: true },
      { invocationScope: { companyId: companyB } },
    ]) {
      await expect(
        requireCreate(hostA["state.create"])(input, scope),
      ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    }
    for (const scopeId of [undefined, "", " "]) {
      await expect(
        requireCreate(hostA["state.create"])({ ...input, scopeId }, context),
      ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    }
    expect(await rows(input.stateKey)).toEqual([]);
  });

  it("validates scope keys and preserves plugin existence errors", async () => {
    const store = pluginStateStore(dbA);
    const input = { ...key(), value: 1 };
    for (const invalid of [
      { scopeKind: "bogus" },
      { scopeId: "" },
      { namespace: "" },
      { stateKey: "" },
    ]) {
      await expect(
        store.create(pluginA, { ...input, ...invalid }),
      ).rejects.toThrow();
    }
    await expect(store.create(randomUUID(), input)).rejects.toThrow(
      "Plugin not found",
    );
    expect(await rows(input.stateKey)).toEqual([]);
  });

  it("throws on insert and commit errors, never resolving true before commit", async () => {
    await dbA.execute(sql`CREATE FUNCTION atomic_state_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'disposable state failure'; END $$`);
    for (const deferred of [false, true]) {
      const statement = deferred
        ? "CREATE CONSTRAINT TRIGGER atomic_state_failure AFTER INSERT ON plugin_state DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION atomic_state_reject()"
        : "CREATE TRIGGER atomic_state_failure BEFORE INSERT ON plugin_state FOR EACH ROW EXECUTE FUNCTION atomic_state_reject()";
      await dbA.execute(sql.raw(statement));
      const input = key();
      try {
        await expect(
          requireCreate(hostA["state.create"])({ ...input, value: 1 }, context),
        ).rejects.toThrow();
        expect(await rows(input.stateKey)).toEqual([]);
      } finally {
        await dbA.execute(
          sql`DROP TRIGGER atomic_state_failure ON plugin_state`,
        );
      }
    }
    await dbA.execute(sql`DROP FUNCTION atomic_state_reject()`);
  });

  it("round-trips SDK → JSON-RPC → gated host → database and fails closed on a lost committed response", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = createInterface({ input: output });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const stateKey = key();
    const freshKey = key();
    let id = 0;
    let loseResponse = false;
    const worker = startWorkerRpcHost({
      stdin: input,
      stdout: output,
      rpcTimeoutMs: 200,
      plugin: definePlugin({
        async setup(ctx) {
          ctx.actions.register(
            "available",
            async () => typeof ctx.state.create === "function",
          );
          ctx.actions.register("create", async () =>
            requireCreate(ctx.state.create)(stateKey, { immutable: true }),
          );
          ctx.actions.register("fresh", async () =>
            requireCreate(ctx.state.create)(freshKey, null),
          );
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
        expect(message.method).toBe("state.create");
        requireCreate(hostA["state.create"])(
          message.params as WorkerToHostMethods["state.create"][0],
          context,
        ).then(
          (result) => {
            if (!loseResponse)
              input.write(
                serializeMessage(createSuccessResponse(message.id, result)),
              );
          },
          (error: Error) =>
            input.write(
              serializeMessage(
                createErrorResponse(message.id, -32603, error.message),
              ),
            ),
        );
      }
    });
    try {
      await call("initialize", {
        manifest,
        config: {},
        supportedHostMethods: ["state.create"],
      });
      expect(
        await call("performAction", { key: "available", params: {} }),
      ).toBe(true);
      expect(await rows(stateKey.stateKey)).toEqual([]);
      loseResponse = true;
      await expect(
        call("performAction", { key: "create", params: {} }),
      ).rejects.toThrow("timed out");
      const winner = await rows(stateKey.stateKey);
      expect(winner).toHaveLength(1);
      loseResponse = false;
      expect(await call("performAction", { key: "create", params: {} })).toBe(
        false,
      );
      expect(await rows(stateKey.stateKey)).toEqual(winner);
      expect(await call("performAction", { key: "fresh", params: {} })).toBe(
        true,
      );
      expect(await call("performAction", { key: "fresh", params: {} })).toBe(
        false,
      );
    } finally {
      worker.stop();
      reader.close();
      input.destroy();
      output.destroy();
    }
  });
});
