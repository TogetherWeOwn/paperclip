import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "issue_override_env_merge_capture";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue override env merge tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TEST_ENV_KEYS = ["PAPERCLIP_HOME", "PAPERCLIP_API_URL"] as const;

function snapshotEnv(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, env[key]]));
}

function restoreEnvSnapshot(
  env: Record<string, string | undefined>,
  snapshot: Map<string, string | undefined>,
  written: ReadonlySet<string>,
): void {
  // Restore only the keys this fixture actually wrote, so a setup failure
  // can never delete an original value that was never captured or written.
  for (const key of written) {
    const original = snapshot.get(key);
    if (original === undefined) delete env[key];
    else env[key] = original;
  }
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

type EnvMergeFixtureDb = {
  connectionString: string;
  cleanup: () => Promise<void>;
};

type EnvMergeFixtureDeps = {
  createDatabase: (prefix: string) => Promise<EnvMergeFixtureDb>;
  createDbClient: (connectionString: string) => ReturnType<typeof createDb>;
  makeHomeDir: () => Promise<string>;
  removeHomeDir: (home: string) => Promise<void>;
  registerAdapter: () => void;
  unregisterAdapter: () => void;
  env: Record<string, string | undefined>;
};

type EnvMergeFixtureState = {
  db: ReturnType<typeof createDb> | null;
  tempDb: EnvMergeFixtureDb | null;
  paperclipHome: string | null;
  adapterRegistered: boolean;
  savedEnv: Map<string, string | undefined>;
  writtenEnvKeys: Set<string>;
  // Set by teardown before disposing. Setup work that is still in flight
  // must clean a late resource instead of publishing it, because a Vitest
  // timeout does not cancel the timed-out async callback.
  tornDown: boolean;
};

function newEnvMergeFixtureState(
  savedEnv: Map<string, string | undefined>,
  writtenEnvKeys: Set<string>,
): EnvMergeFixtureState {
  return {
    db: null,
    tempDb: null,
    paperclipHome: null,
    adapterRegistered: false,
    savedEnv,
    writtenEnvKeys,
    tornDown: false,
  };
}

function lateFixtureError(stage: string): Error {
  return new Error(
    `env-merge fixture setup finished ${stage} after teardown; late resource cleaned up instead of published`,
  );
}

async function setupEnvMergeFixture(
  deps: EnvMergeFixtureDeps,
  state: EnvMergeFixtureState,
): Promise<void> {
  const setTestEnv = (key: string, value: string): void => {
    state.writtenEnvKeys.add(key);
    deps.env[key] = value;
  };
  // Teardown already ran: release what setup still holds without publishing
  // anything new. State fields published before the late step were disposed
  // by teardown, so only clean what is still held here.
  const abandonLateSetup = async (stage: string): Promise<never> => {
    restoreEnvSnapshot(deps.env, state.savedEnv, state.writtenEnvKeys);
    const home = state.paperclipHome;
    state.paperclipHome = null;
    if (home !== null) {
      await deps.removeHomeDir(home).catch(() => undefined);
    }
    const pendingDb = state.tempDb;
    state.tempDb = null;
    state.db = null;
    if (pendingDb !== null) {
      await pendingDb.cleanup();
    }
    throw lateFixtureError(stage);
  };
  try {
    const tempDb = await deps.createDatabase("heartbeat-issue-override-env-merge-");
    if (state.tornDown) {
      await tempDb.cleanup();
      throw lateFixtureError("database creation");
    }
    state.tempDb = tempDb;
    state.db = deps.createDbClient(tempDb.connectionString);
    const home = await deps.makeHomeDir();
    if (state.tornDown) {
      await deps.removeHomeDir(home).catch(() => undefined);
      return abandonLateSetup("home-directory creation");
    }
    state.paperclipHome = home;
    setTestEnv("PAPERCLIP_HOME", home);
    // The server normalizes PAPERCLIP_API_URL into its own env at boot
    // (server/src/index.ts); heartbeat gateway delivery requires it, so pin
    // a deterministic value for tests that never boot the full server.
    setTestEnv("PAPERCLIP_API_URL", "http://127.0.0.1:3100/api");
    if (state.tornDown) {
      return abandonLateSetup("environment publication");
    }
    deps.registerAdapter();
    state.adapterRegistered = true;
    if (state.tornDown) {
      try {
        deps.unregisterAdapter();
      } catch {
        // Keep disposing; teardown already ran, so report the late setup,
        // not an unregister failure.
      }
      state.adapterRegistered = false;
      return abandonLateSetup("adapter registration");
    }
  } catch (error) {
    restoreEnvSnapshot(deps.env, state.savedEnv, state.writtenEnvKeys);
    throw error;
  }
}

async function teardownEnvMergeFixture(
  deps: EnvMergeFixtureDeps,
  state: EnvMergeFixtureState,
): Promise<void> {
  // Mark disposal first so setup work that is still in flight cleans its
  // late resources instead of publishing them (see setupEnvMergeFixture).
  state.tornDown = true;
  let teardownError: unknown = null;
  const noteError = (error: unknown): void => {
    if (teardownError === null) teardownError = error;
  };
  if (state.adapterRegistered) {
    state.adapterRegistered = false;
    try {
      deps.unregisterAdapter();
    } catch (error) {
      noteError(error);
    }
  }
  restoreEnvSnapshot(deps.env, state.savedEnv, state.writtenEnvKeys);
  const home = state.paperclipHome;
  state.paperclipHome = null;
  if (home !== null) {
    try {
      await deps.removeHomeDir(home);
    } catch (error) {
      // Keep disposing: the database cleanup below must run even when home
      // removal fails. The home error is rethrown after disposal below.
      noteError(error);
    }
  }
  const tempDb = state.tempDb;
  state.tempDb = null;
  state.db = null;
  if (tempDb !== null) {
    try {
      await tempDb.cleanup();
    } catch (error) {
      noteError(error);
    }
  }
  if (teardownError !== null) throw teardownError;
}

describeEmbeddedPostgres("heartbeat issue override env merge", () => {
  let db!: ReturnType<typeof createDb>;
  // Captured before any fallible setup so a startup failure restores (and
  // never deletes) the original process settings.
  const savedEnv = snapshotEnv(process.env, TEST_ENV_KEYS);
  const writtenEnvKeys = new Set<string>();
  const capturedRuns: Array<{ config: Record<string, unknown>; ctxIssueId: unknown }> = [];
  const fixtureState = newEnvMergeFixtureState(savedEnv, writtenEnvKeys);
  const fixtureDeps: EnvMergeFixtureDeps = {
    createDatabase: (prefix) => startEmbeddedPostgresTestDatabase(prefix),
    createDbClient: (connectionString) => createDb(connectionString),
    makeHomeDir: () => fs.mkdtemp(path.join(os.tmpdir(), "paperclip-issue-env-merge-home-")),
    removeHomeDir: (home) => fs.rm(home, { recursive: true, force: true }),
    registerAdapter: () => {
      registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async (ctx) => {
        capturedRuns.push({
          config: ctx.config as Record<string, unknown>,
          ctxIssueId: (ctx.context as Record<string, unknown> | undefined)?.["issueId"] ?? null,
        });
        await ctx.onLog("stdout", "captured issue env merge\n");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          label: "Captured issue env merge",
        };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
      });
    },
    unregisterAdapter: () => {
      unregisterServerAdapter(TEST_ADAPTER_TYPE);
    },
    env: process.env as unknown as Record<string, string | undefined>,
  };

  beforeAll(async () => {
    await setupEnvMergeFixture(fixtureDeps, fixtureState);
    db = fixtureState.db!;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    capturedRuns.length = 0;
    await heartbeatService(db).drainActiveRunExecutions();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "issues",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await teardownEnvMergeFixture(fixtureDeps, fixtureState);
  }, 30_000);

  async function seedAgentWithIssue(opts: {
    agentEnv: Record<string, unknown>;
    overrideAdapterConfig: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Env Merge",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: { env: opts.agentEnv },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Env merge probe",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      assigneeAdapterOverrides: { adapterConfig: opts.overrideAdapterConfig },
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  function configForIssue(issueId: string): Record<string, unknown> {
    // A wake can dispatch a follow-up run for a previous issue that only
    // reaches the adapter after teardown, so match captures by issue.
    const found = capturedRuns.find((run) => run.ctxIssueId === issueId);
    expect(found, `expected an adapter execution for issue ${issueId}`).toBeDefined();
    return found!.config;
  }

  it("delivers both agent and issue override env keys to the adapter", async () => {
    const { agentId, issueId } = await seedAgentWithIssue({
      agentEnv: { HEARTBEAT_MERGE_BASE: "base-value" },
      overrideAdapterConfig: { env: { HEARTBEAT_MERGE_OVERRIDE: "override-value" } },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    expect(run).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, run!.id))?.status).toBe("succeeded");

    const env = configForIssue(issueId)["env"] as Record<string, unknown>;
    // The issue override adds a key while the agent key survives the merge.
    // Reverting the executeRun call site to the plain spread drops
    // HEARTBEAT_MERGE_BASE and fails this assertion.
    expect(env["HEARTBEAT_MERGE_BASE"]).toBe("base-value");
    expect(env["HEARTBEAT_MERGE_OVERRIDE"]).toBe("override-value");
  });

  it("preserves an explicit null override env as a clearing operation", async () => {
    const { agentId, issueId } = await seedAgentWithIssue({
      agentEnv: { HEARTBEAT_MERGE_BASE: "base-value" },
      overrideAdapterConfig: { env: null },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    expect(run).not.toBeNull();
    expect((await waitForRunToFinish(heartbeat, run!.id))?.status).toBe("succeeded");

    const env = configForIssue(issueId)["env"] as Record<string, unknown>;
    // Clearing drops every agent/issue env key through runtime secret
    // resolution: no inherited agent key may reappear. Host-injected
    // operational vars (PAPERCLIP_*, GIT_CONFIG_GLOBAL, ...) are a separate
    // layer and are not part of this contract.
    expect(Object.keys(env ?? {}).filter((key) => key.startsWith("HEARTBEAT"))).toEqual([]);
  });

  it("fails the run before the adapter executes when the base carries several spellings", async () => {
    const { agentId, issueId } = await seedAgentWithIssue({
      agentEnv: {
        API_TOKEN: "base-value",
        api_token: "shadow-value",
      },
      overrideAdapterConfig: { env: { API_TOKEN: "replacement" } },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, taskId: issueId }, "manual");
    expect(run).not.toBeNull();
    // The ambiguous alias group rejects at the merge boundary, so the run
    // fails with the alias-conflict cause instead of executing. Both bindings
    // are valid plain values: without the guard the merge would succeed and
    // reach the adapter, so a failure here is the guard working, not
    // downstream binding validation failing for another reason.
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    expect(finished?.status).toBe("failed");
    const failureText = `${finished?.error ?? ""} ${JSON.stringify(finished?.resultJson ?? {})}`;
    expect(failureText).toMatch(/conflicts with agent env keys?/);
    expect(capturedRuns.find((candidate) => candidate.ctxIssueId === issueId)).toBeUndefined();
  });

  it("restores only env keys actually written when setup fails", () => {
    // Runs against a fake env object so the diagnostic never touches the
    // real process settings.
    const fakeEnv: Record<string, string | undefined> = {
      PAPERCLIP_HOME: "/orig/home",
      PAPERCLIP_API_URL: "https://orig.example",
    };
    // A startup failure before any write leaves every original in place.
    const beforeStartup = snapshotEnv(fakeEnv, TEST_ENV_KEYS);
    restoreEnvSnapshot(fakeEnv, beforeStartup, new Set());
    expect(fakeEnv).toEqual({
      PAPERCLIP_HOME: "/orig/home",
      PAPERCLIP_API_URL: "https://orig.example",
    });
    // A mkdtemp failure after the first write restores the written home
    // while the never-written API URL keeps its original value.
    fakeEnv.PAPERCLIP_HOME = "/tmp/partial-home";
    restoreEnvSnapshot(fakeEnv, beforeStartup, new Set(["PAPERCLIP_HOME"]));
    expect(fakeEnv.PAPERCLIP_HOME).toBe("/orig/home");
    expect(fakeEnv.PAPERCLIP_API_URL).toBe("https://orig.example");
    // A written key that was originally absent is removed again.
    const emptyEnv: Record<string, string | undefined> = {};
    const emptySnapshot = snapshotEnv(emptyEnv, TEST_ENV_KEYS);
    emptyEnv.PAPERCLIP_HOME = "/tmp/other-home";
    restoreEnvSnapshot(emptyEnv, emptySnapshot, new Set(["PAPERCLIP_HOME"]));
    expect("PAPERCLIP_HOME" in emptyEnv).toBe(false);
    expect("PAPERCLIP_API_URL" in emptyEnv).toBe(false);
  });
});

describe("issue override env merge fixture lifecycle", () => {
  // Fault-injection checks on the actual setup/teardown hooks above, with
  // synthetic doubles and a fake env object. These never touch a database,
  // the real process settings, or the adapter registry, so they always run.
  function fakeFixture(initialEnv: Record<string, string | undefined> = {}) {
    const env = { ...initialEnv };
    const calls = {
      dbCleanups: 0,
      homeRemovals: [] as string[],
      adapterRegistrations: 0,
      adapterUnregistrations: 0,
      clientsCreated: 0,
    };
    const deps: EnvMergeFixtureDeps = {
      createDatabase: async () => ({
        connectionString: "postgres://fake-isolated/test",
        cleanup: async () => {
          calls.dbCleanups += 1;
        },
      }),
      createDbClient: () => {
        calls.clientsCreated += 1;
        return {} as ReturnType<typeof createDb>;
      },
      makeHomeDir: async () => "/fake/paperclip-home",
      removeHomeDir: async (home: string) => {
        calls.homeRemovals.push(home);
      },
      registerAdapter: () => {
        calls.adapterRegistrations += 1;
      },
      unregisterAdapter: () => {
        calls.adapterUnregistrations += 1;
      },
      env,
    };
    const state = newEnvMergeFixtureState(snapshotEnv(env, TEST_ENV_KEYS), new Set<string>());
    return { env, calls, deps, state };
  }

  it("cleans a database that arrives after teardown and publishes nothing", async () => {
    const { env, calls, deps, state } = fakeFixture();
    let resolveDatabase!: (db: EnvMergeFixtureDb) => void;
    const databaseGate = new Promise<EnvMergeFixtureDb>((resolve) => {
      resolveDatabase = resolve;
    });
    const blockingDeps: EnvMergeFixtureDeps = {
      ...deps,
      createDatabase: () => databaseGate,
      createDbClient: () => {
        throw new Error("must not create a client for a database that arrived after teardown");
      },
      makeHomeDir: async () => {
        throw new Error("must not create a home directory after teardown");
      },
      removeHomeDir: async () => {
        throw new Error("must not remove a home directory that was never created");
      },
    };
    const setupPromise = setupEnvMergeFixture(blockingDeps, state);
    await teardownEnvMergeFixture(blockingDeps, state);
    resolveDatabase({
      connectionString: "postgres://fake-isolated/late",
      cleanup: async () => {
        calls.dbCleanups += 1;
      },
    });
    await expect(setupPromise).rejects.toThrow(/after teardown/);
    expect(calls.dbCleanups).toBe(1);
    expect(calls.adapterRegistrations).toBe(0);
    expect(state.tempDb).toBeNull();
    expect(state.db).toBeNull();
    expect(state.paperclipHome).toBeNull();
    expect(state.adapterRegistered).toBe(false);
    expect(env).toEqual({});
  });

  it("cleans a home directory that arrives after teardown without publishing env or adapter state", async () => {
    const { env, calls, deps, state } = fakeFixture({ PAPERCLIP_HOME: "/orig/home" });
    let resolveHome!: (home: string) => void;
    const homeGate = new Promise<string>((resolve) => {
      resolveHome = resolve;
    });
    const blockingDeps: EnvMergeFixtureDeps = { ...deps, makeHomeDir: () => homeGate };
    const setupPromise = setupEnvMergeFixture(blockingDeps, state);
    // Let setup acquire the database so it is waiting on the home gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await teardownEnvMergeFixture(blockingDeps, state);
    expect(calls.dbCleanups).toBe(1);
    resolveHome("/late/paperclip-home");
    await expect(setupPromise).rejects.toThrow(/after teardown/);
    // No double cleanup of the database teardown already disposed.
    expect(calls.dbCleanups).toBe(1);
    expect(calls.homeRemovals).toEqual(["/late/paperclip-home"]);
    expect(calls.adapterRegistrations).toBe(0);
    expect(state.tempDb).toBeNull();
    expect(state.db).toBeNull();
    expect(state.paperclipHome).toBeNull();
    expect(env).toEqual({ PAPERCLIP_HOME: "/orig/home" });
  });

  it("still cleans the database when home removal fails", async () => {
    const { env, calls, deps, state } = fakeFixture({
      PAPERCLIP_HOME: "/orig/home",
      PAPERCLIP_API_URL: "https://orig.example",
    });
    const failingDeps: EnvMergeFixtureDeps = {
      ...deps,
      // Synthetic EACCES at the exact home-removal hook.
      removeHomeDir: async () => {
        throw Object.assign(new Error("EACCES: permission denied, rmdir '/fake/home'"), {
          code: "EACCES",
        });
      },
    };
    await setupEnvMergeFixture(failingDeps, state);
    expect(state.adapterRegistered).toBe(true);
    await expect(teardownEnvMergeFixture(failingDeps, state)).rejects.toThrow(/EACCES/);
    expect(calls.adapterUnregistrations).toBe(1);
    expect(calls.dbCleanups).toBe(1);
    expect(env).toEqual({
      PAPERCLIP_HOME: "/orig/home",
      PAPERCLIP_API_URL: "https://orig.example",
    });
    expect(state.tempDb).toBeNull();
    expect(state.db).toBeNull();
    expect(state.paperclipHome).toBeNull();
    expect(state.adapterRegistered).toBe(false);
  });
});
