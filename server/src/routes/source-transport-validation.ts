import type { Db } from "@paperclipai/db";
import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import {
  createDbSourceBoundTransportValidationDeps,
  runSourceBoundTransportValidation,
  type SourceBoundTransportValidationDeps,
  type SourceBoundTransportValidationReceipt,
} from "../services/source-bound-transport-validation-operation.js";
import { getActorInfo } from "./authz.js";

const sourceTransportValidationSchema = z.object({
  workspaceId: z.string().min(1),
  transport: z.string().min(1),
  requestedToolClass: z.string().nullable().optional(),
});

function receiptStatus(receipt: SourceBoundTransportValidationReceipt): number {
  if (receipt.ok) return 200;
  if (!receipt.transport.ok) {
    switch (receipt.transport.errorCode) {
      case "unauthorized_principal":
        return 403;
      case "issue_dependencies_blocked":
        return 409;
      case "low_trust_preflight_denied":
        return 403;
      case "workspace_transport_mismatch":
        return 409;
    }
  }
  return 422;
}

/**
 * `POST /api/issues/:issueId/transport-validation`
 *
 * Source-issue-bound transport-only validation. The authenticated agent is
 * the principal; every compared fact is resolved server-side. This route
 * performs no wake, no checkout, no workspace realization and no runtime
 * start: it returns a validation receipt (or a deny receipt) and records an
 * audit activity entry for the decision. See
 * `server/src/services/source-bound-transport-validation-operation.ts`.
 */
export function sourceTransportValidationRoutes(
  db: Db,
  opts: { deps?: SourceBoundTransportValidationDeps } = {},
) {
  const router = Router();

  router.post(
    "/issues/:id/transport-validation",
    validate(sourceTransportValidationSchema),
    async (req, res) => {
      const actor = getActorInfo(req);
      const principalAgentId = actor.agentId ?? "";
      const companyId =
        req.actor.type === "agent" ? (req.actor.companyId ?? "") : "";
      const sourceIssueId = req.params.id as string;

      const deps: SourceBoundTransportValidationDeps =
        opts.deps ??
        createDbSourceBoundTransportValidationDeps(db, {
          logDecision: async (entry) => {
            if (!entry.companyId || !entry.sourceIssueId) return;
            await logActivity(db, {
              companyId: entry.companyId,
              actorType: "agent",
              actorId: entry.principalAgentId || "unknown-agent",
              agentId: entry.principalAgentId || null,
              runId: actor.runId,
              action: "issue.source_transport_validation",
              entityType: "issue",
              entityId: entry.sourceIssueId,
              issueId: entry.sourceIssueId,
              details: {
                workspaceId: entry.workspaceId,
                resultCode: entry.resultCode,
                attestationResultCode: entry.attestationResultCode,
                boundary: "transport-only",
                runtimeInvoked: false,
              },
            });
          },
        });

      const receipt = await runSourceBoundTransportValidation(deps, {
        companyId,
        sourceIssueId,
        principalAgentId,
        workspaceId: req.body.workspaceId,
        transport: req.body.transport,
        requestedToolClass: req.body.requestedToolClass ?? null,
      });
      res.status(receiptStatus(receipt)).json(receipt);
    },
  );

  return router;
}
