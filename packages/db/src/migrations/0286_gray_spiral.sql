DROP INDEX "chat_github_carry_runs_group_uq";--> statement-breakpoint
ALTER TABLE "chat_github_carry_runs" ADD COLUMN "proof_fingerprint" jsonb;--> statement-breakpoint
ALTER TABLE "chat_github_carry_runs" ADD COLUMN "publication_attempt" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_carry_runs_group_uq" ON "chat_github_carry_runs" USING btree ("endpoint_id","repository_id","group_sha");