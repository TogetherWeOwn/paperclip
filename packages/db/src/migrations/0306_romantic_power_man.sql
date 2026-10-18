-- Read-side candidate alias lookup only. No visibility table, trigger or shared
-- per-company write lock. Native issue/run lookup already has a covering unique
-- index; keep the legacy JSON precedence predicates independently indexable.
CREATE INDEX "heartbeat_runs_company_agent_visibility_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","id");
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_legacy_issue_visibility_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" ->> 'issueId'),"id") WHERE "native_issue_id" is null;
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_legacy_task_visibility_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" ->> 'taskId'),"id") WHERE "native_issue_id" is null and "context_snapshot"->>'issueId' is null;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The migrator wraps each migration in a transaction, so CONCURRENTLY is not supported. Build this partial covering index during the normal pre-start migration drain; runtime writes have no visibility trigger or shared lock.
CREATE INDEX "issue_comments_company_agent_visibility_idx" ON "issue_comments" USING btree ("company_id","author_agent_id","id") WHERE "author_agent_id" is not null;
--> statement-breakpoint
CREATE INDEX "assets_company_agent_visibility_idx" ON "assets" USING btree ("company_id","created_by_agent_id","id") WHERE "created_by_agent_id" is not null;
--> statement-breakpoint
CREATE INDEX "documents_company_agent_visibility_idx" ON "documents" USING btree ("company_id","created_by_agent_id","id") WHERE "created_by_agent_id" is not null;
