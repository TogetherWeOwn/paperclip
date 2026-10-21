-- 1015.0 cutover pack, part 2: review bots (enableGitHubReviewBots + author filters).
-- Runbook: doc/UPGRADE-1015.md §2.
--
-- Flag (prefer API): PATCH /api/instance/settings/experimental
--   { "enableGitHubReviewBots": true }        (server/src/routes/instance-settings.ts:263-298)
-- Current value read:
--   SELECT experimental->'enableGitHubReviewBots' FROM instance_settings;
--
-- Author-filter conversion (prefer Board UI or the config update API with
-- expectedRevision). Rule: every people[] login with automaticReviews false
-- moves to defaults.excludeAuthors; if defaults.includeAuthors is non-empty,
-- add the automaticReviews-true logins to it; leave people[] rows in place.

-- 2a. Preview: per-endpoint people[] automaticReviews flags + current filters.
SELECT c.endpoint_id,
       c.company_id,
       c.revision,
       person->>'login' AS login,
       person->>'githubUserId' AS github_user_id,
       person->>'kind' AS kind,
       COALESCE((person->>'automaticReviews')::boolean, false) AS automatic_reviews,
       c.configuration->'defaults'->>'invocation' AS invocation,
       c.configuration->'defaults'->'includeAuthors' AS include_authors,
       c.configuration->'defaults'->'excludeAuthors' AS exclude_authors,
       c.configuration->>'memberAccess' AS member_access
FROM chat_github_configurations c,
     jsonb_array_elements(c.configuration->'people') AS person
ORDER BY c.endpoint_id, login;

-- 2b. Endpoints with per-repository overrides (an override replaces the
-- author-filter fields wholesale for that repo, review-policy.ts:14-22,
-- so conversion must cover these too).
SELECT c.endpoint_id, c.company_id, c.revision,
       o.repository_id,
       o.override->'includeAuthors' AS include_authors,
       o.override->'excludeAuthors' AS exclude_authors,
       o.override->>'invocation' AS invocation
FROM chat_github_configurations c,
     LATERAL (SELECT key AS repository_id, value AS override
              FROM jsonb_each(c.configuration->'repositories')) o;

-- 2c. TEMPLATE: append reviewed logins to defaults.excludeAuthors for one endpoint.
-- Fill :endpoint_id, :expected_revision, and the ':login' array from the 2a
-- preview (only logins whose automaticReviews is false). Verify with 2a after.
-- UPDATE chat_github_configurations
-- SET configuration = jsonb_set(
--       configuration,
--       '{defaults,excludeAuthors}',
--       (configuration->'defaults'->'excludeAuthors') || to_jsonb(ARRAY[':login']::text[]),
--       true),
--     revision = revision + 1,
--     updated_at = now()
-- WHERE endpoint_id = ':endpoint_id'::uuid
--   AND revision = :expected_revision;
