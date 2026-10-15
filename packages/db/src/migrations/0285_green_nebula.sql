CREATE TABLE "chat_github_carry_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"repository" text NOT NULL,
	"group_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"heads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delivery_id" text NOT NULL,
	"configuration_revision" integer NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"verdict_ok" boolean,
	"code" text,
	"detail" text,
	"check_id" text,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_carry_runs_status_check" CHECK ("chat_github_carry_runs"."status" in ('processing', 'processed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "chat_github_carry_runs" ADD CONSTRAINT "chat_github_carry_runs_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_carry_runs_group_uq" ON "chat_github_carry_runs" USING btree ("endpoint_id","group_sha");--> statement-breakpoint
CREATE INDEX "chat_github_carry_runs_endpoint_idx" ON "chat_github_carry_runs" USING btree ("endpoint_id","status","created_at");