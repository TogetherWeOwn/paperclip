import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runAdapterExecutionTargetProcess, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { NativeSshHostExecutorTarget } from "@paperclipai/adapter-utils/host-executor";
import { redactEventPayload } from "../redaction.js";

export const DEFAULT_TOOL_RESULT_MAX_BYTES = 16 * 1024;
const PREVIEW_BYTES = 12 * 1024;
const MAX_CONFIGURED_BYTES = 1024 * 1024;

export interface ToolResultScope {
  companyId: string;
  agentId: string | null;
  runId: string | null;
}

interface ResultTool {
  name: string;
  upstreamToolName?: string | null;
  providerType?: string;
  connectionId?: string | null;
  applicationKey?: string | null;
}

type SpillWriter = (input: { invocationId: string; text: string }) => Promise<string>;
const spillWriters = new Map<string, SpillWriter>();
const scopeKey = (scope: ToolResultScope) => JSON.stringify([scope.companyId, scope.agentId, scope.runId]);

/** Only the run controller registers writers. Tool arguments cannot select a path or target. */
export function registerToolResultSpillWriter(scope: ToolResultScope, writer: SpillWriter) {
  if (!scope.agentId || !scope.runId) throw new Error("Tool-result writer requires a run binding");
  const key = scopeKey(scope);
  if (spillWriters.has(key)) throw new Error("Tool-result writer already registered for run");
  spillWriters.set(key, writer);
  return () => {
    if (spillWriters.get(key) === writer) spillWriters.delete(key);
  };
}

export function createToolResultSpillWriter(input: {
  scope: ToolResultScope;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  scratchDir: string | null;
  hostExecutor?: NativeSshHostExecutorTarget | null;
}): SpillWriter {
  const remote = input.target?.kind === "remote";
  const root = input.target?.kind === "remote" ? input.target.remoteCwd : input.scratchDir;
  return async ({ invocationId, text }) => {
    if (!root || !input.scope.runId) throw new Error("Tool-result spill target unavailable");
    const program = await readFile(new URL("./scripts/tool-result-spill.mjs", import.meta.url), "utf8");
    // Auxiliary children must not replace the agent's run-keyed Stop handle.
    const result = await runAdapterExecutionTargetProcess(
      `tool-result-spill-${randomUUID()}`, input.target, "node", ["--input-type=module", "-e", program], {
        cwd: input.cwd,
        env: {},
        stdin: JSON.stringify({ root, remote, runId: input.scope.runId, invocationId, text }),
        timeoutSec: 15,
        graceSec: 1,
        hostExecutor: input.hostExecutor,
        // The private payload and any provider diagnostics must never enter run logs.
        onLog: async () => {},
      },
    );
    if (result.exitCode !== 0 || result.timedOut || result.signal) throw new Error("Tool-result spill failed");
    const receipt = JSON.parse(result.stdout) as { path?: unknown; sizeBytes?: unknown };
    if (typeof receipt.path !== "string" || receipt.sizeBytes !== Buffer.byteLength(text, "utf8")) {
      throw new Error("Tool-result spill receipt mismatch");
    }
    return receipt.path;
  };
}

function configuredCap(value: unknown): number | undefined {
  const cap = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof cap === "number" && Number.isSafeInteger(cap) &&
    (cap === 0 || (cap >= 1024 && cap <= MAX_CONFIGURED_BYTES)) ? cap : undefined;
}

export function resolveToolResultCap(tool: ResultTool, env = process.env, resultMaxBytes?: number): number {
  const name = (tool.upstreamToolName ?? tool.name).replaceAll("-", "_");
  // These are the reviewer protocol's canonical reads, not tool display labels.
  if (name === "read_pull_request" || (tool.providerType === "paperclip_github_chat" && name === "read_file")) return 0;
  const profileCap = configuredCap(resultMaxBytes);
  if (profileCap !== undefined) return profileCap;
  let overrides: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(env.PAPERCLIP_TOOL_RESULT_CAPS ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed as Record<string, unknown>;
  } catch { /* Invalid overrides retain the safe default. */ }
  for (const key of [
    tool.connectionId ? `${tool.connectionId}/${name}` : null,
    tool.applicationKey ? `${tool.applicationKey}/${name}` : null,
    name,
  ]) {
    if (key && Object.hasOwn(overrides, key)) {
      const cap = configuredCap(overrides[key]);
      if (cap !== undefined) return cap;
    }
  }
  return configuredCap(env.PAPERCLIP_TOOL_RESULT_MAX_BYTES) ?? DEFAULT_TOOL_RESULT_MAX_BYTES;
}

export function defaultToolResultArguments(tool: ResultTool, parameters: unknown): unknown {
  if ((tool.upstreamToolName ?? tool.name).replaceAll("-", "_") !== "get_job_logs") return parameters;
  if (parameters === undefined || parameters === null) return { failed_only: true };
  if (typeof parameters !== "object" || Array.isArray(parameters)) return parameters;
  const record = parameters as Record<string, unknown>;
  return record.failed_only === undefined ? { ...record, failed_only: true } : parameters;
}

function utf8Preview(text: string, maxBytes: number, tail: boolean): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  if (tail) {
    let start = bytes.length - maxBytes;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function resultText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const content = (value as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    if (!content.every((item) => item && item.type === "text" && typeof item.text === "string")) return null;
    return content.map((item) => item.text).join("\n");
  }
  return JSON.stringify(value);
}

export async function prepareToolResultDelivery(input: {
  scope: ToolResultScope;
  invocationId: string;
  tool: ResultTool;
  value: unknown;
  originalSizeBytes: number;
  resultMaxBytes?: number;
}) {
  // Defense in depth for string/array roots as well as nested text content.
  const value = redactEventPayload({ result: input.value })!.result;
  const size = (result: unknown) => Buffer.byteLength(JSON.stringify(result) ?? "null", "utf8");
  const cap = resolveToolResultCap(input.tool, process.env, input.resultMaxBytes);
  const unchanged = (reason?: string) => ({
    value,
    metadata: { truncated: false, deliveredSizeBytes: size(value), ...(reason ? { resultCapSkipped: reason } : {}) },
  });
  if (!input.scope.runId || !input.scope.agentId || cap === 0 || size(value) <= cap) return unchanged();
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const pluginEnvelope = record && typeof record.pluginId === "string" && typeof record.toolName === "string" &&
    record.result && typeof record.result === "object" ? record : null;
  const textValue = pluginEnvelope ? pluginEnvelope.result : value;
  const text = resultText(textValue);
  if (text === null) return unchanged("non_text_result");
  const writer = spillWriters.get(scopeKey(input.scope));
  if (!writer) return unchanged("spill_writer_unavailable");
  const spillText = typeof value === "string" ? value : JSON.stringify(value);
  let file: string;
  try {
    file = await writer({ invocationId: input.invocationId, text: spillText });
  } catch {
    // The provider may already have made a write. Do not fail or replay it just
    // because a private spill could not be made; make degradation measurable.
    return unchanged("spill_write_failed");
  }
  const footer = `\n\n[truncated: ${input.originalSizeBytes} bytes total; full result saved to ${file}; read it with a ranged read or grep if you need more]`;
  const tail = (input.tool.upstreamToolName ?? input.tool.name).replaceAll("-", "_") === "get_job_logs";
  const preview = (bytes: number) => {
    const textRecord = textValue && typeof textValue === "object" ? textValue as Record<string, unknown> : null;
    const result = {
      content: [{ type: "text", text: utf8Preview(text, bytes, tail) + footer }],
      structuredContent: { truncated: true, fullResultPath: file, totalBytes: input.originalSizeBytes },
      isError: record?.isError === true || textRecord?.isError === true,
    };
    return pluginEnvelope ? { pluginId: pluginEnvelope.pluginId, toolName: pluginEnvelope.toolName, result } : result;
  };
  if (size(preview(0)) > cap) return unchanged("spill_footer_exceeds_cap");
  // Budget the serialized envelope too: escaped JSON/newlines can double the
  // visible text's bytes, and content/data must not retain a second full copy.
  let low = 0;
  let high = PREVIEW_BYTES;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(preview(middle)) <= cap) low = middle;
    else high = middle - 1;
  }
  const delivered = preview(low);
  return { value: delivered, metadata: { truncated: true, deliveredSizeBytes: size(delivered) } };
}
