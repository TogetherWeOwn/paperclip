import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload } from "../redaction.js";
import { boundHeartbeatRunEventPayloadForStorage } from "../services/heartbeat.js";
import { GITHUB_SHADOW_PROTOCOL } from "../services/chat-github-comparison.js";
import { GITHUB_BOT_TOOLS, GITHUB_CANDIDATE_REVIEW_TOOL_NAMES } from "../services/chat-github-tools.js";
import { createGitHubRunEvidenceCollector, githubCliInitFacts, githubPairEquivalence, githubRunEvidence, githubRunEvidenceRecord,
  githubShadowCandidateDeniedMcpServer, githubShadowCandidateDeniedTool, GITHUB_SHADOW_CANDIDATE_DENIALS,
  type GitHubReviewRunEvidenceRecord } from "../services/chat-github-run-evidence.js";

// Production facts from 2026-10-18 (tog.16, deploy/tog6 a84df565): the
// primary's raw CLI init event and the candidate's receipt as it was stored.
const fixture = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/github-shadow/${file}`, import.meta.url), "utf8"));
const primaryInit = fixture("primary-init-20261018.json") as { claude_code_version: string; tools: string[];
  mcp_servers: { name: string }[]; permissionMode: string };
const storedCandidate = fixture("candidate-evidence-20261018.json") as { version: 1; workspaceHead: string; workspaceTree: string;
  workspaceKind: string; cli: { claudeCodeVersion: string; tools: string[]; mcpServers: string[]; permissionMode: string } };
// The stored candidate version was masked (root cause 1); both arms run the
// same pinned CLI, so its init is rebuilt from the stored inventory.
const candidateInit = { type: "system", subtype: "init", claude_code_version: primaryInit.claude_code_version,
  tools: storedCandidate.cli.tools, mcp_servers: storedCandidate.cli.mcpServers.map(name => ({ name, status: "connected" })),
  permissionMode: storedCandidate.cli.permissionMode, cwd: "/workspace" };
const head = storedCandidate.workspaceHead, tree = storedCandidate.workspaceTree;

/** The appendRunEvent persistence path: storage bounds, then the event redactor. */
const persist = (payload: object) => redactEventPayload(boundHeartbeatRunEventPayloadForStorage({ ...payload }))!;

async function recorded(init: object, role: "primary" | "candidate") {
  const observed: GitHubReviewRunEvidenceRecord[] = [];
  const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", role,
    workspaceHead: async () => role === "candidate" ? { head, tree } : { head: null, tree: null },
    record: async evidence => { observed.push(evidence); } });
  await collect("stdout", JSON.stringify({ ...init, cwd: "/workspace" }) + "\n");
  expect(observed).toHaveLength(1);
  return persist(observed[0]!);
}

const toolsEquivalent = (primary: unknown, candidate: unknown) =>
  githubPairEquivalence({ admittedHead: head, primaryRuns: [[primary]], candidateRun: [candidate] }).tools;

const withTools = (init: object, change: (tools: string[]) => string[]) =>
  ({ ...init, tools: change([...(init as { tools: string[] }).tools]) });

describe("paired shadow run evidence survives persistence", () => {
  it("certifies the real 2026-10-18 inventories after storage bounds and redaction", async () => {
    const primary = await recorded(primaryInit, "primary");
    const candidate = await recorded(candidateInit, "candidate");
    expect(JSON.stringify([primary, candidate])).not.toMatch(/REDACTED|_truncated/);
    expect(githubRunEvidence(primary)?.cli).toMatchObject({ claudeCodeVersion: "2.1.284",
      mcpServers: ["Paperclip connections", "Paperclip projects", "paperclip-assigned"] });
    expect(githubRunEvidence(primary)?.cli?.tools).toHaveLength(60);
    expect(githubRunEvidence(candidate)?.cli?.tools).toHaveLength(30);
    expect(toolsEquivalent(primary, candidate)).toBe(true);
    // The predicate denies exactly what the candidate lacks: nothing more, nothing less.
    expect(primaryInit.tools.filter(githubShadowCandidateDeniedTool).sort())
      .toEqual(primaryInit.tools.filter(tool => !storedCandidate.cli.tools.includes(tool)).sort());
    expect(primaryInit.mcp_servers.map(server => server.name).filter(githubShadowCandidateDeniedMcpServer).sort())
      .toEqual(["Paperclip connections", "Paperclip projects"]);
  });

  it("documents why the version-1 receipt was never verifiable once stored", () => {
    // Before the storage encoding: 60 tools cut to 50 + marker. Dotted
    // versions are retained verbatim: upstream narrowed JWT redaction to
    // encoded-JSON headers, so a bare CLI version is no longer masked.
    const legacy = persist({ version: 1, cli: githubCliInitFacts(primaryInit), workspaceHead: null });
    expect((legacy.cli as Record<string, unknown>).claudeCodeVersion).toBe("2.1.284");
    expect(JSON.stringify(legacy)).toContain("_truncated");
    expect(githubRunEvidence(legacy)?.cli).toBeNull();
  });

  it.each(["2.1.284", "1.0.0", "10.0.0", "0.0.1", "2.1.284-beta.1", "2.1.284+build.5.6", "2.1.284-rc-1"])(
    "round-trips CLI version %s through the real redactEventPayload", async version => {
      const primary = await recorded({ ...primaryInit, claude_code_version: version }, "primary");
      const candidate = await recorded({ ...candidateInit, claude_code_version: version }, "candidate");
      expect(JSON.stringify(primary)).not.toContain(REDACTED_EVENT_VALUE);
      expect(githubRunEvidence(primary)?.cli?.claudeCodeVersion).toBe(version);
      expect(githubRunEvidence(candidate)?.cli?.claudeCodeVersion).toBe(version);
      expect(toolsEquivalent(primary, candidate)).toBe(true);
    });

  it("still distinguishes different persisted versions", async () => {
    const primary = await recorded(primaryInit, "primary");
    for (const version of ["2.1.285", "2.1.284-beta.1", "2.12.84"]) {
      expect(toolsEquivalent(primary, await recorded({ ...candidateInit, claude_code_version: version }, "candidate"))).toBe(false);
    }
  });

  it("rejects malformed storage encodings instead of guessing", async () => {
    const good = githubRunEvidenceRecord({ version: 1, cli: githubCliInitFacts(primaryInit), workspaceHead: null });
    const cli = good.cli!;
    for (const broken of [
      { ...cli, claudeCodeVersionParts: [2, 1] }, { ...cli, claudeCodeVersionParts: [2, 1, -1] },
      { ...cli, claudeCodeVersionParts: [2, 1, 1.5] }, { ...cli, claudeCodeVersionParts: ["2", "1", "284"] },
      { ...cli, claudeCodeVersionSuffix: ["beta"] }, { ...cli, claudeCodeVersionSuffix: ["-rc.1"] },
      { ...cli, claudeCodeVersionSuffix: [REDACTED_EVENT_VALUE] },
      { ...cli, toolChunks: cli.toolChunks.flat() }, { ...cli, toolChunks: [...cli.toolChunks, [{ _truncated: true }]] },
      { ...cli, toolChunks: [cli.toolChunks.flat()] }, { ...cli, mcpServerChunks: cli.mcpServerChunks.flat() },
    ]) {
      expect(githubRunEvidence({ ...good, cli: broken })?.cli).toBeNull();
    }
    expect(githubRunEvidence(persist(good))?.cli).toEqual(githubCliInitFacts(primaryInit));
  });
});

describe("MCP server names", () => {
  const init = (...names: string[]) => ({ ...primaryInit, type: "system", subtype: "init", mcp_servers: names.map(name => ({ name })) });
  it("accepts bounded printable names with spaces and keeps them through storage", async () => {
    expect(githubCliInitFacts(init("Paperclip projects", "Paperclip connections", "paperclip-assigned"))?.mcpServers)
      .toEqual(["Paperclip connections", "Paperclip projects", "paperclip-assigned"]);
    expect(githubRunEvidence(await recorded(init("Paperclip projects", "a b c d"), "primary"))?.cli?.mcpServers)
      .toEqual(["Paperclip projects", "a b c d"]);
    expect(githubCliInitFacts(init("x".repeat(200)))).not.toBeNull();
  });
  it.each([["empty", ""], ["too long", "x".repeat(201)], ["leading space", " Paperclip"], ["trailing space", "Paperclip "],
    ["control character", "Paper\nclip"], ["tab", "Paper\tclip"], ["non-ASCII", "Paperclip\u00a0projects"], ["masked", REDACTED_EVENT_VALUE],
    ["partly masked", `Bearer ${REDACTED_EVENT_VALUE}`]])("rejects a %s server name", (_label, name) => {
    expect(githubCliInitFacts(init(name))).toBeNull();
  });
  it("keeps the server count bound", () => {
    expect(githubCliInitFacts(init(...Array.from({ length: 128 }, (_, i) => `server ${i}`)))).not.toBeNull();
    expect(githubCliInitFacts(init(...Array.from({ length: 129 }, (_, i) => `server ${i}`)))).toBeNull();
  });
});

describe("candidate inventory is the primary's minus the documented denials, exactly", () => {
  const endpointTool = (tool: string) => `mcp__paperclip-assigned__github-bot_213544ef-08cb-4f1d-82d4-bf9bf3dd3ad6_${tool}`;
  it.each([
    "Glob", "mcp__paperclip-assigned__paperclip_new_tool", endpointTool("submit_review"),
    // Near misses of each denial stay ordinary tools.
    "mcp__paperclip-assigned__github-bot_not-a-uuid_comment", endpointTool("comment_draft"), "mcp__Paperclip_projects_x__list",
    "mcp__paperclip-assigned__mcpx_tool", "mcp__other__mcp_tool", "WebSearchLite", "mcp__paperclip-assigned__paperclip-plugin-hindsightx",
  ])("fails when non-denied primary tool %s is missing from the candidate", async tool => {
    expect(githubShadowCandidateDeniedTool(tool)).toBe(false);
    const primary = await recorded(withTools(primaryInit, tools => [...tools.filter(entry => entry !== tool), tool]), "primary");
    expect(toolsEquivalent(primary, await recorded(withTools(candidateInit, tools => tools.filter(entry => entry !== tool)), "candidate"))).toBe(false);
  });
  it("fails when the candidate lacks a non-denied tool both arms are expected to hold", async () => {
    const primary = await recorded(primaryInit, "primary");
    for (const tool of ["Read", "Bash", endpointTool("begin_review"), "mcp__paperclip-assigned__paperclip_read_resource"]) {
      expect(toolsEquivalent(primary, await recorded(withTools(candidateInit, tools => tools.filter(entry => entry !== tool)), "candidate"))).toBe(false);
    }
  });
  it.each(["Glob", "WebSearch", endpointTool("comment"), endpointTool("formal_review"), "mcp__Paperclip_projects__create_task",
    "mcp__paperclip-assigned__mcp_deepwiki-18f17569_ask-wiki-question", "mcp__paperclip-assigned__paperclip-plugin-hindsight_hindsight_recall",
    "mcp__paperclip-assigned__mcp_new-app_fetch"])("fails when the candidate holds candidate-only or denied tool %s", async tool => {
    const primary = await recorded(primaryInit, "primary");
    expect(toolsEquivalent(primary, await recorded(withTools(candidateInit, tools => [...tools, tool]), "candidate"))).toBe(false);
  });
  it("requires the candidate MCP servers to be the primary's minus the denied servers", async () => {
    const primary = await recorded(primaryInit, "primary");
    const servers = (...names: string[]) => ({ ...candidateInit, mcp_servers: names.map(name => ({ name })) });
    expect(toolsEquivalent(primary, await recorded(servers("paperclip-assigned"), "candidate"))).toBe(true);
    for (const names of [[], ["paperclip-assigned", "Paperclip projects"], ["paperclip-assigned", "external"]]) {
      expect(toolsEquivalent(primary, await recorded(servers(...names), "candidate"))).toBe(false);
    }
    // A primary retry with the candidate's reduced inventory is not equivalent.
    expect(githubPairEquivalence({ admittedHead: head, primaryRuns: [[primary], [await recorded(candidateInit, "primary")]],
      candidateRun: [await recorded(candidateInit, "candidate")] }).tools).toBe(false);
  });
  it("keeps a legacy receipt with a masked version unverified", async () => {
    expect(githubRunEvidence(storedCandidate)?.cli).toBeNull();
    const primary = await recorded(primaryInit, "primary");
    expect(toolsEquivalent(primary, storedCandidate)).toBe(false);
    // Two masks never compare equal as a version.
    const masked = (cli: object | null) => ({ version: 1, workspaceHead: null, cli: { ...cli, claudeCodeVersion: REDACTED_EVENT_VALUE } });
    expect(toolsEquivalent(masked(githubCliInitFacts(primaryInit)), masked(githubCliInitFacts(candidateInit)))).toBe(false);
  });
});

describe("deviation protocol", () => {
  it("records every candidate denial with a reason and the primary-favouring bias", () => {
    expect(Object.keys(GITHUB_SHADOW_PROTOCOL.deviations).sort()).toEqual(Object.keys(GITHUB_SHADOW_CANDIDATE_DENIALS).sort());
    for (const deviation of Object.values(GITHUB_SHADOW_PROTOCOL.deviations)) {
      expect(deviation).toMatchObject({ primaryChanged: false, bias: "favours_primary" });
      expect(deviation.reason.length).toBeGreaterThan(20);
    }
    expect(GITHUB_SHADOW_PROTOCOL.deviations.paperclipBoardMcp.deniedMcpServers).toEqual(["Paperclip projects", "Paperclip connections"]);
  });
  it("denies exactly the github-bot tools the candidate capability omits", () => {
    const omitted = GITHUB_BOT_TOOLS.map(tool => tool.name)
      .filter(tool => !(GITHUB_CANDIDATE_REVIEW_TOOL_NAMES as readonly string[]).includes(tool));
    const endpoint = "213544ef-08cb-4f1d-82d4-bf9bf3dd3ad6";
    for (const tool of GITHUB_BOT_TOOLS.map(entry => entry.name)) {
      expect(githubShadowCandidateDeniedTool(`mcp__paperclip-assigned__github-bot_${endpoint}_${tool}`)).toBe(omitted.includes(tool));
    }
    expect(omitted.sort()).toEqual(["comment", "formal_review", "update_comment"]);
  });
});
