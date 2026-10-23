import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  runChildProcess,
  runningProcesses,
  signalRunningProcess,
} from "../server-utils.js";

// Run outside Vitest: an unhandled stdin error must really terminate this parent.
// Every no-reader child has a self-deadline even if its parent crashes.
const mode = process.argv[2];
const prompt = "prompt: hello\n".repeat(65_536);
const options = {
  cwd: process.cwd(),
  env: {},
  timeoutSec: 5,
  graceSec: 0.1,
  stdin: prompt,
  onLog: async () => {},
};

async function closedStdin(exitCode: number, waitForClose: boolean) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const runId = randomUUID();
    let child: NonNullable<ReturnType<typeof runningProcesses.get>>["child"] | undefined;
    const result = await runChildProcess(
      runId,
      process.execPath,
      [
        "-e",
        waitForClose
          ? `require('node:fs').closeSync(0); process.stdout.write('closed\\n'); setTimeout(() => process.exit(${exitCode}), 40);`
          : `process.exit(${exitCode});`,
      ],
      {
        ...options,
        onSpawn: async () => {
          // onSpawn runs before registry insertion; yield before inspecting it.
          await Promise.resolve();
          child = runningProcesses.get(runId)?.child;
          assert.ok(child?.stdout);
          if (waitForClose) {
            // A real fd-close acknowledgement, not a sleep or an injected EPIPE.
            const [chunk] = await once(child.stdout, "data");
            assert.equal(String(chunk), "closed\n", "child did not acknowledge closing fd 0");
          }
        },
      },
    );
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.stderr, "");
    if (waitForClose) assert.equal(result.stdout, "closed\n");
    assert.equal(child?.exitCode, exitCode);
    assert.equal(runningProcesses.has(runId), false, "run registry did not settle");
  }
  console.log(JSON.stringify({ completed: 8, exitCode }));
}

async function interruptedStdin(cancel: boolean) {
  const runId = randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let child: NonNullable<ReturnType<typeof runningProcesses.get>>["child"] | undefined;
  try {
    const result = await runChildProcess(
      runId,
      process.execPath,
      ["-e", "require('node:fs').closeSync(0); process.stdout.write('closed\\n'); setTimeout(() => process.exit(91), 3000);"],
      {
        ...options,
        timeoutSec: cancel ? 5 : 1,
        onSpawn: async () => {
          await Promise.resolve();
          const running = runningProcesses.get(runId);
          assert.ok(running?.child.stdout);
          child = running.child;
          await once(child.stdout!, "data");
          if (cancel) {
            timer = setTimeout(() => signalRunningProcess(running, "SIGTERM"), 50);
          }
        },
      },
    );
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.timedOut, !cancel);
    assert.equal(result.stdout, "closed\n");
    assert.equal(child?.signalCode, "SIGTERM");
    assert.equal(runningProcesses.has(runId), false);
    console.log(JSON.stringify({ interrupted: cancel ? "cancel" : "timeout" }));
  } finally {
    clearTimeout(timer);
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

if (mode === "echo") {
  const runId = randomUUID();
  const ordinaryPrompt = "ordinary stdin: hello 🙂\n";
  const result = await runChildProcess(
    runId,
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout);"],
    { ...options, stdin: ordinaryPrompt },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, ordinaryPrompt);
  assert.equal(result.stderr, "");
  assert.equal(runningProcesses.has(runId), false);
  console.log(JSON.stringify({ bytes: Buffer.byteLength(result.stdout) }));
} else if (mode === "non-pipe") {
  // Real stdin stream; inject only the otherwise non-hermetic OS error.
  // Reporting or rejection are acceptable. Silently swallowing it is not.
  const observed: string[] = [];
  try {
    await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setTimeout(() => process.exit(0), 250);"],
      {
        ...options,
        onLogError: (error) => observed.push(String(error)),
        onSpawn: async ({ pid }) => {
          await Promise.resolve();
          const running = [...runningProcesses.values()].find((entry) => entry.child.pid === pid);
          assert.ok(running?.child.stdin);
          running.child.stdin.destroy(Object.assign(new Error("stdin-non-pipe-sentinel EIO"), { code: "EIO" }));
        },
      },
    );
  } catch (error) {
    observed.push(String(error));
  }
  console.log(JSON.stringify({ observed }));
} else if (mode === "cancel" || mode === "timeout") {
  await interruptedStdin(mode === "cancel");
} else {
  assert.match(mode ?? "", /^(closed|race)-(0|73)$/);
  await closedStdin(mode!.endsWith("-73") ? 73 : 0, mode!.startsWith("closed-"));
}
