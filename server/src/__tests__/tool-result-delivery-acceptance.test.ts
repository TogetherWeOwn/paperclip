import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import {
  createToolResultSpillWriter,
  defaultToolResultArguments,
  prepareToolResultDelivery,
  registerToolResultSpillWriter,
  resolveToolResultCap,
} from "../services/tool-result-delivery.js";

const CAP = 16_384;
const PREVIEW = 12_288;
const LARGE = "BEGIN\n" + "x".repeat(200 * 1024 - 10) + "\nEND";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  const content = (value as { content: unknown }).content;
  if (typeof content === "string") return content;
  return (content as Array<{ text: string }>).map((item) => item.text).join("\n");
};
const footer = (value: unknown) => {
  const match = text(value).match(/\n\n\[truncated: (\d+) bytes total; full result saved to (.+); read it with a ranged read or grep if you need more\]$/);
  expect(match, "truncated delivery must have a truthful, usable spill footer").not.toBeNull();
  return { total: Number(match![1]), file: match![2]!, preview: text(value).slice(0, match!.index) };
};

let root: string;
let scope: { companyId: string; agentId: string; runId: string };
const unregister: Array<() => void> = [];
const normalTool = { name: "github:list-commits", upstreamToolName: "list-commits", providerType: "mcp_remote_http" };

beforeEach(async () => {
  vi.stubEnv("PAPERCLIP_TOOL_RESULT_CAPS", "{}");
  vi.stubEnv("PAPERCLIP_TOOL_RESULT_MAX_BYTES", String(CAP));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-result-acceptance-"));
  scope = { companyId: randomUUID(), agentId: randomUUID(), runId: randomUUID() };
});

afterEach(async () => {
  for (const remove of unregister.splice(0)) remove();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function useDiskWriter(scratchDir: string | null = root) {
  const writer = createToolResultSpillWriter({ scope, target: null, cwd: root, scratchDir });
  unregister.push(registerToolResultSpillWriter(scope, writer));
  return writer;
}

function deliver(value: unknown, tool = normalTool, context = scope) {
  return prepareToolResultDelivery({ scope: context, invocationId: randomUUID(), tool, value, originalSizeBytes: bytes(value) });
}

describe("gateway result delivery acceptance", () => {
  it("delivers a 200 KiB result as a 12 KiB preview with a complete private spill", async () => {
    expect(Buffer.byteLength(LARGE)).toBe(200 * 1024);
    useDiskWriter();
    const result = await deliver(LARGE);
    const saved = footer(result.value);
    expect(bytes(result.value)).toBeLessThanOrEqual(CAP);
    expect(Buffer.byteLength(saved.preview)).toBe(PREVIEW);
    expect(saved.preview.startsWith("BEGIN\n")).toBe(true);
    expect(saved.preview).not.toContain("\nEND");
    expect(saved.total).toBe(bytes(LARGE));
    expect(await fs.readFile(saved.file, "utf8")).toBe(LARGE);
    expect(path.relative(root, saved.file)).not.toMatch(/^\.\./);
    expect((await fs.lstat(saved.file)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(path.dirname(saved.file))).mode & 0o777).toBe(0o700);
    expect(result.metadata).toMatchObject({ truncated: true, deliveredSizeBytes: bytes(result.value) });
  });

  it.each(["", "small result", "x".repeat(CAP - 2)])("preserves a result within the exact serialized byte limit", async (value) => {
    const writer = vi.fn(async () => path.join(root, "unused.txt"));
    unregister.push(registerToolResultSpillWriter(scope, writer));
    const result = await deliver(value);
    expect(result.value).toEqual(value);
    expect(writer).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({ truncated: false, deliveredSizeBytes: bytes(value) });
  });

  it("truncates one byte above the serialized limit", async () => {
    useDiskWriter();
    const value = "x".repeat(CAP - 1);
    expect(bytes(value)).toBe(CAP + 1);
    const result = await deliver(value);
    expect(result.metadata.truncated).toBe(true);
    expect(bytes(result.value)).toBeLessThanOrEqual(CAP);
    expect(await fs.readFile(footer(result.value).file, "utf8")).toBe(value);
  });

  it.each(["é", "界", "🙂"])("does not split UTF-8 %s code points", async (character) => {
    useDiskWriter();
    const value = "a" + character.repeat(70_000);
    const result = await deliver(value);
    const saved = footer(result.value);
    expect(saved.preview).not.toContain("�");
    expect(value.startsWith(saved.preview)).toBe(true);
    expect(Buffer.byteLength(saved.preview)).toBeLessThanOrEqual(PREVIEW);
    expect(Buffer.byteLength(saved.preview)).toBeGreaterThan(PREVIEW - 4);
    expect(bytes(result.value)).toBeLessThanOrEqual(CAP);
    expect(await fs.readFile(saved.file, "utf8")).toBe(value);
  });

  it("budgets JSON escaping and removes the duplicate structuredContent payload", async () => {
    useDiskWriter();
    const repeated = '"\\\n'.repeat(70_000);
    const value = { content: [{ type: "text", text: repeated }], structuredContent: { full: repeated }, data: { full: repeated } };
    const result = await deliver(value);
    expect(bytes(result.value)).toBeLessThanOrEqual(CAP);
    expect(JSON.stringify(result.value)).not.toContain(repeated);
    expect(result.value).not.toHaveProperty("structuredContent.full");
    expect(result.value).not.toHaveProperty("data.full");
    const saved = footer(result.value);
    expect(JSON.parse(await fs.readFile(saved.file, "utf8"))).toEqual(value);
    expect(result.metadata.deliveredSizeBytes).toBe(bytes(result.value));
  });

  it.each(["string", "array", "text-content"])("redacts a token before preview AND full spill for %s roots", async (shape) => {
    useDiskWriter();
    // Deliberately synthetic token; no live credential is read by this suite.
    const token = "ghp_" + "q".repeat(36);
    const sensitive = `prefix ${token}\n${LARGE}\nsuffix ${token}`;
    const value = shape === "string" ? sensitive : shape === "array" ? [sensitive] : { content: [{ type: "text", text: sensitive }] };
    const result = await deliver(value);
    const saved = footer(result.value);
    const full = await fs.readFile(saved.file, "utf8");
    expect(JSON.stringify(result.value)).not.toContain(token);
    expect(full).not.toContain(token);
    expect(full).toContain(REDACTED_EVENT_VALUE);
    expect(full).toContain("BEGIN");
    expect(full).toContain("END");
    expect(saved.total).toBe(bytes(value));
  });

  it.each(["actions-list", "list-commits", "list-pull-requests", "get-file-contents", "pull-request-read", "browser_snapshot"])("caps ordinary %s reads by default", async (name) => {
    useDiskWriter();
    const tool = { ...normalTool, name, upstreamToolName: name };
    expect(resolveToolResultCap(tool)).toBe(CAP);
    const result = await deliver(LARGE, tool);
    expect(result.metadata.truncated).toBe(true);
    expect(bytes(result.value)).toBeLessThanOrEqual(CAP);
  });

  it.each([
    { ...normalTool, name: "review:read_pull_request", upstreamToolName: "read_pull_request", providerType: "paperclip_github_chat" },
    { ...normalTool, name: "review:read_file", upstreamToolName: "read_file", providerType: "paperclip_github_chat" },
  ])("leaves canonical reviewer protocol read $upstreamToolName unchanged", async (tool) => {
    const writer = vi.fn(async () => "must-not-spill");
    unregister.push(registerToolResultSpillWriter(scope, writer));
    const value = { content: LARGE, structuredContent: { diff: LARGE } };
    const result = await deliver(value, tool);
    expect(result.value).toEqual(value);
    expect(result.metadata.truncated).toBe(false);
    expect(writer).not.toHaveBeenCalled();
  });

  it("does not exempt a normal read_file or a reviewer-looking display label", () => {
    expect(resolveToolResultCap({ ...normalTool, upstreamToolName: "read_file" })).toBe(CAP);
    expect(resolveToolResultCap({ ...normalTool, name: "read_pull_request", upstreamToolName: "pull-request-read" })).toBe(CAP);
  });

  it("keeps the tail of job logs, including a multibyte failure message", async () => {
    useDiskWriter();
    const value = "OLD-HEADER\n" + "🙂".repeat(60_000) + "\nFAILURE: compilation failed 界";
    const result = await deliver(value, { ...normalTool, upstreamToolName: "get-job-logs" });
    const saved = footer(result.value);
    expect(saved.preview).not.toContain("OLD-HEADER");
    expect(saved.preview.endsWith("FAILURE: compilation failed 界")).toBe(true);
    expect(saved.preview).not.toContain("�");
    expect(value.endsWith(saved.preview)).toBe(true);
    expect(bytes(result.value)).toBeLessThanOrEqual(CAP);
    expect(await fs.readFile(saved.file, "utf8")).toBe(value);
  });

  it("honors a per-tool cap without changing another tool's default", async () => {
    vi.stubEnv("PAPERCLIP_TOOL_RESULT_CAPS", JSON.stringify({ list_commits: 32_768 }));
    useDiskWriter();
    const value = "x".repeat(24_000);
    expect((await deliver(value)).value).toEqual(value);
    expect((await deliver(value, { ...normalTool, upstreamToolName: "browser_snapshot" })).metadata.truncated).toBe(true);
  });

  it.each(["runId", "companyId", "agentId"] as const)("does not use a writer from another %s", async (key) => {
    const writer = vi.fn(async () => path.join(root, "other-scope.txt"));
    unregister.push(registerToolResultSpillWriter(scope, writer));
    const result = await deliver(LARGE, normalTool, { ...scope, [key]: randomUUID() });
    expect(writer).not.toHaveBeenCalled();
    expect(result.metadata.truncated).toBe(false);
    expect(text(result.value)).not.toContain("full result saved to");
  });

  it("does not advertise a file when no workspace writer is available", async () => {
    const result = await deliver(LARGE);
    expect(result.value).toEqual(LARGE);
    expect(result.metadata).toMatchObject({ truncated: false, resultCapSkipped: expect.any(String) });
    expect(text(result.value)).not.toContain("full result saved to");
  });

  it.each(["disk full", "unsupported workspace"])("reports %s spill failure honestly", async (message) => {
    unregister.push(registerToolResultSpillWriter(scope, async () => { throw new Error(message); }));
    const result = await deliver(LARGE);
    expect(result.value).toEqual(LARGE);
    expect(result.metadata).toMatchObject({ truncated: false, resultCapSkipped: expect.any(String) });
    expect(text(result.value)).not.toContain("full result saved to");
  });

  it("unregisters completed runs and rejects duplicate writers", async () => {
    const writer = vi.fn(async () => path.join(root, "old-run.txt"));
    const remove = registerToolResultSpillWriter(scope, writer);
    unregister.push(remove);
    expect(() => registerToolResultSpillWriter(scope, writer)).toThrow();
    remove();
    const result = await deliver(LARGE);
    expect(writer).not.toHaveBeenCalled();
    expect(result.metadata.truncated).toBe(false);
  });
});

describe("controller-owned private spill filesystem", () => {
  it("refuses a symlink in the spill directory without writing into its target", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    await fs.symlink(outside, path.join(root, "tool-results"));
    const writer = useDiskWriter();
    await expect(writer({ invocationId: randomUUID(), text: LARGE })).rejects.toThrow();
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("does not overwrite an existing destination or follow a destination symlink", async () => {
    const writer = useDiskWriter();
    const invocationId = randomUUID();
    const file = await writer({ invocationId, text: "original" });
    await expect(writer({ invocationId, text: "replacement" })).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("original");
    const victim = path.join(root, "victim.txt");
    await fs.writeFile(victim, "untouched");
    const nextId = randomUUID();
    await fs.symlink(victim, path.join(path.dirname(file), `${nextId}.txt`));
    await expect(writer({ invocationId: nextId, text: LARGE })).rejects.toThrow();
    expect(await fs.readFile(victim, "utf8")).toBe("untouched");
  });

  it("rejects path traversal in the invocation identifier", async () => {
    const writer = useDiskWriter();
    await expect(writer({ invocationId: "../../caller-chosen", text: LARGE })).rejects.toThrow();
    await expect(fs.stat(path.join(root, "caller-chosen.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("separates files from two run scopes even with the same invocation identifier", async () => {
    const invocationId = randomUUID();
    const first = useDiskWriter();
    const secondScope = { ...scope, runId: randomUUID() };
    const second = createToolResultSpillWriter({ scope: secondScope, target: null, cwd: root, scratchDir: root });
    const firstPath = await first({ invocationId, text: "first run" });
    const secondPath = await second({ invocationId, text: "second run" });
    expect(firstPath).not.toBe(secondPath);
    expect(await fs.readFile(firstPath, "utf8")).toBe("first run");
    expect(await fs.readFile(secondPath, "utf8")).toBe("second run");
  });

  it("ignores provider-supplied paths and keeps files under the controller root", async () => {
    useDiskWriter();
    const victim = path.join(root, "provider-selected.txt");
    await fs.writeFile(victim, "untouched");
    const value = { content: LARGE, fullResultPath: victim, path: "../../caller-selected" };
    const result = await deliver(value);
    const saved = footer(result.value);
    expect(saved.file).not.toBe(victim);
    expect(path.relative(root, saved.file)).not.toMatch(/^\.\./);
    expect(await fs.readFile(victim, "utf8")).toBe("untouched");
  });

  it("reports a missing local scratch target rather than inventing a saved path", async () => {
    useDiskWriter(null);
    const result = await deliver(LARGE);
    expect(result.metadata.truncated).toBe(false);
    expect(text(result.value)).not.toContain("full result saved to");
  });
});

describe("job log argument defaults", () => {
  const tool = { ...normalTool, upstreamToolName: "get-job-logs" };

  it.each([undefined, null, {}, { run_id: 123 }])("defaults failed_only without mutating caller arguments", (parameters) => {
    const before = structuredClone(parameters);
    expect(defaultToolResultArguments(tool, parameters)).toEqual({ ...parameters, failed_only: true });
    expect(parameters).toEqual(before);
  });

  it.each([false, true])("honors explicit failed_only=%s", (failed_only) => {
    const parameters = { run_id: 123, failed_only };
    expect(defaultToolResultArguments(tool, parameters)).toEqual(parameters);
  });

  it("leaves other tools' parameters unchanged", () => {
    const parameters = { run_id: 123 };
    expect(defaultToolResultArguments(normalTool, parameters)).toEqual(parameters);
  });
});
