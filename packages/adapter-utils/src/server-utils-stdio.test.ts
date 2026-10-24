import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runChildProcess, runningProcesses } from "./server-utils.js";

it.each(
  (["stdin", "stdout", "stderr"] as const).flatMap((stream) =>
    ["EPIPE", "ECONNRESET"].map((code) => ({ stream, code })),
  ),
)("contains $code on child $stream without crashing the host", async ({ stream, code }) => {
  const runId = randomUUID();
  const onLogError = vi.fn();
  const result = runChildProcess(runId, process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(), env: {}, timeoutSec: 0, graceSec: 1,
    stdin: "input", onLog: async () => {}, onLogError,
  });
  try {
    await vi.waitFor(() => expect(runningProcesses.has(runId)).toBe(true));
    const child = runningProcesses.get(runId)!.child;
    const error = Object.assign(new Error("child disconnected"), { code });
    expect(() => child[stream]!.emit("error", error)).not.toThrow();
    expect(onLogError).toHaveBeenCalledWith(error, runId, expect.stringContaining(code));
  } finally {
    runningProcesses.get(runId)?.child.kill("SIGTERM");
    await result;
  }
  expect(runningProcesses.has(runId)).toBe(false);
});
