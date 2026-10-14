import { generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";

import {
  createEd25519NativeSshEnvelopeVerifier,
  createNativeSshHostExecutorTarget,
  nativeSshEnvelopeSigningPayload,
  sha256CanonicalJson,
  type NativeSshHostExecutorTarget,
  type NativeSshLaunchAuthority,
  type NativeSshLaunchInput,
  type NativeSshSignedEnvelope,
} from "../host-executor.js";

/**
 * Test-only stand-in for the root-owned signer: signs whatever authority the
 * executor persisted for the request id, with a throwaway Ed25519 key. It goes
 * through the same executor and verification path as production, so a test that
 * needs a valid launch authority gets a real issued proof, not a hand-built one.
 */
export function createFixtureNativeSshHostExecutor(): NativeSshHostExecutorTarget {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const persisted = new Map<string, NativeSshLaunchAuthority>();
  return createNativeSshHostExecutorTarget({
    runId: randomUUID(),
    companyId: randomUUID(),
    agentId: randomUUID(),
    issueId: randomUUID(),
    adapterType: "fixture",
    assignedModel: { version: "1", model: "fixture-model", sha256: sha256CanonicalJson("fixture-model") },
    persistAuthority: async (authority) => {
      persisted.set(authority.opaqueRequestId, authority);
    },
    verifyEnvelope: createEd25519NativeSshEnvelopeVerifier(publicKeyPem),
    signer: {
      requestEnvelope: async ({ opaqueRequestId }) => {
        const authority = persisted.get(opaqueRequestId);
        if (!authority) throw new Error("fixture signer has no persisted authority for the request");
        const unsigned = { version: "1", audience: "paperclip-native-ssh", authority } as const;
        return {
          ...unsigned,
          signature: cryptoSign(null, Buffer.from(nativeSshEnvelopeSigningPayload(unsigned)), keys.privateKey).toString("base64"),
        } satisfies NativeSshSignedEnvelope;
      },
    },
  });
}

export async function issueFixtureNativeSshAuthority(launch: NativeSshLaunchInput): Promise<NativeSshSignedEnvelope> {
  return createFixtureNativeSshHostExecutor().authorizeLaunch(launch);
}
