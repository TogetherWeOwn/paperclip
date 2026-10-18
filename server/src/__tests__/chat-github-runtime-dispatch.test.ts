import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import * as shadow from "../services/chat-github-shadow.js";
import { assertGitHubCandidateDispatch, githubIsolationConfigurationDigest,
  type PreparedGitHubCandidateRuntime } from "../services/chat-github-runtime-isolation.js";
import { createHash } from "node:crypto";

const companyId = "10000000-0000-4000-8000-000000000001";
const environmentId = "20000000-0000-4000-8000-000000000001";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(["allowedModelAccepted", "otherModelDenied", "rawProxyDenied"] as const)(
  "rechecks %s at actual dispatch and rejects legacy/missing positive evidence", async check => {
    vi.spyOn(shadow, "githubCandidateMayWake").mockResolvedValue(true);
    const environment = { id: environmentId, driver: "ssh", status: "active", config: {}, envVars: {} };
    const certificate = { companyId, environmentId, configurationDigest: githubIsolationConfigurationDigest(environment), modelProxyPolicy: "client-tools-only-v1",
      primaryCanaries: ["run", "worktree"].map(kind => ({ kind, serverPath: "/server/" + kind, remotePath: "/remote/" + kind, sha256: "a".repeat(64) })) };
    vi.stubEnv("PAPERCLIP_GITHUB_SHADOW_CERTIFIED_ENVIRONMENTS", JSON.stringify([certificate]));
    const prepared = { companyId, runId: "run", candidateId: "candidate", enrollmentId: "enrollment", namespace: "namespace", home: "/home/fixture",
      configurationDigest: certificate.configurationDigest,
      certificateDigest: createHash("sha256").update(JSON.stringify(canonical(certificate))).digest("hex"),
      target: { kind: "remote", transport: "ssh", environmentId, remoteCwd: "/remote/workspace", spec: { host: "fixture", username: "paperclip-shadow" },
        githubCandidateIsolation: { namespace: "namespace", home: "/home/fixture" } },
    } as PreparedGitHubCandidateRuntime;
    for (const value of [true, false, undefined]) {
      const receipt = { status: "passed", candidateId: prepared.candidateId, namespace: prepared.namespace,
        configurationDigest: prepared.configurationDigest, certificateDigest: prepared.certificateDigest,
        checks: { providerToolsDenied: true, allowedModelAccepted: true, otherModelDenied: true, rawProxyDenied: true, [check]: value } };
      const rows = [[{ id: "candidate" }], [environment], [{ isolationTests: { run: receipt } }]];
      const db = { select: () => ({ from: () => ({ where: async () => rows.shift() }) }) } as unknown as Db;
      const dispatch = assertGitHubCandidateDispatch(db, prepared, prepared.target);
      if (value === true) await expect(dispatch).resolves.toBeUndefined();
      else await expect(dispatch).rejects.toThrow("github_candidate_isolation_unavailable");
    }
  },
);
