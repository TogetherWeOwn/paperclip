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
import { resolveCommandForLogs, ensureCommandResolvable, runChildProcess } from "./server-utils.js";
import { buildSshSpawnTarget, type SshRemoteExecutionSpec } from "./ssh.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const verifyEnvelope = createEd25519NativeSshEnvelopeVerifier(publicKeyPem);

const RUN = "73efe034-f471-4a3c-a5f0-50187895d340";
const IDS = {
  runId: RUN,
  companyId: "73efe034-f471-4a3c-a5f0-50187895d341",
  agentId: "73efe034-f471-4a3c-a5f0-50187895d342",
  issueId: "73efe034-f471-4a3c-a5f0-50187895d343",
};
const REQUEST_ID = "73efe034-f471-4a3c-a5f0-50187895d33a";

const spec: SshRemoteExecutionSpec = {
  host: "fixture.example.test",
  port: 22,
  username: "fixture-agent",
  remoteCwd: "/srv/paperclip/run",
  remoteWorkspacePath: "/srv/paperclip/run",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----",
  knownHosts: "fixture.example.test ssh-ed25519 AAAAfixture",
  strictHostKeyChecking: true,
};
const COMMAND = "claude";
const ARGS = ["--print", "--model", "claude-opus-5"];
const launch = {
  command: COMMAND,
  args: ARGS,
  remote: { host: spec.host, port: spec.port, username: spec.username, remoteCwd: spec.remoteCwd },
};

let sandbox: string;
let fakeBin: string;
let marker: string;
let originalTmpdir: string | undefined;

function authorityFor(overrides: { args?: string[]; issuedAt?: Date; ttlMs?: number } = {}): NativeSshLaunchAuthority {
  const issuedAt = overrides.issuedAt ?? new Date();
  const args = overrides.args ?? ARGS;
  const base = {
    version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
    opaqueRequestId: REQUEST_ID,
    ...IDS,
    adapterType: "claude_local",
    assignedModel: { version: "1" as const, model: "claude-opus-5", sha256: sha256CanonicalJson("claude-opus-5") },
    command: COMMAND,
    args,
    remote: launch.remote,
    argvSha256: sha256CanonicalJson({ command: COMMAND, args }),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + (overrides.ttlMs ?? 60_000)).toISOString(),
  };
  return { ...base, launchSpecSha256: sha256CanonicalJson(base) };
}

function sign(authority: NativeSshLaunchAuthority, privateKey = keys.privateKey): NativeSshSignedEnvelope {
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

// Stand-in signer: like the real one, it is handed only the request id and signs
// the authority the executor recorded for it (passed here as `recorded`).
function executor(
  requestEnvelope: ((recorded: NativeSshLaunchAuthority) => Promise<unknown>) | null,
  extra: { now?: () => Date; nextOpaqueRequestId?: () => string } = {},
): NativeSshHostExecutorTarget {
  let recorded: NativeSshLaunchAuthority | null = null;
  return createNativeSshHostExecutorTarget({
    ...IDS,
    adapterType: "claude_local",
    assignedModel: { version: "1", model: "claude-opus-5", sha256: sha256CanonicalJson("claude-opus-5") },
    signer: { requestEnvelope: (requestEnvelope ? () => requestEnvelope(recorded!) : null) as never },
    verifyEnvelope,
    persistAuthority: async (authority) => {
      recorded = authority;
    },
    nextOpaqueRequestId: () => REQUEST_ID,
    ...extra,
  });
}

function launchWith(hostExecutor?: NativeSshHostExecutorTarget | null) {
  return runChildProcess(RUN, COMMAND, ARGS, {
    cwd: sandbox,
    env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
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

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "native-ssh-dispatch-"));
  originalTmpdir = process.env.TMPDIR;
  // Isolate temp-file artifacts so "zero key material written" is observable.
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
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("native SSH egress enforcement at the agent-launch dispatch site", () => {
  it("launches exactly once when a verified authority matches, and reports the receipt", async () => {
    const result = await launchWith(executor(async (recorded) => sign(recorded)));

    expect(result.exitCode).toBe(0);
    expect(childStarted()).toBe(true);
    expect(result.nativeSshAuthority).toMatchObject({ opaqueRequestId: REQUEST_ID });
    expect(result.nativeSshAuthority!.launchSpecSha256).toMatch(/^[a-f0-9]{64}$/);
    // Key material is cleaned up once the launch is done.
    expect(await tempArtifacts()).toEqual([]);
  });

  it("accepts an executor bound by the active run scope instead of an explicit option", async () => {
    const result = await runWithNativeSshHostExecutor(executor(async (recorded) => sign(recorded)), () => launchWith());
    expect(result.exitCode).toBe(0);
    expect(childStarted()).toBe(true);
  });

  const stale = new Date(Date.now() - 10 * 60_000);
  // First reading issues the authority in the past; later readings are the real clock, as if the
  // signer round trip outlived the authority.
  const lapsingClock = () => {
    const readings = [stale];
    return () => readings.shift() ?? new Date();
  };
  const negatives: Array<[string, () => NativeSshHostExecutorTarget | null, string]> = [
    ["no executor at all", () => null, "Native SSH execution requires"],
    ["signer unavailable", () => executor(null), "unavailable"],
    ["signer throws", () => executor(async () => Promise.reject(new Error("signer down"))), "signer down"],
    [
      "tampered signature",
      () => executor(async (recorded) => ({ ...sign(recorded), signature: Buffer.from("forged").toString("base64") })),
      "signature",
    ],
    [
      "foreign signing key",
      () => executor(async (recorded) => sign(recorded, generateKeyPairSync("ed25519").privateKey)),
      "signature",
    ],
    [
      "authority for different argv",
      () => executor(async () => sign(authorityFor({ args: [...ARGS, "--dangerously-skip-permissions"] }))),
      "does not match",
    ],
    ["expired authority", () => executor(async (recorded) => sign(recorded), { now: lapsingClock() }), "expired"],
    [
      "replayed request id",
      () => {
        const reuse = executor(async (recorded) => sign(recorded));
        return {
          kind: "native_ssh" as const,
          async authorizeLaunch(input) {
            await reuse.authorizeLaunch(input);
            return reuse.authorizeLaunch(input);
          },
        };
      },
      "already used",
    ],
  ];

  it.each(negatives)("fails closed with zero child, key material and network on: %s", async (_name, make, message) => {
    await expect(launchWith(make())).rejects.toThrow(new RegExp(message, "i"));
    expect(childStarted()).toBe(false);
    expect(await tempArtifacts()).toEqual([]);
  });

  it("does not let an inherited run-scope executor bypass an explicit denial", async () => {
    const good = executor(async (recorded) => sign(recorded));
    const readings = [stale];
    const bad = executor(async (recorded) => sign(recorded), {
      now: () => readings.shift() ?? new Date(),
    });
    await expect(runWithNativeSshHostExecutor(good, () => launchWith(bad))).rejects.toThrow(/expired/i);
    expect(childStarted()).toBe(false);
  });
});

describe("ssh.ts agent-launch builder is gated independently of its caller", () => {
  async function issue() {
    return executor(async (recorded) => sign(recorded)).authorizeLaunch(launch);
  }

  it.each([
    ["no authority", () => undefined],
    ["a structurally valid but unissued authority", () => sign(authorityFor())],
    ["a JSON round-tripped authority", async () => JSON.parse(JSON.stringify(await issue()))],
  ])("refuses %s before reading key material", async (_name, make) => {
    const authority = await make();
    await expect(
      buildSshSpawnTarget({ spec, command: COMMAND, args: ARGS, env: {}, authority: authority as never }),
    ).rejects.toMatchObject({ code: "native_ssh_authority_required" });
    expect(await tempArtifacts()).toEqual([]);
  });

  it("refuses an authority issued for a different launch", async () => {
    const proof = await issue();
    await expect(
      buildSshSpawnTarget({ spec, command: COMMAND, args: [...ARGS, "--extra"], env: {}, authority: proof }),
    ).rejects.toMatchObject({ code: "native_ssh_authority_mismatch" });
    expect(await tempArtifacts()).toEqual([]);
  });

  it("builds once and refuses to reuse the same authority", async () => {
    const proof = await issue();
    const first = await buildSshSpawnTarget({ spec, command: COMMAND, args: ARGS, env: {}, authority: proof });
    await first.cleanup();
    await expect(
      buildSshSpawnTarget({ spec, command: COMMAND, args: ARGS, env: {}, authority: proof }),
    ).rejects.toMatchObject({ code: "native_ssh_authority_replayed" });
    expect(await tempArtifacts()).toEqual([]);
  });

  it("refuses an authority that expires before the argv is built", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
      const proof = await executor(async (recorded) => sign(recorded)).authorizeLaunch(launch);
      vi.setSystemTime(new Date("2026-08-29T12:01:01.000Z"));
      await expect(
        buildSshSpawnTarget({ spec, command: COMMAND, args: ARGS, env: {}, authority: proof }),
      ).rejects.toMatchObject({ code: "native_ssh_authority_expired" });
      expect(await tempArtifacts()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ssh call-site inventory", () => {
  const root = path.dirname(new URL(import.meta.url).pathname);
  const sshSource = readFileSync(path.join(root, "ssh.ts"), "utf8");
  const serverUtilsSource = readFileSync(path.join(root, "server-utils.ts"), "utf8");

  function enclosingFunctions(source: string, needle: string): string[] {
    const lines = source.split("\n");
    const out: string[] = [];
    lines.forEach((line, index) => {
      if (!line.includes(needle)) return;
      for (let i = index; i >= 0; i -= 1) {
        const match = /^(?:export )?(?:async )?function (\w+)/.exec(lines[i]);
        if (match) {
          out.push(match[1]);
          break;
        }
      }
    });
    return [...new Set(out)].sort();
  }

  it("classifies every function that can start an ssh client or touch SSH key material", () => {
    // Anything new that spawns ssh or stages a private key must be classified here on purpose:
    //  - mediated: starts an agent command, requires an executor-issued authority.
    //  - transport: workspace/file transfer or probe commands issued by the server, never an agent launch.
    const spawners = enclosingFunctions(sshSource, 'spawn("ssh"');
    const keyStagers = enclosingFunctions(sshSource, "await createSshAuthArgs(");
    const mediated = ["buildSshSpawnTarget"];
    const transport = ["runSshCommand", "streamLocalFileToSsh", "streamSshToLocalFile", "syncDirectoryFromSsh", "syncDirectoryToSsh"];
    expect([...spawners, ...keyStagers].every((name) => [...mediated, ...transport].includes(name))).toBe(true);
    expect(keyStagers).toEqual([...mediated, ...transport].sort());
  });

  it("keeps the only agent-launch ssh spawn target behind the authority assertion", () => {
    const builder = sshSource.slice(sshSource.indexOf("export async function buildSshSpawnTarget"));
    const assertAt = builder.indexOf("assertNativeSshLaunchAuthority(");
    const keysAt = builder.indexOf("createSshAuthArgs(");
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(keysAt);
  });

  it("authorizes before resolving ssh or building the target at the spawn site", () => {
    const site = serverUtilsSource.slice(serverUtilsSource.indexOf("async function resolveSpawnTarget"));
    const authorizeAt = site.indexOf("authorizeLaunch(");
    expect(authorizeAt).toBeGreaterThan(-1);
    expect(authorizeAt).toBeLessThan(site.indexOf('resolveCommandPath("ssh"'));
    expect(authorizeAt).toBeLessThan(site.indexOf("buildSshSpawnTarget("));
  });

  it("leaves the which-ssh preflight and log-label helpers free of egress", async () => {
    // Neither may require authority: they never start a client, read a key, or reach a host.
    await expect(
      ensureCommandResolvable(COMMAND, sandbox, { PATH: fakeBin }, { remoteExecution: spec }),
    ).resolves.toBeUndefined();
    await expect(
      resolveCommandForLogs(COMMAND, sandbox, { PATH: fakeBin }, { remoteExecution: spec }),
    ).resolves.toContain("ssh://fixture-agent@fixture.example.test:22");
    expect(childStarted()).toBe(false);
    expect(await tempArtifacts()).toEqual([]);
  });
});
