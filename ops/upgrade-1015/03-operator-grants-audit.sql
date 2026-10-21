-- 1015.0 cutover pack, part 3: Operator grants audit + agent identity counts.
-- Runbook: doc/UPGRADE-1015.md §3-§4. All queries are read-only.
-- NEVER select private_key_material or print key values.

-- 3a. PRE-CUTOVER SNAPSHOT (run on the old version, keep the output for CISO):
-- active human operators and their stored grant rows.
SELECT m.company_id, m.principal_id AS user_id, m.membership_role,
       g.permission_key, g.scope, g.granted_by_user_id, g.created_at
FROM company_memberships m
LEFT JOIN principal_permission_grants g
  ON g.company_id = m.company_id
 AND g.principal_type = 'user'
 AND g.principal_id = m.principal_id
WHERE m.principal_type = 'user'
  AND m.status = 'active'
  AND m.membership_role IN ('operator', 'member')
ORDER BY 1, 2, 4;

-- 3b. POST-BOOT VERIFICATION (first 1015.0 boot inserts missing role-default
-- rows with granted_by_user_id NULL; server/src/index.ts:709): rows the
-- backfill added for operators. Fill :cutover_time with the boot timestamp.
-- SELECT m.company_id, m.principal_id AS user_id, g.permission_key, g.created_at
-- FROM principal_permission_grants g
-- JOIN company_memberships m
--   ON m.company_id = g.company_id
--  AND m.principal_type = 'user'
--  AND m.principal_id = g.principal_id
-- WHERE g.principal_type = 'user'
--   AND m.membership_role IN ('operator', 'member')
--   AND g.granted_by_user_id IS NULL
--   AND g.created_at >= ':cutover_time'::timestamptz
-- ORDER BY 1, 2, 3;
-- Expect the 13 new keys per operator (company-member-roles.ts:57-72 minus
-- the pre-existing tasks:assign): agents:create, agents:configure,
-- skills:create, environments:manage, users:invite, pipelines:write,
-- tools:manage_connections, tools:manage_profiles, tools:manage_runtime,
-- tools:use, tools:admin, tools:view_audit, audit:view_agent_actions.

-- 3c. Stored tool grants with restrictions (1012.0 #14915 enforces these as
-- written; malformed/unknown restrictions now deny). Review pre-cutover.
SELECT company_id, principal_type, principal_id, permission_key, scope
FROM principal_permission_grants
WHERE permission_key LIKE 'tools:%'
  AND scope IS NOT NULL
  AND scope <> '{}'::jsonb
ORDER BY 1, 2, 3, 4;

-- 3d. Agent identity provisioning counts (no key material).
-- Table exists after the #15352 migration; pre-cutover this errors, which is fine.
-- SELECT company_id, count(*) AS provisioned_identities
-- FROM agent_identity_keys
-- GROUP BY 1;
