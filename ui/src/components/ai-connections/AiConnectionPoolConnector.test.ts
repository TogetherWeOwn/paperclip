import { describe, expect, it } from "vitest";
import { aiConnectionPoolMemberSchema, type AiManagedConnectionSummary } from "@paperclipai/shared";
import { memberOf } from "./AiConnectionPoolConnector";

function accountOf(kind: "gateway" | "local", protocol: "chat" | "responses" | "messages", model: string): AiManagedConnectionSummary {
  return {
    id: "connection", grantId: "grant", companyId: "company", provider: "openai", method: "api_key", name: "Gateway", ownership: "personal", isDefault: false, status: "connected",
    routing: { kind, protocol, auth: "bearer", baseUrl: kind === "local" ? "http://127.0.0.1:1234" : "https://gateway.example/v1", models: [{ id: model }] },
  };
}

describe("connection pool member defaults", () => {
  it.each(["gateway", "local"] as const)("uses OpenCode and the routed model for a chat %s connection", (kind) => {
    expect(memberOf(accountOf(kind, "chat", `${kind}-chat-model`)).profile).toEqual({ provider: "opencode", model: `paperclip/${kind}-chat-model` });
  });
  it.each([
    ["gateway", "responses", { provider: "codex", model: "gateway-responses-model" }],
    ["gateway", "messages", { provider: "acpx", acpxAgent: "claude", model: "gateway-messages-model" }],
    ["local", "responses", { provider: "codex", model: "local-responses-model" }],
    ["local", "messages", { provider: "acpx", acpxAgent: "claude", model: "local-messages-model" }],
  ] as const)("uses the %s %s protocol instead of the provider name", (kind, protocol, profile) => {
    expect(memberOf(accountOf(kind, protocol, profile.model)).profile).toEqual(profile);
  });
  it("accepts 267-character pool model IDs and rejects 268 characters", () => {
    const account = { ...accountOf("gateway", "chat", "model"), id: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002" };
    const member = memberOf(account);
    expect(aiConnectionPoolMemberSchema.parse({ ...member, profile: { ...member.profile, model: "m".repeat(267) } }).profile.model).toHaveLength(267);
    expect(aiConnectionPoolMemberSchema.safeParse({ ...member, profile: { ...member.profile, model: "m".repeat(268) } }).success).toBe(false);
  });
  it("keeps a maximum-length chat model ID serializable after normalization", () => {
    const raw = "m".repeat(256);
    const account = { ...accountOf("gateway", "chat", raw), id: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002" };
    const member = memberOf(account);
    expect(member.profile.model).toBe(`paperclip/${raw}`);
    expect(aiConnectionPoolMemberSchema.parse(member).profile.model).toHaveLength(266);
  });
});
