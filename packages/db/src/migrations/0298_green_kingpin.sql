CREATE TABLE "chat_github_review_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"arm_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"shadow_label" text NOT NULL,
	"native_delivery_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"issue_id" uuid,
	"comment_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_candidates_label_check" CHECK ("chat_github_review_candidates"."shadow_label" <> ''),
	CONSTRAINT "chat_github_candidates_state_check" CHECK ("chat_github_review_candidates"."state" in ('pending', 'materialized', 'dispatched', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "chat_github_review_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"origin_delivery_id" uuid NOT NULL,
	"origin_event_id" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"repository" text NOT NULL,
	"pull_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"round_ordinal" integer NOT NULL,
	"configuration_revision" integer NOT NULL,
	"pair_key" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_github_enrollments_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_github_enrollments_round_check" CHECK ("chat_github_review_enrollments"."round_ordinal" > 0 and "chat_github_review_enrollments"."configuration_revision" > 0)
);
--> statement-breakpoint
DROP INDEX "chat_conversations_thread_uq";--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "execution_scope" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_github_review_candidates" ADD CONSTRAINT "chat_github_review_candidates_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_candidates" ADD CONSTRAINT "chat_github_review_candidates_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_candidates" ADD CONSTRAINT "chat_github_review_candidates_company_id_enrollment_id_chat_github_review_enrollments_company_id_id_fk" FOREIGN KEY ("company_id","enrollment_id") REFERENCES "public"."chat_github_review_enrollments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_candidates" ADD CONSTRAINT "chat_github_review_candidates_company_id_arm_id_chat_github_review_arms_company_id_id_fk" FOREIGN KEY ("company_id","arm_id") REFERENCES "public"."chat_github_review_arms"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_candidates" ADD CONSTRAINT "chat_github_review_candidates_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_candidates" ADD CONSTRAINT "chat_github_review_candidates_company_id_conversation_id_chat_conversations_company_id_id_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_candidates" ADD CONSTRAINT "chat_github_review_candidates_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_enrollments" ADD CONSTRAINT "chat_github_review_enrollments_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_enrollments" ADD CONSTRAINT "chat_github_review_enrollments_company_id_origin_delivery_id_chat_deliveries_company_id_id_fk" FOREIGN KEY ("company_id","origin_delivery_id") REFERENCES "public"."chat_deliveries"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_github_review_enrollments" ADD CONSTRAINT "chat_github_review_enrollments_company_id_principal_id_chat_external_principals_company_id_id_fk" FOREIGN KEY ("company_id","principal_id") REFERENCES "public"."chat_external_principals"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_candidates_arm_uq" ON "chat_github_review_candidates" USING btree ("enrollment_id","arm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_candidates_delivery_uq" ON "chat_github_review_candidates" USING btree ("native_delivery_id");--> statement-breakpoint
CREATE INDEX "chat_github_candidates_work_idx" ON "chat_github_review_candidates" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_enrollments_event_uq" ON "chat_github_review_enrollments" USING btree ("endpoint_id","origin_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_enrollments_delivery_uq" ON "chat_github_review_enrollments" USING btree ("origin_delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_enrollments_pair_uq" ON "chat_github_review_enrollments" USING btree ("pair_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_github_enrollments_round_uq" ON "chat_github_review_enrollments" USING btree ("endpoint_id","repository_id","pull_number","round_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_thread_uq" ON "chat_conversations" USING btree ("endpoint_id","external_conversation_id","external_thread_id","session_generation","execution_scope");
--> statement-breakpoint
CREATE FUNCTION protect_github_pair_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'GitHub review enrollment is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_github_enrollment_immutable BEFORE UPDATE ON chat_github_review_enrollments
FOR EACH ROW EXECUTE FUNCTION protect_github_pair_enrollment();
--> statement-breakpoint
CREATE FUNCTION protect_github_pair_seed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.normalized_event ? 'githubPairingSeed' AND
    (NEW.normalized_event->'githubPairingSeed' IS DISTINCT FROM OLD.normalized_event->'githubPairingSeed'
     OR ROW(NEW.company_id, NEW.endpoint_id, NEW.provider_event_id, NEW.principal_id)
       IS DISTINCT FROM ROW(OLD.company_id, OLD.endpoint_id, OLD.provider_event_id, OLD.principal_id)) THEN
    RAISE EXCEPTION 'GitHub pairing seed is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.normalized_event ? 'githubPairedCandidate' AND
    (NEW.normalized_event IS DISTINCT FROM OLD.normalized_event OR
     ROW(NEW.company_id, NEW.endpoint_id, NEW.conversation_id, NEW.principal_id, NEW.github_shadow_label)
       IS DISTINCT FROM ROW(OLD.company_id, OLD.endpoint_id, OLD.conversation_id, OLD.principal_id, OLD.github_shadow_label)) THEN
    RAISE EXCEPTION 'GitHub candidate delivery authority is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_github_pair_seed_immutable BEFORE UPDATE ON chat_deliveries
FOR EACH ROW EXECUTE FUNCTION protect_github_pair_seed();
--> statement-breakpoint
CREATE FUNCTION protect_github_pair_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.company_id, NEW.endpoint_id, NEW.enrollment_id, NEW.arm_id, NEW.agent_id, NEW.shadow_label, NEW.native_delivery_id)
       IS DISTINCT FROM ROW(OLD.id, OLD.company_id, OLD.endpoint_id, OLD.enrollment_id, OLD.arm_id, OLD.agent_id, OLD.shadow_label, OLD.native_delivery_id)
       OR (OLD.issue_id IS NOT NULL AND ROW(NEW.issue_id, NEW.conversation_id, NEW.comment_id)
           IS DISTINCT FROM ROW(OLD.issue_id, OLD.conversation_id, OLD.comment_id)) THEN
      RAISE EXCEPTION 'GitHub candidate capability is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chat_github_review_arms a JOIN chat_github_review_enrollments e
       ON e.company_id = a.company_id AND e.endpoint_id = a.endpoint_id
       WHERE a.id = NEW.arm_id AND a.company_id = NEW.company_id AND a.endpoint_id = NEW.endpoint_id
       AND a.agent_id = NEW.agent_id AND a.label = NEW.shadow_label AND e.id = NEW.enrollment_id) THEN
    RAISE EXCEPTION 'GitHub candidate scope mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.issue_id IS NOT NULL OR NEW.conversation_id IS NOT NULL OR NEW.comment_id IS NOT NULL
     OR NEW.state IN ('materialized', 'dispatched') THEN
    IF NOT EXISTS (
      SELECT 1 FROM chat_deliveries d
      JOIN chat_conversations c ON c.id = d.conversation_id AND c.company_id = d.company_id
      JOIN issue_comments m ON m.issue_id = c.issue_id AND m.company_id = c.company_id
      JOIN chat_message_links l ON l.delivery_id = d.id AND l.conversation_id = c.id AND l.comment_id = m.id
      WHERE d.id = NEW.native_delivery_id AND d.company_id = NEW.company_id AND d.endpoint_id = NEW.endpoint_id
        AND c.id = NEW.conversation_id AND c.endpoint_id = NEW.endpoint_id AND c.issue_id = NEW.issue_id
        AND m.id = NEW.comment_id AND l.company_id = NEW.company_id AND l.direction = 'inbound'
        AND c.execution_scope = 'shadow:' || NEW.arm_id::text || ':' || NEW.enrollment_id::text
        AND c.github_shadow_label = NEW.shadow_label AND d.github_shadow_label = NEW.shadow_label
        AND d.normalized_event->>'githubPairedCandidate' = NEW.id::text
    ) THEN
      RAISE EXCEPTION 'GitHub candidate native binding mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_github_candidate_immutable BEFORE INSERT OR UPDATE ON chat_github_review_candidates
FOR EACH ROW EXECUTE FUNCTION protect_github_pair_candidate();
--> statement-breakpoint
CREATE FUNCTION protect_github_execution_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_scope IS DISTINCT FROM OLD.execution_scope THEN
    RAISE EXCEPTION 'GitHub execution scope is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_github_execution_scope_immutable BEFORE UPDATE ON chat_conversations
FOR EACH ROW EXECUTE FUNCTION protect_github_execution_scope();