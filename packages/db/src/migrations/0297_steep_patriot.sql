ALTER TABLE "chat_conversations" ADD COLUMN "github_shadow_label" text;--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD COLUMN "github_shadow_label" text;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_shadow_label_check" CHECK ("chat_conversations"."github_shadow_label" is null or "chat_conversations"."github_shadow_label" <> '');--> statement-breakpoint
ALTER TABLE "chat_deliveries" ADD CONSTRAINT "chat_deliveries_shadow_label_check" CHECK ("chat_deliveries"."github_shadow_label" is null or "chat_deliveries"."github_shadow_label" <> '');
--> statement-breakpoint
-- Capture-only is a permanent restriction, not a live configuration cache.
-- No speculative backfill: historical manual events did not record this fact.
CREATE FUNCTION "protect_chat_delivery_shadow_authority"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.github_shadow_label IS NOT NULL AND
     ROW(NEW.id, NEW.company_id, NEW.endpoint_id, NEW.provider_event_id,
         NEW.github_shadow_label)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.company_id, OLD.endpoint_id, OLD.provider_event_id,
         OLD.github_shadow_label) THEN
    RAISE EXCEPTION 'GitHub delivery capture authority is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_delivery_shadow_authority_immutable"
BEFORE UPDATE ON "chat_deliveries"
FOR EACH ROW EXECUTE FUNCTION "protect_chat_delivery_shadow_authority"();
--> statement-breakpoint
CREATE FUNCTION "protect_chat_conversation_shadow_authority"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.github_shadow_label IS NOT NULL AND
     ROW(NEW.id, NEW.company_id, NEW.endpoint_id, NEW.issue_id,
         NEW.github_shadow_label)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.company_id, OLD.endpoint_id, OLD.issue_id,
         OLD.github_shadow_label) THEN
    RAISE EXCEPTION 'GitHub task capture authority is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_conversation_shadow_authority_immutable"
BEFORE UPDATE ON "chat_conversations"
FOR EACH ROW EXECUTE FUNCTION "protect_chat_conversation_shadow_authority"();