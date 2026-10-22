import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEd25519NativeSshEnvelopeVerifier,
  NATIVE_SSH_ENVELOPE_AUDIENCE,
  sha256CanonicalJson,
  type NativeSshLaunchAuthority,
} from "@paperclipai/adapter-utils/host-executor";
import { createUnixSocketNativeSshSignerTransport } from "@paperclipai/adapter-utils/native-ssh-signer-transport";
import {
  createMemoryNativeSshIssueLedger,
  createNativeSshSignerDaemon,
  issueNativeSshEnvelope,
  NativeSshSignerRefusal,
  type IssueNativeSshEnvelopeInput,
  type NativeSshSignerDaemon,
  type NativeSshSignerExpectedPeer,
  type NativeSshSignerPeerIdentity,
} from "./native-ssh-signer-daemon.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const REQUEST_ID = "73efe034-f471-4a3c-a5f0-50187895d33a";
const OTHER_REQUEST_ID = "83efe034-f471-4a3c-a5f0-50187895d33b";

const keys = generateKeyPairSync("ed25519");
const verifyEnvelope = createEd25519NativeSshEnvelopeVerifier(
  keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
);

const EXPECTED_PEER: NativeSshSignerExpectedPeer = {
  uid: 1001,
  gid: 1001,
  executable: "/usr/bin/paperclip-server",
  executableSha256: "ab".repeat(32),
  cgroup: "/system.slice/paperclip.service",
};
const VALID_PEER: NativeSshSignerPeerIdentity = { pid: 4242, ...EXPECTED_PEER };

interface AuthoritySeed {
  opaqueRequestId: string;
  model: string;
  adapterType: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  remote: { host: string; port: number; username: string; remoteCwd: string };
  issuedAt: string;
  expiresAt: string;
}

const SEED: AuthoritySeed = {
  opaqueRequestId: REQUEST_ID,
  model: "claude-opus-5",
  adapterType: "claude_local",
  command: "claude",
  args: ["--model", "opus"],
  env: { PATH: "/usr/bin", FOO: "bar" },
  remote: { host: "h.example.test", port: 22, username: "agent", remoteCwd: "/srv/run" },
  issuedAt: new Date(NOW.getTime() - 5_000).toISOString(),
  expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
};

/** Builds a well-formed recorded authority exactly the way the server records one. */
function validAuthority(overrides: Partial<AuthoritySeed> = {}): NativeSshLaunchAuthority {
  const seed = { ...SEED, ...overrides };
  const base = {
    version: "1" as const,
    opaqueRequestId: seed.opaqueRequestId,
    runId: "73efe034-f471-4a3c-a5f0-50187895d340",
    companyId: "73efe034-f471-4a3c-a5f0-50187895d341",
    agentId: "73efe034-f471-4a3c-a5f0-50187895d342",
    issueId: "73efe034-f471-4c83-aa9d-c76a58fae043",
    adapterType: seed.adapterType,
    assignedModel: {
      version: "1" as const,
      model: seed.model,
      sha256: createHash("sha256").update(seed.model, "utf8").digest("hex"),
    },
    command: seed.command,
    args: [...seed.args],
    remote: { ...seed.remote },
    argvSha256: sha256CanonicalJson({ command: seed.command, args: [...seed.args] }),
    envKeys: Object.keys(seed.env).sort(),
    envSha256: sha256CanonicalJson(seed.env),
    issuedAt: seed.issuedAt,
    expiresAt: seed.expiresAt,
  };
  return { ...base, launchSpecSha256: sha256CanonicalJson(base) };
}

function issueInput(overrides: Partial<IssueNativeSshEnvelopeInput> = {}): IssueNativeSshEnvelopeInput {
  return {
    request: { version: "1", opaqueRequestId: REQUEST_ID },
    peer: { ...VALID_PEER },
    expectedPeer: { ...EXPECTED_PEER },
    policy: { audience: NATIVE_SSH_ENVELOPE_AUDIENCE, maxLifetimeSeconds: 60 },
    loadRecordedAuthority: () => validAuthority(),
    ledger: createMemoryNativeSshIssueLedger(),
    privateKey: keys.privateKey,
    now: new Date(NOW),
    hashExecutable: async () => EXPECTED_PEER.executableSha256,
    ...overrides,
  };
}

async function refusalReason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(NativeSshSignerRefusal);
  return (error as NativeSshSignerRefusal).reason;
}

describe("signer issue core", () => {
  it("issues a verifiable envelope for the recorded authority", async () => {
    const recorded = validAuthority();
    const envelope = await issueNativeSshEnvelope({ ...issueInput(), loadRecordedAuthority: () => recorded });
    expect(envelope.version).toBe("1");
    expect(envelope.audience).toBe("paperclip-native-ssh");
    expect(envelope.authority).toEqual(recorded);
    expect(typeof envelope.signature).toBe("string");
    expect(await verifyEnvelope(envelope)).toBe(true);
  });

  it("rejects malformed requests with closed reasons", async () => {
    const cases: Array<[unknown, string]> = [
      [null, "request_not_object"],
      ["opaque", "request_not_object"],
      [{}, "request_fields_invalid"],
      [{ version: "1" }, "request_fields_invalid"],
      [{ version: "1", opaqueRequestId: REQUEST_ID, extra: true }, "request_fields_invalid"],
      [{ version: "2", opaqueRequestId: REQUEST_ID }, "request_version_unsupported"],
      [{ version: "1", opaqueRequestId: "not-a-uuid" }, "opaque_request_invalid"],
    ];
    for (const [request, reason] of cases) {
      await expect(refusalReason(issueNativeSshEnvelope({ ...issueInput(), request }))).resolves.toBe(reason);
    }
  });

  it("refuses an unidentified peer", async () => {
    await expect(refusalReason(issueNativeSshEnvelope({ ...issueInput(), peer: null }))).resolves.toBe(
      "peer_identity_unavailable",
    );
  });

  it("refuses a peer whose uid or gid differs", async () => {
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), peer: { ...VALID_PEER, uid: 0 } })),
    ).resolves.toBe("peer_unauthorized");
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), peer: { ...VALID_PEER, gid: 0 } })),
    ).resolves.toBe("peer_unauthorized");
  });

  it("refuses a peer outside the pinned cgroup or executable", async () => {
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), peer: { ...VALID_PEER, cgroup: "/user.slice/evil" } })),
    ).resolves.toBe("peer_cgroup_mismatch");
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), peer: { ...VALID_PEER, executable: "/tmp/evil-server" } })),
    ).resolves.toBe("peer_executable_mismatch");
  });

  it("refuses an unreadable peer executable", async () => {
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), hashExecutable: async () => null })),
    ).resolves.toBe("peer_executable_unreadable");
  });

  it("refuses a peer whose executable digest differs (generation mismatch)", async () => {
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), hashExecutable: async () => "00".repeat(32) })),
    ).resolves.toBe("peer_generation_mismatch");
  });

  it("refuses an unknown opaque request", async () => {
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), loadRecordedAuthority: () => null })),
    ).resolves.toBe("opaque_request_not_found");
  });

  it("refuses when the recorded authority cannot be loaded", async () => {
    await expect(
      refusalReason(
        issueNativeSshEnvelope({
          ...issueInput(),
          loadRecordedAuthority: () => {
            throw new Error("ledger down");
          },
        }),
      ),
    ).resolves.toBe("authority_load_unavailable");
  });

  it("refuses a recorded authority filed under a different id", async () => {
    const recorded = validAuthority({ opaqueRequestId: OTHER_REQUEST_ID });
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), loadRecordedAuthority: () => recorded })),
    ).resolves.toBe("opaque_request_mismatch");
  });

  it("re-validates the recorded authority grammar", async () => {
    const recorded = validAuthority();
    // Time tampering must recompute the launch-spec digest, or the digest
    // check (correctly) fires before the time check is reached.
    const withTime = (issuedAt: string) => {
      const tampered = { ...recorded, issuedAt };
      const { launchSpecSha256: _dropped, ...rest } = tampered;
      return { ...tampered, launchSpecSha256: sha256CanonicalJson(rest) };
    };
    const cases: Array<[unknown, string]> = [
      ["filed-under-a-string", "authority_not_object"],
      [{ ...recorded, extra: true }, "authority_fields_invalid"],
      [Object.fromEntries(Object.entries(recorded).filter(([key]) => key !== "command")), "authority_fields_invalid"],
      [{ ...recorded, version: "2" }, "authority_version_unsupported"],
      [{ ...recorded, runId: "not-a-uuid" }, "authority_run_binding_invalid"],
      [{ ...recorded, adapterType: "" }, "authority_adapter_invalid"],
      [{ ...recorded, assignedModel: { version: "1", model: "", sha256: "ab".repeat(32) } }, "authority_model_invalid"],
      [
        { ...recorded, assignedModel: { ...recorded.assignedModel, sha256: "00".repeat(32) } },
        "authority_model_digest_mismatch",
      ],
      [{ ...recorded, command: "" }, "authority_command_invalid"],
      [{ ...recorded, args: ["ok", 5] }, "authority_command_invalid"],
      [{ ...recorded, remote: { ...recorded.remote, port: 0 } }, "authority_remote_invalid"],
      [{ ...recorded, argvSha256: "00".repeat(32) }, "authority_argv_digest_mismatch"],
      [{ ...recorded, envKeys: [...recorded.envKeys].reverse() }, "authority_env_keys_invalid"],
      [{ ...recorded, envSha256: "not-hex" }, "authority_env_digest_invalid"],
      [{ ...recorded, launchSpecSha256: "00".repeat(32) }, "authority_launch_spec_digest_mismatch"],
      [withTime(recorded.expiresAt), "authority_time_invalid"],
      [withTime("not-a-date"), "authority_time_invalid"],
    ];
    for (const [authority, reason] of cases) {
      await expect(
        refusalReason(issueNativeSshEnvelope({ ...issueInput(), loadRecordedAuthority: () => authority })),
      ).resolves.toBe(reason);
    }
  });

  it("refuses a lifetime beyond the policy cap", async () => {
    const recorded = validAuthority({
      issuedAt: new Date(NOW.getTime() - 5_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 56_000).toISOString(),
    });
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), loadRecordedAuthority: () => recorded })),
    ).resolves.toBe("lifetime_exceeds_policy");
  });

  it("enforces the absolute 60s maximum even against a lax policy", async () => {
    const recorded = validAuthority({
      issuedAt: new Date(NOW.getTime() - 5_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 56_000).toISOString(),
    });
    await expect(
      refusalReason(
        issueNativeSshEnvelope({
          ...issueInput(),
          loadRecordedAuthority: () => recorded,
          policy: { audience: NATIVE_SSH_ENVELOPE_AUDIENCE, maxLifetimeSeconds: 3600 },
        }),
      ),
    ).resolves.toBe("lifetime_exceeds_maximum");
  });

  it("refuses outside the authority time window, and issues on its edges", async () => {
    const recorded = validAuthority();
    const before = new Date(Date.parse(recorded.issuedAt) - 1);
    const after = new Date(Date.parse(recorded.expiresAt));
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), loadRecordedAuthority: () => recorded, now: before })),
    ).resolves.toBe("time_window_invalid");
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), loadRecordedAuthority: () => recorded, now: after })),
    ).resolves.toBe("time_window_invalid");
    const onIssuedAt = await issueNativeSshEnvelope({
      ...issueInput(),
      loadRecordedAuthority: () => recorded,
      now: new Date(recorded.issuedAt),
    });
    expect(await verifyEnvelope(onIssuedAt)).toBe(true);
    const beforeExpiry = await issueNativeSshEnvelope({
      ...issueInput(),
      loadRecordedAuthority: () => validAuthority({ opaqueRequestId: OTHER_REQUEST_ID }),
      request: { version: "1", opaqueRequestId: OTHER_REQUEST_ID },
      now: new Date(Date.parse(recorded.expiresAt) - 1),
    });
    expect(await verifyEnvelope(beforeExpiry)).toBe(true);
  });

  it("refuses when deployment policy withholds permission", async () => {
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), permitAuthority: () => false })),
    ).resolves.toBe("authority_policy_refused");
    await expect(
      refusalReason(
        issueNativeSshEnvelope({
          ...issueInput(),
          permitAuthority: () => {
            throw new Error("policy hook blew up");
          },
        }),
      ),
    ).resolves.toBe("authority_policy_refused");
  });

  it("issues each opaque id once and keeps ids independent", async () => {
    const ledger = createMemoryNativeSshIssueLedger();
    const first = await issueNativeSshEnvelope(issueInput({ ledger }));
    expect(await verifyEnvelope(first)).toBe(true);
    await expect(refusalReason(issueNativeSshEnvelope(issueInput({ ledger })))).resolves.toBe("opaque_request_replayed");
    const other = await issueNativeSshEnvelope(
      issueInput({
        ledger,
        request: { version: "1", opaqueRequestId: OTHER_REQUEST_ID },
        loadRecordedAuthority: () => validAuthority({ opaqueRequestId: OTHER_REQUEST_ID }),
      }),
    );
    expect(await verifyEnvelope(other)).toBe(true);
  });

  it("refuses when the ledger write fails", async () => {
    await expect(
      refusalReason(
        issueNativeSshEnvelope({
          ...issueInput(),
          ledger: {
            recordIssue: () => {
              throw new Error("disk full");
            },
          },
        }),
      ),
    ).resolves.toBe("ledger_unavailable");
  });

  it("refuses when signing fails instead of returning an unsigned envelope", async () => {
    const ecKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), privateKey: ecKeys.privateKey })),
    ).resolves.toBe("envelope_signing_failed");
    await expect(
      refusalReason(issueNativeSshEnvelope({ ...issueInput(), privateKey: keys.publicKey })),
    ).resolves.toBe("envelope_signing_failed");
  });
});

describe("daemon configuration", () => {
  function config(overrides: Record<string, unknown> = {}) {
    return {
      socketPath: join(tmpdir(), `native-ssh-signer-config-${process.pid}.sock`),
      expectedPeer: { ...EXPECTED_PEER },
      policy: { audience: NATIVE_SSH_ENVELOPE_AUDIENCE, maxLifetimeSeconds: 60 },
      privateKey: keys.privateKey,
      loadRecordedAuthority: () => null,
      peerResolver: () => null,
      ...overrides,
    };
  }

  it("fails fast on operator config faults", () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ socketPath: "" }, "socketPath"],
      [{ socketMode: 0o1000 }, "socketMode"],
      [{ expectedPeer: { ...EXPECTED_PEER, uid: -1 } }, "uid"],
      [{ expectedPeer: { ...EXPECTED_PEER, executable: "relative/path" } }, "absolute executable"],
      [{ expectedPeer: { ...EXPECTED_PEER, executableSha256: "xyz" } }, "sha256"],
      [{ expectedPeer: { ...EXPECTED_PEER, cgroup: "/a/../b" } }, "cgroup"],
      [{ policy: { audience: "wrong", maxLifetimeSeconds: 60 } }, "audience"],
      [{ policy: { audience: NATIVE_SSH_ENVELOPE_AUDIENCE, maxLifetimeSeconds: 0 } }, "maxLifetimeSeconds"],
      [{ policy: { audience: NATIVE_SSH_ENVELOPE_AUDIENCE, maxLifetimeSeconds: 61 } }, "maxLifetimeSeconds"],
      [{ privateKey: "not-a-key" }, "privateKey"],
      [{ privateKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey }, "Ed25519"],
      [{ loadRecordedAuthority: null }, "loadRecordedAuthority"],
      [{ peerResolver: null }, "peerResolver"],
      [{ readTimeoutMs: 0 }, "readTimeoutMs"],
      [{ backlog: 0 }, "backlog"],
    ];
    for (const [overrides, fragment] of bad) {
      expect(() => createNativeSshSignerDaemon(config(overrides) as never)).toThrowError(
        new RegExp(`misconfigured.*${fragment}`),
      );
    }
  });

  it("accepts an Ed25519 PEM private key", () => {
    const daemon = createNativeSshSignerDaemon(
      config({ privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }) as never,
    );
    expect(daemon.socketPath).toContain("native-ssh-signer-config");
  });
});

describe("daemon wire protocol", () => {
  let socketCounter = 0;
  const daemons: NativeSshSignerDaemon[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (daemons.length) await daemons.pop()!.close();
  });

  function socketPath(): string {
    return join(tmpdir(), `native-ssh-signer-${process.pid}-${socketCounter++}.sock`);
  }

  async function startDaemon(overrides: Record<string, unknown> = {}) {
    const records = new Map<string, NativeSshLaunchAuthority>([[REQUEST_ID, validAuthority()]]);
    const daemon = createNativeSshSignerDaemon({
      socketPath: socketPath(),
      expectedPeer: { ...EXPECTED_PEER },
      policy: { audience: NATIVE_SSH_ENVELOPE_AUDIENCE, maxLifetimeSeconds: 60 },
      privateKey: keys.privateKey,
      loadRecordedAuthority: (id: string) => records.get(id) ?? null,
      peerResolver: () => ({ ...VALID_PEER }),
      hashExecutable: async () => EXPECTED_PEER.executableSha256,
      now: () => new Date(NOW),
      ...(overrides as Record<string, never>),
    });
    await daemon.listen();
    daemons.push(daemon);
    return { daemon, records };
  }

  function readRawFrame(socket: Socket): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let received = Buffer.alloc(0);
      let frameLength = -1;
      socket.on("data", function onData(chunk: Buffer) {
        received = Buffer.concat([received, chunk]);
        if (frameLength < 0 && received.length >= 4) frameLength = received.readUInt32BE(0);
        if (frameLength >= 0 && received.length >= 4 + frameLength) {
          socket.off("data", onData);
          resolve(received.subarray(4, 4 + frameLength));
        }
      });
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("closed before frame arrived")));
    });
  }

  async function rawRequest(path: string, payload: Buffer): Promise<unknown> {
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    try {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(payload.length, 0);
      socket.write(Buffer.concat([header, payload]));
      const body = await readRawFrame(socket);
      return JSON.parse(body.toString("utf8"));
    } finally {
      socket.destroy();
    }
  }

  it("serves the transport client end to end with a verifiable envelope", async () => {
    const { daemon, records } = await startDaemon();
    const transport = createUnixSocketNativeSshSignerTransport(daemon.socketPath);
    const envelope = (await transport.requestEnvelope({ version: "1", opaqueRequestId: REQUEST_ID })) as {
      authority: NativeSshLaunchAuthority;
    } & Record<string, unknown>;
    expect(envelope.authority).toEqual(records.get(REQUEST_ID));
    expect(await verifyEnvelope(envelope as never)).toBe(true);
  });

  it("answers an unknown id with a refusal the transport surfaces", async () => {
    const { daemon } = await startDaemon();
    const transport = createUnixSocketNativeSshSignerTransport(daemon.socketPath);
    const error = await transport.requestEnvelope({ version: "1", opaqueRequestId: OTHER_REQUEST_ID }).then(
      () => null,
      (thrown: unknown) => thrown as { code: string; message: string },
    );
    expect(error?.code).toBe("native_ssh_signer_unavailable");
    expect(error?.message).toContain("opaque_request_not_found");
  });

  it("refuses a wrong protocol version with a request digest", async () => {
    const { daemon } = await startDaemon();
    const request = { version: "9", opaqueRequestId: REQUEST_ID };
    await expect(rawRequest(daemon.socketPath, Buffer.from(JSON.stringify(request), "utf8"))).resolves.toEqual({
      ok: false,
      reason: "request_version_unsupported",
      requestDigest: sha256CanonicalJson(request),
    });
  });

  it("refuses an oversize frame length without waiting for the body", async () => {
    const { daemon } = await startDaemon({ readTimeoutMs: 5000 });
    const socket = connect(daemon.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    try {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(64 * 1024 + 1, 0);
      socket.write(header);
      const body = await readRawFrame(socket);
      expect(JSON.parse(body.toString("utf8"))).toEqual({
        ok: false,
        reason: "request_frame_invalid",
        requestDigest: sha256CanonicalJson(null),
      });
    } finally {
      socket.destroy();
    }
  });

  it("refuses invalid JSON and keeps serving afterwards", async () => {
    const { daemon } = await startDaemon();
    await expect(rawRequest(daemon.socketPath, Buffer.from("{nope", "utf8"))).resolves.toMatchObject({
      ok: false,
      reason: "request_json_invalid",
    });
    const transport = createUnixSocketNativeSshSignerTransport(daemon.socketPath);
    const envelope = await transport.requestEnvelope({ version: "1", opaqueRequestId: REQUEST_ID });
    expect(await verifyEnvelope(envelope as never)).toBe(true);
  });

  it("refuses a throwing peer resolver as unidentified", async () => {
    const { daemon } = await startDaemon({
      peerResolver: () => {
        throw new Error("no native binding");
      },
    });
    const transport = createUnixSocketNativeSshSignerTransport(daemon.socketPath);
    const error = await transport.requestEnvelope({ version: "1", opaqueRequestId: REQUEST_ID }).then(
      () => null,
      (thrown: unknown) => thrown as { code: string; message: string },
    );
    expect(error?.message).toContain("peer_identity_unavailable");
  });

  it("replays are refused while distinct ids succeed concurrently", async () => {
    const secondId = "93efe034-f471-4a3c-a5f0-50187895d33c";
    const { daemon, records } = await startDaemon();
    records.set(secondId, validAuthority({ opaqueRequestId: secondId }));
    const transport = createUnixSocketNativeSshSignerTransport(daemon.socketPath);
    const [first, second] = await Promise.all([
      transport.requestEnvelope({ version: "1", opaqueRequestId: REQUEST_ID }),
      transport.requestEnvelope({ version: "1", opaqueRequestId: secondId }),
    ]);
    expect(await verifyEnvelope(first as never)).toBe(true);
    expect(await verifyEnvelope(second as never)).toBe(true);
    const replay = await transport.requestEnvelope({ version: "1", opaqueRequestId: REQUEST_ID }).then(
      () => null,
      (thrown: unknown) => thrown as { code: string; message: string },
    );
    expect(replay?.message).toContain("opaque_request_replayed");
  });

  it("reports refusals to the observability hook with the opaque id", async () => {
    const seen: Array<{ reason: string; opaqueRequestId: string | null }> = [];
    const { daemon } = await startDaemon({ onRefusal: (info: never) => seen.push(info as never) });
    await rawRequest(daemon.socketPath, Buffer.from(JSON.stringify({ version: "9", opaqueRequestId: REQUEST_ID }), "utf8"));
    expect(seen).toEqual([
      { reason: "request_version_unsupported", detail: expect.any(String), opaqueRequestId: REQUEST_ID },
    ]);
  });

  it("binds the socket with mode 0660, replaces a stale path, and unlinks on close", async () => {
    const path = socketPath();
    await writeFile(path, "stale");
    const { daemon } = await startDaemon({ socketPath: path });
    expect(existsSync(path)).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o660);
    await daemon.close();
    expect(existsSync(path)).toBe(false);
  });

  it("creates missing parent directories for the socket", async () => {
    const nested = join(tmpdir(), `native-ssh-signer-nested-${process.pid}`, "a", "b", "signer.sock");
    const { daemon } = await startDaemon({ socketPath: nested });
    expect(existsSync(nested)).toBe(true);
    await daemon.close();
  });
});

describe("signer daemon self-disable pins", () => {
  it("enforcement does not consult ambient authority configuration", async () => {
    vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", "");
    vi.stubEnv("PAPERCLIP_NATIVE_SSH_SIGNER_SOCKET", "/nonexistent/rogue.sock");
    const records = new Map<string, NativeSshLaunchAuthority>([[REQUEST_ID, validAuthority()]]);
    const daemon = createNativeSshSignerDaemon({
      socketPath: join(tmpdir(), `native-ssh-signer-env-${process.pid}.sock`),
      expectedPeer: { ...EXPECTED_PEER },
      policy: { audience: NATIVE_SSH_ENVELOPE_AUDIENCE, maxLifetimeSeconds: 60 },
      privateKey: keys.privateKey,
      loadRecordedAuthority: (id: string) => records.get(id) ?? null,
      peerResolver: () => ({ ...VALID_PEER }),
      hashExecutable: async () => EXPECTED_PEER.executableSha256,
      now: () => new Date(NOW),
    });
    await daemon.listen();
    try {
      const transport = createUnixSocketNativeSshSignerTransport(daemon.socketPath);
      const error = await transport.requestEnvelope({ version: "1", opaqueRequestId: OTHER_REQUEST_ID }).then(
        () => null,
        (thrown: unknown) => thrown as { code: string; message: string },
      );
      expect(error?.message).toContain("opaque_request_not_found");
      const envelope = await transport.requestEnvelope({ version: "1", opaqueRequestId: REQUEST_ID });
      expect(await verifyEnvelope(envelope as never)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await daemon.close();
    }
  });
});
