-- 1015.0 cutover pack, part 1: budgets / unpricedUsagePolicy.
-- Runbook: doc/UPGRADE-1015.md §1. All reads are safe on the old version
-- except the unpriced_usage_policy column, which appears after migration 0312.
--
-- Preferred cutover path is the API (validated, activity-logged):
--   POST /api/companies/:companyId/budgets/policies               (server/src/routes/costs.ts:354-362)
--   { "scopeType": "<company|agent|project>", "scopeId": "<uuid>",
--     "unpricedUsagePolicy": "allow" }
-- Use the UPDATE template at the bottom only if the API is unavailable.

-- 1a. Current budget policies that can hard-stop (old version: no unpriced column yet).
SELECT company_id, scope_type, scope_id, metric, window_kind, amount,
       hard_stop_enabled, is_active
FROM budget_policies
WHERE is_active AND hard_stop_enabled AND amount > 0
ORDER BY company_id, scope_type, scope_id;

-- 1b. Unpriced cost events in the current UTC month per scope.
-- Definition: cost_status = 'unpriced' AND billing_type <> 'subscription_included'
-- (server/src/services/budgets.ts:203). Any scope listed here AND in 1a
-- blocks at cutover unless its policy is set to 'allow'.
SELECT company_id,
       COALESCE(agent_id::text, project_id::text, goal_id::text, '(company)') AS scope_ref,
       count(*) AS unpriced_events,
       min(occurred_at) AS first_unpriced_at,
       max(occurred_at) AS last_unpriced_at
FROM cost_events
WHERE cost_status = 'unpriced'
  AND billing_type <> 'subscription_included'
  AND occurred_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
GROUP BY 1, 2
ORDER BY 1, 2;

-- 1c. Post-migration verification: every policy's unpriced policy.
-- (Run after 0312; pre-cutover this errors with "column does not exist".)
-- SELECT company_id, scope_type, scope_id, unpriced_usage_policy
-- FROM budget_policies
-- WHERE is_active AND hard_stop_enabled AND amount > 0
-- ORDER BY 1, 2, 3;

-- 1d. FALLBACK template (prefer the API above). Fill in :company_id and the
-- fleet scope rows, review the WHERE match with SELECT first, then run.
-- UPDATE budget_policies
-- SET unpriced_usage_policy = 'allow', updated_at = now()
-- WHERE company_id = ':company_id'
--   AND scope_type = ':scope_type'   -- company | agent | project
--   AND scope_id = ':scope_id'::uuid
--   AND unpriced_usage_policy = 'block';
