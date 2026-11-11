import { existsSync, writeFileSync } from "node:fs";
import { getEmbeddedPostgresTestSupport } from "@paperclipai/db";

// Writes the runner capability probes the four scoped suites guard on.
// pg: the real check the receipt/accounting suites use (getEmbeddedPostgresTestSupport).
// sandbox: byte-identical to workspaceCommandSandboxAvailable in
// server/src/services/native-runtime/runner-bridge-tools.ts.
const pg = await getEmbeddedPostgresTestSupport();
const probe = {
  pg: pg.supported ? { supported: true } : { supported: false, reason: pg.reason ?? "unknown" },
  sandbox: { available: process.platform === "linux" && existsSync("/usr/bin/bwrap") },
  at: new Date().toISOString(),
};
writeFileSync(process.env.PER_CASE_PROBE_OUT ?? "probe.json", JSON.stringify(probe, null, 2) + "\n");
