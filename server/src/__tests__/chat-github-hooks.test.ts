import { describe, expect, it } from "vitest";
import { githubCandidateHooks } from "../services/chat-github-hooks.js";

describe("isolated candidate ambient hook parity", () => {
  const settings = { hooks: {
    PreToolUse: [{ matcher: "Bash|Terminal", hooks: [{ type: "command", command: "node /paperclip/model-guard/model-guard-hook.mjs", timeout: 5 }] }],
    Stop: [{ hooks: [{ type: "command", command: "node /paperclip/muse-stop-guard/muse-stop-guard.mjs", timeout: 15 }] },
      { hooks: [{ type: "command", command: "node /paperclip/disposition-stop-guard/disposition-stop-guard.mjs", timeout: 15 }] }],
  }, env: { GH_TOKEN: "NEVER_COPY" } };
  const read = async (path: string) => {
    if (path.endsWith("settings.json")) return JSON.stringify(settings);
    if (path.endsWith(".mjs")) return `// exact immutable hook ${path}`;
    if (path.endsWith("disposition-stop-guard.config.json")) return '{"mode":"observe"}';
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  };
  it("copies all three reviewed definitions and source bytes, not credentials logs or memory", async () => {
    const bundle = await githubCandidateHooks("/fresh", read);
    expect(bundle.files[".claude/settings.json"]).toBeDefined();
    const actual = JSON.parse(bundle.files[".claude/settings.json"]!);
    expect(actual.hooks.PreToolUse[0]).toMatchObject({ matcher: "Bash|Terminal", hooks: [{ timeout: 5, command: "node /fresh/hooks/model-guard/model-guard-hook.mjs" }] });
    expect(actual.hooks.Stop).toHaveLength(2);
    expect(bundle.files["hooks/disposition-stop-guard/disposition-stop-guard.config.json"]).toBe('{"mode":"observe"}');
    expect(bundle.files["hooks/muse-stop-guard/muse-stop-guard.mjs"]).toBe("// exact immutable hook /paperclip/muse-stop-guard/muse-stop-guard.mjs");
    expect(JSON.stringify(bundle)).not.toMatch(/NEVER_COPY|decisions.jsonl|sessions/);
    expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("refuses an enforcing disposition hook whose API reads cannot be reproduced", async () => {
    await expect(githubCandidateHooks("/fresh", path => path.endsWith("disposition-stop-guard.config.json")
      ? Promise.resolve('{"mode":"enforce"}') : read(path))).rejects.toThrow("github_candidate_disposition_hook_not_observational");
  });
  it("refuses unknown hook commands rather than executing arbitrary host settings", async () => {
    await expect(githubCandidateHooks("/fresh", async () => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "curl https://example.com" }] }] } })))
      .rejects.toThrow("github_candidate_hooks_unreviewed");
  });
  it("missing primary settings mean an empty hook set, unreadable settings fail closed", async () => {
    const absent = async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); };
    expect(JSON.parse((await githubCandidateHooks("/fresh", absent)).files[".claude/settings.json"]!)).toEqual({ hooks: {} });
    await expect(githubCandidateHooks("/fresh", async () => { throw new Error("permission denied"); })).rejects.toThrow();
  });
});
