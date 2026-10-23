-- Upgrade config pack, part 3: READ-ONLY sanitized principal inventory.
-- No live execution on the corrective card. Future authorized executor only.
-- Source: integration 321499c232ea4e1966367b85763ad0c53969ffac.
-- Runbook: doc/UPGRADE-1015.md §3-§4. Required psql company_id.
-- Never output raw scopes, credentials, arguments, adapter env or identity material.
-- Principal/membership/grant IDs are opaque; retain inventory in authorized custody.
--
-- Raw role categories include ALL active human rows, not just operator/member.
-- Normalization is exact/case-sensitive: owner/admin/operator/viewer preserved;
-- member, NULL, empty, unknown (including uppercase/whitespace variants) => operator.
-- server/src/services/company-member-roles.ts:4-19. Do not UPDATE stored roles.
--
-- 13 is the newly added permission-key SET, NOT an insert count per principal.
-- Existing scoped/custom keys count as present: grant uniqueness excludes scope
-- (schema/principal_permission_grants.ts:18-23). Backfill ON CONFLICT DO NOTHING
-- preserves those rows/scopes/attribution. Project missing keys individually.
-- Snapshot grant IDs before startup; reconcile predicted missing rows against
-- staging-observed new IDs, unchanged prior scoped rows and startup aggregate.
-- NULL grantor + timestamp alone is NOT proof of backfill attribution.
--
-- Role-only PATCH does NOT revoke grants. Do not delete grants with SQL.
-- Separately authorized narrowing, if required: existing audited atomic
-- PATCH /api/companies/:companyId/members/:memberId/role-and-grants with an
-- EXPLICIT full {membershipRole, status, grants:[{permissionKey,scope}]} target.
-- Omitting grants means [] (replace ALL), not preservation. Validator access.ts:
-- 96-124; route access.ts:4543-4586; service access.ts:483-579.
-- Preserve last-active-owner guard; board/company/users:manage_permissions and
-- target-rank/self/instance-admin protections apply. No new authorization here.
-- GET /api/companies/:companyId/members reads stored grants, NOT complete effective
-- authority. Independently verify intended allowed/denied contexts and restart in
-- disposable staging; privileged owner/admin/local paths must not mask results.
-- Role defaults are reinserted at restart: submitted grants alone are not durable
-- narrowing unless the normalized target role's defaults fit the approved set.

-- 3a. Counts for ALL active raw-role categories plus normalized role.
WITH memberships AS (
  SELECT id, company_id, principal_id,
         CASE WHEN membership_role IS NULL THEN 'null'
              WHEN membership_role IN ('owner','admin','operator','viewer','member')
                THEN membership_role ELSE 'unknown' END AS raw_role_category,
         CASE WHEN membership_role IN ('owner','admin','operator','viewer')
                THEN membership_role ELSE 'operator' END AS normalized_role
  FROM company_memberships
  WHERE company_id = :'company_id'::uuid
    AND principal_type = 'user' AND status = 'active'
)
SELECT company_id, raw_role_category, normalized_role, count(*) AS active_memberships
FROM memberships
GROUP BY company_id, raw_role_category, normalized_role
ORDER BY company_id, raw_role_category, normalized_role;

-- 3b. Opaque principal rows; left join retains principals with ZERO stored grants.
-- Unknown raw strings are suppressed, not dropped from counts. No raw scope JSON.
SELECT m.company_id, m.id AS membership_id, m.principal_id AS principal_alias,
       CASE WHEN m.membership_role IS NULL THEN 'null'
            WHEN m.membership_role IN ('owner','admin','operator','viewer','member')
              THEN m.membership_role ELSE 'unknown' END AS raw_role_category,
       CASE WHEN m.membership_role IN ('owner','admin','operator','viewer')
              THEN m.membership_role ELSE 'operator' END AS normalized_role,
       g.id AS grant_id, g.permission_key,
       CASE WHEN g.id IS NULL THEN 'no-grant'
            WHEN g.scope IS NULL THEN 'null-unrestricted'
            WHEN g.scope = '{}'::jsonb THEN 'empty-object'
            WHEN jsonb_typeof(g.scope) = 'object' THEN 'restricted-object'
            ELSE 'invalid-root' END AS scope_category,
       (g.granted_by_user_id IS NULL) AS bootstrap_compatible_attribution,
       g.created_at, g.updated_at
FROM company_memberships m
LEFT JOIN principal_permission_grants g
  ON g.company_id = m.company_id AND g.principal_type = 'user'
 AND g.principal_id = m.principal_id
WHERE m.company_id = :'company_id'::uuid
  AND m.principal_type = 'user' AND m.status = 'active'
ORDER BY m.id, g.permission_key;

-- 3c. Per-key projection for every normalized operator, including member/null/unknown.
-- Project ALL 14 defaults (tasks:assign may also be missing); never assume 13 inserts.
-- Owner/admin/viewer default sets are unchanged vs old fork; inventory their rows
-- too and reconcile any pre-existing missing-default repairs separately.
WITH operator_defaults(permission_key) AS (VALUES
  ('agents:create'), ('agents:configure'), ('skills:create'),
  ('environments:manage'), ('users:invite'), ('tasks:assign'),
  ('pipelines:write'), ('tools:manage_connections'), ('tools:manage_profiles'),
  ('tools:manage_runtime'), ('tools:use'), ('tools:admin'),
  ('tools:view_audit'), ('audit:view_agent_actions')
)
SELECT m.company_id, m.id AS membership_id, m.principal_id AS principal_alias,
       d.permission_key, g.id AS existing_grant_id,
       CASE WHEN g.id IS NULL THEN 'projected-insert-null-scope'
            ELSE 'preserve-existing-row-and-scope' END AS projected_action
FROM company_memberships m CROSS JOIN operator_defaults d
LEFT JOIN principal_permission_grants g
  ON g.company_id = m.company_id AND g.principal_type = 'user'
 AND g.principal_id = m.principal_id AND g.permission_key = d.permission_key
WHERE m.company_id = :'company_id'::uuid
  AND m.principal_type = 'user' AND m.status = 'active'
  AND (m.membership_role IS NULL
       OR m.membership_role NOT IN ('owner','admin','viewer'))
ORDER BY m.id, d.permission_key;

-- 3d. ALL tools:use roots, including broad grants that might mask restricted denies.
-- This aggregate is NOT the full sanitized selector audit in runbook §4.
-- Do not replace it with the old raw nonempty-scope dump.
SELECT company_id, principal_type,
       CASE WHEN scope IS NULL THEN 'null-unrestricted'
            WHEN scope = '{}'::jsonb THEN 'empty-object'
            WHEN jsonb_typeof(scope) = 'object' THEN 'restricted-object'
            ELSE 'invalid-root' END AS scope_category,
       count(*) AS grants
FROM principal_permission_grants
WHERE company_id = :'company_id'::uuid AND permission_key = 'tools:use'
GROUP BY company_id, principal_type, scope_category
ORDER BY company_id, principal_type, scope_category;

-- 3e. Post-schema identity COUNTS ONLY; not custody/recovery proof. NOT run here.
-- SELECT company_id, count(*) AS provisioned_identities
-- FROM agent_identity_keys
-- WHERE company_id = :'company_id'::uuid
-- GROUP BY company_id;
-- Public key IDs may be compared by the authorized staging recovery executor.
-- Never SELECT private_key_material or clone identity rows into development agents.
