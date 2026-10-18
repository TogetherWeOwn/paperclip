import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_ISOLATION_PROBE,
  GITHUB_ISOLATION_CLEANUP,
  GITHUB_ORPHAN_HOME_MIN_AGE_SECONDS,
  githubIsolationCertificates,
  githubIsolationConfigurationDigest,
  githubCandidateAdapterConfig,
  githubCandidateProbeModel,
  type PreparedGitHubCandidateRuntime,
} from "../services/chat-github-runtime-isolation.js";

const prepared = {
  home: "/home/paperclip-shadow/.paperclip-runtime/isolated/run",
  env: { ANTHROPIC_AUTH_TOKEN: "restricted-shadow-token", HOME: "/home/paperclip-shadow/.paperclip-runtime/isolated/run", CLAUDE_CONFIG_DIR: "/home/paperclip-shadow/.paperclip-runtime/isolated/run/.claude" },
} as PreparedGitHubCandidateRuntime;

afterEach(() => vi.unstubAllEnvs());

describe("certified GitHub candidate configuration", () => {
  it("probes the explicit CLI model with config-before-env precedence and no invented default", () => {
    expect(githubCandidateProbeModel({ model: " configured ", env: { ANTHROPIC_MODEL: "environment" } })).toBe("configured");
    expect(githubCandidateProbeModel({ model: " ", env: { ANTHROPIC_MODEL: " environment " } })).toBe("environment");
    expect(githubCandidateProbeModel({ model: 1, env: { ANTHROPIC_MODEL: false } })).toBeNull();
    expect(githubCandidateProbeModel({})).toBeNull();
  });
  it.each(["isolated", "readable", "missing", "network-open", "raw-proxy-open", "raw-proxy-error", "reused-home", "wrong-user", "sibling-home", "proxy-open", "proxy-error", "proxy-deny-all", "proxy-context-denied", "proxy-other-model", "proxy-wrong-header", "proxy-non-2xx"])(
    "runs the actual Python probe against %s boundary fixtures", scenario => {
      // No real users, firewall, files, or sockets are changed. The exact shipped
      // Python program runs with deterministic syscall fakes, not a fake receipt.
      const fixture = `import builtins, errno, io, json, os, pwd, socket, types, urllib.request, urllib.error
scenario = ${JSON.stringify(scenario)}
os.geteuid = lambda: 12345
pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_name="other" if scenario == "wrong-user" else "paperclip-shadow")
def fake_open(*args, **kwargs):
    if args[0].endswith("/.probe-owner"): return io.StringIO()
    if scenario == "readable": return io.BytesIO(b"PRIMARY_ANSWER")
    raise OSError(errno.ENOENT if scenario == "missing" else errno.EACCES, "fixture")
builtins.open = fake_open
def fake_mkdir(*args, **kwargs):
    if scenario == "reused-home": raise FileExistsError()
os.mkdir = fake_mkdir
os.listdir = lambda path: ["previous-arm-home"] if scenario == "sibling-home" and path == "/" else []
class FakeSocket:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): pass
    def connect(self, address):
        if address == ("127.0.0.1", 8317):
            if scenario == "raw-proxy-open": return
            if scenario == "raw-proxy-error": raise OSError(errno.EBADF, "not confinement")
        elif scenario == "network-open": return
        raise OSError(errno.EACCES, "fixture")
socket.socket = lambda *args: FakeSocket()
import urllib.request, urllib.error
def fake_urlopen(request, **kwargs):
    if scenario == "proxy-error": raise OSError("proxy unavailable")
    body = json.loads(request.data)
    assert body["max_tokens"] == 1 and body["messages"]
    tool_request = "tools" in body or "mcp_servers" in body
    other_model = body["model"] != "configured-arm-model"
    if tool_request: assert not other_model, "tool denial must not pass solely on a disallowed model"
    accepted = not tool_request and not other_model
    if scenario == "proxy-open" or scenario == "proxy-other-model" and other_model: accepted = True
    if scenario == "proxy-deny-all" or scenario == "proxy-context-denied" and "context_management" in body: accepted = False
    if accepted:
        response = io.StringIO("accepted")
        response.status = 302 if scenario == "proxy-non-2xx" else 200
        return response
    policy = "wrong" if scenario == "proxy-wrong-header" else "client-tools-only-v1"
    raise urllib.error.HTTPError(request.full_url, 403, "denied", {"x-paperclip-shadow-policy": policy}, None)
urllib.request.urlopen = fake_urlopen
`;
      const proof = JSON.parse(execFileSync("python3", ["-c", fixture + GITHUB_ISOLATION_PROBE], {
        input: JSON.stringify({ nonce: "nonce", model: "configured-arm-model", home: "/fresh", canaries: ["/primary/run", "/primary/worktree"], githubAddresses: ["192.0.2.1", "2001:db8::1"] }),
        encoding: "utf8", timeout: 5000,
      }));
      expect(proof.nonce).toBe("nonce");
      expect(Object.values(proof.checks).every(Boolean)).toBe(scenario === "isolated");
      if (["readable", "missing"].includes(scenario)) expect(proof.checks.primaryCanariesDenied).toBe(false);
      if (scenario === "network-open") expect(proof.checks.githubDenied).toBe(false);
      expect(proof.checks.providerToolsDenied).toBe(!["wrong-user", "proxy-open", "proxy-error", "proxy-wrong-header"].includes(scenario));
      expect(proof.checks.allowedModelAccepted).toBe(!["wrong-user", "proxy-error", "proxy-deny-all", "proxy-context-denied", "proxy-non-2xx"].includes(scenario));
      expect(proof.checks.otherModelDenied).toBe(!["wrong-user", "proxy-open", "proxy-error", "proxy-other-model", "proxy-wrong-header"].includes(scenario));
      expect(proof.checks.rawProxyDenied).toBe(!["wrong-user", "raw-proxy-open", "raw-proxy-error"].includes(scenario));
      if (scenario === "reused-home") expect(proof.checks.configFresh).toBe(false);
    },
  );
  it("materializes the exact hook bundle into a fresh config using the shipped Python probe", () => {
    const scratch = mkdtempSync(join(tmpdir(), "shadow-hooks-"));
    const home = join(scratch, "fresh");
    const files = { ".claude/settings.json": '{"hooks":{}}', "hooks/guard.mjs": "// immutable guard" };
    const fixture = `import builtins, errno, pwd, socket, types, os, io, json, urllib.request, urllib.error
os.geteuid = lambda: 12345
pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_name="paperclip-shadow")
real_open = builtins.open
def controlled_open(path, *args, **kwargs):
    if str(path).startswith("/primary/"): raise OSError(errno.EACCES, "denied")
    return real_open(path, *args, **kwargs)
builtins.open = controlled_open
class FakeSocket:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): pass
    def connect(self, address): raise OSError(errno.EACCES, "denied")
socket.socket = lambda *args: FakeSocket()
import urllib.request, urllib.error
def deny_provider_tool(request, **kwargs):
    body = json.loads(request.data)
    if body["model"] == "configured-arm-model" and "tools" not in body and "mcp_servers" not in body:
        response = io.StringIO("accepted")
        response.status = 200
        return response
    raise urllib.error.HTTPError(request.full_url, 403, "denied", {"x-paperclip-shadow-policy": "client-tools-only-v1"}, None)
urllib.request.urlopen = deny_provider_tool
`;
    try {
      const proof = JSON.parse(execFileSync("python3", ["-c", fixture + GITHUB_ISOLATION_PROBE], {
        input: JSON.stringify({ nonce: "nonce", model: "configured-arm-model", home, canaries: ["/primary/run"], githubAddresses: ["192.0.2.1"], hooks: { files, digest: "fixture-digest" } }),
        encoding: "utf8", timeout: 5000,
      }));
      expect(proof).toMatchObject({ hooksDigest: "fixture-digest", checks: { configFresh: true } });
      for (const [file, contents] of Object.entries(files)) expect(readFileSync(join(home, file), "utf8")).toBe(contents);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
  describe("orphaned isolated homes (probe namespace section on a real directory)", () => {
    // Only identity, sockets and the proxy are faked; listdir/lstat/rmtree/unlink
    // run for real against a temp isolated/ parent.
    const fixture = `import errno, io, json, os, pwd, socket, types, urllib.request, urllib.error
os.geteuid = lambda: 12345
pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_name="paperclip-shadow")
class FakeSocket:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, value): pass
    def connect(self, address): raise OSError(errno.EACCES, "denied")
socket.socket = lambda *args: FakeSocket()
def proxy(request, **kwargs):
    body = json.loads(request.data)
    if body["model"] == "configured-arm-model" and "tools" not in body and "mcp_servers" not in body:
        response = io.StringIO("accepted")
        response.status = 200
        return response
    raise urllib.error.HTTPError(request.full_url, 403, "denied", {"x-paperclip-shadow-policy": "client-tools-only-v1"}, None)
urllib.request.urlopen = proxy
`;
    const old = (Date.now() / 1000) - GITHUB_ORPHAN_HOME_MIN_AGE_SECONDS - 60;
    let scratch: string;
    let parent: string;
    let outside: string;
    const probe = () => JSON.parse(execFileSync("python3", ["-c", fixture + GITHUB_ISOLATION_PROBE], {
      input: JSON.stringify({ nonce: "nonce", model: "configured-arm-model", home: join(parent, "fresh"), canaries: [], githubAddresses: ["192.0.2.1"] }),
      encoding: "utf8", timeout: 5000,
    }));
    function crashedHome(name: string, { dirAge = old, ownerAge = old }: { dirAge?: number; ownerAge?: number } = {}) {
      const home = join(parent, name);
      mkdirSync(join(home, "workspace"), { recursive: true });
      writeFileSync(join(home, "workspace", "answer.txt"), "stale checkout");
      symlinkSync(outside, join(home, "workspace", "escape"));
      writeFileSync(join(home, ".probe-owner"), "crashed-nonce");
      utimesSync(join(home, ".probe-owner"), ownerAge, ownerAge);
      utimesSync(home, dirAge, dirAge);
      return home;
    }
    afterEach(() => rmSync(scratch, { recursive: true, force: true }));
    function setup() {
      scratch = mkdtempSync(join(tmpdir(), "shadow-orphans-"));
      parent = join(scratch, "isolated");
      outside = join(scratch, "outside");
      mkdirSync(parent);
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "must survive");
    }
    const outsideIntact = () => expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("must survive");

    it("reclaims an orphan idle past the orphan age, records the count, and continues", () => {
      setup();
      crashedHome("crashed-run");
      const proof = probe();
      expect(proof).toMatchObject({ namespaceBusy: false, orphansReclaimed: 1, checks: { configFresh: true } });
      expect(readdirSync(parent)).toEqual(["fresh"]);
      outsideIntact();
    });
    it.each([["young home", true, false], ["old home with a young owner file", false, true]] as const)(
      "keeps candidate_namespace_busy for a %s", (_label, youngDir, youngOwner) => {
        setup();
        const now = Date.now() / 1000;
        const home = crashedHome("live-run", { dirAge: youngDir ? now : old, ownerAge: youngOwner ? now : old });
        const proof = probe();
        expect(proof).toMatchObject({ namespaceBusy: true, orphansReclaimed: 0, checks: { configFresh: false } });
        expect(existsSync(join(home, "workspace", "answer.txt"))).toBe(true);
        expect(existsSync(join(parent, "fresh"))).toBe(false);
        outsideIntact();
      });
    it("never follows a symlinked sibling: an old link is unlinked, its target untouched; a young one stays busy", () => {
      setup();
      symlinkSync(outside, join(parent, "linked-old"));
      lutimesSync(join(parent, "linked-old"), old, old);
      let proof = probe();
      expect(proof).toMatchObject({ namespaceBusy: false, orphansReclaimed: 1, checks: { configFresh: true } });
      expect(() => lstatSync(join(parent, "linked-old"))).toThrow();
      outsideIntact();
      rmSync(join(parent, "fresh"), { recursive: true });
      symlinkSync(outside, join(parent, "linked-young"));
      proof = probe();
      expect(proof).toMatchObject({ namespaceBusy: true, orphansReclaimed: 0 });
      expect(lstatSync(join(parent, "linked-young")).isSymbolicLink()).toBe(true);
      outsideIntact();
    });
  });
  it.each(["mine", "another-attempt", "missing", "symlink"])("cleanup only removes the nonce-owned home: %s", owner => {
    const fixture = `import builtins, io, json, os, shutil, sys
owner = ${JSON.stringify(owner)}
sys.argv = ["cleanup", "/fresh", "mine"]
os.path.isdir = lambda p: True
os.path.islink = lambda p: owner == "symlink"
def fake_open(*args, **kwargs):
    if owner == "missing": raise FileNotFoundError()
    return io.StringIO(owner)
builtins.open = fake_open
removed = []
shutil.rmtree = lambda p: removed.append(p)
`;
    expect(typeof GITHUB_ISOLATION_CLEANUP).toBe("string");
    const removed = JSON.parse(execFileSync("python3", ["-c", fixture + GITHUB_ISOLATION_CLEANUP + String.fromCharCode(10) + "print(json.dumps(removed))"], { encoding: "utf8", timeout: 5000 }));
    expect(removed).toEqual(owner === "mine" ? ["/fresh"] : []);
  });
  it("blocks provider web tools without changing the primary config", () => {
    const primary = { engine: "cli", model: "muse-wonder-full-1.0-contributor" };
    const candidate = githubCandidateAdapterConfig(prepared, primary, "/fresh");
    expect(candidate.extraArgs).toEqual(["--disallowedTools", "WebSearch", "WebFetch"]);
    expect(primary).not.toHaveProperty("extraArgs");
  });
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
      env: { ...prepared.env, ANTHROPIC_AUTH_TOKEN: "restricted-shadow-token", ANTHROPIC_BASE_URL: "http://127.0.0.1:8318", PAPERCLIP_API_URL: "http://127.0.0.1:3100" } });
    expect(JSON.stringify(config)).not.toContain("primary-secret");
    expect(JSON.stringify(config)).not.toContain("primary-db");
    expect(JSON.stringify(config)).not.toContain("NODE_OPTIONS");
  });
  it("preserves only explicit non-secret context timeout and model alias settings", () => {
    const settings = { API_TIMEOUT_MS: "1800000", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000",
      ANTHROPIC_SMALL_FAST_MODEL: "muse-wonder-full-1.0-contributor", CLAUDE_CODE_SUBAGENT_MODEL: "muse-wonder-full-1.0-contributor",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "muse-wonder-full-1.0-contributor", ANTHROPIC_DEFAULT_HAIKU_MODEL: "muse-wonder-full-1.0-contributor",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "muse-wonder-full-1.0-contributor" };
    const config = githubCandidateAdapterConfig(prepared, { engine: "cli", env: { ...settings,
      AWS_SECRET_ACCESS_KEY: "secret", ANTHROPIC_CUSTOM_HEADERS: "unsafe", NODE_OPTIONS: "unsafe" } }, "/fresh");
    expect(config.env).toMatchObject(settings);
    expect(JSON.stringify(config)).not.toMatch(/secret|unsafe/);
  });
  it("derives model-guard and hook scratch inputs from the isolated run rather than host env", () => {
    const config = githubCandidateAdapterConfig(prepared, { engine: "cli", model: "muse-wonder-full-1.0-contributor",
      env: { PAPERCLIP_ASSIGNED_MODEL: "wrong-primary-model", PAPERCLIP_RUN_SCRATCH_DIR: "/primary" } }, "/fresh");
    expect(config.env).toMatchObject({ PAPERCLIP_ASSIGNED_MODEL: "muse-wonder-full-1.0-contributor",
      PAPERCLIP_RUN_SCRATCH_DIR: `${prepared.home}/tmp` });
  });
  it("unconditionally disables provider-side web tools without accepting user CLI arguments", () => {
    expect(githubCandidateAdapterConfig(prepared, { engine: "cli" }, "/fresh").extraArgs)
      .toEqual(["--disallowedTools", "WebSearch", "WebFetch"]);
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
