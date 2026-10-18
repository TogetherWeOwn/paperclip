import { describe, expect, it } from "vitest";
import { createGitHubPrimaryVisibility } from "../services/chat-github-primary-blinding.js";

describe("primary visibility set matching", () => {
  const uuid = "5af20000-cafe-4000-8000-000000000001";
  const tokens = new Set([uuid, "TOG-2", "TEAM.2", "literal[3]", "ÉQUIPE-2", "STRAßE-2"]);
  const visibility = createGitHubPrimaryVisibility(tokens, ["candidate-agent"]);

  it.each([uuid, uuid.toUpperCase(), `/api/issues/${uuid}`, "/issues/TOG-2?full=true", "%54OG%2D2", "[TEAM.2]", "literal[3]", `bad%escape/${uuid}`, `K${uuid}`, `${uuid}K`])("hides a whole reference: %s", text => {
    expect(() => visibility.assertVisible(text)).toThrow(/not found/i);
    expect(visibility.filter(text)).toBeUndefined();
  });
  it.each(["TOG-20", "prefix_TOG-2", `${uuid}-suffix`, `prefix${uuid}`, "TEAMx2", "literal3", "public-id"]) ("preserves nonreferences: %s", text => {
    expect(() => visibility.assertVisible(text)).not.toThrow();
    expect(visibility.filter(text)).toBe(text);
  });
  it.each(["{\n \"id\": 12345678901234567890\n}", "[1, 2,   3]"])("preserves untouched structured text byte for byte: %s", text => {
    expect(visibility.filter({ description: text })).toEqual({ description: text });
    expect(createGitHubPrimaryVisibility(new Set(), []).filter(text)).toBe(text);
  });
  it("is the identity for ordinary default-off data including colliding property names", () => {
    const value = { previousAssessments: ["ordinary"], isolationTests: { ordinary: true }, description: "[1, 2,   3]" };
    expect(createGitHubPrimaryVisibility(new Set(), []).filter(value)).toBe(value);
  });
  it("filters both structured rows and JSON text without removing adjacent public rows", () => {
    const rows = [{ id: uuid, title: "private" }, { id: "public", title: "public", previousAssessments: { secret: true } }];
    const expected = [{ id: "public", title: "public" }];
    expect(visibility.filter({ content: [{ type: "text", text: JSON.stringify(rows) }], data: rows }))
      .toEqual({ content: [{ type: "text", text: JSON.stringify(expected) }], data: expected });
  });
  it("still hides explicit candidate records and internal envelopes without candidates", () => {
    const empty = createGitHubPrimaryVisibility(new Set(), []);
    expect(empty.active).toBe(false);
    expect(empty.filter([{ shadow_label: "candidate", title: "private" }, { id: "public", githubPairingSeed: {} }]))
      .toEqual([{ id: "public" }]);
  });
  it("matches the former whole-token regex across deterministic punctuation and boundary cases", () => {
    const regex = new RegExp(`(^|[^a-z0-9_-])(?:${[...tokens].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z0-9_-])`, "i");
    for (const token of [...tokens, "TOG-20", "public", uuid.toUpperCase(), "équipe-2", "STRASSE-2", "straße-2"]) {
      for (const left of ["", "/", "_", "a", "-", "[", "%20", "K", "İ", "ß"]) {
        for (const right of ["", "/", "_", "a", "-", "]", "%20", "K", "İ", "ß"]) {
          const text = `${left}${token}${right}`;
          expect(visibility.filter(text) === undefined).toBe(regex.test(decodeURIComponent(text)));
        }
      }
    }
  });
});
