import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createEd25519NativeSshEnvelopeVerifier,
  getActiveNativeSshHostExecutor,
  nativeSshEnvelopeSigningPayload,
  NativeSshAuthorityError,
  type NativeSshLaunchAuthority,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { RUN_MODEL_DECISION_SEAM_VIOLATION_ASSIGNED_MODEL_MISSING } from "./run-model-decision.js";
import {
  createNativeSshHostExecutorForRun,
  NativeSshAssignedModelMissingError,
  runWithRunNativeSshHostExecutor,
} from "./native-ssh-authority.js";

const keys = generateKeyPairSync("ed25519");
const verifyEnvelope = createEd25519NativeSshEnvelopeVerifier(
  keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
);

const ids = {
  runId: "73efe034-f471-4a3c-a5f0-50187895d340",
  companyId: "73efe034-f471-4a3c-a5f0-50187895d341",
  agentId: "73efe034-f471-4a3c-a5f0-50187895d342",
  issueId: "73efe034-f471-4a3c-a5f0-50187895d343",
};
const sshTarget = {
  kind: "remote",
  transport: "ssh",
  remoteCwd: "/srv/run",
  spec: {
    host: "h.example.test",
    port: 22,
    username: "agent",
    remoteCwd: "/srv/run",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
  },
} as unknown as AdapterExecutionTarget;
const holder = {
  kind: "single" as const,
  holder: { pluginId: "p1", pluginKey: "model-router", envKeys: [] },
};
const decided = { model: "claude-opus-5", outcome: "decided" as const, pluginKey: "model-router" };
const launch = {
  command: "claude",
  args: ["--print"],
  remote: { host: "h.example.test", port: 22, username: "agent", remoteCwd: "/srv/run" },
};

type Input = Parameters<typeof createNativeSshHostExecutorForRun>[0];

function build(overrides: Partial<Input> = {}) {
  const persisted: NativeSshLaunchAuthority[] = [];
  const target = createNativeSshHostExecutorForRun({
    ...ids,
    target: sshTarget,
    adapterType: "claude_local",
    holder,
    decision: decided,
    verifyEnvelope,
    persistAuthority: async (authority) => {
      persisted.push(authority);
    },
    signer: {
      requestEnvelope: async () => {
        const unsigned = {
          version: "1",
          audience: "paperclip-native-ssh",
          authority: persisted.at(-1)!,
        } as const;
        return {
          ...unsigned,
          signature: cryptoSign(
            null,
            Buffer.from(nativeSshEnvelopeSigningPayload(unsigned)),
            keys.privateKey,
          ).toString("base64"),
        };
      },
    },
    ...overrides,
  });
  return { target, persisted };
}

describe("createNativeSshHostExecutorForRun", () => {
  it("binds the authority to the model the single holder decided, not to adapter config", async () => {
    const { target, persisted } = build();
    const envelope = await target!.authorizeLaunch(launch);
    expect(envelope.authority.assignedModel).toEqual({
      version: "1",
      model: "claude-opus-5",
      sha256: createHash("sha256").update("claude-opus-5").digest("hex"),
    });
    expect(persisted).toHaveLength(1);
    expect(envelope.authority).toMatchObject({ ...ids, adapterType: "claude_local" });
  });

  it.each([
    ["no target", null],
    ["a local target", { kind: "local" }],
    ["a sandbox target", { kind: "remote", transport: "sandbox", remoteCwd: "/w" }],
  ])("returns no executor for %s, even without an assigned model", (_name, target) => {
    const signer = { requestEnvelope: vi.fn() };
    expect(
      createNativeSshHostExecutorForRun({
        ...ids,
        target: target as AdapterExecutionTarget | null,
        adapterType: "claude_local",
        holder: { kind: "none" },
        decision: null,
        signer,
        verifyEnvelope,
        persistAuthority: vi.fn(),
      }),
    ).toBeNull();
    expect(signer.requestEnvelope).not.toHaveBeenCalled();
  });

  const missing: Array<[string, Partial<Input>]> = [
    ["no holder", { holder: { kind: "none" } }],
    ["a disputed holder", { holder: { kind: "conflict", pluginKeys: ["a", "b"] } }],
    ["an unverifiable holder", { holder: { kind: "unavailable", reason: "lookup failed" } }],
    ["no decision", { decision: null }],
    ["a skipped decision", { decision: { model: null, outcome: "skipped", pluginKey: null } }],
    ["a deferred decision", { decision: { model: null, outcome: "deferred", pluginKey: "model-router" } }],
    ["a decision from a foreign router", { decision: { ...decided, pluginKey: "foreign-router" } }],
    ["a keep that names no model", { decision: { model: null, outcome: "kept", pluginKey: "model-router" } }],
    ["a model-bearing record that is not a decision", { decision: { ...decided, outcome: "timeout" } }],
    ["a blank model", { decision: { ...decided, model: "  " } }],
    ["a model with control characters", { decision: { ...decided, model: "claude\nopus" } }],
  ];

  it.each(missing)(
    "fails closed with assigned_model_missing for %s, before any signer or ledger contact",
    (_name, overrides) => {
      const persistAuthority = vi.fn();
      const signer = { requestEnvelope: vi.fn() };
      let thrown: unknown;
      try {
        build({ ...overrides, persistAuthority, signer });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativeSshAssignedModelMissingError);
      expect(thrown).toMatchObject({
        code: "native_ssh_assigned_model_missing",
        violation: RUN_MODEL_DECISION_SEAM_VIOLATION_ASSIGNED_MODEL_MISSING,
      });
      expect(persistAuthority).not.toHaveBeenCalled();
      expect(signer.requestEnvelope).not.toHaveBeenCalled();
    },
  );

  it("refuses a run without an issue before any signer or ledger contact", () => {
    const persistAuthority = vi.fn();
    const signer = { requestEnvelope: vi.fn() };
    expect(() => build({ issueId: null, persistAuthority, signer })).toThrowError(NativeSshAuthorityError);
    expect(persistAuthority).not.toHaveBeenCalled();
    expect(signer.requestEnvelope).not.toHaveBeenCalled();
  });
});

describe("runWithRunNativeSshHostExecutor", () => {
  it("binds the run executor for everything the callback launches", async () => {
    const { target } = build();
    await expect(
      runWithRunNativeSshHostExecutor(target, async () => getActiveNativeSshHostExecutor()),
    ).resolves.toBe(target);
  });

  it("runs the callback unbound for a run without a native SSH executor", async () => {
    await expect(
      runWithRunNativeSshHostExecutor(null, async () => getActiveNativeSshHostExecutor()),
    ).resolves.toBeNull();
  });
});
