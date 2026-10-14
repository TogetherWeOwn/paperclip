import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  createEd25519NativeSshEnvelopeVerifier,
  nativeSshEnvelopeSigningPayload,
  sha256CanonicalJson,
  type NativeSshSignerRequest,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createNativeSshHostExecutorForRun,
  nativeSshAuthorityRunLedger,
} from "../services/native-ssh-authority.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native SSH ledger tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const sshTarget = {
  kind: "remote",
  transport: "ssh",
  remoteCwd: "/srv/run",
  spec: { host: "h.example.test", port: 22, username: "agent", remoteCwd: "/srv/run" },
} as unknown as AdapterExecutionTarget;
const launch = {
  command: "claude",
  args: ["--print"],
  remote: { host: "h.example.test", port: 22, username: "agent", remoteCwd: "/srv/run" },
  env: {},
};

describeEmbeddedPostgres("native SSH authority run ledger", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-ssh-ledger-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_NATIVE_SSH_AUTHORITY", "required");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Native SSH",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Remote",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: {
        issueId,
        modelDecision: { model: "claude-opus-5", outcome: "decided", pluginKey: "model-router" },
      },
    });
    return { companyId, agentId, runId, issueId };
  }

  async function snapshot(runId: string) {
    const [row] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return row?.contextSnapshot as Record<string, unknown>;
  }

  it("records the exact authority before the signer is asked and its envelope digest after", async () => {
    const ids = await seedRun();
    const keys = generateKeyPairSync("ed25519");
    const signerSaw: Array<{ request: NativeSshSignerRequest; recorded: unknown }> = [];
    // Stands in for the heartbeat's in-memory context, which later run writes persist whole.
    const runContext: Record<string, unknown> = { issueId: ids.issueId };
    const executor = createNativeSshHostExecutorForRun({
      ...ids,
      target: sshTarget,
      adapterType: "claude_local",
      holder: { kind: "single", holder: { pluginId: "p1", pluginKey: "model-router", envKeys: [] } },
      decision: { model: "claude-opus-5", outcome: "decided", pluginKey: "model-router" },
      verifyEnvelope: createEd25519NativeSshEnvelopeVerifier(
        keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
      ...nativeSshAuthorityRunLedger(db, ids.runId, runContext),
      // Stand-in for the out-of-process signer: it receives only the opaque id
      // and signs the authority the server recorded for it, nothing the caller says.
      signer: {
        requestEnvelope: async (request) => {
          const recorded = (await snapshot(ids.runId)).nativeSshAuthority as Record<string, unknown>;
          signerSaw.push({ request, recorded });
          const unsigned = { version: "1", audience: "paperclip-native-ssh", authority: recorded } as const;
          return {
            ...unsigned,
            signature: cryptoSign(
              null,
              Buffer.from(nativeSshEnvelopeSigningPayload(unsigned as never)),
              keys.privateKey,
            ).toString("base64"),
          };
        },
      },
    });

    const envelope = await executor!.authorizeLaunch(launch);

    expect(signerSaw).toHaveLength(1);
    expect(Object.keys(signerSaw[0]!.request).sort()).toEqual(["opaqueRequestId", "version"]);
    expect(signerSaw[0]!.recorded).toEqual(envelope.authority);
    const after = await snapshot(ids.runId);
    expect(after.nativeSshAuthority).toEqual(envelope.authority);
    expect(after.nativeSshEnvelopeSha256).toBe(sha256CanonicalJson(envelope));
    expect(after.modelDecision).toEqual({ model: "claude-opus-5", outcome: "decided", pluginKey: "model-router" });
    // A later full-snapshot write of the run context keeps the record.
    expect(runContext).toMatchObject({
      nativeSshAuthority: envelope.authority,
      nativeSshEnvelopeSha256: sha256CanonicalJson(envelope),
    });
    expect(envelope.authority.assignedModel.sha256).toBe(
      createHash("sha256").update("claude-opus-5").digest("hex"),
    );
  });

  it("fails closed when the run row cannot record the authority", async () => {
    const ledger = nativeSshAuthorityRunLedger(db, randomUUID());
    await expect(ledger.persistAuthority({} as never)).rejects.toThrow(/record native SSH authority/i);
  });
});
