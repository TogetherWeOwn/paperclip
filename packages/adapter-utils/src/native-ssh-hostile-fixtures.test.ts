import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEd25519NativeSshEnvelopeVerifier,
  createNativeSshHostExecutorTarget,
  NATIVE_SSH_ENVELOPE_AUDIENCE,
  NATIVE_SSH_SIGNER_REQUEST_VERSION,
  nativeSshEnvelopeSigningPayload,
  runWithNativeSshHostExecutor,
  sha256CanonicalJson,
  type NativeSshHostExecutorTarget,
  type NativeSshLaunchAuthority,
  type NativeSshSignedEnvelope,
} from "./host-executor.js";
import { runChildProcess } from "./server-utils.js";
import type { SshRemoteExecutionSpec } from "./ssh.js";

// Offline fixture hostile matrix for the native SSH launch authority: every
// self-disable attempt below must fail closed with zero child, zero staged
// key material and zero signer contact. The fixture never reaches a host:
// a fake `ssh` on PATH records invocation to a marker file, and TMPDIR is
// isolated per test so stray key material is observable.

const RUN = "73efe034-f471-4a3c-a5f0-50187895d340";
const IDS = {
  runId: RUN,
  companyId: "73efe034-f471-4a3c-a5f0-50187895d341",
  agentId: "73efe034-f471-4a3c-a5f0-50187895d342",
  issueId: "73efe034-f471-4c83-aa9d-c76a58fae043",
};
const REQUEST_ID = "73efe034-f471-4a3c-a5f0-50187895d33a";

const spec: SshRemoteExecutionSpec = {
  host: "fixture.example.test",
  port: 22,
  username: "fixture-agent",
  remoteCwd: "/srv/paperclip/run",
  remoteWorkspacePath: "/srv/paperclip/run",
  privateKey: "fixture-private-key-not-a-real-key",
  knownHosts: "fixture.example.test ssh-ed25519 AAAAfixture",
  strictHostKeyChecking: true,
};
const COMMAND = "claude";
const ARGS = ["--print", "--model", "claude-opus-5"];

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const verifyEnvelope = createEd25519NativeSshEnvelopeVerifier(publicKeyPem);

// The attacker's key: self-signed envelopes under it must never verify.
const attackerKeys = generateKeyPairSync("ed25519");

let sandbox: string;
let fakeBin: string;
let marker: string;
let originalTmpdir: string | undefined;

function launchEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`, ...extraEnv };
}

function launchWith(
  hostExecutor?: NativeSshHostExecutorTarget | null,
  extraEnv: Record<string, string> = {},
) {
  return runChildProcess(RUN, COMMAND, ARGS, {
    cwd: sandbox,
    env: launchEnv(extraEnv),
    timeoutSec: 10,
    graceSec: 1,
    onLog: async () => {},
    remoteExecution: spec,
    ...(hostExecutor === undefined ? {} : { hostExecutor }),
  });
}

async function tempArtifacts() {
  return (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("paperclip-ssh-"));
}

function childStarted() {
  try {
    readFileSync(marker);
    return true;
  } catch {
    return false;
  }
}

/** Real executor whose stand-in signer signs exactly what was recorded. */
function honestExecutor(): NativeSshHostExecutorTarget {
  let recorded: NativeSshLaunchAuthority | null = null;
  return createNativeSshHostExecutorTarget({
    ...IDS,
    adapterType: "claude_local",
    assignedModel: { version: "1", model: "claude-opus-5", sha256: sha256CanonicalJson("claude-opus-5") },
    signer: {
      requestEnvelope: async () => {
        const unsigned = {
          version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
          audience: NATIVE_SSH_ENVELOPE_AUDIENCE,
          authority: recorded!,
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
    verifyEnvelope,
    persistAuthority: async (authority) => {
      recorded = authority;
    },
    nextOpaqueRequestId: () => REQUEST_ID,
  });
}

/**
 * Attacker-forged executor: answers authorizeLaunch with a self-signed
 * envelope under the attacker's own key. Structurally valid, cryptographically
 * self-consistent — but never issued by a server executor, so the identity
 * check must refuse it before any child, key material or host contact.
 */
function forgedExecutor(): NativeSshHostExecutorTarget {
  return {
    kind: "native_ssh",
    authorizeLaunch: async (input): Promise<NativeSshSignedEnvelope> => {
      const authority = {
        version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
        opaqueRequestId: REQUEST_ID,
        ...IDS,
        adapterType: "claude_local",
        assignedModel: {
          version: "1",
          model: "claude-opus-5",
          sha256: sha256CanonicalJson("claude-opus-5"),
        },
        command: input.command,
        args: [...input.args],
        remote: { ...input.remote },
        argvSha256: sha256CanonicalJson({ command: input.command, args: [...input.args] }),
        envKeys: Object.keys(input.env).sort(),
        envSha256: sha256CanonicalJson(input.env),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } as unknown as NativeSshLaunchAuthority;
      const withDigest = {
        ...authority,
        launchSpecSha256: sha256CanonicalJson(authority),
      };
      const unsigned = {
        version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
        audience: NATIVE_SSH_ENVELOPE_AUDIENCE,
        authority: withDigest,
      } as const;
      return {
        ...unsigned,
        signature: cryptoSign(
          null,
          Buffer.from(nativeSshEnvelopeSigningPayload(unsigned)),
          attackerKeys.privateKey,
        ).toString("base64"),
      };
    },
  } as NativeSshHostExecutorTarget;
}

beforeEach(async () => {
  // Server requires authority; caller-supplied env must not override this.
  vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", "required");
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "native-ssh-hostile-"));
  originalTmpdir = process.env.TMPDIR;
  const tmp = path.join(sandbox, "tmp");
  await fs.mkdir(tmp);
  process.env.TMPDIR = tmp;
  fakeBin = path.join(sandbox, "bin");
  marker = path.join(sandbox, "ssh-ran");
  await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(fakeBin, "ssh"), `#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\nexit 0\n`, {
    mode: 0o755,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("hostile fixtures: self-disable attempts fail closed", () => {
  it("positive control: an authorized launch still works exactly once", async () => {
    const result = await launchWith(honestExecutor());
    expect(result.exitCode).toBe(0);
    expect(childStarted()).toBe(true);
    expect(result.nativeSshAuthority).toMatchObject({ opaqueRequestId: REQUEST_ID });
    expect(await tempArtifacts()).toEqual([]);
  });

  it.each([
    ["caller env switches enforcement off", { PAPERCLIP_NATIVE_SSH_AUTHORITY: "off" }],
    ["caller env blanks the switch", { PAPERCLIP_NATIVE_SSH_AUTHORITY: "" }],
  ])("refuses with no executor when %s: server env wins", async (_name, callerEnv) => {
    await expect(launchWith(undefined, callerEnv)).rejects.toThrow(/Native SSH execution requires/i);
    expect(childStarted()).toBe(false);
    expect(await tempArtifacts()).toEqual([]);
  });

  it("refuses with no executor when the child starts from a caller-only env", async () => {
    await expect(
      runChildProcess(RUN, COMMAND, ARGS, {
        cwd: sandbox,
        env: launchEnv(),
        inheritServerEnv: false,
        timeoutSec: 10,
        graceSec: 1,
        onLog: async () => {},
        remoteExecution: spec,
      }),
    ).rejects.toThrow(/Native SSH execution requires/i);
    expect(childStarted()).toBe(false);
    expect(await tempArtifacts()).toEqual([]);
  });

  it("refuses a forged executor that returns a self-signed envelope", async () => {
    await expect(launchWith(forgedExecutor())).rejects.toThrow(
      /executor-issued signed authority/i,
    );
    expect(childStarted()).toBe(false);
    expect(await tempArtifacts()).toEqual([]);
  });

  it("refuses a forged executor smuggled through the run scope", async () => {
    await expect(runWithNativeSshHostExecutor(forgedExecutor(), () => launchWith())).rejects.toThrow(
      /executor-issued signed authority/i,
    );
    expect(childStarted()).toBe(false);
    expect(await tempArtifacts()).toEqual([]);
  });
});

describe("hostile fixtures: server misconfiguration still enforces", () => {
  it.each([["requried"], ["on"], ["yes"]])(
    "treats server value %j as enforcing, not as off",
    async (value) => {
      vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", value);
      await expect(launchWith()).rejects.toThrow(/Native SSH execution requires/i);
      expect(childStarted()).toBe(false);
      expect(await tempArtifacts()).toEqual([]);
    },
  );
});
