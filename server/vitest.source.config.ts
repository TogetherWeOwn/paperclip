import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import serverConfig from "./vitest.config.js";

const sourceConfig = JSON.parse(
  fs.readFileSync(new URL("./tsconfig.source.json", import.meta.url), "utf8"),
) as { compilerOptions: { paths: Record<string, [string]> } };

// Use the same development-only entry points as the compiler. Production
// package exports and the production build configuration stay unchanged.
export default mergeConfig(
  serverConfig,
  defineConfig({
    resolve: {
      alias: Object.entries(sourceConfig.compilerOptions.paths).map(
        ([name, [source]]) => ({
          find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
          replacement: fileURLToPath(new URL(source, import.meta.url)),
        }),
      ),
    },
  }),
);
