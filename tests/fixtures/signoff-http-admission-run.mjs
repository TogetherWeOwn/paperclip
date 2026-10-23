import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Deliberately allowlist environment, rather than inheriting a live run's keys,
// database URLs, config paths, NODE_OPTIONS, GitHub wrapper or agent launcher.
const scratch =
  process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR;
if (!scratch || !path.isAbsolute(scratch)) {
  throw new Error(
    "Set PAPERCLIP_RUN_SCRATCH_DIR to an exclusively owned absolute directory",
  );
}
const original = readFileSync("tests/e2e/signoff-policy.spec.ts");
if (
  createHash("sha256").update(original).digest("hex") !==
  "a371ac27fc7147ba6b1be017333b5b2ca21df678f75f5f110e45311685c7d58b"
) {
  throw new Error("Original signoff source changed; refusing diagnostic");
}
const safePath = "/usr/local/bin:/usr/bin:/bin";
const sourceHead = spawnSync("git", ["rev-parse", "HEAD"], {
  env: { PATH: safePath },
  encoding: "utf8",
});
if (sourceHead.status !== 0) throw new Error("Cannot verify source HEAD");
const productDiff = spawnSync(
  "git",
  [
    "diff",
    "--name-only",
    "28211c5be108f5aa3beb1399141038486e20e0eb",
    "--",
    ".",
    ":(exclude)server/src/__tests__/**",
    ":(exclude)tests/**",
  ],
  {
    env: { PATH: safePath },
    encoding: "utf8",
  },
);
if (productDiff.status !== 0 || productDiff.stdout.trim()) {
  throw new Error(
    "Diagnostic must use the exact product base, with test-only additions",
  );
}
const home = path.join(scratch, "http-admission-home");
mkdirSync(home, { recursive: true });
const env = {
  PATH: safePath,
  HOME: home,
  TMPDIR: scratch,
  NODE_ENV: "test",
  PAPERCLIP_HOME: home,
  PAPERCLIP_CONFIG: path.join(home, "nonexistent-config.json"),
  PAPERCLIP_INSTANCE_ID: "http-admission-diagnostic",
  PAPERCLIP_DISABLE_DOTENV: "true",
  PAPERCLIP_AGENT_JWT_SECRET: "disposable-http-admission-jwt-secret",
  PAPERCLIP_DECISION_SIGNING_SECRET:
    "disposable-http-admission-decision-secret",
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "disposable-http-admission-tool-secret",
  PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
  PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
  PAPERCLIP_TELEMETRY_ENABLED: "false",
  RUN_LOG_BASE_PATH: path.join(home, "run-logs"),
  SIGNOFF_HTTP_SOURCE_HEAD: sourceHead.stdout.trim(),
  SIGNOFF_HTTP_TRACE: path.join(scratch, "http-admission-trace.jsonl"),
};
const build = spawnSync(
  process.execPath,
  ["scripts/ensure-plugin-build-deps.mjs"],
  {
    env,
    stdio: "inherit",
    timeout: 120_000,
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config=tests/fixtures/signoff-http-admission.config.ts",
    "--maxWorkers=1",
    "--no-file-parallelism",
  ],
  { env, stdio: "inherit", timeout: 180_000 },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
