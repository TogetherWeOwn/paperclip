import type { RequestHandler } from "express";
import { checkObserverCeiling } from "../services/observer-scope.js";

/**
 * Global deny-by-default ceiling for observer credentials
 * ([TOG-21648](/TOG/issues/TOG-21648)).
 *
 * Mount immediately after actor resolution (after `cloudControlMiddleware`)
 * and before every route: an observer actor may reach ONLY its three GET
 * read paths with a live, in-window scope for the admitted company. All other
 * verbs (including HEAD/OPTIONS), paths, companies, expired/revoked scopes
 * and malformed scopes end here with 403/400 and never reach generic actor
 * permissions, mutation handlers or cached elevated authority. Revocation is
 * enforced upstream per request (`agent_api_keys.revokedAt` in the auth
 * middleware); this layer additionally re-validates scope shape and expiry on
 * every request with no cache.
 */
export function observerCeiling(): RequestHandler {
  return (req, res, next) => {
    const check = checkObserverCeiling({
      actor: req.actor,
      method: req.method,
      // `req.path` is the full path at app-level mounts (e.g.
      // `/api/companies/{id}/issues`); the ceiling matches exact templates,
      // so subpaths (`/issues/count`, `/issues/{id}`) deny here.
      path: req.path,
    });
    if (!check) {
      next();
      return;
    }
    if (!check.ok) {
      // Uniform 403: the code distinguishes the cause for operators without
      // giving unauthenticated callers a shape oracle via status codes.
      res.status(403).json({ error: check.error, code: check.code });
      return;
    }
    next();
  };
}
