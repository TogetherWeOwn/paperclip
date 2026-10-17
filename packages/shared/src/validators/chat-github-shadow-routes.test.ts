import { describe, expect, it } from "vitest";
import { defaultGitHubReviewPolicy } from "../types/chat-github.js";
import { githubChatConfigurationSchema } from "./chat-github.js";
import { instanceExperimentalSettingsSchema, patchInstanceExperimentalSettingsSchema } from "./instance.js";

const agentId = "f0000000-0000-4000-8000-000000000001";
const otherAgentId = "f0000000-0000-4000-8000-000000000002";
const configuration = {
  version: 1,
  toolsEnabled: false,
  responsibleUserId: "owner",
  memberAccess: "all_linked",
  people: [],
  defaults: defaultGitHubReviewPolicy(),
  repositories: {},
};
const route = { label: "candidate-low", agentId };

function parse(shadowRoutes?: unknown) {
  return githubChatConfigurationSchema.parse({ ...configuration, ...(shadowRoutes === undefined ? {} : { shadowRoutes }) });
}

describe("GitHub shadow route configuration (A11)", () => {
  it("defaults old configurations to no routes without enabling endpoint shadow", () => {
    expect(parse()).toMatchObject({ shadowRoutes: [], toolsEnabled: false });
    expect(parse().shadow).toBeUndefined();
  });

  it("defaults each route OFF and sampleRate to one", () => {
    expect(parse([route]).shadowRoutes).toEqual([{ ...route, enabled: false, sampleRate: 1 }]);
  });

  it("accepts explicit selection rates and separate candidate agents", () => {
    expect(parse([
      { ...route, enabled: true, sampleRate: 0 },
      { label: "candidate-two", agentId: otherAgentId, enabled: false, sampleRate: 1 },
    ]).shadowRoutes).toHaveLength(2);
  });

  it.each([-1, 1.01, Infinity, NaN, "1", null])("rejects invalid sampleRate %s", (sampleRate) => {
    expect(() => parse([{ ...route, sampleRate }])).toThrow();
  });

  it.each(["", "   ", "two words", "a/b", "a".repeat(65)])("rejects invalid label %s", (label) => {
    expect(() => parse([{ ...route, label }])).toThrow();
  });

  it("requires a UUID agent and refuses caller-owned arm IDs", () => {
    expect(() => parse([{ ...route, agentId: "reviewer" }])).toThrow();
    expect(() => parse([{ ...route, armId: otherAgentId }])).toThrow();
  });

  it("rejects duplicate labels after trimming and duplicate agent UUIDs after normalization", () => {
    expect(() => parse([route, { ...route, label: " candidate-low ", agentId: otherAgentId }])).toThrow();
    expect(() => parse([route, { ...route, label: "other", agentId: agentId.toUpperCase() }])).toThrow();
  });

  it("bounds routes to eight", () => {
    const routes = Array.from({ length: 9 }, (_, i) => ({ label: `candidate-${i}`, agentId: `f0000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    expect(() => parse(routes.slice(0, 8))).not.toThrow();
    expect(() => parse(routes)).toThrow();
  });

  it("rejects enabled same-endpoint routes on a legacy shadow-only endpoint", () => {
    expect(() => githubChatConfigurationSchema.parse({ ...configuration, shadow: { enabled: true, label: "legacy" }, shadowRoutes: [{ ...route, enabled: true }] })).toThrow();
    expect(githubChatConfigurationSchema.parse({ ...configuration, shadow: { enabled: true, label: "legacy" }, shadowRoutes: [route] }).shadowRoutes).toHaveLength(1);
  });

  it("defaults the global switch OFF, supports explicit patching and preserves omitted patches", () => {
    expect(instanceExperimentalSettingsSchema.parse({})).toHaveProperty("githubReviewShadowEnabled", false);
    expect(instanceExperimentalSettingsSchema.parse({ githubReviewShadowEnabled: true })).toHaveProperty("githubReviewShadowEnabled", true);
    expect(patchInstanceExperimentalSettingsSchema.parse({ githubReviewShadowEnabled: false })).toEqual({ githubReviewShadowEnabled: false });
    expect(patchInstanceExperimentalSettingsSchema.parse({})).not.toHaveProperty("githubReviewShadowEnabled");
  });
});
