import { Router } from "express";
import type { Request } from "express";
import type { Db, issues } from "@paperclipai/db";
import { isUuidLike, restoreCompletedReviewSchema } from "@paperclipai/shared";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import {
  completedReviewRestorationService,
  type CompletedReviewRestorationAuthorization,
} from "../services/completed-review-restoration.js";
import { assertIssueReviewVerdictActorAllowed } from "../services/issue-review-policy.js";
import { issueService } from "../services/issues.js";
import { assertAuthenticated, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";

type IssueRow = typeof issues.$inferSelect;

function issueResource(issue: IssueRow) {
  return {
    type: "issue" as const,
    companyId: issue.companyId,
    issueId: issue.id,
    projectId: issue.projectId,
    parentIssueId: issue.parentId,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    status: issue.status,
  };
}

function restorationAuthorization(req: Request): CompletedReviewRestorationAuthorization {
  return {
    async issue(tx, issue) {
      // Gate the locked row too: the service passes its own re-read row here,
      // so fold existence into access (404 either way) before the write-path
      // checks below instead of leaking cross-tenant existence as a 403.
      if (!hasCompanyAccess(req, issue.companyId)) throw notFound("Issue not found");
      assertCompanyAccess(req, issue.companyId);
      // This repair is not part of skill-test or task-bridge capability scopes.
      // Never turn ordinary visibility into additional restoration authority.
      if (req.actor.type === "agent" && req.actor.keyScope) {
        throw forbidden("Scoped agent keys cannot restore completed reviews");
      }
      if (req.actor.type === "agent" && !req.actor.runId?.trim()) {
        throw unauthorized("Agent run attribution required");
      }
      const resource = issueResource(issue);
      const decision = await accessService(tx).decide({
        actor: req.actor, action: "issue:mutate", resource, scope: resource,
      });
      if (!decision.allowed) {
        throw forbidden("Not allowed to restore this issue", authorizationDeniedDetails(decision));
      }
      const actor = getActorInfo(req);
      await assertIssueReviewVerdictActorAllowed(tx, {
        issue, actor: { type: actor.actorType, id: actor.actorId },
      });
    },
    async assignment(tx, issue, target) {
      const assigneeAgentId = target.type === "agent" ? target.agentId : null;
      const assigneeUserId = target.type === "user" ? target.userId : null;
      if (issue.assigneeAgentId === assigneeAgentId && issue.assigneeUserId === assigneeUserId) return;
      const resource = { ...issueResource(issue), assigneeAgentId, assigneeUserId };
      const decision = await accessService(tx).decide({
        actor: req.actor, action: "tasks:assign", resource, scope: resource,
      });
      if (!decision.allowed) {
        throw forbidden("Not allowed to restore the original assignee", authorizationDeniedDetails(decision));
      }
    },
  };
}

export function completedReviewRestorationRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const restoration = completedReviewRestorationService(db);

  router.post("/issues/:id/completed-review/restore", validate(restoreCompletedReviewSchema), async (req, res) => {
    assertAuthenticated(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req, res, isUuidLike(id) ? issuesSvc.getById(id) : null, "Issue not found",
    );
    if (!existing) return;
    const authorize = restorationAuthorization(req);
    await authorize.issue(db, existing);
    // The service repeats authorization against its locked row using the same
    // serializable transaction as evidence reads, assignment, update and audit.
    const result = await restoration.restore({
      ...req.body,
      companyId: existing.companyId,
      issueId: existing.id,
      actor: getActorInfo(req),
    }, authorize);
    res.json(result);
  });

  return router;
}
