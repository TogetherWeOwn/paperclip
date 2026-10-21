import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertNativeSshLaunchAuthority,
  createEd25519NativeSshEnvelopeVerifier,
  createNativeSshHostExecutorTarget,
  getActiveNativeSshHostExecutor,
  NATIVE_SSH_ENVELOPE_AUDIENCE,
  NATIVE_SSH_SIGNER_REQUEST_VERSION,
  isNativeSshAuthorityRequired,
  nativeSshEnvelopeSigningPayload,
  requestNativeSshSignerEnvelope,
  runWithNativeSshHostExecutor,
  sha256CanonicalJson,
  type NativeSshLaunchAuthority,
  type NativeSshSignedEnvelope,
} from "./host-executor.js";

const REQUEST_ID = "73efe034-f471-4a3c-a5f0-50187895d33a";
const NOW = new Date("2026-08-29T12:00:00.000Z");
const launchInput = {
  command: "claude",
  args: ["--model", "claude-opus-5"],
  remote: {
    host: "fixture.example.test",
    port: 22,
    username: "fixture-agent",
    remoteCwd: "/srv/paperclip/run",
  },
  env: { PATH: "/usr/local/bin:/usr/bin", ANTHROPIC_API_KEY: "secret-value-never-in-authority" },
};

const keys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function seed() {
  return {
    runId: "73efe034-f471-4a3c-a5f0-50187895d340",
    companyId: "73efe034-f471-4a3c-a5f0-50187895d341",
    agentId: "73efe034-f471-4a3c-a5f0-50187895d342",
    issueId: "73efe034-f471-4a3c-a5f0-50187895d343",
    adapterType: "claude_local",
    assignedModel: {
      version: "1" as const,
      model: "claude-opus-5",
      sha256: sha256CanonicalJson("claude-opus-5"),
    },
  };
}

function expectedAuthority(overrides: Partial<{ opaqueRequestId: string; issuedAt: Date; ttlMs: number }> = {}) {
  const issuedAt = overrides.issuedAt ?? NOW;
  const base = {
    version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
    opaqueRequestId: overrides.opaqueRequestId ?? REQUEST_ID,
    ...seed(),
    command: launchInput.command,
    args: [...launchInput.args],
    remote: { ...launchInput.remote },
    argvSha256: sha256CanonicalJson({ command: launchInput.command, args: launchInput.args }),
    envKeys: Object.keys(launchInput.env).sort(),
    envSha256: sha256CanonicalJson(launchInput.env),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + (overrides.ttlMs ?? 60_000)).toISOString(),
  };
  return { ...base, launchSpecSha256: sha256CanonicalJson(base) } as NativeSshLaunchAuthority;
}

function signEnvelope(
  authority: NativeSshLaunchAuthority,
  privateKey = keys.privateKey,
): NativeSshSignedEnvelope {
  const unsigned = {
    version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
    audience: NATIVE_SSH_ENVELOPE_AUDIENCE,
    authority,
  } as const;
  return {
    ...unsigned,
    signature: cryptoSign(null, Buffer.from(nativeSshEnvelopeSigningPayload(unsigned)), privateKey).toString("base64"),
  };
}

function makeTarget(
  signer: { requestEnvelope: (request: { version: "1"; opaqueRequestId: string }) => Promise<unknown> },
  extra: Partial<Parameters<typeof createNativeSshHostExecutorTarget>[0]> = {},
) {
  return createNativeSshHostExecutorTarget({
    ...seed(),
    signer,
    verifyEnvelope: createEd25519NativeSshEnvelopeVerifier(publicKeyPem),
    persistAuthority: vi.fn(async () => {}),
    nextOpaqueRequestId: () => REQUEST_ID,
    now: () => NOW,
    ...extra,
  });
}

describe("requestNativeSshSignerEnvelope", () => {
  it.each([
    ["run", { version: "1", opaqueRequestId: REQUEST_ID, runId: "run-2" }],
    ["agent", { version: "1", opaqueRequestId: REQUEST_ID, agentId: "agent-2" }],
    ["issue", { version: "1", opaqueRequestId: REQUEST_ID, issueId: "issue-2" }],
    ["model", { version: "1", opaqueRequestId: REQUEST_ID, model: "alternate" }],
    ["argv", { version: "1", opaqueRequestId: REQUEST_ID, args: ["--override"] }],
    ["hash", { version: "1", opaqueRequestId: REQUEST_ID, launchSpecSha256: "0".repeat(64) }],
    ["expiry", { version: "1", opaqueRequestId: REQUEST_ID, expiresAt: "2099-01-01T00:00:00.000Z" }],
  ])("rejects a caller-selected %s before invoking the signer", async (_field, request) => {
    const signer = { requestEnvelope: vi.fn() };
    await expect(requestNativeSshSignerEnvelope(signer, request)).rejects.toMatchObject({
      code: "native_ssh_signer_request_invalid",
    });
    expect(signer.requestEnvelope).not.toHaveBeenCalled();
  });

  it("fails closed when no signer transport exists", async () => {
    await expect(
      requestNativeSshSignerEnvelope(null, { version: "1", opaqueRequestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "native_ssh_signer_unavailable" });
  });
});

describe("createNativeSshHostExecutorTarget", () => {
  it("persists the authority before signing and returns a verified envelope", async () => {
    const events: string[] = [];
    const authority = expectedAuthority();
    const signer = {
      requestEnvelope: vi.fn(async (request: unknown) => {
        events.push("signer");
        expect(request).toEqual({ version: "1", opaqueRequestId: REQUEST_ID });
        return signEnvelope(authority);
      }),
    };
    const persistAuthority = vi.fn(async () => {
      events.push("persist-authority");
    });
    const target = makeTarget(signer, { persistAuthority });

    const envelope = await target.authorizeLaunch(launchInput);

    expect(envelope).toEqual(signEnvelope(authority));
    expect(events).toEqual(["persist-authority", "signer"]);
    expect(persistAuthority).toHaveBeenCalledWith(authority);
    expect(() => assertNativeSshLaunchAuthority(envelope, launchInput, { now: () => NOW })).not.toThrow();
  });

  it.each([
    ["runId", { runId: "73efe034-f471-4a3c-a5f0-50187895d344" }],
    ["agentId", { agentId: "73efe034-f471-4a3c-a5f0-50187895d345" }],
    ["issueId", { issueId: "73efe034-f471-4a3c-a5f0-50187895d346" }],
    ["assigned model", { assignedModel: { ...seed().assignedModel, model: "alternate" } }],
    ["argv", { args: ["--model", "alternate"] }],
    ["hash", { launchSpecSha256: "0".repeat(64) }],
    ["lifetime", { expiresAt: new Date(NOW.getTime() + 120_000).toISOString() }],
    ["request id", { opaqueRequestId: "73efe034-f471-4a3c-a5f0-50187895d399" }],
  ])("rejects a validly signed envelope whose %s differs from the server-derived authority", async (_field, patch) => {
    const authority = { ...expectedAuthority(), ...patch } as NativeSshLaunchAuthority;
    const persistEnvelope = vi.fn();
    const target = makeTarget({ requestEnvelope: async () => signEnvelope(authority) }, { persistEnvelope });

    await expect(target.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_authority_mismatch",
    });
    expect(persistEnvelope).not.toHaveBeenCalled();
  });

  it("rejects a tampered signature, a foreign signing key and a missing signature", async () => {
    const authority = expectedAuthority();
    const good = signEnvelope(authority);
    for (const envelope of [
      { ...good, signature: Buffer.from("not-a-signature").toString("base64") },
      signEnvelope(authority, otherKeys.privateKey),
      { ...good, signature: "" },
      { ...good, audience: "someone-else" },
    ]) {
      const target = makeTarget({ requestEnvelope: async () => envelope });
      await expect(target.authorizeLaunch(launchInput)).rejects.toMatchObject({
        code: expect.stringMatching(/native_ssh_signature_invalid|native_ssh_signer_envelope_invalid/),
      });
    }
  });

  it("rejects an envelope that expired while the signer was answering", async () => {
    let clock = NOW.getTime();
    const authority = expectedAuthority();
    const target = makeTarget(
      {
        requestEnvelope: async () => {
          clock += 61_000;
          return signEnvelope(authority);
        },
      },
      { now: () => new Date(clock) },
    );
    await expect(target.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_authority_expired",
    });
  });

  it("rejects a replayed opaque request id without calling the signer a second time", async () => {
    const signer = { requestEnvelope: vi.fn(async () => signEnvelope(expectedAuthority())) };
    const target = makeTarget(signer);
    await target.authorizeLaunch(launchInput);
    await expect(target.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_authority_replayed",
    });
    expect(signer.requestEnvelope).toHaveBeenCalledOnce();
  });

  it("rejects a previously valid envelope replayed for a fresh request", async () => {
    const stale = signEnvelope(expectedAuthority());
    const ids = [REQUEST_ID, "73efe034-f471-4a3c-a5f0-50187895d34a"];
    const target = makeTarget(
      { requestEnvelope: async () => stale },
      { nextOpaqueRequestId: () => ids.shift() as string },
    );
    await target.authorizeLaunch(launchInput);
    await expect(target.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_authority_mismatch",
    });
  });

  it("fails closed without a verifier or signer", async () => {
    const noVerifier = createNativeSshHostExecutorTarget({
      ...seed(),
      signer: { requestEnvelope: async () => signEnvelope(expectedAuthority()) },
      verifyEnvelope: undefined as never,
      persistAuthority: vi.fn(async () => {}),
      nextOpaqueRequestId: () => REQUEST_ID,
      now: () => NOW,
    });
    await expect(noVerifier.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_signer_unavailable",
    });
    const noSigner = makeTarget(null as never);
    await expect(noSigner.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_signer_unavailable",
    });
  });

  it("never reaches the signer when authority persistence fails", async () => {
    const signer = { requestEnvelope: vi.fn() };
    const target = makeTarget(signer, {
      persistAuthority: async () => {
        throw new Error("ledger down");
      },
    });
    await expect(target.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_ledger_unavailable",
      message: expect.stringContaining("ledger down"),
    });
    expect(signer.requestEnvelope).not.toHaveBeenCalled();
  });

  it("refuses the launch when the envelope digest cannot be recorded", async () => {
    const target = makeTarget(
      { requestEnvelope: async () => signEnvelope(expectedAuthority()) },
      {
        persistEnvelope: async () => {
          throw new Error("ledger down");
        },
      },
    );
    await expect(target.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_ledger_unavailable",
    });
  });

  it("reports a signer transport failure as signer unavailable", async () => {
    const target = makeTarget({ requestEnvelope: async () => Promise.reject(new Error("connect ECONNREFUSED")) });
    await expect(target.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_signer_unavailable",
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("stops waiting for a signer that does not answer in time", async () => {
    const target = makeTarget({ requestEnvelope: () => new Promise(() => {}) }, { signerTimeoutMs: 20 });
    await expect(target.authorizeLaunch(launchInput)).rejects.toMatchObject({
      code: "native_ssh_signer_unavailable",
      message: expect.stringMatching(/did not answer/i),
    });
  });

  it("binds a digest of the launch environment, never its values", async () => {
    const target = makeTarget({ requestEnvelope: async () => signEnvelope(expectedAuthority()) });
    const envelope = await target.authorizeLaunch(launchInput);
    expect(envelope.authority.envSha256).toBe(sha256CanonicalJson(launchInput.env));
    // Key names let the signer judge what is set; values stay on the server.
    expect(envelope.authority.envKeys).toEqual(["ANTHROPIC_API_KEY", "PATH"]);
    expect(JSON.stringify(envelope)).not.toContain("secret-value-never-in-authority");
  });

  it("authorizes concurrent launches without one overwriting the other's recorded authority", async () => {
    // The run ledger holds one authority slot. The out-of-process signer is
    // handed only the opaque id and reads the recorded authority after a delay,
    // so interleaved persist -> sign sequences would hand launch A the envelope
    // for launch B and refuse a valid launch. The executor serializes launches.
    const slot: { authority: NativeSshLaunchAuthority | null; digest: string | null } = {
      authority: null,
      digest: null,
    };
    const ids = ["73efe034-f471-4a3c-a5f0-50187895d34a", "73efe034-f471-4a3c-a5f0-50187895d34b"];
    const launchB = { ...launchInput, args: ["--model", "claude-haiku-4-5"] };
    const target = createNativeSshHostExecutorTarget({
      ...seed(),
      signer: {
        requestEnvelope: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return signEnvelope(slot.authority!);
        },
      },
      verifyEnvelope: createEd25519NativeSshEnvelopeVerifier(publicKeyPem),
      persistAuthority: async (authority) => {
        slot.authority = authority;
        slot.digest = null;
      },
      persistEnvelope: async ({ envelopeSha256 }) => {
        slot.digest = envelopeSha256;
      },
      nextOpaqueRequestId: () => ids.shift() as string,
      now: () => NOW,
    });

    const [proofA, proofB] = await Promise.all([
      target.authorizeLaunch(launchInput),
      target.authorizeLaunch(launchB),
    ]);

    expect(proofA.authority.args).toEqual(launchInput.args);
    expect(proofB.authority.args).toEqual(launchB.args);
    expect(proofA.authority.opaqueRequestId).not.toBe(proofB.authority.opaqueRequestId);
    // Each proof verifies its own launch: no cross-signed envelope, no paired digest.
    expect(() => assertNativeSshLaunchAuthority(proofA, launchInput, { now: () => NOW })).not.toThrow();
    expect(() => assertNativeSshLaunchAuthority(proofB, launchB, { now: () => NOW })).not.toThrow();
    expect(slot.authority).toEqual(proofB.authority);
    expect(slot.digest).toBe(sha256CanonicalJson(proofB));
  });
});

describe("isNativeSshAuthorityRequired", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["off", false],
    ["required", true],
    // An unrecognized value is a misconfiguration; it enforces rather than silently disabling.
    ["requried", true],
    ["on", true],
  ])("reads %j as required=%s", (value, required) => {
    expect(isNativeSshAuthorityRequired({ PAPERCLIP_NATIVE_SSH_AUTHORITY: value })).toBe(required);
  });
});

describe("assertNativeSshLaunchAuthority", () => {
  async function issue() {
    const target = makeTarget({ requestEnvelope: async () => signEnvelope(expectedAuthority()) });
    return target.authorizeLaunch(launchInput);
  }

  it("accepts a proof exactly once", async () => {
    const envelope = await issue();
    assertNativeSshLaunchAuthority(envelope, launchInput, { now: () => NOW, consume: true });
    expect(() =>
      assertNativeSshLaunchAuthority(envelope, launchInput, { now: () => NOW, consume: true }),
    ).toThrowError(expect.objectContaining({ code: "native_ssh_authority_replayed" }));
  });

  it("rejects a hand-built proof that no executor issued", async () => {
    const forged = signEnvelope(expectedAuthority());
    expect(() => assertNativeSshLaunchAuthority(forged, launchInput, { now: () => NOW })).toThrowError(
      expect.objectContaining({ code: "native_ssh_authority_required" }),
    );
    expect(() =>
      assertNativeSshLaunchAuthority(null as never, launchInput, { now: () => NOW }),
    ).toThrowError(expect.objectContaining({ code: "native_ssh_authority_required" }));
  });

  it("rejects an expired proof", async () => {
    const envelope = await issue();
    const later = () => new Date(NOW.getTime() + 60_001);
    expect(() => assertNativeSshLaunchAuthority(envelope, launchInput, { now: later })).toThrowError(
      expect.objectContaining({ code: "native_ssh_authority_expired" }),
    );
  });

  it.each([
    ["command", { ...launchInput, command: "codex" }],
    ["args", { ...launchInput, args: [...launchInput.args, "--dangerously-skip-permissions"] }],
    ["host", { ...launchInput, remote: { ...launchInput.remote, host: "other.example.test" } }],
    ["port", { ...launchInput, remote: { ...launchInput.remote, port: 2222 } }],
    ["username", { ...launchInput, remote: { ...launchInput.remote, username: "root" } }],
    ["cwd", { ...launchInput, remote: { ...launchInput.remote, remoteCwd: "/" } }],
    ["env", { ...launchInput, env: { ...launchInput.env, NODE_OPTIONS: "--require=/tmp/hook.js" } }],
    ["PATH", { ...launchInput, env: { ...launchInput.env, PATH: "/tmp/shadow/bin" } }],
  ])("rejects a launch whose %s differs from the authorized one", async (_field, launch) => {
    const envelope = await issue();
    expect(() => assertNativeSshLaunchAuthority(envelope, launch, { now: () => NOW })).toThrowError(
      expect.objectContaining({ code: "native_ssh_authority_mismatch" }),
    );
  });

  it("issues deeply frozen proofs", async () => {
    const envelope = await issue();
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.authority)).toBe(true);
    expect(Object.isFrozen(envelope.authority.args)).toBe(true);
    expect(Object.isFrozen(envelope.authority.remote)).toBe(true);
  });
});

describe("runWithNativeSshHostExecutor", () => {
  it("scopes the executor to the async call chain only", async () => {
    const target = makeTarget({ requestEnvelope: async () => signEnvelope(expectedAuthority()) });
    expect(getActiveNativeSshHostExecutor()).toBeNull();
    await runWithNativeSshHostExecutor(target, async () => {
      await Promise.resolve();
      expect(getActiveNativeSshHostExecutor()).toBe(target);
    });
    expect(getActiveNativeSshHostExecutor()).toBeNull();
  });
});

describe("barrel browser safety", () => {
  it("keeps the host executor out of the shared barrel", () => {
    // host-executor.ts instantiates AsyncLocalStorage at module top level. The UI
    // imports the shared barrel, so re-exporting it here ships node:async_hooks
    // into browser chunks: the chunk throws at evaluation and every route that
    // loads it renders "Paperclip couldn't start". Server code imports the
    // subpath "@paperclipai/adapter-utils/host-executor" instead.
    const root = path.dirname(new URL(import.meta.url).pathname);
    const barrel = readFileSync(path.join(root, "index.ts"), "utf8");
    expect(barrel).not.toContain("host-executor");
  });
});
