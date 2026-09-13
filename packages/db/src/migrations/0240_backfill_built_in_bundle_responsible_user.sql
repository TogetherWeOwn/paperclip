-- TOG-2397: `createOrResetRoutine` used to stamp built-in-agent-bundle routines
-- (Reflection Coach, Summarizer) with the synthetic actor userId
-- "built-in-bundles" instead of a real `user` row. That string then persisted
-- as `responsible_user_id` on the routine, and propagated from there onto every
-- issue and heartbeat run the routine ever spawned. Because "built-in-bundles"
-- is not a row in "user", `applyResponsibleUserIntersection` denies every
-- action gated on the responsible user (posting issue comments, changing issue
-- status) with RESPONSIBLE_USER_UNAVAILABLE for those runs — which is what
-- produced TOG-1385's repeat auto-block loop. The code fix (built-in-agents.ts)
-- stops writing the sentinel going forward; this repairs rows already poisoned
-- by it, using each company's real default responsible user.
UPDATE "routines" AS r
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE r."company_id" = c."id"
  AND r."responsible_user_id" = 'built-in-bundles'
  AND c."default_responsible_user_id" IS NOT NULL;--> statement-breakpoint
UPDATE "issues" AS i
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE i."company_id" = c."id"
  AND i."responsible_user_id" = 'built-in-bundles'
  AND c."default_responsible_user_id" IS NOT NULL;--> statement-breakpoint
UPDATE "heartbeat_runs" AS hr
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE hr."company_id" = c."id"
  AND hr."responsible_user_id" = 'built-in-bundles'
  AND c."default_responsible_user_id" IS NOT NULL;
