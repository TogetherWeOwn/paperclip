CREATE TABLE "chat_github_review_arms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"label" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"configuration_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "chat_github_review_arms_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_github_review_arm_revision_check" CHECK ("chat_github_review_arms"."configuration_revision" > 0),
	CONSTRAINT "chat_github_review_arm_label_check" CHECK ("chat_github_review_arms"."label" ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "chat_github_review_arms" ADD CONSTRAINT "chat_github_review_arms_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_arms" ADD CONSTRAINT "chat_github_review_arms_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_review_arms_label_uq" ON "chat_github_review_arms" USING btree ("endpoint_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_review_arms_active_agent_uq" ON "chat_github_review_arms" USING btree ("endpoint_id","agent_id") WHERE "chat_github_review_arms"."retired_at" is null;
--> statement-breakpoint
-- Arm IDs are durable identities, not editable routing aliases. An application
-- may retire an arm once; historical bindings must never acquire another agent.
CREATE FUNCTION "protect_chat_github_review_arm"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GitHub review arms must be retired, not deleted' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.company_id, NEW.endpoint_id, NEW.label, NEW.agent_id,
         NEW.configuration_revision, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.company_id, OLD.endpoint_id, OLD.label, OLD.agent_id,
         OLD.configuration_revision, OLD.created_at) THEN
    RAISE EXCEPTION 'GitHub review arm identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'GitHub review arm retirement is permanent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_github_review_arm_immutable"
BEFORE UPDATE OR DELETE ON "chat_github_review_arms"
FOR EACH ROW EXECUTE FUNCTION "protect_chat_github_review_arm"();