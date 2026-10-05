import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("strips database connection vars (TOG-9648 regression)", () => {
    expect(sanitizeInheritedPaperclipEnv({
      DATABASE_URL: "postgres://superuser:secret@db:5432/paperclip",
      DATABASE_MIGRATION_URL: "postgres://superuser:secret@db:5432/paperclip",
      DATABASE_POOL_MAX: "10",
      POSTGRES_USER: "paperclip",
      POSTGRES_PASSWORD: "secret",
      POSTGRES_DB: "paperclip",
      PGHOST: "db",
      PGPORT: "5432",
      PGUSER: "paperclip",
      PGPASSWORD: "secret",
      PATH: "/usr/bin",
    })).toEqual({ PATH: "/usr/bin" });
  });

  it("strips session/auth signing secrets", () => {
    expect(sanitizeInheritedPaperclipEnv({
      BETTER_AUTH_SECRET: "signing-secret",
      PATH: "/usr/bin",
    })).toEqual({ PATH: "/usr/bin" });
  });

  it("strips provider keys and auth tokens", () => {
    expect(sanitizeInheritedPaperclipEnv({
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_AUTH_TOKEN: "oauth-test",
      OPENAI_API_KEY: "sk-test",
      GEMINI_API_KEY: "test",
      GOOGLE_API_KEY: "test",
      GEMINI_API_KEY_EXTRA: "nope",
      GH_TOKEN: "test",
      GITHUB_TOKEN: "test",
      GH_ENTERPRISE_TOKEN: "test",
      GITHUB_ENTERPRISE_TOKEN: "test",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      AWS_SESSION_TOKEN: "test",
      CLAUDE_CODE_OAUTH_TOKEN: "test",
      PATH: "/usr/bin",
    })).toEqual({ PATH: "/usr/bin", GEMINI_API_KEY_EXTRA: "nope" });
  });

  it("strips credential-pointer vars (TOG-9729)", () => {
    expect(sanitizeInheritedPaperclipEnv({
      AWS_SHARED_CREDENTIALS_FILE: "/root/.aws/credentials",
      AWS_CONFIG_FILE: "/root/.aws/config",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/token",
      SSH_AUTH_SOCK: "/run/agent.sock",
      GH_CONFIG_DIR: "/root/.config/gh",
      GIT_CONFIG_GLOBAL: "/root/.gitconfig",
      GIT_CONFIG_SYSTEM: "/etc/gitconfig",
      GOOGLE_APPLICATION_CREDENTIALS: "/root/sa.json",
      PATH: "/usr/bin",
    })).toEqual({ PATH: "/usr/bin" });
  });

  it("fails closed on future *_TOKEN vars (TOG-9729)", () => {
    expect(sanitizeInheritedPaperclipEnv({
      SOME_FUTURE_PROVIDER_TOKEN: "test",
      PATH: "/usr/bin",
    })).toEqual({ PATH: "/usr/bin" });
  });

  it("fails closed on future *_API_KEY and DATABASE_*/POSTGRES_*/PG* vars", () => {
    expect(sanitizeInheritedPaperclipEnv({
      SOME_FUTURE_PROVIDER_API_KEY: "test",
      FUTURE_DATABASE_URL: "nope",
      DATABASE_FUTURE_SETTING: "test",
      POSTGRES_FUTURE_VAR: "test",
      PGFUTUREVAR: "test",
      PATH: "/usr/bin",
    })).toEqual({ PATH: "/usr/bin", FUTURE_DATABASE_URL: "nope" });
  });

  it("keeps non-secret inherited env and Paperclip runtime allowlist", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      LANG: "C.UTF-8",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_LISTEN_HOST: "127.0.0.1",
      PAPERCLIP_LISTEN_PORT: "3100",
      PAPERCLIP_RUN_ID: "run-123",
      CUSTOM_SETTING: "kept",
    })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      LANG: "C.UTF-8",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_LISTEN_HOST: "127.0.0.1",
      PAPERCLIP_LISTEN_PORT: "3100",
      CUSTOM_SETTING: "kept",
    });
  });

  it("regression: a server-style env yields no DB credentials in the child env", () => {
    const child = sanitizeInheritedPaperclipEnv({
      DATABASE_URL: "postgres://superuser:secret@prod-db:5432/paperclip",
      DATABASE_MIGRATION_URL: "postgres://superuser:secret@prod-db:5432/paperclip",
      POSTGRES_PASSWORD: "secret",
      PGPASSWORD: "secret",
      BETTER_AUTH_SECRET: "signing-secret",
      ANTHROPIC_API_KEY: "sk-ant-server",
      PAPERCLIP_API_KEY: "harness-token",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
    for (const key of Object.keys(child)) {
      expect(key).not.toMatch(/DATABASE|POSTGRES|^PG/);
      expect(key).not.toBe("BETTER_AUTH_SECRET");
      expect(key).not.toMatch(/_API_KEY$|_TOKEN$|_SECRET/);
    }
    expect(child.PATH).toBe("/usr/bin");
    expect(child.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3100");
  });
});
