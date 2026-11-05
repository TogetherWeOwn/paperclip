CREATE TABLE "code_delivery_terminal_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"effect_kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_delivery_terminal_effects_target_uq" UNIQUE("receipt_id","run_id","effect_kind"),
	CONSTRAINT "code_delivery_terminal_effects_kind_ck" CHECK ("code_delivery_terminal_effects"."effect_kind" = 'stop_run'),
	CONSTRAINT "code_delivery_terminal_effects_state_ck" CHECK ("code_delivery_terminal_effects"."state" in ('pending', 'settled') and (("code_delivery_terminal_effects"."state" = 'settled') = ("code_delivery_terminal_effects"."settled_at" is not null))),
	CONSTRAINT "code_delivery_terminal_effects_attempts_ck" CHECK ("code_delivery_terminal_effects"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "code_delivery_terminal_effects" ADD CONSTRAINT "code_delivery_terminal_effects_receipt_id_code_delivery_receipt_consumptions_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."code_delivery_receipt_consumptions"("receipt_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_terminal_effects" ADD CONSTRAINT "code_delivery_terminal_effects_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_terminal_effects" ADD CONSTRAINT "code_delivery_terminal_effects_company_id_issue_id_receipt_id_code_delivery_readiness_receipts_company_id_issue_id_id_fk" FOREIGN KEY ("company_id","issue_id","receipt_id") REFERENCES "public"."code_delivery_readiness_receipts"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_delivery_terminal_effects_pending_idx" ON "code_delivery_terminal_effects" USING btree ("state","next_attempt_at","id");
--> statement-breakpoint
CREATE FUNCTION code_delivery_terminal_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  certified boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'code_delivery_terminal_effect_history_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.company_id, NEW.issue_id, NEW.receipt_id, NEW.run_id, NEW.effect_kind, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.issue_id, OLD.receipt_id, OLD.run_id, OLD.effect_kind, OLD.created_at)
      OR OLD.state = 'settled' OR NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'code_delivery_terminal_effect_binding_immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM code_delivery_readiness_receipts r
    JOIN code_delivery_receipt_consumptions c ON c.receipt_id = r.id
      AND c.company_id = r.company_id AND c.issue_id = r.issue_id
    JOIN issues i ON i.company_id = r.company_id AND i.id = r.issue_id
    JOIN heartbeat_runs h ON h.id = NEW.run_id AND h.company_id = r.company_id
    WHERE r.id = NEW.receipt_id AND r.company_id = NEW.company_id AND r.issue_id = NEW.issue_id
      AND r.transaction_id = pg_current_xact_id()::text AND c.transaction_id = r.transaction_id
      AND c.issue_revision = r.issue_revision + 1 AND c.terminal_status = r.terminal_status
      AND i.code_delivery_revision = c.issue_revision AND i.status = r.terminal_status
      AND coalesce(h.native_issue_id::text, h.issue_id::text,
        nullif(h.context_snapshot->>'issueId', ''), nullif(h.context_snapshot->>'taskId', '')) = r.issue_id::text
  ) INTO certified;
  IF NOT certified OR NEW.state <> 'pending' OR NEW.attempt_count <> 0 OR NEW.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'code_delivery_terminal_effect_receipt_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_terminal_effect_guard
BEFORE INSERT OR UPDATE OR DELETE ON code_delivery_terminal_effects
FOR EACH ROW EXECUTE FUNCTION code_delivery_terminal_effect_guard();
