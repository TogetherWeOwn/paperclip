import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import serverConfig from "../../server/vitest.config.ts";

// Preserve the server suite's existing deadlines and real module aliases.
// This opt-in diagnostic requires the sanitized launcher, not a live-run env.
export default defineConfig({
  ...serverConfig,
  test: {
    ...serverConfig.test,
    include: [
      fileURLToPath(
        new URL(
          "../../server/src/__tests__/signoff-http-admission.acceptance.ts",
          import.meta.url,
        ),
      ),
    ],
    setupFiles: [
      fileURLToPath(
        new URL(
          "../../server/src/__tests__/setup-supertest.ts",
          import.meta.url,
        ),
      ),
    ],
  },
});
