-- Upgrade config pack, part 1: READ-ONLY budget inventory, NOT an apply script.
-- No DB execution on the corrective card. Future authorized executor only.
-- Runbook: doc/UPGRADE-1015.md §1. Source: integration
-- 321499c232ea4e1966367b85763ad0c53969ffac.
-- psql company_id REQUIRED; inventory only that company. Do not dump to public logs.
-- Pre-schema reads intentionally omit unpriced_usage_policy, reservation_cents
-- and enforcement versions (absent in the old fork). After schema migration use
-- API/readback for those fields and the complete expected prior state.
-- The old scope-only UPDATE fallback has been REMOVED: it had neither metric/
-- window identity nor API audit. Do not invent a replacement SQL write here.
--
-- Mapping manifest, ONE entry per EXISTING policy (never create one for an exception):
-- companyId, scopeType, scopeId, metric, windowKind, policyId, expectedUpdatedAt,
-- expectedUnpricedUsagePolicy, expected amount/reservationCents/warnPercent/
-- hardStopEnabled/notifyEnabled/isActive, expected enforcement versions,
-- windowStart/windowEnd, usage snapshot time/counts, CLIProxy-only justification,
-- reason, authorization/evidence reference, reviewAt, expiresAt,
-- before/after states, targetCount, affectedCount, same-policy rollback prior value.
-- Inventory ALL policies, not only active/hard-stop rows. Reviewed targets are a
-- strict explicit subset. No wildcard company/fleet selection or implicit month.
--
-- Future preferred apply: audited POST /api/companies/:companyId/budgets/policies
-- {"scopeType":"project","scopeId":"<existing UUID>","metric":"billed_cents",
--  "windowKind":"lifetime","unpricedUsagePolicy":"allow"}
-- Spell out metric and the ACTUAL existing windowKind for EVERY row (monthly is
-- calendar_month_utc, not a default to rely on). Never send amount/new limits to
-- make a missing-policy error succeed. Validator budget.ts:10-22; exact lookup
-- server/src/services/budgets.ts:719-735. Policy ID is a manifest/readback guard,
-- NOT a supported upsert request field. No expectedRevision/CAS exists here.
--
-- Therefore require exclusive authorized configuration ownership with ALL other
-- budget writers quiesced; re-read and assert EXACTLY ONE ID+full-key row and
-- every expected prior field immediately before request; mismatch/missing/duplicate
-- => STOP with zero request. If exclusivity cannot be guaranteed, STOP (not a
-- preflight-read claim of atomic CAS). Read back SAME ID+key; assert only
-- unpricedUsagePolicy and allowed audit/version timestamps changed. Target=N,
-- affected=N, created=0, untargeted changes=0; reconcile API audit receipts.
-- Any ambiguous response: read back/audit, do not blindly replay. Rollback uses
-- the SAME ID+key and expected post-state, restoring the captured prior value
-- through the same audited API, under exclusivity; drift => STOP and reconcile.
-- Amount, active/hard stop, reservation, warning/notification controls stay intact.
-- allow does not waive priced-spend, pending accounting or any manual/security pause.
-- reviewAt/expiresAt are executor follow-up obligations, NOT API auto-expiry fields.

-- 1a. Old-schema-compatible full existing-policy identity and stop configuration.
SELECT id AS policy_id, company_id, scope_type, scope_id, metric, window_kind,
       amount, warn_percent, hard_stop_enabled, notify_enabled, is_active, updated_at
FROM budget_policies
WHERE company_id = :'company_id'::uuid
ORDER BY company_id, scope_type, scope_id, metric, window_kind, id;

-- 1b. Actual-window unpriced counts. Uses a FIXED reviewed as_of, not wall-clock
-- rollover during apply. Lifetime has NO occurred_at predicate in this integration
-- (display bounds are 1970..9999); monthly uses UTC month [start,end). Unsupported key/window =>
-- STOP via inventory review; never silently treat it as monthly.
-- Each event can contribute to company AND its matching agent AND project policy;
-- independent JOIN matching deliberately replaces the old COALESCE scope shortcut.
-- No subscription_included event counts. This is unpriced inventory, not a complete
-- enforcement summary (priced spend, pending accounting and reservations still apply).
WITH snapshot AS (
  SELECT :'as_of'::timestamptz AS as_of
), policy_windows AS (
  SELECT p.id, p.company_id, p.scope_type, p.scope_id, p.metric, p.window_kind,
         CASE p.window_kind
           WHEN 'calendar_month_utc' THEN
             date_trunc('month', s.as_of AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           WHEN 'lifetime' THEN '1970-01-01T00:00:00Z'::timestamptz
         END AS window_start,
         CASE p.window_kind
           WHEN 'calendar_month_utc' THEN
             (date_trunc('month', s.as_of AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
           WHEN 'lifetime' THEN '9999-01-01T00:00:00Z'::timestamptz
         END AS window_end
  FROM budget_policies p CROSS JOIN snapshot s
  WHERE p.company_id = :'company_id'::uuid
)
SELECT p.id AS policy_id, p.company_id, p.scope_type, p.scope_id,
       p.metric, p.window_kind, p.window_start, p.window_end,
       CASE WHEN p.window_start IS NULL OR p.metric <> 'billed_cents'
                  OR p.scope_type NOT IN ('company', 'agent', 'project')
                  OR (p.scope_type = 'company' AND p.scope_id <> p.company_id)
            THEN 'STOP-unsupported-policy' ELSE 'review' END AS mapping_state,
       count(e.id) AS unpriced_events, min(e.occurred_at) AS first_unpriced_at,
       max(e.occurred_at) AS last_unpriced_at
FROM policy_windows p
LEFT JOIN cost_events e
  ON e.company_id = p.company_id
 AND ((p.scope_type = 'company' AND p.scope_id = p.company_id)
   OR (p.scope_type = 'agent' AND e.agent_id = p.scope_id)
   OR (p.scope_type = 'project' AND e.project_id = p.scope_id))
 AND p.metric = 'billed_cents'
 AND (p.window_kind = 'lifetime'
   OR (p.window_kind = 'calendar_month_utc'
       AND e.occurred_at >= p.window_start AND e.occurred_at < p.window_end))
 AND e.cost_status = 'unpriced' AND e.billing_type <> 'subscription_included'
GROUP BY p.id, p.company_id, p.scope_type, p.scope_id, p.metric, p.window_kind,
         p.window_start, p.window_end
ORDER BY p.company_id, p.scope_type, p.scope_id, p.metric, p.window_kind, p.id;

-- 1c. Post-schema-only readback; intentionally commented so old-schema inventory
-- cannot accidentally depend on the new column. Run only in the separately
-- authorized environment after migration, under the reviewed execution contract.
-- SELECT id AS policy_id, company_id, scope_type, scope_id, metric, window_kind,
--        unpriced_usage_policy, amount, reservation_cents, warn_percent,
--        hard_stop_enabled, notify_enabled, is_active, enforcement_version,
--        enforcement_delivered_version, updated_at
-- FROM budget_policies
-- WHERE company_id = :'company_id'::uuid
-- ORDER BY id;
