import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { registerIssueWaitCoverageSchema } from "@paperclipai/shared";
import { assertAuthenticated, assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { issueWaitCoverageService } from "../services/issue-wait-coverage.js";

const scopeSchema = z.object({ companyId: z.string().uuid(), issueId: z.string().uuid() });

export function issueWaitCoverageRoutes(db: Db) {
  const router = Router();
  const service = issueWaitCoverageService(db);

  router.post("/companies/:companyId/issues/:issueId/wait-coverage", async (req, res) => {
    assertAuthenticated(req);
    // Controllers use existing board authentication. Agent keys can never self-register coverage.
    assertBoard(req);
    const { companyId, issueId } = scopeSchema.parse(req.params);
    assertCompanyAccess(req, companyId);
    const input = registerIssueWaitCoverageSchema.parse(req.body);
    const actor = getActorInfo(req);
    const coverage = await service.register(companyId, issueId, input, {
      type: "board", id: actor.actorId, runId: actor.runId,
    });
    res.status(200).json(coverage);
  });

  return router;
}
