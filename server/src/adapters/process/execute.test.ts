import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import * as utils from "../utils.js";
import { execute } from "./execute.js";

function ctxWithConfig(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-pid-seam",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent",
      adapterType: "process",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: async () => {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("process adapter per-run PID limit", () => {
  it("forwards config.runPidLimit to the child and carries pidStats", async () => {
    const runChildProcessSpy = vi
      .spyOn(utils, "runChildProcess")
      .mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "hi\n",
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
      });

    const result = await execute(
      ctxWithConfig({
        command: "echo",
        args: ["hi"],
        runPidLimit: 200,
      }),
    );

    expect(runChildProcessSpy).toHaveBeenCalledWith(
      "run-pid-seam",
      "echo",
      ["hi"],
      expect.objectContaining({ pidLimit: 200 }),
    );
    const resultJson = result.resultJson as {
      pidStats?: { limit: number; exceeded: boolean };
    };
    expect(resultJson.pidStats?.limit).toBe(200);
    expect(resultJson.pidStats?.exceeded).toBe(false);
    expect(result.errorCode ?? null).toBeNull();
  });

  it("fails with the typed code for the signal-kill shape", async () => {
    vi.spyOn(utils, "runChildProcess").mockResolvedValue({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "[paperclip] run PID limit exceeded: 600 over the 512 budget\n",
      pid: 4243,
      startedAt: new Date().toISOString(),
      errorCode: "run_pid_limit_exceeded",
      pidStats: {
        limit: 512,
        peak: 600,
        lastCount: 600,
        enforced: "poll",
        exceeded: true,
      },
    });

    const result = await execute(ctxWithConfig({ command: "echo" }));

    expect(result.errorCode).toBe("run_pid_limit_exceeded");
    expect(result.errorMessage).toContain("PID limit");
    expect(result.signal).toBe("SIGTERM");
    const resultJson = result.resultJson as {
      pidStats?: { exceeded: boolean };
    };
    expect(resultJson.pidStats?.exceeded).toBe(true);
  });

  it("fails with the typed code when a trapped SIGTERM exits nonzero-safe", async () => {
    vi.spyOn(utils, "runChildProcess").mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "[paperclip] run PID limit exceeded\n",
      pid: 4244,
      startedAt: new Date().toISOString(),
      errorCode: "run_pid_limit_exceeded",
      pidStats: {
        limit: 512,
        peak: 600,
        lastCount: 33,
        enforced: "poll",
        exceeded: true,
      },
    });

    const result = await execute(ctxWithConfig({ command: "echo" }));

    expect(result.errorCode).toBe("run_pid_limit_exceeded");
    expect(result.errorMessage).toContain("PID limit");
  });
});
