import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { instanceExperimentalSettingsSchema, patchInstanceExperimentalSettingsSchema } from "@paperclipai/shared";
import { applyExperimentalSettingsPatch, instanceSettingsService, normalizeExperimentalSettings } from "../services/instance-settings.js";

// Storage double only: this suite proves normalization/serialization, not PostgreSQL.
function settingsStore() {
  let row = {
    id: "settings", singletonKey: "default", defaultEnvironmentId: null,
    general: {}, experimental: {}, createdAt: new Date(0), updatedAt: new Date(0),
  };
  return {
    select: () => ({ from: () => ({ where: async () => [row] }) }),
    update: () => ({ set: (values: Partial<typeof row>) => ({ where: () => ({ returning: async () => {
      row = { ...row, ...values }; return [row];
    } }) }) }),
  } as unknown as Db;
}

function mode(settings: unknown) {
  return (settings as Record<string, unknown>).eventBackedWaitMode;
}

describe("event-backed wait setting acceptance", () => {
  it.each([undefined, {}, { enablePipelines: true }])("legacy normalization defaults off: %j", (stored) => {
    expect(mode(normalizeExperimentalSettings(stored))).toBe("off");
  });

  it("shared response schema defaults off", () => {
    expect(mode(instanceExperimentalSettingsSchema.parse({}))).toBe("off");
  });

  it.each(["off", "shadow", "enforce"])("shared patch preserves explicit %s instead of stripping the key", (value) => {
    expect(patchInstanceExperimentalSettingsSchema.parse({ eventBackedWaitMode: value })).toEqual({ eventBackedWaitMode: value });
  });

  it.each(["unknown", "", true, 1, null, {}, []].map((value) => ({ value })))("rejects malformed requested mode $value", ({ value }) => {
    expect(patchInstanceExperimentalSettingsSchema.safeParse({ eventBackedWaitMode: value }).success).toBe(false);
  });

  it.each(["unknown", null, true])("malformed stored mode %j normalizes off, never enforce", (value) => {
    expect(mode(normalizeExperimentalSettings({ eventBackedWaitMode: value }))).toBe("off");
  });

  it("round-trips shadow/enforce/off through the real service and serialized storage", async () => {
    const service = instanceSettingsService(settingsStore());
    expect(mode(await service.getExperimental())).toBe("off");
    for (const value of ["shadow", "enforce", "off"] as const) {
      const patch = patchInstanceExperimentalSettingsSchema.parse({ eventBackedWaitMode: value });
      const updated = await service.updateExperimental(patch);
      expect(mode(updated.experimental)).toBe(value);
      expect(mode(JSON.parse(JSON.stringify(await service.getExperimental())))).toBe(value);
    }
  });

  it("unrelated patches preserve the mode and explicit off is the reversible undo", () => {
    let settings = applyExperimentalSettingsPatch({}, patchInstanceExperimentalSettingsSchema.parse({ eventBackedWaitMode: "enforce" }));
    settings = applyExperimentalSettingsPatch(settings, { enablePipelines: true });
    expect(mode(settings)).toBe("enforce");
    settings = applyExperimentalSettingsPatch(settings, patchInstanceExperimentalSettingsSchema.parse({ eventBackedWaitMode: "off" }));
    expect(mode(settings)).toBe("off");
    expect(settings.enablePipelines).toBe(true);
  });
});
