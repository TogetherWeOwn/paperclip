-- Upgrade config pack, part 2: read-only author-filter inventory; NOT an apply script.
-- No live execution on the corrective card. Future authorized executor only.
-- Runbook: doc/UPGRADE-1015.md §2; all source citations use integration
-- 321499c232ea4e1966367b85763ad0c53969ffac unless marked old fork.
-- psql variable company_id is REQUIRED; never export configuration to a public log.
--
-- Keep includeAuthors identical at defaults AND every repository override.
-- Never union automaticReviews:true logins into includes. Preserve all excludes.
-- Old fork 67dfe6748c11fe65ecc6d8ef8555552eae776e39:
-- chat-github-review-policy.ts:154-158 denies person && !person.automaticReviews.
-- Missing/null/false/0/empty-string flags were falsy; nonempty strings (even
-- "false"), nonzero numbers, objects and arrays were truthy but malformed.
-- Valid old schema required a boolean. Missing is accepted by the new schema,
-- but conversion must STOP pending a separately reviewed endpoint/revision/identity
-- denial mapping (runbook §2). This pack provides no such decision.
-- Any present nonboolean flag, invalid login/ID, duplicate ID, malformed config
-- or ambiguous ID-to-current-login mapping must STOP conversion, not be coerced.
-- Retain people and automaticReviews unchanged: workflow-trigger sender checks
-- still require strict true (chat-github-review-policy.ts:333-362).
--
-- For reviewed valid/missing-flag rows, append every old-denied person's current
-- verified login to defaults.excludeAuthors, preserving prior entries/order.
-- For EACH repository with its OWN excludeAuthors (INCLUDING []), append the
-- same denials to THAT array. An absent field inherits corrected defaults.
-- Do not materialize inherited includes or replace override objects wholesale.
-- Verify effective policy for every configured/enabled repo before and after.
-- Preserve all other fields, especially authority, invocation/events, filters,
-- toolsEnabled, shadow/shadowRoutes and publication controls. See runbook §2.
--
-- Before ANY PUT, runbook §2's complete tool-sync preflight MUST pass under
-- exclusive relevant writers and existing independent authority. Unchanged or
-- false toolsEnabled is NOT proof: every save calls syncGitHubBotTools on
-- catalog/profile/entries/installs/bindings and derives guest/sponsor metadata.
-- Unknown/widening effects
-- STOP with zero write requests. This inventory does not qualify that write set.
-- Prior-config PUT reruns sync; it does NOT restore erased narrowed tool decisions.
-- Apply ONLY through authorized GET/PUT
-- /api/chat-endpoints/:endpointId/github/configuration, using
-- {expectedRevision:<read revision>, configuration:<complete corrected snapshot>}.
-- Validator: packages/shared/src/validators/chat-github.ts:63-79,142-147.
-- Route: server/src/routes/chat-channels.ts:228-235; revision lock:
-- server/src/services/chat-github-management.ts:152-168. Read back the next
-- revision and full preserved fields. Conflict/validation error = STOP/refresh
-- and re-review; never raw UPDATE. The defaults-only SQL fallback is REMOVED.
-- Feature management flag enableGitHubReviewBots is not runtime authority;
-- this corrective pack does not enable it or any new bot/tool.

-- 2a. Configuration structure inventory. Non-object/missing required roots STOP.
SELECT endpoint_id, company_id, revision,
       jsonb_typeof(configuration) AS root_kind,
       jsonb_typeof(configuration->'people') AS people_kind,
       jsonb_typeof(configuration->'defaults') AS defaults_kind,
       jsonb_typeof(configuration->'repositories') AS repositories_kind,
       CASE WHEN jsonb_typeof(configuration) IS DISTINCT FROM 'object'
                  OR jsonb_typeof(configuration->'people') IS DISTINCT FROM 'array'
                  OR jsonb_typeof(configuration->'defaults') IS DISTINCT FROM 'object'
                  OR jsonb_typeof(configuration->'repositories') IS DISTINCT FROM 'object'
            THEN 'STOP-malformed-structure' ELSE 'review' END AS inventory_state,
       configuration->'defaults'->'includeAuthors' AS include_authors,
       configuration->'defaults'->'excludeAuthors' AS exclude_authors,
       configuration->'defaults'->>'invocation' AS invocation,
       configuration->>'memberAccess' AS member_access
FROM chat_github_configurations
WHERE company_id = :'company_id'::uuid
ORDER BY endpoint_id;

-- 2b. Per-person classification without unsafe boolean casts. This is evidence,
-- not validation or permission to repair malformed historical input.
SELECT c.endpoint_id, c.company_id, c.revision, p.ordinality AS person_index,
       p.person->>'githubUserId' AS github_user_id,
       p.person->>'login' AS login, p.person->>'kind' AS kind,
       CASE WHEN NOT (p.person ? 'automaticReviews') THEN 'missing'
            ELSE jsonb_typeof(p.person->'automaticReviews') END AS flag_kind,
       CASE WHEN jsonb_typeof(c.configuration->'people') IS DISTINCT FROM 'array'
              THEN 'STOP-malformed-people-root'
            WHEN p.ordinality IS NULL THEN 'valid-empty-people'
            WHEN jsonb_typeof(p.person) IS DISTINCT FROM 'object'
              THEN 'STOP-malformed-person'
            WHEN NOT (p.person ? 'automaticReviews') THEN 'denied-missing'
            WHEN p.person->'automaticReviews' = 'false'::jsonb THEN 'denied-false'
            WHEN p.person->'automaticReviews' = 'true'::jsonb THEN 'true-keep-includes'
            ELSE 'STOP-malformed' END AS conversion_state,
       CASE WHEN p.ordinality IS NULL OR jsonb_typeof(p.person) IS DISTINCT FROM 'object'
              THEN NULL
            WHEN NOT (p.person ? 'automaticReviews')
                  OR p.person->'automaticReviews' IN
                     ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
              THEN true ELSE false END AS old_person_predicate_denied
FROM chat_github_configurations c
LEFT JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(c.configuration->'people') = 'array'
       THEN c.configuration->'people' ELSE '[]'::jsonb END
) WITH ORDINALITY AS p(person, ordinality) ON true
WHERE c.company_id = :'company_id'::uuid
ORDER BY c.endpoint_id, p.ordinality;

-- 2c. EVERY repository override, including explicit-empty excludeAuthors.
-- -> vs ? distinguishes inherited fields from explicitly owned []/null.
-- null/nonarray filters STOP; absent override field alone means inheritance.
SELECT c.endpoint_id, c.company_id, c.revision, o.key AS repository_id,
       o.value ? 'includeAuthors' AS owns_include_authors,
       o.value ? 'excludeAuthors' AS owns_exclude_authors,
       CASE WHEN o.value ? 'includeAuthors' THEN o.value->'includeAuthors'
            ELSE c.configuration->'defaults'->'includeAuthors' END AS effective_includes,
       CASE WHEN o.value ? 'excludeAuthors' THEN o.value->'excludeAuthors'
            ELSE c.configuration->'defaults'->'excludeAuthors' END AS effective_excludes,
       CASE WHEN jsonb_typeof(c.configuration->'repositories') IS DISTINCT FROM 'object'
              THEN 'STOP-malformed-repositories-root'
            WHEN o.key IS NULL THEN 'valid-empty-repositories'
            WHEN jsonb_typeof(o.value) IS DISTINCT FROM 'object'
              THEN 'STOP-malformed-override'
            WHEN (o.value ? 'includeAuthors')
                 AND jsonb_typeof(o.value->'includeAuthors') IS DISTINCT FROM 'array'
              THEN 'STOP-malformed-filter'
            WHEN (o.value ? 'excludeAuthors')
                 AND jsonb_typeof(o.value->'excludeAuthors') IS DISTINCT FROM 'array'
              THEN 'STOP-malformed-filter'
            WHEN o.value ? 'excludeAuthors' THEN 'append-denials-here-too'
            ELSE 'inherits-corrected-defaults' END AS exclusion_action
FROM chat_github_configurations c
LEFT JOIN LATERAL jsonb_each(
  CASE WHEN jsonb_typeof(c.configuration->'repositories') = 'object'
       THEN c.configuration->'repositories' ELSE '{}'::jsonb END
) AS o ON true
WHERE c.company_id = :'company_id'::uuid
ORDER BY c.endpoint_id, o.key;
