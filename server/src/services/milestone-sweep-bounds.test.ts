import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getAgentWorkEligibility,
} from "@paperclipai/shared";
import { SKILL_INVENTORY_CACHE_TTL_MS } from "./company-skills.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";

function eligibilityAgent(
  id: string,
  name: string,
  status: "active" | "paused" | "terminated" = "active",
  reportsTo: string | null = null,
) {
  return { id, companyId: COMPANY, name, status, reportsTo };
}

describe("milestone sweep + skills cache bounds", () => {
  it("keeps the milestone idle poll at 15 s", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(source).toContain("CHAT_MILESTONE_RECONCILIATION_INTERVAL_MS = 15_000");
    expect(source).toContain("CHAT_MILESTONE_SWEEP_OVERLAP_MS = 5 * 60_000");
    expect(source).toContain("lastMilestoneSweepStartedAt");
    // A truncated sweep must not advance past its backlog.
    expect(source).toContain("CHAT_RUN_MILESTONE_SWEEP_DEFAULT_LIMIT");
    expect(source).toContain(
      "if (inserted < CHAT_RUN_MILESTONE_SWEEP_DEFAULT_LIMIT)",
    );
  });

  it("keeps the milestone sweep index migration idempotent", () => {
    const migration = readFileSync(
      new URL(
        "../../../packages/db/src/migrations/0336_volatile_star_brand.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("IF NOT EXISTS");
    expect(migration).toContain("heartbeat_runs_updated_at_id_idx");
  });

  it("logs background skills refresh failures instead of swallowing them", () => {
    const source = readFileSync(
      new URL("./company-skills.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("scheduleSkillInventoryBackgroundRefresh(companyId)");
    expect(source).toContain(
      '"Background skills inventory refresh failed; next read retries"',
    );
  });

  it("keeps the skills inventory TTL at 60 s", () => {
    expect(SKILL_INVENTORY_CACHE_TTL_MS).toBe(60_000);
  });

  it("splits skills reads (cached) from writes (reconciling)", () => {
    const source = readFileSync(new URL("./company-skills.ts", import.meta.url), "utf8");
    // Read paths serve cached rows; cold start reconciles once, later reads
    // refresh in the background single-flight.
    expect(source).toContain("await ensureSkillInventoryCached(companyId)");
    expect(source).toContain("scheduleSkillInventoryBackgroundRefresh(companyId)");
    expect(source).toContain("if (skillInventoryRefreshPromises.has(companyId)) return;");
    // Write paths still reconcile synchronously.
    expect(source).toContain("async function ensureSkillInventoryCurrent(companyId: string)");
  });

  it("resolves agent GET from reporting ancestors only", () => {
    // Agent data access lives in lib/agent-records.ts on this line (the
    // sync-base extraction); assert on the implementation there.
    const source = readFileSync(new URL("../lib/agent-records.ts", import.meta.url), "utf8");
    const getById = source.slice(
      source.indexOf("async function getById(id: string)"),
      source.indexOf("async function ensureManager"),
    );
    expect(getById).toContain("reportsTo");
    expect(getById).not.toContain("listCompanyAgentRows");
  });

  it("proves ancestor-only context preserves org chain health", () => {
    const ceo = eligibilityAgent("ceo", "CEO");
    const cto = eligibilityAgent("cto", "CTO", "paused", "ceo");
    const coder = eligibilityAgent("coder", "Coder", "active", "cto");
    const unrelated = eligibilityAgent("other", "Other", "terminated", null);
    const full = [coder, cto, ceo, unrelated];
    const ancestorsOnly = [coder, cto, ceo];
    const withFull = getAgentWorkEligibility({ agent: coder, agents: full });
    const withAncestors = getAgentWorkEligibility({ agent: coder, agents: ancestorsOnly });
    expect(withAncestors.orgChainHealth).toEqual(withFull.orgChainHealth);
    expect(withAncestors.orgChainHealth.status).toBe("healthy");
    expect((withAncestors.orgChainHealth.pausedAncestors ?? []).map((a) => a.id)).toEqual(["cto"]);
  });
});
