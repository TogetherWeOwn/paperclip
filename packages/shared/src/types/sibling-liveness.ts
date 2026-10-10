export const NATIVE_SIBLING_LIVENESS_SCHEMA = "paperclip.native-sibling-liveness.v1" as const;

export type NativeSiblingLivenessVerdict = "clear" | "sibling" | "unknown";

export interface NativeSiblingLivenessResponseV1 {
  schema: typeof NATIVE_SIBLING_LIVENESS_SCHEMA;
  issueId: string;
  runId: string;
  verdict: NativeSiblingLivenessVerdict;
  observedAt: string;
  expiresAt: string;
}

export type NativeSiblingLivenessResponse = NativeSiblingLivenessResponseV1;
