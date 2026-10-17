import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_ISOLATION_PROBE,
  githubIsolationCertificates,
  githubIsolationConfigurationDigest,
  githubCandidateAdapterConfig,
  type PreparedGitHubCandidateRuntime,
} from "../services/chat-github-runtime-isolation.js";

const prepared = {
  home: "/home/paperclip-shadow/.paperclip-runtime/isolated/run",
  env: { HOME: "/home/paperclip-shadow/.paperclip-runtime/isolated/run", CLAUDE_CONFIG_DIR: "/home/paperclip-shadow/.paperclip-runtime/isolated/run/.claude" },
} as PreparedGitHubCandidateRuntime;

afterEach(() => vi.unstubAllEnvs());

describe("certified GitHub candidate configuration", () => {
  it.each(["isolated", "readable", "missing", "network-open", "reused-home", "wrong-user"])(
    "runs the actual Python probe against %s boundary fixtures", scenario => {
      // No real users, firewall, files, or sockets are changed. The exact shipped
      // Python program runs with deterministic syscall fakes, not a fake receipt.
      const fixture = `import builtins, errno, io, os, pwd, socket, types
scenario = ${JSON.stringify(scenario)}
os.geteuid = lambda: 12345
pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_name="other" if scenario == "wrong-user" else "paperclip-shadow")
def fake_open(*args, **kwargs):
    if scenario == "readable": return io.BytesIO(b"PRIMARY_ANSWER")
    raise OSError(errno.ENOENT if scenario == "missing" else errno.EACCES, "fixture")
builtins.open = fake_open
def fake_mkdir(*args, **kwargs):
    if scenario == "reused-home": raise FileExistsError()
os.mkdir = fake_mkdir
os.listdir = lambda path: []
class FakeSocket:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): pass
    def connect(self, address):
        if scenario != "network-open": raise OSError(errno.EACCES, "fixture")
socket.socket = lambda *args: FakeSocket()
`;
      const proof = JSON.parse(execFileSync("python3", ["-c", fixture + GITHUB_ISOLATION_PROBE], {
        input: JSON.stringify({ nonce: "nonce", home: "/fresh", canaries: ["/primary/run", "/primary/worktree"], githubAddresses: ["192.0.2.1", "2001:db8::1"] }),
        encoding: "utf8", timeout: 5000,
      }));
      expect(proof.nonce).toBe("nonce");
      expect(Object.values(proof.checks).every(Boolean)).toBe(scenario === "isolated");
      if (["readable", "missing"].includes(scenario)) expect(proof.checks.primaryCanariesDenied).toBe(false);
      if (scenario === "network-open") expect(proof.checks.githubDenied).toBe(false);
      if (scenario === "reused-home") expect(proof.checks.configFresh).toBe(false);
    },
  );
  it("is empty by default and rejects malformed certification", () => {
    for (const value of [undefined, "", "{}", "not json", '[{"environmentId":"fake"}]']) {
      vi.stubEnv("PAPERCLIP_GITHUB_SHADOW_CERTIFIED_ENVIRONMENTS", value);
      expect(githubIsolationCertificates()).toEqual([]);
    }
  });
  it("binds all environment config and env vars independent of key order", () => {
    const base = { driver: "ssh", config: { host: "host", username: "paperclip-shadow" }, envVars: { X: "one" } };
    expect(githubIsolationConfigurationDigest(base)).toBe(githubIsolationConfigurationDigest({ ...base, config: { username: "paperclip-shadow", host: "host" } }));
    expect(githubIsolationConfigurationDigest(base)).not.toBe(githubIsolationConfigurationDigest({ ...base, envVars: { X: "two" } }));
  });
  it("uses explicit proxy credentials, fresh identity, and no host auth or provision hooks", () => {
    const config = githubCandidateAdapterConfig(prepared, {
      engine: "cli", model: "muse-wonder-full-1.0-contributor", effort: "low", cwd: "/primary",
      env: { HOME: "/primary", CLAUDE_CONFIG_DIR: "/primary/.claude", GH_TOKEN: "primary-secret", DATABASE_URL: "primary-db",
        ANTHROPIC_AUTH_TOKEN: "explicit-proxy-token", ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", NODE_OPTIONS: "--require /primary/inject.js" },
    }, "/fresh/workspace");
    expect(config).toMatchObject({ engine: "cli", model: "muse-wonder-full-1.0-contributor", effort: "low", cwd: "/fresh/workspace",
      env: { ...prepared.env, ANTHROPIC_AUTH_TOKEN: "explicit-proxy-token", ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", PAPERCLIP_API_URL: "http://127.0.0.1:3100" } });
    expect(JSON.stringify(config)).not.toContain("primary-secret");
    expect(JSON.stringify(config)).not.toContain("primary-db");
    expect(JSON.stringify(config)).not.toContain("NODE_OPTIONS");
  });
  it.each([
    {}, { engine: "acp" }, { engine: "cli", args: ["--resume", "primary"] },
    { engine: "cli", extraArgs: ["--settings", "/primary/.claude"] },
    { engine: "cli", command: "custom-wrapper" }, { engine: "cli", isolateRuntime: true },
    { engine: "cli", env: { ANTHROPIC_BASE_URL: "https://github.com" } },
  ])("refuses uncertified adapter launch options %j", config => {
    expect(() => githubCandidateAdapterConfig(prepared, config, "/fresh")).toThrow("github_candidate_isolation_unavailable");
  });
});
