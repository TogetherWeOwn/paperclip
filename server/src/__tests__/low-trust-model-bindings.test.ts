import { describe, expect, it } from "vitest";
import {
  LOW_TRUST_MODEL_CREDENTIAL_ENV_KEYS,
  filterLowTrustModelBindingIds,
  lowTrustModelCredentialConfigPaths,
} from "../services/chat-channels.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("low-trust review model credential bindings", () => {
  it("exposes only secret-bearing model credential paths", () => {
    const paths = lowTrustModelCredentialConfigPaths();
    expect(paths).toContain("env.ANTHROPIC_AUTH_TOKEN");
    expect(paths).toContain("env.ANTHROPIC_API_KEY");
    expect(paths).toContain("env.CLAUDE_CODE_OAUTH_TOKEN");
    expect(paths).toContain("env.OPENAI_API_KEY");
    expect(paths).toContain("env.OPENROUTER_API_KEY");
    expect(paths).toContain("env.XAI_API_KEY");
    // Configuration, not credentials: base URLs, home dirs and provider
    // routing keys must never become an allowlist entry.
    expect(paths).not.toContain("env.ANTHROPIC_BASE_URL");
    expect(paths).not.toContain("env.OPENAI_BASE_URL");
    expect(paths).not.toContain("env.CODEX_HOME");
    expect(paths).not.toContain("env.GH_TOKEN");
    expect(paths).not.toContain("env.GITHUB_TOKEN");
    expect(LOW_TRUST_MODEL_CREDENTIAL_ENV_KEYS).toHaveLength(paths.length);
  });

  it("keeps only the assigned agent's model bindings", () => {
    const bindings = [
      { id: "b-model", targetType: "agent", targetId: AGENT_ID, configPath: "env.ANTHROPIC_AUTH_TOKEN" },
      { id: "b-openai", targetType: "agent", targetId: AGENT_ID, configPath: "env.OPENAI_API_KEY" },
      { id: "b-gh", targetType: "agent", targetId: AGENT_ID, configPath: "env.GH_TOKEN" },
      { id: "b-other-agent", targetType: "agent", targetId: "22222222-2222-4222-8222-222222222222", configPath: "env.ANTHROPIC_AUTH_TOKEN" },
      { id: "b-project", targetType: "project", targetId: AGENT_ID, configPath: "env.ANTHROPIC_AUTH_TOKEN" },
      { id: "b-url", targetType: "agent", targetId: AGENT_ID, configPath: "env.ANTHROPIC_BASE_URL" },
    ];
    expect(filterLowTrustModelBindingIds(bindings, AGENT_ID)).toEqual([
      "b-model",
      "b-openai",
    ]);
  });

  it("allows the model binding while any other binding stays refused", () => {
    const allowed = filterLowTrustModelBindingIds(
      [
        { id: "b-model", targetType: "agent", targetId: AGENT_ID, configPath: "env.ANTHROPIC_AUTH_TOKEN" },
        { id: "b-gh", targetType: "agent", targetId: AGENT_ID, configPath: "env.GH_TOKEN" },
      ],
      AGENT_ID,
    );
    // Mirrors secrets.ts assertBindingContext: a binding outside the
    // allowlist throws binding_not_allowed.
    expect(allowed).toContain("b-model");
    expect(allowed).not.toContain("b-gh");
  });

  it("dedupes and sorts binding ids", () => {
    const bindings = [
      { id: "b-b", targetType: "agent", targetId: AGENT_ID, configPath: "env.OPENAI_API_KEY" },
      { id: "b-a", targetType: "agent", targetId: AGENT_ID, configPath: "env.ANTHROPIC_AUTH_TOKEN" },
      { id: "b-a", targetType: "agent", targetId: AGENT_ID, configPath: "env.ANTHROPIC_AUTH_TOKEN" },
    ];
    expect(filterLowTrustModelBindingIds(bindings, AGENT_ID)).toEqual(["b-a", "b-b"]);
  });

  it("returns no bindings without an agent", () => {
    expect(
      filterLowTrustModelBindingIds(
        [{ id: "b-model", targetType: "agent", targetId: AGENT_ID, configPath: "env.ANTHROPIC_AUTH_TOKEN" }],
        "",
      ),
    ).toEqual([]);
  });
});
