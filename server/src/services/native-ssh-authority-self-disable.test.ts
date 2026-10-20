import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { createEd25519NativeSshEnvelopeVerifier } from "@paperclipai/adapter-utils/host-executor";
import { RUN_MODEL_DECISION_SEAM_VIOLATION_ASSIGNED_MODEL_MISSING } from "./run-model-decision.js";
import {
  createNativeSshHostExecutorForRun,
  NativeSshAssignedModelMissingError,
} from "./native-ssh-authority.js";

// Run-layer self-disable pins: the authority binds only a decided model from
// the single enforced holder. Legacy environment vocabulary must not rescue a
// model-less run, and a foreign decision must not borrow authority either.

const keys = generateKeyPairSync("ed25519");
const verifyEnvelope = createEd25519NativeSshEnvelopeVerifier(
  keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
);

const ids = {
  runId: "73efe034-f471-4a3c-a5f0-50187895d340",
  companyId: "73efe034-f471-4a3c-a5f0-50187895d341",
  agentId: "73efe034-f471-4a3c-a5f0-50187895d342",
  issueId: "73efe034-f471-4c83-aa9d-c76a58fae043",
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

type Input = Parameters<typeof createNativeSshHostExecutorForRun>[0];

function build(overrides: Partial<Input> = {}) {
  const persistAuthority = vi.fn();
  const signer = { requestEnvelope: vi.fn() };
  let thrown: unknown;
  try {
    createNativeSshHostExecutorForRun({
      ...ids,
      target: sshTarget,
      adapterType: "claude_local",
      holder: { kind: "none" },
      decision: null,
      verifyEnvelope,
      persistAuthority,
      signer,
      ...overrides,
    });
  } catch (error) {
    thrown = error;
  }
  return { thrown, persistAuthority, signer };
}

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", "required");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("run authority ignores legacy model environment", () => {
  it("still fails closed when the legacy assigned-model env names a model", () => {
    vi.stubEnv("PAPERCLIP_ASSIGNED_MODEL", "claude-opus-5");
    const { thrown, persistAuthority, signer } = build();
    expect(thrown).toBeInstanceOf(NativeSshAssignedModelMissingError);
    expect(thrown).toMatchObject({
      code: "native_ssh_assigned_model_missing",
      violation: RUN_MODEL_DECISION_SEAM_VIOLATION_ASSIGNED_MODEL_MISSING,
    });
    expect(persistAuthority).not.toHaveBeenCalled();
    expect(signer.requestEnvelope).not.toHaveBeenCalled();
  });

  it("still fails closed when the legacy env and a foreign decision agree", () => {
    vi.stubEnv("PAPERCLIP_ASSIGNED_MODEL", "claude-opus-5");
    const { thrown, persistAuthority, signer } = build({
      holder: {
        kind: "single",
        holder: { pluginId: "p1", pluginKey: "model-router", envKeys: [] },
      },
      decision: { model: "claude-opus-5", outcome: "decided", pluginKey: "foreign-router" },
    });
    expect(thrown).toBeInstanceOf(NativeSshAssignedModelMissingError);
    expect(persistAuthority).not.toHaveBeenCalled();
    expect(signer.requestEnvelope).not.toHaveBeenCalled();
  });
});
