CREATE TABLE "code_delivery_authorities" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"technical_agent_id" uuid NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"configured_by_user_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_delivery_authorities_revision_ck" CHECK ("code_delivery_authorities"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "code_delivery_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"obligation_id" uuid,
	"kind" text NOT NULL,
	"issue_revision" bigint NOT NULL,
	"obligation_revision" bigint,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"reason" text NOT NULL,
	"authority" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_delivery_decisions_request_uq" UNIQUE("company_id","issue_id","idempotency_key"),
	CONSTRAINT "code_delivery_decisions_kind_ck" CHECK ("code_delivery_decisions"."kind" in ('classify_code', 'classify_non_code', 'accept_head', 'no_pr', 'closed_unmerged', 'withdrawn', 'transfer')),
	CONSTRAINT "code_delivery_decisions_scope_ck" CHECK (("code_delivery_decisions"."kind" in ('classify_code', 'classify_non_code', 'no_pr') and "code_delivery_decisions"."obligation_id" is null and "code_delivery_decisions"."obligation_revision" is null) or ("code_delivery_decisions"."kind" in ('accept_head', 'closed_unmerged', 'withdrawn', 'transfer') and "code_delivery_decisions"."obligation_id" is not null and "code_delivery_decisions"."obligation_revision" > 0)),
	CONSTRAINT "code_delivery_decisions_revision_ck" CHECK ("code_delivery_decisions"."issue_revision" >= 0),
	CONSTRAINT "code_delivery_decisions_actor_ck" CHECK ("code_delivery_decisions"."actor_type" in ('agent', 'user') and length("code_delivery_decisions"."actor_id") > 0 and ("code_delivery_decisions"."actor_type" <> 'agent' or "code_delivery_decisions"."run_id" is not null)),
	CONSTRAINT "code_delivery_decisions_request_ck" CHECK (length("code_delivery_decisions"."idempotency_key") between 1 and 200 and "code_delivery_decisions"."request_hash" ~ '^[a-f0-9]{64}$' and length("code_delivery_decisions"."reason") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "code_delivery_obligations" ADD COLUMN "head_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "code_delivery_obligations" ADD COLUMN "transfer_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "code_delivery_authorities" ADD CONSTRAINT "code_delivery_authorities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_authorities" ADD CONSTRAINT "code_delivery_authorities_company_id_technical_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","technical_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_decisions" ADD CONSTRAINT "code_delivery_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_decisions" ADD CONSTRAINT "code_delivery_decisions_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_decisions" ADD CONSTRAINT "code_delivery_decisions_company_id_obligation_id_code_delivery_obligations_company_id_id_fk" FOREIGN KEY ("company_id","obligation_id") REFERENCES "public"."code_delivery_obligations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_delivery_decisions_issue_idx" ON "code_delivery_decisions" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "code_delivery_decisions_obligation_idx" ON "code_delivery_decisions" USING btree ("company_id","obligation_id");
--> statement-breakpoint
CREATE TRIGGER code_delivery_preserve_decisions BEFORE UPDATE OR DELETE ON code_delivery_decisions FOR EACH ROW EXECUTE FUNCTION code_delivery_preserve_history();
--> statement-breakpoint
CREATE FUNCTION code_delivery_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_status text;
  owner_revision bigint;
BEGIN
  SELECT status, code_delivery_revision INTO owner_status, owner_revision FROM issues
    WHERE company_id = NEW.company_id AND id = NEW.issue_id FOR UPDATE;
  IF owner_status IS NULL OR owner_status IN ('done', 'cancelled') OR owner_revision <> NEW.issue_revision THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_decision_requires_current_open_owner';
  END IF;
  IF NEW.obligation_id IS NOT NULL AND (NEW.obligation_revision IS NULL OR NOT EXISTS (
    SELECT 1 FROM code_delivery_obligations WHERE company_id = NEW.company_id AND id = NEW.obligation_id
      AND owner_issue_id = NEW.issue_id AND revision = NEW.obligation_revision)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_decision_requires_current_obligation';
  END IF;
  UPDATE issues SET code_delivery_revision = code_delivery_revision + 1 WHERE company_id = NEW.company_id AND id = NEW.issue_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_decision_mutation BEFORE INSERT ON code_delivery_decisions FOR EACH ROW EXECUTE FUNCTION code_delivery_decision_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION code_delivery_obligation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_status text;
  decision code_delivery_decisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_obligation_cannot_be_deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM 1 FROM issues WHERE company_id = NEW.company_id AND id IN (OLD.owner_issue_id, NEW.owner_issue_id) ORDER BY id FOR UPDATE;
    IF (to_jsonb(NEW) - 'owner_issue_id' - 'proposed_head_sha' - 'reviewed_head_sha' - 'head_decision_id' - 'transfer_decision_id' - 'revision') IS DISTINCT FROM
       (to_jsonb(OLD) - 'owner_issue_id' - 'proposed_head_sha' - 'reviewed_head_sha' - 'head_decision_id' - 'transfer_decision_id' - 'revision') OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_obligation_identity_is_immutable';
    END IF;
    IF NEW.owner_issue_id <> OLD.owner_issue_id THEN
      SELECT * INTO decision FROM code_delivery_decisions WHERE id = NEW.transfer_decision_id AND company_id = NEW.company_id
        AND issue_id = OLD.owner_issue_id AND obligation_id = OLD.id AND obligation_revision = OLD.revision AND kind = 'transfer';
      IF decision.id IS NULL OR decision.payload->>'destinationIssueId' IS DISTINCT FROM NEW.owner_issue_id::text
        OR NOT EXISTS (SELECT 1 FROM issues WHERE id = OLD.owner_issue_id AND company_id = OLD.company_id
          AND status NOT IN ('done', 'cancelled') AND code_delivery_revision = decision.issue_revision + 1)
        OR NOT EXISTS (SELECT 1 FROM issues WHERE id = NEW.owner_issue_id AND company_id = NEW.company_id
          AND code_delivery_revision::text = decision.payload->>'destinationRevision')
        OR EXISTS (SELECT 1 FROM code_delivery_ownership_events WHERE obligation_id = OLD.id AND to_issue_id = NEW.owner_issue_id)
        OR NEW.reviewed_head_sha IS NOT NULL OR NEW.head_decision_id IS NOT NULL OR NEW.proposed_head_sha <> OLD.proposed_head_sha THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_transfer_requires_current_decision';
      END IF;
    ELSIF NEW.transfer_decision_id IS DISTINCT FROM OLD.transfer_decision_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_transfer_requires_owner_change';
    END IF;
    IF NEW.reviewed_head_sha IS NOT NULL AND (NEW.reviewed_head_sha IS DISTINCT FROM OLD.reviewed_head_sha
      OR NEW.head_decision_id IS DISTINCT FROM OLD.head_decision_id OR NEW.proposed_head_sha IS DISTINCT FROM OLD.proposed_head_sha) THEN
      SELECT * INTO decision FROM code_delivery_decisions WHERE id = NEW.head_decision_id AND company_id = NEW.company_id
        AND issue_id = NEW.owner_issue_id AND obligation_id = OLD.id AND obligation_revision = OLD.revision AND kind = 'accept_head';
      IF decision.id IS NULL OR decision.payload->>'headSha' IS DISTINCT FROM NEW.reviewed_head_sha OR NEW.reviewed_head_sha <> NEW.proposed_head_sha
        OR NOT EXISTS (SELECT 1 FROM issues WHERE id = NEW.owner_issue_id AND company_id = NEW.company_id AND code_delivery_revision = decision.issue_revision + 1) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_head_requires_current_decision';
      END IF;
    ELSIF NEW.reviewed_head_sha IS NULL AND NEW.head_decision_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_head_requires_current_decision';
    END IF;
  ELSIF NEW.revision <> 1 OR NEW.owner_issue_id <> NEW.source_issue_id OR NEW.reviewed_head_sha IS NOT NULL
    OR NEW.head_decision_id IS NOT NULL OR NEW.transfer_decision_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_invalid_initial_obligation';
  END IF;
  SELECT status INTO owner_status FROM issues WHERE id = NEW.owner_issue_id AND company_id = NEW.company_id FOR UPDATE;
  IF owner_status IS NULL OR owner_status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_requires_open_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM issue_code_delivery_intents WHERE company_id = NEW.company_id AND issue_id = NEW.owner_issue_id AND intent = 'non_code') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_non_code_intent_is_immutable';
  END IF;
  UPDATE issues SET code_delivery_revision = code_delivery_revision + 1 WHERE id = NEW.owner_issue_id AND company_id = NEW.company_id;
  IF TG_OP = 'UPDATE' AND OLD.owner_issue_id <> NEW.owner_issue_id THEN
    UPDATE issues SET code_delivery_revision = code_delivery_revision + 1 WHERE id = OLD.owner_issue_id AND company_id = OLD.company_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION code_delivery_transferred_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_issue_id <> OLD.owner_issue_id THEN
    INSERT INTO code_delivery_ownership_events (company_id, obligation_id, from_issue_id, to_issue_id, obligation_revision, provenance)
      VALUES (NEW.company_id, NEW.id, OLD.owner_issue_id, NEW.owner_issue_id, NEW.revision,
        jsonb_build_object('kind', 'independent_transfer', 'decisionId', NEW.transfer_decision_id));
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_transferred_ownership AFTER UPDATE ON code_delivery_obligations FOR EACH ROW EXECUTE FUNCTION code_delivery_transferred_ownership();