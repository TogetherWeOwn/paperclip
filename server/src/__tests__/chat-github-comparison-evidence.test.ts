import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { githubComparisonEligibility, githubRunComparisonEligibility, GITHUB_SHADOW_PROTOCOL } from "../services/chat-github-comparison.js";
import { createGitHubRunEvidenceCollector, githubCliInitFacts, githubPairEquivalence, githubWorkspaceHead,
  type GitHubReviewRunEvidence } from "../services/chat-github-run-evidence.js";
import type { chatGitHubReviewEnrollments } from "@paperclipai/db";

const head = "a".repeat(40);
const init = { type: "system", subtype: "init", claude_code_version: "2.1.284", tools: ["Read", "Bash", "WebSearch", "WebFetch"],
  mcp_servers: [{ name: "paperclip", status: "connected" }], permissionMode: "bypassPermissions", cwd: "/workspace" };
const primary = (): GitHubReviewRunEvidence => ({ version: 1, cli: githubCliInitFacts(init), workspaceHead: head });
const candidate = (): GitHubReviewRunEvidence => ({ ...primary(), cli: githubCliInitFacts({ ...init, tools: ["Bash", "Read"] }) });
const pair = () => ({ admittedHead: head, primaryRuns: [[primary()]], candidateRun: [candidate()] });
const proof = { environmentCertified: true, selfTestRecorded: true, selfTestPassed: true, primaryBlindingActive: true,
  snapshotAvailable: true, roundOrdinal: 1, primaryInputSource: "snapshot" as const };

describe("observed per-run equivalence", () => {
  it("certifies equal versions/tool sets/MCP/permissions/heads modulo candidate-only web removals and model identity", () => {
    const runEvidence = pair();
    runEvidence.primaryRuns[0]![0]!.cli = githubCliInitFacts({ ...init, tools: ["WebFetch", "Read", "Bash", "WebSearch", "Read"], model: "primary" });
    runEvidence.candidateRun[0]!.cli = githubCliInitFacts({ ...init, tools: ["Read", "Bash", "Bash"], model: "candidate" });
    expect(githubComparisonEligibility({ ...proof, runEvidence })).toEqual({ certifiedClean: true, reasons: [] });
  });
  it.each(["version", "tools", "candidate-web", "mcp", "permission", "missing-cli", "missing-version", "malformed-tools", "malformed-mcp"])(
    "retains tool uncertainty for %s without hiding valid workspace proof", change => {
      const runEvidence = pair();
      const c = runEvidence.candidateRun[0]!;
      if (change === "version") c.cli!.claudeCodeVersion = "2.1.302";
      if (change === "tools") c.cli!.tools.push("Write");
      if (change === "candidate-web") c.cli!.tools.push("WebSearch");
      if (change === "mcp") c.cli!.mcpServers.push("external");
      if (change === "permission") c.cli!.permissionMode = "default";
      if (change === "missing-cli") c.cli = null;
      if (change === "missing-version") delete (c.cli as Record<string, unknown>).claudeCodeVersion;
      if (change === "malformed-tools") (c.cli as Record<string, unknown>).tools = [null];
      if (change === "malformed-mcp") (c.cli as Record<string, unknown>).mcpServers = {};
      expect(githubComparisonEligibility({ ...proof, runEvidence })).toEqual({ certifiedClean: false, reasons: ["effective_tool_equivalence_unverified"] });
    });
  it.each(["primary-mismatch", "candidate-mismatch", "primary-missing", "candidate-missing", "admission-missing", "admission-invalid"])(
    "retains workspace uncertainty for %s", change => {
      const runEvidence = pair();
      if (change === "primary-mismatch") runEvidence.primaryRuns[0]![0]!.workspaceHead = "b".repeat(40);
      if (change === "candidate-mismatch") runEvidence.candidateRun[0]!.workspaceHead = "b".repeat(40);
      if (change === "primary-missing") runEvidence.primaryRuns[0]![0]!.workspaceHead = null;
      if (change === "candidate-missing") runEvidence.candidateRun[0]!.workspaceHead = null;
      if (change === "admission-missing") runEvidence.admittedHead = "";
      if (change === "admission-invalid") runEvidence.admittedHead = "not-a-commit";
      expect(githubComparisonEligibility({ ...proof, runEvidence })).toEqual({ certifiedClean: false, reasons: ["workspace_equivalence_unverified"] });
    });
  it.each(["primary", "candidate", "retry", "all"])("never substitutes previous evidence for missing %s run evidence", missing => {
    const runEvidence = pair();
    if (missing === "primary") runEvidence.primaryRuns = [];
    if (missing === "candidate") runEvidence.candidateRun = [];
    if (missing === "retry") runEvidence.primaryRuns.push([]);
    const result = githubComparisonEligibility({ ...proof, runEvidence: missing === "all" ? undefined : runEvidence });
    expect(result).toEqual({ certifiedClean: false, reasons: ["effective_tool_equivalence_unverified", "workspace_equivalence_unverified"] });
  });
  it("checks every init and every primary retry rather than the last good receipt", () => {
    const runEvidence = pair();
    runEvidence.primaryRuns.push([{ ...primary(), workspaceHead: "b".repeat(40) }], [primary()]);
    runEvidence.candidateRun.unshift({ ...candidate(), cli: null });
    expect(githubPairEquivalence(runEvidence)).toEqual({ tools: false, workspace: false });
  });
  it("does not erase primary tool differences using candidate-only deviations", () => {
    const runEvidence = pair();
    runEvidence.primaryRuns.push([candidate()]);
    expect(githubPairEquivalence(runEvidence).tools).toBe(false);
  });
  it("still applies all isolation, input, and admission gates to otherwise equal runtime evidence", () => {
    for (const field of ["environmentCertified", "selfTestRecorded", "selfTestPassed", "primaryBlindingActive", "snapshotAvailable"]) {
      expect(githubComparisonEligibility({ ...proof, [field]: false, runEvidence: pair() }).certifiedClean).toBe(false);
    }
    expect(githubComparisonEligibility({ ...proof, primaryInputSource: "live", runEvidence: pair() }).certifiedClean).toBe(false);
    expect(githubComparisonEligibility({ ...proof, roundOrdinal: 2, runEvidence: pair() }).certifiedClean).toBe(false);
  });
  it("binds positive equivalence to the exact isolation receipt and requires every new probe", () => {
    const enrollment = { headSha: head, roundOrdinal: 1, envelope: { snapshot: {}, protocol: GITHUB_SHADOW_PROTOCOL }, isolationTests: {
      run: { version: 1, runId: "run", candidateId: "candidate", armId: "arm", environmentId: "env", configurationDigest: "config",
        certificateDigest: "cert", hooksDigest: "hooks", primaryBlindingVersion: 1, status: "passed",
        checks: { primaryCanariesDenied: true, githubDenied: true, configFresh: true, providerToolsDenied: true,
          allowedModelAccepted: true, otherModelDenied: true, rawProxyDenied: true } },
    } } as unknown as typeof chatGitHubReviewEnrollments.$inferSelect;
    const assess = () => githubRunComparisonEligibility(enrollment, { id: "candidate", armId: "arm" }, "run", "snapshot", pair());
    expect(assess()).toEqual({ certifiedClean: true, reasons: [] });
    for (const key of ["allowedModelAccepted", "otherModelDenied", "rawProxyDenied"] as const) {
      for (const value of [false, undefined]) {
        enrollment.isolationTests.run!.checks[key] = value;
        expect(assess().reasons).toContain("candidate_isolation_self_test_failed");
      }
      enrollment.isolationTests.run!.checks[key] = true;
    }
    enrollment.isolationTests.run!.armId = "other-arm";
    expect(assess().certifiedClean).toBe(false);
    expect(assess().reasons).toContain("effective_tool_equivalence_unverified");
  });
});

describe("heartbeat stream-json evidence collector", () => {
  it("records only init facts, handles arbitrary chunk boundaries, and never records prompts or results", async () => {
    const observed: GitHubReviewRunEvidence[] = [];
    const workspaceHead = vi.fn(async () => head);
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", workspaceHead, record: async e => { observed.push(e); } });
    const line = JSON.stringify({ ...init, prompt: "SECRET PROMPT", session_id: "SECRET SESSION", model: "primary" }) + "\n";
    await collect("stderr", line);
    await collect("stdout", "ordinary diagnostic\n");
    for (const char of line) await collect("stdout", char);
    await collect("stdout", JSON.stringify({ type: "assistant", text: "SECRET ANSWER" }) + "\n");
    expect(observed).toEqual([primary()]);
    expect(workspaceHead).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(observed)).not.toMatch(/SECRET|\/workspace|model|session_id/);
  });
  it("retains malformed and unequal reconnect evidence, not just the latest good init", async () => {
    const observed: GitHubReviewRunEvidence[] = [];
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", workspaceHead: async () => head, record: async e => { observed.push(e); } });
    for (const event of [init, { ...init, tools: undefined }, { ...init, claude_code_version: "2.1.302" }]) await collect("stdout", JSON.stringify(event) + "\n");
    expect(observed).toHaveLength(3);
    expect(observed[1]!.cli).toBeNull();
    expect(githubPairEquivalence({ admittedHead: head, primaryRuns: [observed], candidateRun: [candidate()] }).tools).toBe(false);
  });
  it("serializes concurrent log chunks while workspace and receipt I/O are pending", async () => {
    const observed: GitHubReviewRunEvidence[] = [];
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/workspace",
      workspaceHead: async () => { await waiting; return head; }, record: async e => { observed.push(e); } });
    const first = collect("stdout", JSON.stringify(init) + "\n");
    const second = collect("stdout", JSON.stringify({ ...init, claude_code_version: "2.1.302" }) + "\n");
    release();
    await Promise.all([first, second]);
    expect(observed.map(e => e.cli?.claudeCodeVersion)).toEqual(["2.1.284", "2.1.302"]);
    expect(githubPairEquivalence({ admittedHead: head, primaryRuns: [observed], candidateRun: [candidate()] }).tools).toBe(false);
  });
  it("does not equate the host mirror with a different CLI cwd", async () => {
    const record = vi.fn(async (_: GitHubReviewRunEvidence) => {});
    const workspaceHead = vi.fn(async () => head);
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/host-mirror", workspaceHead, record });
    await collect("stdout", JSON.stringify(init) + "\n");
    expect(workspaceHead).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({ ...primary(), workspaceHead: null });
  });
  it("bounds incomplete lines and resumes at the next line boundary", async () => {
    const observed: GitHubReviewRunEvidence[] = [];
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", workspaceHead: async () => head, record: async e => { observed.push(e); } });
    await collect("stdout", "x".repeat(256 * 1024));
    await collect("stdout", JSON.stringify(init) + "\n");
    await collect("stdout", JSON.stringify(init) + "\n");
    expect(observed).toEqual([primary()]);
  });
  it.each(["claude_code_version", "tools", "mcp_servers", "permissionMode"])("rejects missing init field %s rather than treating it as an empty set", field => {
    expect(githubCliInitFacts({ ...init, [field]: undefined })).toBeNull();
  });
});

it("observes actual local HEAD and leaves an empty workspace unverified", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "github-head-evidence-"));
  const input = { runId: "test", target: null, cwd, env: {} };
  try {
    expect(await githubWorkspaceHead(input)).toBeNull();
    execFileSync("git", ["init", "--quiet", cwd]);
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture"], { cwd, stdio: "pipe" });
    const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    expect(await githubWorkspaceHead(input)).toBe(actual);
    expect(actual).not.toBe(head);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
