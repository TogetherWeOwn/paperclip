import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// TOG-7967 H9: the run-end reap block lives inline in heartbeatService's
// executeRun teardown (a ~29k-line service with no seam at that site). This
// source-contract test pins the block's mandatory properties: cancel call
// with system actorContext + company scope, terminal-status gate, and
// never-throws structure. A full executeRun run-through needs embedded
// Postgres + provider fixtures (see test-baselines/lifecycle-heartbeat).
const here = dirname(fileURLToPath(import.meta.url));
const heartbeatSrc = readFileSync(join(here, "../services/heartbeat.ts"), "utf8");

function reapBlock(): string {
  const anchor = "router run-end reap";
  const idx = heartbeatSrc.indexOf(anchor);
  expect(idx).toBeGreaterThan(-1);
  return heartbeatSrc.slice(Math.max(0, idx - 1500), idx + 2500);
}

describe("heartbeat router run-end reap (TOG-7967 H9)", () => {
  it("calls cancel-run-invocations with a system actorContext and company scope", () => {
    const block = reapBlock();
    expect(block).toContain('"cancel-run-invocations"');
    expect(block).toContain('type: "system"');
    expect(block).toContain("companyId: run.companyId");
    expect(block).toContain("togetherweown.paperclip-model-router");
  });

  it("only reaps on terminal status and never throws", () => {
    const block = reapBlock();
    expect(block).toContain("isHeartbeatRunTerminalStatus(latestRun.status)");
    expect(block).toContain(".catch(() => null)");
    expect(block).toContain("orphans linger to TTL");
    // Inner call failure is swallowed with a warn, outer lookup failure too.
    expect(block.match(/\.catch\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("imports the registry service for the router lookup", () => {
    expect(heartbeatSrc).toContain(
      'import { pluginRegistryService } from "./plugin-registry.js";',
    );
  });

  it("emits a bounded success receipt (counts only, no payload passthrough)", () => {
    const block = reapBlock();
    expect(block).toContain("router run-end reap completed");
    expect(block).toContain("toBoundedReapReceipt");
    expect(block).toContain("cancelled");
    expect(block).toContain("alreadyTerminal");
    expect(block).toContain("failed");
    // Only safe run ID plus bounded counts; no prompts, args, or headers.
    expect(block).not.toContain("effectiveParameters");
    expect(block).not.toContain("requestedParameters");
    expect(block).not.toContain("callerHeaders");
  });
});
