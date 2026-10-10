import { z } from "zod";
import { NATIVE_SIBLING_LIVENESS_SCHEMA } from "../types/sibling-liveness.js";

export const nativeSiblingLivenessVerdictSchema = z.enum(["clear", "sibling", "unknown"]);

export const nativeSiblingLivenessResponseV1Schema = z.object({
  schema: z.literal(NATIVE_SIBLING_LIVENESS_SCHEMA),
  issueId: z.string().uuid(),
  runId: z.string().uuid(),
  verdict: nativeSiblingLivenessVerdictSchema,
  observedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const nativeSiblingLivenessResponseSchema = nativeSiblingLivenessResponseV1Schema;
export type NativeSiblingLivenessResponseInput = z.infer<typeof nativeSiblingLivenessResponseSchema>;
