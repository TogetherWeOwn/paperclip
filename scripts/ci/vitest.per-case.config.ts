import { fileURLToPath } from "node:url";

import { defineConfig, type UserConfig } from "vitest/config";

import serverConfig from "../../server/vitest.config.ts";

// Server-project-only config for the per-case evidence run. The root config
// declares `projects`, and vitest 5 does not forward CLI --setupFiles into
// declared projects, so the probe must be wired here in config instead. The
// server project's existing setup (setup-supertest.ts) is chained first, then
// the probe setup writes probe.json. Root is the server directory so the
// server config's include globs and relative setupFiles keep resolving as
// declared.
const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const probeSetup = fileURLToPath(new URL("../../server/src/__tests__/per-case-probe-setup.mjs", import.meta.url));

const base = serverConfig as unknown as UserConfig;

export default defineConfig({
  ...base,
  root: serverRoot,
  test: {
    ...base.test,
    setupFiles: [...((base.test?.setupFiles as string[] | undefined) ?? []), probeSetup],
  },
});
