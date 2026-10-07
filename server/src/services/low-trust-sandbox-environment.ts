import type { Environment } from "@paperclipai/shared";

/**
 * Why a stored low-trust sandbox designation cannot be used for a run. Callers
 * log it and treat the designation as absent, so the low-trust gate rejects the
 * run with `low_trust_requires_sandbox_environment` instead of running on local.
 */
export type LowTrustSandboxDesignationRejection =
  | "environment_not_found"
  | "environment_not_active"
  | "environment_not_sandbox"
  | "environment_probe_only_provider"
  | "environment_reuses_lease"
  | "environment_bound_to_other_company";

type LowTrustSandboxEnvironmentReader = {
  getById(environmentId: string): Promise<Pick<Environment, "id" | "driver" | "status" | "config"> | null>;
  listBoundCompanyIds(environmentId: string): Promise<string[]>;
};

/**
 * Verify the instance's designated low-trust sandbox environment right before
 * it is used to place a `low_trust_review` run. The setting is plain data, so
 * the row can have been archived, deleted or re-pointed since it was written;
 * checking at use time keeps a stale designation from landing untrusted code
 * on an unusable or foreign environment. A designated environment must also
 * keep `reuseLease` off: a retained VM would carry one untrusted run's content
 * into the next. An unbound (instance-global) environment is open to every
 * company; a bound one only to its owners.
 */
export async function resolveLowTrustSandboxEnvironment(input: {
  designatedEnvironmentId: string | null | undefined;
  companyId: string;
  environments: LowTrustSandboxEnvironmentReader;
}): Promise<
  | { environmentId: string; rejection: null }
  | { environmentId: null; rejection: LowTrustSandboxDesignationRejection | null }
> {
  if (!input.designatedEnvironmentId) return { environmentId: null, rejection: null };
  const environment = await input.environments.getById(input.designatedEnvironmentId);
  if (!environment) return { environmentId: null, rejection: "environment_not_found" };
  if (environment.status !== "active") return { environmentId: null, rejection: "environment_not_active" };
  if (environment.driver !== "sandbox") return { environmentId: null, rejection: "environment_not_sandbox" };
  const config = environment.config && typeof environment.config === "object" ? environment.config : {};
  if ((config as Record<string, unknown>).provider === "fake") {
    return { environmentId: null, rejection: "environment_probe_only_provider" };
  }
  if ((config as Record<string, unknown>).reuseLease === true) {
    return { environmentId: null, rejection: "environment_reuses_lease" };
  }
  const owners = await input.environments.listBoundCompanyIds(environment.id);
  if (owners.length > 0 && !owners.includes(input.companyId)) {
    return { environmentId: null, rejection: "environment_bound_to_other_company" };
  }
  return { environmentId: environment.id, rejection: null };
}
