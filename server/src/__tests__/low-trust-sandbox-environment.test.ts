import { describe, expect, it } from "vitest";
import { resolveExecutionWorkspaceEnvironmentId } from "../services/execution-workspace-policy.ts";
import { preflightLowTrustWorkspaceIsolation } from "../services/heartbeat.ts";
import { resolveLowTrustSandboxEnvironment } from "../services/low-trust-sandbox-environment.ts";
import type { TrustPresetResolution } from "../services/trust-preset-resolver.ts";

const COMPANY_ID = "company-1";
const LOCAL_ID = "env-local";
const SANDBOX_ID = "env-low-trust-sandbox";

type FakeEnvironment = {
  id: string;
  driver: "local" | "ssh" | "sandbox";
  status: "active" | "archived";
  config: Record<string, unknown>;
  boundCompanyIds?: string[];
};

function fakeEnvironments(rows: FakeEnvironment[]) {
  return {
    getById: async (id: string) => rows.find((row) => row.id === id) ?? null,
    listBoundCompanyIds: async (id: string) =>
      rows.find((row) => row.id === id)?.boundCompanyIds ?? [],
  };
}

const exeDevSandbox: FakeEnvironment = {
  id: SANDBOX_ID,
  driver: "sandbox",
  status: "active",
  config: { provider: "exe-dev", reuseLease: false },
};
const localEnvironment: FakeEnvironment = {
  id: LOCAL_ID,
  driver: "local",
  status: "active",
  config: {},
};

describe("resolveLowTrustSandboxEnvironment", () => {
  it("accepts an active sandbox environment", async () => {
    await expect(
      resolveLowTrustSandboxEnvironment({
        designatedEnvironmentId: SANDBOX_ID,
        companyId: COMPANY_ID,
        environments: fakeEnvironments([exeDevSandbox]),
      }),
    ).resolves.toEqual({ environmentId: SANDBOX_ID, rejection: null });
  });

  it("treats no designation as absent without a rejection to report", async () => {
    for (const designatedEnvironmentId of [null, undefined, ""]) {
      await expect(
        resolveLowTrustSandboxEnvironment({
          designatedEnvironmentId,
          companyId: COMPANY_ID,
          environments: fakeEnvironments([exeDevSandbox]),
        }),
      ).resolves.toEqual({ environmentId: null, rejection: null });
    }
  });

  it.each([
    ["a deleted row", [], "environment_not_found"],
    ["an archived row", [{ ...exeDevSandbox, status: "archived" as const }], "environment_not_active"],
    ["a non-sandbox driver", [{ ...exeDevSandbox, driver: "ssh" as const }], "environment_not_sandbox"],
    ["the local environment", [{ ...localEnvironment, id: SANDBOX_ID }], "environment_not_sandbox"],
    [
      "the probe-only fake provider",
      [{ ...exeDevSandbox, config: { provider: "fake" } }],
      "environment_probe_only_provider",
    ],
    [
      "an environment that retains its VM between runs",
      [{ ...exeDevSandbox, config: { provider: "exe-dev", reuseLease: true } }],
      "environment_reuses_lease",
    ],
    [
      "an environment bound to another company",
      [{ ...exeDevSandbox, boundCompanyIds: ["company-2"] }],
      "environment_bound_to_other_company",
    ],
  ])("rejects %s", async (_label, rows, rejection) => {
    await expect(
      resolveLowTrustSandboxEnvironment({
        designatedEnvironmentId: SANDBOX_ID,
        companyId: COMPANY_ID,
        environments: fakeEnvironments(rows),
      }),
    ).resolves.toEqual({ environmentId: null, rejection });
  });

  it("accepts an environment bound to the run's own company", async () => {
    await expect(
      resolveLowTrustSandboxEnvironment({
        designatedEnvironmentId: SANDBOX_ID,
        companyId: COMPANY_ID,
        environments: fakeEnvironments([{ ...exeDevSandbox, boundCompanyIds: [COMPANY_ID, "company-2"] }]),
      }),
    ).resolves.toEqual({ environmentId: SANDBOX_ID, rejection: null });
  });
});

// Composes the same three steps `heartbeat.ts` runs per run: verify the
// designation, resolve the environment selection, then let the existing
// low-trust gate inspect the selected environment's driver.
describe("low-trust sandbox placement (resolver + low-trust gate)", () => {
  const lowTrust: TrustPresetResolution = {
    kind: "low_trust_review",
    preset: "low_trust_review",
    boundary: { mode: "low_trust_review", companyId: COMPANY_ID, rootIssueId: "issue-1" },
    sourcePresets: { agent: "low_trust_review" },
  };
  const standard: TrustPresetResolution = {
    kind: "standard",
    preset: "standard",
    boundary: null,
    sourcePresets: {},
  };

  async function placeRun(input: {
    trustPreset: TrustPresetResolution;
    designatedEnvironmentId: string | null;
    agentDefaultEnvironmentId?: string | null;
    environments: FakeEnvironment[];
  }) {
    const environments = fakeEnvironments([localEnvironment, ...input.environments]);
    const isLowTrust = input.trustPreset.kind === "low_trust_review";
    const designation = isLowTrust
      ? await resolveLowTrustSandboxEnvironment({
          designatedEnvironmentId: input.designatedEnvironmentId,
          companyId: COMPANY_ID,
          environments,
        })
      : null;
    const resolution = resolveExecutionWorkspaceEnvironmentId({
      agentDefaultEnvironmentId: input.agentDefaultEnvironmentId ?? null,
      instanceDefaultEnvironmentId: null,
      localDefaultEnvironmentId: LOCAL_ID,
      lowTrustReview: isLowTrust,
      lowTrustSandboxEnvironmentId: designation?.environmentId ?? null,
    });
    const selected = await environments.getById(resolution.environmentId);
    const driver = await preflightLowTrustWorkspaceIsolation({
      trustPreset: input.trustPreset,
      isolatedWorkspacesEnabled: true,
      effectiveExecutionWorkspaceMode: "isolated_workspace",
      issue: { companyId: COMPANY_ID, id: "issue-1", projectId: "project-1" },
      resolveSelectedEnvironmentDriver: async () => selected?.driver,
    });
    return { resolution, driver };
  }

  it("runs a low-trust review in the designated sandbox with no agent or instance binding", async () => {
    await expect(
      placeRun({
        trustPreset: lowTrust,
        designatedEnvironmentId: SANDBOX_ID,
        environments: [exeDevSandbox],
      }),
    ).resolves.toEqual({
      resolution: { environmentId: SANDBOX_ID, source: "low_trust_sandbox" },
      driver: "sandbox",
    });
  });

  it("fails closed with low_trust_requires_sandbox_environment when nothing is designated", async () => {
    await expect(
      placeRun({
        trustPreset: lowTrust,
        designatedEnvironmentId: null,
        environments: [exeDevSandbox],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "low_trust_requires_sandbox_environment" }),
    });
  });

  it.each([
    ["deleted", []],
    ["archived", [{ ...exeDevSandbox, status: "archived" as const }]],
    ["not a sandbox driver", [{ ...exeDevSandbox, driver: "ssh" as const }]],
    ["reusing its lease", [{ ...exeDevSandbox, config: { provider: "exe-dev", reuseLease: true } }]],
    ["bound to another company", [{ ...exeDevSandbox, boundCompanyIds: ["company-2"] }]],
  ])("fails closed when the designated environment is %s", async (_label, environments) => {
    await expect(
      placeRun({ trustPreset: lowTrust, designatedEnvironmentId: SANDBOX_ID, environments }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "low_trust_requires_sandbox_environment" }),
    });
  });

  it("leaves a trusted run on local and ignores the designation", async () => {
    await expect(
      placeRun({
        trustPreset: standard,
        designatedEnvironmentId: SANDBOX_ID,
        environments: [exeDevSandbox],
      }),
    ).resolves.toEqual({
      resolution: { environmentId: LOCAL_ID, source: "default" },
      driver: null,
    });
  });

  it("leaves a trusted run with its own binding untouched", async () => {
    await expect(
      placeRun({
        trustPreset: standard,
        designatedEnvironmentId: SANDBOX_ID,
        agentDefaultEnvironmentId: "env-agent-ssh",
        environments: [
          exeDevSandbox,
          { id: "env-agent-ssh", driver: "ssh", status: "active", config: {} },
        ],
      }),
    ).resolves.toMatchObject({
      resolution: { environmentId: "env-agent-ssh", source: "agent" },
    });
  });
});
