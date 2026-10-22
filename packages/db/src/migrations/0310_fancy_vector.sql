CREATE TABLE "issue_event_wait_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"external_ref" text NOT NULL,
	"source_kind" text NOT NULL,
	"event_revision" text NOT NULL,
	"observation_status" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"armed_revision" text NOT NULL,
	"armed_assignee_agent_id" uuid NOT NULL,
	"armed_status" text NOT NULL,
	"fallback_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"unresolved_actionable_event_at" timestamp with time zone,
	"registered_by_actor" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_event_wait_coverage_source_check" CHECK ("issue_event_wait_coverage"."source_kind" = 'github_pr'),
	CONSTRAINT "issue_event_wait_coverage_observation_check" CHECK ("issue_event_wait_coverage"."observation_status" in ('ok', 'error')),
	CONSTRAINT "issue_event_wait_coverage_status_check" CHECK ("issue_event_wait_coverage"."armed_status" in ('in_progress', 'in_review'))
);
--> statement-breakpoint
ALTER TABLE "issue_event_wait_coverage" ADD CONSTRAINT "issue_event_wait_coverage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_event_wait_coverage" ADD CONSTRAINT "issue_event_wait_coverage_company_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_event_wait_coverage" ADD CONSTRAINT "issue_event_wait_coverage_company_agent_fk" FOREIGN KEY ("company_id","armed_assignee_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_event_wait_coverage_natural_uq" ON "issue_event_wait_coverage" USING btree ("issue_id","service_name","external_ref");--> statement-breakpoint
CREATE INDEX "issue_event_wait_coverage_company_expiry_idx" ON "issue_event_wait_coverage" USING btree ("company_id","expires_at");