/**
 * Per-run PID budget wiring in the hermes-local adapter.
 *
 * Pins config.runPidLimit reaching runChildProcess() as pidLimit and the
 * resulting pidStats reaching resultJson, mirroring the process-adapter seam
 * test. (Hermes is not in the root vitest projects list, so this runs at the
 * package level via `pnpm --filter <hermes> test`.)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
      pidStats: {
        limit: 200,
        peak: 1,
        lastCount: 1,
        enforced: "poll",
        exceeded: false,
      },
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: "test-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
      ...overrides,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  } satisfies Record<string, unknown>;
}

describe("hermes-local adapter per-run PID limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards config.runPidLimit to the child and carries pidStats", async () => {
    const ctx = makeCtx({ runPidLimit: 200 });

    const result = await execute(ctx as any);

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked).toHaveBeenCalled();
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1]!;
    expect(lastCall[3]).toMatchObject({ pidLimit: 200 });
    const resultJson = result.resultJson as {
      pidStats?: { limit: number; exceeded: boolean };
    };
    expect(resultJson.pidStats?.limit).toBe(200);
    expect(resultJson.pidStats?.exceeded).toBe(false);
  });
});
