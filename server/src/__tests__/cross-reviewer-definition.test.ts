import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const definitionUrl = new URL(
  "../../../.claude/agents/cross-reviewer.md",
  import.meta.url,
);

// Source contract only; runtime discovery and model routing need separate proof.
describe("canonical cross-reviewer definition", () => {
  it("preserves the exact canonical bytes", () => {
    const bytes = readFileSync(definitionUrl);

    expect(bytes.byteLength).toBe(764);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "1ee1bfd0af549abf78913a4036212b40c38927607f99fce95ee8c69100adc9fa",
    );
  });

  it("declares the canonical name, model and tool list in frontmatter", () => {
    const definition = readFileSync(definitionUrl, "utf8");
    const frontmatter = definition.match(/^---\n([\s\S]*?)\n---\n/);

    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.[1]).toMatch(/^name: cross-reviewer$/m);
    expect(frontmatter?.[1]).toMatch(/^model: gpt-6\.1-sol$/m);
    expect(frontmatter?.[1]).toMatch(/^tools: Read, Grep, Glob, Bash$/m);
  });

  it("explicitly restricts Bash to read-only review commands", () => {
    const definition = readFileSync(definitionUrl, "utf8");

    expect(definition).toContain(
      "- Read-only. Use Bash only for read-only commands (git diff/log/show, rg, running existing tests).",
    );
  });
});
