import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { githubComparisonEligibility, githubRunComparisonEligibility, GITHUB_SHADOW_PROTOCOL } from "../services/chat-github-comparison.js";
import { createGitHubRunEvidenceCollector, githubCliInitFacts, githubPairEquivalence, githubRunEvidence, githubRunEvidenceRecord,
  githubWorkspaceHead, githubWorkspaceState, type GitHubReviewRunEvidenceRecord,
  type GitHubReviewRunEvidence } from "../services/chat-github-run-evidence.js";
import type { chatGitHubReviewEnrollments, GitHubCandidateWorkspaceReceipt, GitHubReviewRepositoryArtifact } from "@paperclipai/db";

const head = "a".repeat(40);
const init = { type: "system", subtype: "init", claude_code_version: "2.1.284", tools: ["Read", "Bash", "WebSearch", "WebFetch"],
  mcp_servers: [{ name: "paperclip", status: "connected" }], permissionMode: "bypassPermissions", cwd: "/workspace" };
const tree = "f".repeat(40), baseSha = "e".repeat(40), baseTree = "d".repeat(40), artifactSha = "c".repeat(64);
const repository = (): GitHubReviewRepositoryArtifact => ({ version: 1, kind: "bundle", path: `${artifactSha}.bundle`, sha256: artifactSha, bytes: 1,
  headSha: head, baseSha, headTree: tree, baseTree, refs: { base: "refs/heads/main", head: "refs/pull/7/head" }, commits: { base: baseSha, head } });
const receipt = (): GitHubCandidateWorkspaceReceipt => ({ version: 1, status: "materialized", kind: "bundle", artifactSha256: artifactSha,
  head, tree, baseCommit: baseSha, baseTree });
const primary = (): GitHubReviewRunEvidence => ({ version: 1, cli: githubCliInitFacts(init), workspaceHead: head });
const candidate = (): GitHubReviewRunEvidence => ({ ...primary(), workspaceTree: tree, workspaceKind: "isolated_checkout",
  cli: githubCliInitFacts({ ...init, tools: ["Bash", "Read"] }) });
const pair = () => ({ admittedHead: head, admittedBase: baseSha, repository: repository(), candidateWorkspace: receipt(),
  primaryRuns: [[primary()]], candidateRun: [candidate()] });
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
    expect(githubPairEquivalence(runEvidence)).toMatchObject({ tools: false, workspace: false });
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
    const enrollment = { headSha: head, baseSha, roundOrdinal: 1, envelope: { snapshot: { repository: repository() }, protocol: GITHUB_SHADOW_PROTOCOL }, isolationTests: {
      run: { version: 1, runId: "run", candidateId: "candidate", armId: "arm", environmentId: "env", configurationDigest: "config",
        certificateDigest: "cert", hooksDigest: "hooks", primaryBlindingVersion: 1, status: "passed", workspace: receipt(),
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
    // The sealed artifact and this exact run's materialisation receipt are both required.
    enrollment.isolationTests.run!.workspace = undefined;
    expect(assess().reasons).toEqual(["workspace_equivalence_unverified"]);
    enrollment.isolationTests.run!.workspace = receipt();
    enrollment.envelope.snapshot = {} as never;
    expect(assess().reasons).toEqual(["workspace_equivalence_unverified"]);
    enrollment.envelope.snapshot = { repository: repository() } as never;
    expect(assess()).toEqual({ certifiedClean: true, reasons: [] });
    enrollment.isolationTests.run!.armId = "other-arm";
    expect(assess().certifiedClean).toBe(false);
    expect(assess().reasons).toContain("effective_tool_equivalence_unverified");
  });
});

describe("checkout capability equivalence", () => {
  const reason = (runEvidence: ReturnType<typeof pair>) => githubPairEquivalence(runEvidence).workspaceReason;
  it("accepts a primary reviewing from its agent home with network git instead of a checkout HEAD", () => {
    const runEvidence = pair();
    runEvidence.primaryRuns[0]![0] = { ...primary(), workspaceHead: null, workspaceKind: "agent_home_with_network_git" };
    expect(githubComparisonEligibility({ ...proof, runEvidence })).toEqual({ certifiedClean: true, reasons: [] });
    for (const kind of ["checkout", "isolated_checkout", null, undefined] as const) {
      runEvidence.primaryRuns[0]![0] = { ...primary(), workspaceHead: null, workspaceKind: kind };
      expect(reason(runEvidence)).toBe("primary_workspace_unverified");
    }
    // A primary checkout at another commit is not rescued by its kind.
    runEvidence.primaryRuns[0]![0] = { ...primary(), workspaceHead: "b".repeat(40), workspaceKind: "agent_home_with_network_git" };
    expect(reason(runEvidence)).toBe("primary_workspace_unverified");
  });
  it("accepts a synthetic checkout only by tree identity with the base tree present", () => {
    const synthetic = { head: "1".repeat(40), base: "2".repeat(40) };
    const runEvidence = pair();
    runEvidence.repository = { ...repository(), kind: "synthetic", commits: synthetic };
    runEvidence.candidateWorkspace = { ...receipt(), kind: "synthetic", head: synthetic.head, baseCommit: synthetic.base };
    runEvidence.candidateRun[0]!.workspaceHead = synthetic.head;
    expect(githubComparisonEligibility({ ...proof, runEvidence })).toEqual({ certifiedClean: true, reasons: [] });
    runEvidence.candidateWorkspace.tree = "b".repeat(40);
    expect(reason(runEvidence)).toBe("candidate_workspace_head_mismatch");
    runEvidence.candidateWorkspace = { ...receipt(), kind: "synthetic", head: synthetic.head, baseCommit: synthetic.base, baseTree: null };
    expect(reason(runEvidence)).toBe("candidate_workspace_head_mismatch");
    // A bundle receipt must name the admitted head itself, not merely an equal tree.
    const bundle = pair();
    bundle.candidateWorkspace.head = synthetic.head;
    bundle.candidateRun[0]!.workspaceHead = synthetic.head;
    expect(reason(bundle)).toBe("candidate_workspace_head_mismatch");
  });
  it.each([
    ["no artifact", (e: ReturnType<typeof pair>) => { e.repository = undefined as never; }, "repository_artifact_unavailable"],
    ["no receipt", (e: ReturnType<typeof pair>) => { e.candidateWorkspace = undefined as never; }, "candidate_workspace_not_recorded"],
    ["unavailable receipt", (e: ReturnType<typeof pair>) => { e.candidateWorkspace = { version: 1, status: "unavailable", kind: null, reason: "repository_artifact_late" }; }, "repository_artifact_late"],
    ["errored receipt", (e: ReturnType<typeof pair>) => { e.candidateWorkspace.status = "error"; e.candidateWorkspace.reason = "workspace_transfer_failed"; }, "workspace_transfer_failed"],
    ["artifact for another head", (e: ReturnType<typeof pair>) => { e.repository.headSha = "b".repeat(40); }, "repository_artifact_binding_mismatch"],
    ["artifact for another base", (e: ReturnType<typeof pair>) => { e.repository.baseSha = "b".repeat(40); }, "repository_artifact_binding_mismatch"],
    ["receipt for another artifact", (e: ReturnType<typeof pair>) => { e.candidateWorkspace.artifactSha256 = "b".repeat(64); }, "candidate_workspace_artifact_mismatch"],
    ["receipt of another kind", (e: ReturnType<typeof pair>) => { e.candidateWorkspace.kind = "synthetic"; }, "candidate_workspace_artifact_mismatch"],
    ["base commit absent", (e: ReturnType<typeof pair>) => { e.candidateWorkspace.baseCommit = null; }, "candidate_workspace_head_mismatch"],
    ["base tree absent", (e: ReturnType<typeof pair>) => { e.candidateWorkspace.baseTree = null; }, "candidate_workspace_head_mismatch"],
    ["CLI tree unobserved", (e: ReturnType<typeof pair>) => { e.candidateRun[0]!.workspaceTree = null; }, "candidate_cli_workspace_unobserved"],
    ["CLI at another head", (e: ReturnType<typeof pair>) => { e.candidateRun[0]!.workspaceHead = "b".repeat(40); }, "candidate_cli_workspace_unobserved"],
  ])("keeps the candidate workspace unverified for %s", (_name, mutate, expected) => {
    const runEvidence = pair();
    mutate(runEvidence);
    expect(reason(runEvidence)).toBe(expected);
    expect(githubComparisonEligibility({ ...proof, runEvidence })).toEqual({ certifiedClean: false, reasons: ["workspace_equivalence_unverified"] });
  });
  it("records each arm's workspace kind from the CLI's actual cwd", async () => {
    const observed: GitHubReviewRunEvidenceRecord[] = [];
    const record = async (e: GitHubReviewRunEvidenceRecord) => { observed.push(e); };
    await createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", role: "candidate", workspaceHead: async () => ({ head, tree }), record })("stdout", JSON.stringify(init) + "\n");
    await createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", role: "primary", workspaceHead: async () => ({ head: null, tree: null }), record })("stdout", JSON.stringify(init) + "\n");
    await createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", role: "primary", workspaceHead: async () => ({ head, tree }), record })("stdout", JSON.stringify(init) + "\n");
    await createGitHubRunEvidenceCollector({ expectedCwd: "/elsewhere", role: "primary", workspaceHead: async () => ({ head: null, tree: null }), record })("stdout", JSON.stringify(init) + "\n");
    expect(observed.map(e => [e.workspaceKind, e.workspaceHead, e.workspaceTree])).toEqual([
      ["isolated_checkout", head, tree], ["agent_home_with_network_git", null, null], ["checkout", head, tree], [null, null, undefined]]);
  });
});

describe("heartbeat stream-json evidence collector", () => {
  it("records only init facts, handles arbitrary chunk boundaries, and never records prompts or results", async () => {
    const observed: GitHubReviewRunEvidenceRecord[] = [];
    const workspaceHead = vi.fn(async () => head);
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", workspaceHead, record: async e => { observed.push(e); } });
    const line = JSON.stringify({ ...init, prompt: "SECRET PROMPT", session_id: "SECRET SESSION", model: "primary" }) + "\n";
    await collect("stderr", line);
    await collect("stdout", "ordinary diagnostic\n");
    for (const char of line) await collect("stdout", char);
    await collect("stdout", JSON.stringify({ type: "assistant", text: "SECRET ANSWER" }) + "\n");
    expect(observed).toEqual([githubRunEvidenceRecord(primary())]);
    expect(workspaceHead).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(observed)).not.toMatch(/SECRET|\/workspace|model|session_id/);
  });
  it("retains malformed and unequal reconnect evidence, not just the latest good init", async () => {
    const observed: GitHubReviewRunEvidenceRecord[] = [];
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", workspaceHead: async () => head, record: async e => { observed.push(e); } });
    for (const event of [init, { ...init, tools: undefined }, { ...init, claude_code_version: "2.1.302" }]) await collect("stdout", JSON.stringify(event) + "\n");
    expect(observed).toHaveLength(3);
    expect(observed[1]!.cli).toBeNull();
    expect(githubPairEquivalence({ admittedHead: head, primaryRuns: [observed], candidateRun: [candidate()] }).tools).toBe(false);
  });
  it("serializes concurrent log chunks while workspace and receipt I/O are pending", async () => {
    const observed: GitHubReviewRunEvidenceRecord[] = [];
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/workspace",
      workspaceHead: async () => { await waiting; return head; }, record: async e => { observed.push(e); } });
    const first = collect("stdout", JSON.stringify(init) + "\n");
    const second = collect("stdout", JSON.stringify({ ...init, claude_code_version: "2.1.302" }) + "\n");
    release();
    await Promise.all([first, second]);
    expect(observed.map(e => githubRunEvidence(e)?.cli?.claudeCodeVersion)).toEqual(["2.1.284", "2.1.302"]);
    expect(githubPairEquivalence({ admittedHead: head, primaryRuns: [observed], candidateRun: [candidate()] }).tools).toBe(false);
  });
  it("does not equate the host mirror with a different CLI cwd", async () => {
    const record = vi.fn(async (_: GitHubReviewRunEvidenceRecord) => {});
    const workspaceHead = vi.fn(async () => head);
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/host-mirror", workspaceHead, record });
    await collect("stdout", JSON.stringify(init) + "\n");
    expect(workspaceHead).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(githubRunEvidenceRecord({ ...primary(), workspaceHead: null }));
  });
  it("bounds incomplete lines and resumes at the next line boundary", async () => {
    const observed: GitHubReviewRunEvidenceRecord[] = [];
    const collect = createGitHubRunEvidenceCollector({ expectedCwd: "/workspace", workspaceHead: async () => head, record: async e => { observed.push(e); } });
    await collect("stdout", "x".repeat(256 * 1024));
    await collect("stdout", JSON.stringify(init) + "\n");
    await collect("stdout", JSON.stringify(init) + "\n");
    expect(observed).toEqual([githubRunEvidenceRecord(primary())]);
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
    expect(await githubWorkspaceState(input)).toEqual({ head: null, tree: null });
    execFileSync("git", ["init", "--quiet", cwd]);
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture"], { cwd, stdio: "pipe" });
    const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    expect(await githubWorkspaceHead(input)).toBe(actual);
    expect(await githubWorkspaceState(input)).toEqual({ head: actual, tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim() });
    expect(actual).not.toBe(head);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
