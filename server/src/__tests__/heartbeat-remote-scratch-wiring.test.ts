import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The remote-scratch dispatch wiring lives inline in
// heartbeatService's executeRun (a ~31k-line service with no seam at that
// site: the environment orchestrator is constructed inline from the DB, so a
// full executeRun run-through would need embedded Postgres plus
// remote-transport fixtures). Provision/cleanup behavior is covered by
// executed unit tests against a fake remote shell
// (server/src/services/run-scratch-remote.test.ts); this source-contract
// test pins the heartbeat call sites the same way
// heartbeat-router-run-end-reap.test.ts does: dispatch provisions scratch
// through the extracted unit with a location derived from the target kind,
// terminal cleanup runs for remote targets above the native-session guard,
// and cleanup precedes the environment lease release.
const here = dirname(fileURLToPath(import.meta.url));
const heartbeatSrc = readFileSync(
  join(here, "../services/heartbeat.ts"),
  "utf8",
);

const REMOTE_CLEANUP_CALL = "cleanupRemoteHeartbeatRunScratch(";
const REMOTE_KIND_CHECK = 'runScratchTarget?.kind === "remote"';
const MAIN_NATIVE_GUARD = [
  "if (",
  "          !nativeSessionResumeScheduled &&",
  "          !nativeWorkspaceFinalizeScheduled &&",
  "          !nativeOwnershipHeld",
  "        ) {",
].join("\n");
const TEARDOWN_ANCHOR =
  "\n          providerResourceDispositionForTerminalRun(\n";

function teardownRegion(): string {
  const start = heartbeatSrc.indexOf(TEARDOWN_ANCHOR);
  expect(start).toBeGreaterThan(-1);
  return heartbeatSrc.slice(start);
}

describe("heartbeat remote run scratch wiring", () => {
  it("dispatches scratch provisioning through the extracted unit with a location derived from the target kind", () => {
    expect(heartbeatSrc).toContain("provisionHeartbeatRunScratch(");
    expect(heartbeatSrc).toContain('? "local" : "remote"');
    expect(heartbeatSrc).toContain("provisionedScratch.env");
    expect(heartbeatSrc).toContain(
      "Remote scratch provisioning requires a remote execution target.",
    );
  });

  it("continues without scratch env when provisioning fails, for both locations", () => {
    expect(heartbeatSrc).toContain(
      "failed to prepare remote heartbeat run scratch directory; continuing without scratch env",
    );
    expect(heartbeatSrc).toContain(
      "failed to prepare heartbeat run scratch directory; continuing without scratch env",
    );
    expect(heartbeatSrc).toContain("delete context.paperclipScratch");
  });

  it("cleans remote scratch above the native-session guard so terminal native runs cannot leak the run dir", () => {
    const region = teardownRegion();
    const cleanupIdx = region.indexOf(REMOTE_KIND_CHECK);
    const guardIdx = region.indexOf(MAIN_NATIVE_GUARD);
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(guardIdx);
  });

  it("gates remote cleanup on terminal status and runs it before the environment lease release", () => {
    const region = teardownRegion();
    const cleanupIdx = region.indexOf(REMOTE_CLEANUP_CALL);
    expect(cleanupIdx).toBeGreaterThan(-1);
    const block = region.slice(Math.max(0, cleanupIdx - 600), cleanupIdx + 200);
    expect(block).toContain("isHeartbeatRunTerminalStatus(latestRun.status)");
    expect(block).toContain(REMOTE_KIND_CHECK);
    const releaseIdx = region.indexOf("await releaseEnvironmentLeasesForRun({");
    expect(releaseIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(releaseIdx);
  });

  it("keeps local fs cleanup away from remote paths", () => {
    expect(heartbeatSrc).toContain("!runScratchTarget");
  });
});
