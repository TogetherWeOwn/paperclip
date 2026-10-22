import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEd25519NativeSshEnvelopeVerifier,
  createNativeSshHostExecutorTarget,
  NATIVE_SSH_ENVELOPE_AUDIENCE,
  NATIVE_SSH_SIGNER_REQUEST_VERSION,
  nativeSshEnvelopeSigningPayload,
  sha256CanonicalJson,
  type NativeSshLaunchAuthority,
} from "./host-executor.js";
import {
  buildNativeSshHostVerifierLinks,
  buildNativeSshVerifiedRemoteScript,
  NATIVE_SSH_HOST_CLOCK_SKEW_SEC,
  NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT,
  nativeSshHostArgvDigest,
  nativeSshHostBindingDigest,
  nativeSshHostEnvDigest,
} from "./native-ssh-host-verifier.js";
import {
  SSH_REMOTE_ARG_MAX_BYTES,
  sshScriptOuterQuotedBytes,
} from "./remote-execution-env.js";
import {
  buildSshSpawnTarget,
  shellQuote,
  sshLaunchEnv,
  sshVerifiedEnvEntryFinalBytes,
  SSH_LOGIN_PROFILE_LINES,
  SSH_VERIFIED_RESERVATION_BINDING,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const verifyEnvelope = createEd25519NativeSshEnvelopeVerifier(publicKeyPem);

const IDS = {
  runId: "73efe034-f471-4a3c-a5f0-50187895d340",
  companyId: "73efe034-f471-4a3c-a5f0-50187895d341",
  agentId: "73efe034-f471-4a3c-a5f0-50187895d342",
  issueId: "73efe034-f471-4a3c-a5f0-50187895d343",
};
const REQUEST_ID = "73efe034-f471-4a3c-a5f0-50187895d33a";
const USER = os.userInfo().username;

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

let sandbox: string;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bindingFor(expiresAt: Date = new Date(Date.now() + 60_000)) {
  return { expiresAt: expiresAt.toISOString(), opaqueRequestId: REQUEST_ID };
}

function linksFor(
  overrides: Partial<Parameters<typeof buildNativeSshHostVerifierLinks>[0]> = {},
): string[] {
  return buildNativeSshHostVerifierLinks({
    username: USER,
    remoteCwd: sandbox,
    command: "my-cmd",
    args: ["a1", "a2"],
    launchEnv: { FOO: "bar", NUM: "42" },
    binding: bindingFor(),
    ...overrides,
  });
}

function runScript(script: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  // Absolute shell: tool-stub tests run with a restricted PATH.
  return spawnSync("/bin/sh", ["-c", script], {
    cwd: opts.cwd ?? sandbox,
    env: opts.env ?? process.env,
    encoding: "utf8",
  }) as SpawnSyncReturns<string>;
}

function sign(recorded: NativeSshLaunchAuthority) {
  const unsigned = {
    version: NATIVE_SSH_SIGNER_REQUEST_VERSION,
    audience: NATIVE_SSH_ENVELOPE_AUDIENCE,
    authority: recorded,
  } as const;
  return {
    ...unsigned,
    signature: cryptoSign(null, Buffer.from(nativeSshEnvelopeSigningPayload(unsigned)), keys.privateKey).toString(
      "base64",
    ),
  };
}

/** A proof issued exactly the way resolveSpawnTarget issues one. */
async function authorizeFor(
  env: Record<string, string>,
  command: string = COMMAND,
  args: string[] = ARGS,
) {
  let recorded: NativeSshLaunchAuthority | null = null;
  const target = createNativeSshHostExecutorTarget({
    ...IDS,
    adapterType: "claude_local",
    assignedModel: { version: "1", model: "claude-opus-5", sha256: sha256CanonicalJson("claude-opus-5") },
    signer: { requestEnvelope: async () => sign(recorded!) },
    verifyEnvelope,
    persistAuthority: async (authority) => {
      recorded = authority;
    },
    nextOpaqueRequestId: () => REQUEST_ID,
  });
  return target.authorizeLaunch({
    command,
    args,
    remote: { host: spec.host, port: spec.port, username: spec.username, remoteCwd: spec.remoteCwd },
    env,
  });
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "native-ssh-host-verify-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("host binding digest", () => {
  it("hashes the empty record list to the empty-string digest", () => {
    expect(nativeSshHostBindingDigest([])).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("pins known digests, including multibyte records hashed as UTF-8 bytes", () => {
    expect(nativeSshHostBindingDigest(["é"])).toBe(
      "e596a79e6c62eb6751ed2a6cf89823a9623aca8282abf60814d2d7e384d8665b",
    );
    expect(nativeSshHostBindingDigest([""])).toBe(
      "cd372fb85148700fa88095e3492d3f9f5beb43e555e5ff26d95f5a6adc36f8e6",
    );
  });

  it("is order-sensitive and unambiguous across record boundaries", () => {
    expect(nativeSshHostBindingDigest(["ab", "c"])).toBe(
      "14eec32d1bd92fe52253ef7547e20407b0dd70dbc835e3cbbb81dd8ef52ca6c7",
    );
    expect(nativeSshHostBindingDigest(["a", "bc"])).toBe(
      "1b1523301a6d369a2c5b449878470cf36660521c60f4254f1e9169052dafd3ea",
    );
    expect(nativeSshHostBindingDigest(["a", "b"])).not.toBe(nativeSshHostBindingDigest(["b", "a"]));
  });

  it("frames argv as command-plus-args and env as sorted KEY=VALUE records", () => {
    expect(nativeSshHostArgvDigest("c", ["a", "b"])).toBe(nativeSshHostBindingDigest(["c", "a", "b"]));
    expect(nativeSshHostEnvDigest({ B: "1", A: "2" })).toBe(nativeSshHostBindingDigest(["A=2", "B=1"]));
    expect(nativeSshHostEnvDigest({})).toBe(nativeSshHostBindingDigest([]));
  });
});

describe("verified script generation", () => {
  function scriptFor(
    overrides: Partial<Parameters<typeof buildNativeSshVerifiedRemoteScript>[0]> = {},
  ): string {
    return buildNativeSshVerifiedRemoteScript({
      profileLines: ["PROFILE_ONE", "PROFILE_TWO"],
      username: "some-user",
      remoteCwd: "/srv/run",
      command: COMMAND,
      args: ARGS,
      launchEnv: { B_KEY: "b", A_KEY: "a" },
      binding: bindingFor(),
      ...overrides,
    });
  }

  it("assembles profiles, cd, verifier and exec in order", () => {
    const script = scriptFor();
    const order = [
      "PROFILE_ONE",
      "PROFILE_TWO",
      "cd '/srv/run'",
      "set +e +u",
      "unset IFS",
      "paperclip_expected_argv='",
      "paperclip_expected_env='",
      "paperclip_expected_user='some-user'",
      "paperclip_expected_cwd='/srv/run'",
      "paperclip_expires_at='",
      `paperclip_opaque_id='${REQUEST_ID}'`,
      "set -- 'claude'",
      "id -un",
      "date +%s",
      "command -v sha256sum",
      'for paperclip_item in "$@"',
      "export A_KEY='a'",
      "export B_KEY='b'",
      'for paperclip_item in "A_KEY=$A_KEY" "B_KEY=$B_KEY"',
      'exec "$@"',
    ];
    let at = -1;
    for (const needle of order) {
      const next = script.indexOf(needle, at + 1);
      expect(next, `expected ${needle} after offset ${at}`).toBeGreaterThan(at);
      at = next;
    }
    expect(script.endsWith('exec "$@"')).toBe(true);
    // Exports follow the same sorted order the digest is computed over.
    expect(script.indexOf("export A_KEY=")).toBeLessThan(script.indexOf("export B_KEY="));
  });

  it("embeds the expiry with the documented clock-skew allowance", () => {
    const expiresAt = new Date("2026-10-22T12:00:00.000Z");
    const script = scriptFor({ binding: { ...bindingFor(expiresAt), opaqueRequestId: REQUEST_ID } });
    const epoch = Math.floor(expiresAt.getTime() / 1000) + NATIVE_SSH_HOST_CLOCK_SKEW_SEC;
    expect(script).toContain(`paperclip_expires_at='${epoch}'`);
  });

  it("quotes values exactly like the ssh lane", () => {
    const hostile = "a'b\"c$d`e!f%g-h\nünï☃ ";
    const script = scriptFor({ command: hostile, args: [hostile], launchEnv: { Q: hostile } });
    const quoted = shellQuote(hostile);
    expect(quoted).toContain(`'"'"'`);
    expect(script).toContain(`set -- ${quoted} ${quoted}`);
    expect(script).toContain(`export Q=${quoted}`);
  });

  it("omits the cwd check for a relative working directory", () => {
    const script = scriptFor({ remoteCwd: "relative/dir" });
    expect(script).toContain("cd 'relative/dir'");
    expect(script).not.toContain("paperclip_expected_cwd");
    expect(script).not.toContain("pwd -P");
  });

  it("normalizes a trailing slash off the expected cwd, keeping root intact", () => {
    expect(scriptFor({ remoteCwd: "/srv/run/" })).toContain("paperclip_expected_cwd='/srv/run'");
    expect(scriptFor({ remoteCwd: "/" })).toContain("paperclip_expected_cwd='/'");
  });

  it.each([
    ["empty command", { command: "" }],
    ["non-array args", { args: "nope" }],
    ["non-string arg", { args: ["ok", 7] }],
    ["NUL in command", { command: "a\0b" }],
    ["NUL in arg", { args: ["a\0b"] }],
    ["NUL in env value", { launchEnv: { A: "a\0b" } }],
    ["NUL in username", { username: "a\0b" }],
    ["NUL in cwd", { remoteCwd: "/srv\0/run" }],
    ["empty username", { username: "" }],
    ["empty cwd", { remoteCwd: "" }],
    ["invalid env key", { launchEnv: { "NO-GOOD": "x" } }],
    ["numeric env key", { launchEnv: { "9LIVES": "x" } }],
    ["non-string env value", { launchEnv: { A: 7 } }],
    ["non-object env", { launchEnv: "nope" }],
    ["bad opaque id", { binding: { expiresAt: new Date().toISOString(), opaqueRequestId: "not-a-uuid" } }],
    ["bad expiry", { binding: { expiresAt: "not-a-date", opaqueRequestId: REQUEST_ID } }],
    ["null binding", { binding: null }],
  ])("refuses to generate for %s", (_name, overrides) => {
    expect(() =>
      scriptFor(overrides as unknown as Parameters<typeof buildNativeSshVerifiedRemoteScript>[0]),
    ).toThrowError(expect.objectContaining({ name: "NativeSshAuthorityError" }));
  });
});

describe("verified links on a real shell", () => {
  it("reaches the exec line with argv and env intact on a matching launch", () => {
    const script = [...linksFor(), 'echo "ARGS:$1:$2:$3"', 'echo "FOO=$FOO"', 'echo "NUM=$NUM"'].join(" && ");
    const result = runScript(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ARGS:my-cmd:a1:a2");
    expect(result.stdout).toContain("FOO=bar");
    expect(result.stdout).toContain("NUM=42");
  });

  it("execs the verified command end to end through the assembled script", () => {
    const script = buildNativeSshVerifiedRemoteScript({
      profileLines: [],
      username: USER,
      remoteCwd: sandbox,
      command: "echo",
      args: ["hello-verified"],
      launchEnv: { X: "1" },
      binding: bindingFor(),
    });
    const result = runScript(script, { cwd: os.tmpdir() });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("hello-verified\n");
  });

  it("refuses with 125 and runs nothing when the argv was altered after signing", () => {
    const tampered = linksFor().map((link) =>
      link.startsWith("set -- ") ? `${link} 'injected'` : link,
    );
    const result = runScript([...tampered, 'echo "REACHED:$1"'].join(" && "));
    expect(result.status).toBe(NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT);
    expect(result.stderr).toContain(REQUEST_ID);
    expect(result.stderr).toContain("command does not match the launch authority");
    expect(result.stdout).not.toContain("REACHED");
  });

  it("refuses with 125 and runs nothing when the env was altered after signing", () => {
    const tampered = linksFor().map((link) =>
      link === "export FOO='bar'" ? "export FOO='evil'" : link,
    );
    const result = runScript([...tampered, 'echo "REACHED:$FOO"'].join(" && "));
    expect(result.status).toBe(NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT);
    expect(result.stderr).toContain("environment does not match the launch authority");
    expect(result.stdout).not.toContain("REACHED");
  });

  it("refuses when the embedded expected digest no longer matches", () => {
    const argvDigest = nativeSshHostArgvDigest("my-cmd", ["a1", "a2"]);
    const tampered = linksFor().map((link) => link.replace(argvDigest, "0".repeat(64)));
    const result = runScript([...tampered, 'echo "REACHED"'].join(" && "));
    expect(result.status).toBe(NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT);
    expect(result.stdout).not.toContain("REACHED");
  });

  it("refuses an expired authority at exec time", () => {
    const links = linksFor({ binding: bindingFor(new Date(Date.now() - 60_000)) });
    const result = runScript([...links, 'echo "REACHED"'].join(" && "));
    expect(result.status).toBe(NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT);
    expect(result.stderr).toContain("launch authority expired");
    expect(result.stdout).not.toContain("REACHED");
  });

  it("refuses when the remote user is not the bound one", () => {
    const links = linksFor({ username: "definitely-not-the-test-user" });
    const result = runScript([...links, 'echo "REACHED"'].join(" && "));
    expect(result.status).toBe(NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT);
    expect(result.stderr).toContain("unexpected remote user");
    expect(result.stdout).not.toContain("REACHED");
  });

  it("refuses when the working directory is not the bound one", () => {
    const links = linksFor({ remoteCwd: "/definitely/not/the-bound-dir" });
    const result = runScript([...links, 'echo "REACHED"'].join(" && "));
    expect(result.status).toBe(NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT);
    expect(result.stderr).toContain("unexpected working directory");
    expect(result.stdout).not.toContain("REACHED");
  });

  it("accepts either spelling of a symlinked working directory", async () => {
    const real = path.join(sandbox, "real");
    await fs.mkdir(real);
    const link = path.join(sandbox, "link");
    await fs.symlink(real, link, "dir");
    for (const expected of [link, await fs.realpath(real)]) {
      const links = linksFor({ remoteCwd: expected });
      const result = runScript(`cd ${shellQuote(link)} && ${links.join(" && ")} && echo REACHED`);
      expect(result.status, `expected ${expected}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("REACHED");
    }
  });

  it("refuses when the host clock is unreadable", async () => {
    const fakeBin = path.join(sandbox, "bin");
    await fs.mkdir(fakeBin);
    const stapler = async (name: string, body: string) =>
      fs.writeFile(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await stapler("date", 'echo "not-a-clock"');
    await stapler("id", 'exec /usr/bin/id "$@"');
    await stapler("sha256sum", 'exec /usr/bin/sha256sum "$@"');
    const result = runScript([...linksFor(), 'echo "REACHED"'].join(" && "), {
      env: { ...process.env, PATH: fakeBin },
    });
    expect(result.status).toBe(NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT);
    expect(result.stderr).toContain("host clock is unreadable");
    expect(result.stdout).not.toContain("REACHED");
  });

  it("refuses when the host has no sha256 tool", async () => {
    const fakeBin = path.join(sandbox, "bin");
    await fs.mkdir(fakeBin);
    const stapler = async (name: string, body: string) =>
      fs.writeFile(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await stapler("id", 'exec /usr/bin/id "$@"');
    await stapler("date", 'exec /usr/bin/date "$@"');
    const result = runScript([...linksFor(), 'echo "REACHED"'].join(" && "), {
      env: { ...process.env, PATH: fakeBin },
    });
    expect(result.status).toBe(NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT);
    expect(result.stderr).toContain("no sha256 tool on host");
    expect(result.stdout).not.toContain("REACHED");
  });

  it("falls back to shasum when sha256sum is missing", async () => {
    const fakeBin = path.join(sandbox, "bin");
    await fs.mkdir(fakeBin);
    const stapler = async (name: string, body: string) =>
      fs.writeFile(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    // Drops the `-a 256` the verifier passes, then behaves as sha256sum.
    await stapler("shasum", 'shift; shift; exec /usr/bin/sha256sum "$@"');
    await stapler("id", 'exec /usr/bin/id "$@"');
    await stapler("date", 'exec /usr/bin/date "$@"');
    await stapler("cut", 'exec /usr/bin/cut "$@"');
    const result = runScript([...linksFor(), 'echo "REACHED:$1"'].join(" && "), {
      env: { ...process.env, PATH: fakeBin },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REACHED:my-cmd");
  });

  it("round-trips hostile argv and env values byte-exactly", () => {
    const args = [
      "a'b",
      'c"d',
      "e$f",
      "g`h",
      "i!j",
      "%k",
      "-l",
      "m\nn",
      "o\tp",
      "ünïcodé☃",
      "trailing-space ",
      "",
      "x".repeat(5000),
    ];
    const launchEnv = {
      Q1: "v'v",
      Q2: "line1\nline2",
      Q3: "ünï☃",
      EMPTY: "",
      PCT: "100%",
      DASH: "-n -e",
    };
    const links = linksFor({ command: "my-cmd", args, launchEnv });
    // One hash line per argv element then per KEY=VALUE record, in order: the
    // shell values must hash to the digests of the server-side strings.
    const sortedKeys = Object.keys(launchEnv).sort();
    const harness = [
      'for paperclip_probe in "$@"; do printf \'%s\' "$paperclip_probe" | sha256sum; done',
      `for paperclip_probe in ${sortedKeys.map((key) => `"${key}=$${key}"`).join(" ")}; do printf '%s' "$paperclip_probe" | sha256sum; done`,
    ].join(" && ");
    const result = runScript([...links, harness].join(" && "));
    expect(result.status).toBe(0);
    const hashes = result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[0]);
    expect(hashes).toEqual([
      ...["my-cmd", ...args].map((value) => sha256Hex(value)),
      ...sortedKeys.map((key) => sha256Hex(`${key}=${launchEnv[key as keyof typeof launchEnv]}`)),
    ]);
  });

  it("passes with an empty argument list and an empty environment", () => {
    const links = linksFor({ command: "my-cmd", args: [], launchEnv: {} });
    const result = runScript([...links, 'echo "ARGS:$1"', 'echo "REACHED"'].join(" && "));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ARGS:my-cmd");
    expect(result.stdout).toContain("REACHED");
  });

  it("is unaffected by hostile shell state left by login profiles", () => {
    const script = [
      "set -e",
      "set -u",
      "IFS=,:",
      "set -- poison",
      ...linksFor(),
      'echo "ARGS:$1:$2"',
      'echo "FOO=$FOO"',
    ].join(" && ");
    const result = runScript(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ARGS:my-cmd:a1");
    expect(result.stdout).toContain("FOO=bar");
  });
});

describe("verified launch budgeting", () => {
  it("reserves identical bytes for the stand-in and real bindings", () => {
    const base = {
      profileLines: [] as string[],
      username: "u",
      remoteCwd: "/srv/x",
      command: "c",
      args: ["a"],
      launchEnv: {},
    };
    const reserved = buildNativeSshVerifiedRemoteScript({
      ...base,
      binding: SSH_VERIFIED_RESERVATION_BINDING,
    });
    const real = buildNativeSshVerifiedRemoteScript({ ...base, binding: bindingFor() });
    expect(Buffer.byteLength(reserved)).toBe(Buffer.byteLength(real));
  });

  const mirrorEnvs: Array<[string, Record<string, string>]> = [
    ["empty env", {}],
    ["small env", { A: "1", B: "two" }],
    ["quote-heavy env", { Q: "a'b'c'd'e", R: "'leading", S: "trailing'" }],
    ["many keys", Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`K${String(i).padStart(3, "0")}`, `v${i}`]))],
    ["large values", Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`BIG_${i}`, "x".repeat(1024)]))],
    ["oversized single value", { BIG: "x".repeat(70_000) }],
  ];

  it("sends the verifier with a spent proof and keeps legacy bytes without one", async () => {
    const env = { FOO: "bar" };
    const kept = sshLaunchEnv({ spec, command: COMMAND, args: ARGS, env, verified: true }).env;
    const proof = await authorizeFor(kept);
    const verified = await buildSshSpawnTarget({ spec, command: COMMAND, args: ARGS, env, authority: proof });
    try {
      const last = String(verified.args.at(-1));
      expect(last).toContain("paperclip_expected_argv");
      expect(last).toContain("paperclip_expected_env");
      expect(last).toContain(proof.authority.opaqueRequestId);
      expect(last).toContain('exec "$@"');
      expect(last).not.toContain("exec env ");
    } finally {
      await verified.cleanup();
    }

    vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", "off");
    const legacy = await buildSshSpawnTarget({ spec, command: "node", args: ["--version"], env });
    try {
      const last = String(legacy.args.at(-1));
      expect(last).toContain("exec env ");
      expect(last).not.toContain("paperclip_");
    } finally {
      await legacy.cleanup();
    }
  });

  it.each(mirrorEnvs)("accounts every byte of the verified script for %s", async (_name, env) => {
    const kept = sshLaunchEnv({ spec, command: COMMAND, args: ARGS, env, verified: true }).env;
    const proof = await authorizeFor(kept);
    const built = await buildSshSpawnTarget({ spec, command: COMMAND, args: ARGS, env, authority: proof });
    try {
      const lastArg = String(built.args.at(-1));
      const actual = Buffer.byteLength(lastArg);
      // The fixed part rendered with the real binding, plus the per-entry
      // formula over the kept env, must equal the measured final argument
      // exactly: the formula and the generator are independent
      // implementations of the same shape, and this pins them together.
      const envFree = buildNativeSshVerifiedRemoteScript({
        profileLines: SSH_LOGIN_PROFILE_LINES,
        username: spec.username,
        remoteCwd: spec.remoteCwd,
        command: COMMAND,
        args: ARGS,
        launchEnv: {},
        binding: proof.authority,
      });
      const expected =
        6 +
        sshScriptOuterQuotedBytes(envFree) +
        Object.entries(kept).reduce((sum, [key, value]) => sum + sshVerifiedEnvEntryFinalBytes(key, value), 0);
      expect(actual).toBe(expected);
      expect(actual).toBeLessThanOrEqual(SSH_REMOTE_ARG_MAX_BYTES);
    } finally {
      await built.cleanup();
    }
  });
});
