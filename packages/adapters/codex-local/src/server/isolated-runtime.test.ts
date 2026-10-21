import { describe, expect, it } from "vitest";
import {
  ISOLATED_RUNTIME_ENV_KEYS,
  isIsolatedRuntime,
  isolatedRuntimeEnv,
} from "./isolated-runtime.js";

describe("isIsolatedRuntime", () => {
  it("is off unless the key is the boolean true", () => {
    expect(isIsolatedRuntime({})).toBe(false);
    expect(isIsolatedRuntime(null)).toBe(false);
    expect(isIsolatedRuntime([])).toBe(false);
    expect(isIsolatedRuntime({ isolateRuntime: false })).toBe(false);
    expect(isIsolatedRuntime({ isolateRuntime: true })).toBe(true);
  });
});

describe("isolatedRuntimeEnv", () => {
  const adapterEnv = {
    CODEX_HOME: "/homes/agent/codex-home",
    OPENAI_API_KEY: "sk-agent",
    PAPERCLIP_API_KEY: "jwt",
    PAPERCLIP_AGENT_ID: "agent-1",
    PAPERCLIP_COMPANY_ID: "company-1",
    PAPERCLIP_RUN_ID: "run-1",
    PAPERCLIP_TASK_ID: "task-1",
    PAPERCLIP_WAKE_REASON: "issue_assigned",
    PAPERCLIP_API_URL: "https://paperclip.example",
    PAPERCLIP_WORKSPACES_JSON: "[]",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
    GH_APP_TOKEN_SOURCE: "broker",
    GIT_CONFIG_GLOBAL: "/x/gitconfig",
    GH_CONFIG_DIR: "/x/gh",
    TMPDIR: "/run/tmp",
  };

  it("keeps CODEX_HOME, OPENAI_API_KEY, run ids and basics, and nothing else", () => {
    const out = isolatedRuntimeEnv(adapterEnv, { PATH: "/usr/bin", HOME: "/home/node", LANG: "C.UTF-8" });
    expect(out).toEqual({
      CODEX_HOME: "/homes/agent/codex-home",
      OPENAI_API_KEY: "sk-agent",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_TASK_ID: "task-1",
      PAPERCLIP_WAKE_REASON: "issue_assigned",
      TMPDIR: "/run/tmp",
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
    });
  });

  it("never lets a credential-named key through, whatever the server env holds", () => {
    const out = isolatedRuntimeEnv(adapterEnv, {
      PATH: "/usr/bin",
      GH_TOKEN: "t",
      DATABASE_URL: "postgres://x",
      CLOUDFLARE_API_TOKEN: "c",
    });
    for (const key of Object.keys(out)) expect(ISOLATED_RUNTIME_ENV_KEYS).toContain(key);
    expect(Object.keys(out).filter((key) => /KEY|TOKEN|SECRET|DATABASE|GH_|GIT_/.test(key))).toEqual([
      "OPENAI_API_KEY",
    ]);
  });

  it("omits empty values and a missing OPENAI_API_KEY", () => {
    const out = isolatedRuntimeEnv({ CODEX_HOME: "/h", OPENAI_API_KEY: "" }, { PATH: "" });
    expect(out).toEqual({ CODEX_HOME: "/h" });
  });
});
