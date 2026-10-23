import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { parse } from "acorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nativeSshEnvelopeSigningPayload,
  type NativeSshLaunchAuthority,
} from "@paperclipai/adapter-utils/host-executor";
import {
  createNativeSshHostExecutorForRun,
  resolveNativeSshSignerPair,
} from "../services/native-ssh-authority.js";

// Execute the actual production call expression, not a hand-copied builder call.
// This isolates the heartbeat->executor configuration boundary from the database,
// scheduling, runtime and adapter. It is NOT whole-heartbeat E2E. The ledger is
// an in-memory boundary double; the executor and config resolver remain real.
// An eager resolver spread at this call site must fail the non-SSH/off cases.
const source = transformSync(
  readFileSync(new URL("../services/heartbeat.ts", import.meta.url), "utf8"),
  { loader: "ts", target: "esnext", format: "esm", treeShaking: false },
).code;
const calls: Array<{ start: number; end: number }> = [];
function visit(node: unknown) {
  if (!node || typeof node !== "object") return;
  const candidate = node as { type?: string; callee?: { type?: string; name?: string }; start: number; end: number };
  if (candidate.type === "CallExpression" && candidate.callee?.type === "Identifier"
    && candidate.callee.name === "createNativeSshHostExecutorForRun") calls.push(candidate);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else visit(value);
  }
}
visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
if (calls.length !== 1) throw new Error(`Expected exactly one heartbeat SSH executor call site; found ${calls.length}`);
const compiled = `return (${source.slice(calls[0].start, calls[0].end)});`;
const evaluate = new Function(
  "createNativeSshHostExecutorForRun", "resolveNativeSshSignerPair", "nativeSshAuthorityRunLedger",
  "options", "run", "agent", "issueRef", "executionTarget", "modelDecision", "db", "context", compiled,
);

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const sshTarget = {
  kind: "remote", transport: "ssh", remoteCwd: "/synthetic/run",
  spec: { host: "ssh.example.test", port: 22, username: "fixture", remoteCwd: "/synthetic/run",
    privateKey: null, knownHosts: null, strictHostKeyChecking: true },
};
const targets = [
  { name: "local", target: { kind: "local" }, enforcement: "required" },
  { name: "sandbox", target: { kind: "remote", transport: "sandbox", remoteCwd: "/synthetic/run" }, enforcement: "required" },
  { name: "no target", target: null, enforcement: "required" },
  { name: "dormant SSH", target: sshTarget, enforcement: "off" },
];
const malformed = [
  { name: "endpoint only", options: { nativeSshSignerEndpoint: "/synthetic/signer.sock" } },
  { name: "key only", options: { nativeSshSignerPublicKeyPem: publicKeyPem } },
  { name: "invalid key", options: { nativeSshSignerEndpoint: "/synthetic/signer.sock", nativeSshSignerPublicKeyPem: "not-a-public-key" } },
  { name: "conflicting explicit/endpoint configuration", options: {
    nativeSshSigner: { requestEnvelope: async () => { throw new Error("must not contact signer"); } },
    nativeSshEnvelopeVerifier: () => true,
    nativeSshSignerEndpoint: "/synthetic/signer.sock", nativeSshSignerPublicKeyPem: publicKeyPem,
  } },
];

function invoke(target: unknown, options: Record<string, unknown> = {}) {
  const persisted: NativeSshLaunchAuthority[] = [];
  const persistAuthority = vi.fn(async (authority: NativeSshLaunchAuthority) => { persisted.push(authority); });
  const eagerResolver = vi.fn(resolveNativeSshSignerPair);
  const executor = evaluate(
    createNativeSshHostExecutorForRun, eagerResolver, () => ({ persistAuthority }), options,
    { id: "73efe034-f471-4a3c-a5f0-50187895d340" },
    { companyId: "73efe034-f471-4a3c-a5f0-50187895d341", id: "73efe034-f471-4a3c-a5f0-50187895d342", adapterType: "claude_local" },
    { id: "73efe034-f471-4a3c-a5f0-50187895d343" }, target,
    { holder: { kind: "single", holder: { pluginId: "fixture", pluginKey: "router", envKeys: [] } },
      record: { model: "synthetic-model", outcome: "decided", pluginKey: "router" } },
    {}, {},
  ) as ReturnType<typeof createNativeSshHostExecutorForRun>;
  return { executor, persisted, persistAuthority, eagerResolver };
}

afterEach(() => vi.unstubAllEnvs());

describe("heartbeat signer configuration scoping (extracted production call)", () => {
  for (const { name, target, enforcement } of targets) {
    it.each(malformed)(`${name} ignores $name without resolving SSH configuration`, ({ options }) => {
      vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", enforcement);
      const result = invoke(target, options);
      expect(result.executor).toBeNull();
      expect(result.eagerResolver).not.toHaveBeenCalled();
      expect(result.persistAuthority).not.toHaveBeenCalled();
    });
  }

  it.each(malformed)("required SSH refuses $name before any authority is persisted", ({ options }) => {
    vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", "required");
    expect(() => invoke(sshTarget, options)).toThrowError(expect.objectContaining({ code: "native_ssh_authority_invalid" }));
  });

  it.each(targets)("$name stays dormant with no signer configuration", ({ target, enforcement }) => {
    vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", enforcement);
    expect(invoke(target).executor).toBeNull();
  });

  it("forwards a valid explicit pair through the real builder and authorizes a signed launch", async () => {
    vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", "required");
    let recorded: NativeSshLaunchAuthority[] = [];
    const requestEnvelope = vi.fn(async () => {
      const unsigned = { version: "1" as const, audience: "paperclip-native-ssh", authority: recorded.at(-1)! };
      return { ...unsigned, signature: sign(null, Buffer.from(nativeSshEnvelopeSigningPayload(unsigned)), keys.privateKey).toString("base64") };
    });
    // The public-key/endpoint path is covered by native-ssh-signer-wiring; this
    // control checks that heartbeat does not drop an explicit signer/verifier.
    const { createEd25519NativeSshEnvelopeVerifier } = await import("@paperclipai/adapter-utils/host-executor");
    const result = invoke(sshTarget, {
      nativeSshSigner: { requestEnvelope },
      nativeSshEnvelopeVerifier: createEd25519NativeSshEnvelopeVerifier(publicKeyPem),
    });
    recorded = result.persisted;
    const envelope = await result.executor!.authorizeLaunch({
      command: "synthetic-command", args: ["--fixture"], env: {},
      remote: { host: "ssh.example.test", port: 22, username: "fixture", remoteCwd: "/synthetic/run" },
    });
    expect(envelope.authority.command).toBe("synthetic-command");
    expect(envelope.authority.assignedModel.model).toBe("synthetic-model");
    expect(result.persistAuthority).toHaveBeenCalledOnce();
    expect(requestEnvelope).toHaveBeenCalledOnce();
  });
});
