import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBiomeCheckArgs } from "./biome-changed.mjs";

describe("buildBiomeCheckArgs", () => {
  it("passes --no-errors-on-unmatched so skipped-only sets pass", () => {
    const args = buildBiomeCheckArgs([
      "packages/db/src/migrations/meta/0284_snapshot.json",
    ]);
    assert.deepEqual(args, [
      "exec",
      "biome",
      "check",
      "--no-errors-on-unmatched",
      "packages/db/src/migrations/meta/0284_snapshot.json",
    ]);
  });

  it("keeps the flag ahead of every added file", () => {
    const args = buildBiomeCheckArgs(["a.ts", "b.ts"]);
    assert.equal(args.includes("--no-errors-on-unmatched"), true);
    assert.ok(
      args.indexOf("--no-errors-on-unmatched") < args.indexOf("a.ts"),
      `flag must precede files in ${args.join(" ")}`,
    );
  });
});
