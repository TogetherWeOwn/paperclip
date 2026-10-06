import { describe, expect, it } from "vitest";
import {
  CLAUDE_ISOLATED_RUNTIME_ENV_KEYS,
  isIsolatedRuntime,
  isolatedRuntimeEnv,
} from "./isolated-runtime.js";

describe("isIsolatedRuntime", () => {
  it("is off unless the key is the boolean true", () => {
    expect(isIsolatedRuntime({})).toBe(false);
    expect(isIsolatedRuntime(null)).toBe(false);
    expect(isIsolatedRuntime([])).toBe(false);
    expect(isIsolatedRuntime({ isolateRuntime: false })).toBe(false);
    expect(isIsolatedRuntime({ isolateRuntime: "true" })).toBe(false);
    expect(isIsolatedRuntime({ isolateRuntime: 1 })).toBe(false);
    expect(isIsolatedRuntime({ isolateRuntime: true })).toBe(true);
  });
});

describe("isolatedRuntimeEnv", () => {
  const adapterEnv = {
    ANTHROPIC_API_KEY: "sk-agent",
    ANTHROPIC_AUTH_TOKEN: "auth-token",
    ANTHROPIC_BASE_URL: "https://gateway.example",
    ANTHROPIC_MODEL: "claude-sonnet-4-5",
    CLAUDE_CONFIG_DIR: "/homes/agent/claude",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "us-west-2",
    CLAUDE_CODE_USE_VERTEX: "1",
    ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
    CLOUD_ML_REGION: "us-east5",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
    PAPERCLIP_API_KEY: "run-jwt",
    PAPERCLIP_AGENT_ID: "agent-1",
    PAPERCLIP_COMPANY_ID: "company-1",
    PAPERCLIP_RUN_ID: "run-1",
    PAPERCLIP_TASK_ID: "task-1",
    PAPERCLIP_WAKE_REASON: "issue_assigned",
    PAPERCLIP_API_URL: "https://paperclip.example",
    PAPERCLIP_WORKSPACE_CWD: "/work",
    GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
    GH_APP_TOKEN_SOURCE: "broker",
    DATABASE_URL: "postgres://server-secret",
    SERVER_ONLY_SECRET_X: "server-secret",
  };

  it("keeps model/auth keys, run ids, harness keys and the run token, and nothing else", () => {
    const out = isolatedRuntimeEnv(adapterEnv, {
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      SERVER_ONLY_SECRET_X: "must-not-pass",
    });
    expect(out).toEqual({
      ANTHROPIC_API_KEY: "sk-agent",
      ANTHROPIC_AUTH_TOKEN: "auth-token",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      CLAUDE_CONFIG_DIR: "/homes/agent/claude",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
      CLOUD_ML_REGION: "us-east5",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
      PAPERCLIP_API_KEY: "run-jwt",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_TASK_ID: "task-1",
      PAPERCLIP_WAKE_REASON: "issue_assigned",
      PAPERCLIP_API_URL: "https://paperclip.example",
      PAPERCLIP_WORKSPACE_CWD: "/work",
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
    });
  });

  it("never lets a credential-named server key through, whatever the server env holds", () => {
    const out = isolatedRuntimeEnv(adapterEnv, {
      PATH: "/usr/bin",
      GH_TOKEN: "t",
      DATABASE_URL: "postgres://x",
      CLOUDFLARE_API_TOKEN: "c",
      ANTHROPIC_API_KEY: "sk-server-ignored",
    });
    for (const key of Object.keys(out)) {
      if (key.startsWith("PAPERCLIP_")) continue;
      expect(CLAUDE_ISOLATED_RUNTIME_ENV_KEYS).toContain(key);
    }
    expect(
      Object.keys(out).filter((key) => /KEY|TOKEN|SECRET|DATABASE|GH_|GIT_/.test(key)),
    ).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PAPERCLIP_API_KEY"]);
    expect(out.ANTHROPIC_API_KEY).toBe("sk-agent");
  });

  it("prefers adapter bindings over server values and omits empties", () => {
    const out = isolatedRuntimeEnv(
      { ANTHROPIC_API_KEY: "", PATH: "/agent/bin", PAPERCLIP_RUN_ID: "run-9" },
      { PATH: "/usr/bin", HOME: "/home/node", LANG: "" },
    );
    expect(out).toEqual({
      PAPERCLIP_RUN_ID: "run-9",
      PATH: "/agent/bin",
      HOME: "/home/node",
    });
  });
});
