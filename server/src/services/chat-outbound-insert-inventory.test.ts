import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(name)
      : /\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) ? [name] : [];
  });
}

/** This is a security-boundary inventory, not an assertion about formatting.
 * New writers must use the transactional helper, including local actions:
 * unknown action kinds are outbound by default, never an implicit exemption.
 */
describe("outbound insert inventory", () => {
  it("routes every publication/action insertion through the guarded writer", () => {
    const bypasses: string[] = [];
    let guardedSites = 0;
    for (const file of sourceFiles(sourceRoot)) {
      const text = readFileSync(file, "utf8");
      if (!/chatPublications|chatActions|chat_publications|chat_actions/.test(text)) continue;
      const relative = path.relative(sourceRoot, file);
      const tables = new Set(["chatPublications", "chatActions"]);
      for (const alias of text.matchAll(/\b(chatPublications|chatActions)\s+as\s+(\w+)/g)) tables.add(alias[2]);
      // Cover the repository's direct writer idiom and import aliases. This
      // source inventory is not a JavaScript interpreter: the independent SQL
      // tripwire also rejects dynamic/indirect inserts at the database boundary.
      for (const match of text.matchAll(/\.\s*insert\s*\(\s*(?:\w+\.)?(\w+)\s*\)/g)) {
        if (!tables.has(match[1])) continue;
        if (relative === "services/chat-publication-authority.ts") guardedSites++;
        else bypasses.push(`${relative}:${text.slice(0, match.index).split("\n").length}`);
      }
      if (/insert\s+into\s+["']?(chat_publications|chat_actions)\b/i.test(text)) bypasses.push(`${relative}:raw SQL`);
    }
    expect(bypasses).toEqual([]);
    expect(guardedSites).toBe(2);
  });
});
