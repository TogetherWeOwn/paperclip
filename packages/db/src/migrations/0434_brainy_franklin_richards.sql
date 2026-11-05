CREATE TABLE "code_delivery_readiness_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"issue_revision" bigint NOT NULL,
	"terminal_status" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"transaction_id" text DEFAULT pg_current_xact_id()::text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" uuid,
	"evidence" jsonb NOT NULL,
	"prepared_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_delivery_readiness_receipts_identity_uq" UNIQUE("company_id","issue_id","id"),
	CONSTRAINT "code_delivery_readiness_receipts_revision_uq" UNIQUE("company_id","issue_id","issue_revision"),
	CONSTRAINT "code_delivery_readiness_receipts_status_ck" CHECK ("code_delivery_readiness_receipts"."terminal_status" in ('done', 'cancelled')),
	CONSTRAINT "code_delivery_readiness_receipts_revision_ck" CHECK ("code_delivery_readiness_receipts"."issue_revision" >= 0),
	CONSTRAINT "code_delivery_readiness_receipts_snapshot_ck" CHECK ("code_delivery_readiness_receipts"."snapshot_hash" ~ '^[a-f0-9]{64}$' and "code_delivery_readiness_receipts"."transaction_id" ~ '^[0-9]+$'),
	CONSTRAINT "code_delivery_readiness_receipts_time_ck" CHECK ("code_delivery_readiness_receipts"."expires_at" > "code_delivery_readiness_receipts"."prepared_at" and "code_delivery_readiness_receipts"."expires_at" <= "code_delivery_readiness_receipts"."prepared_at" + interval '30 seconds'),
	CONSTRAINT "code_delivery_readiness_receipts_actor_ck" CHECK ("code_delivery_readiness_receipts"."actor_type" in ('agent', 'user') and length("code_delivery_readiness_receipts"."actor_id") > 0 and ("code_delivery_readiness_receipts"."actor_type" <> 'agent' or "code_delivery_readiness_receipts"."run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "code_delivery_receipt_consumptions" (
	"receipt_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"issue_revision" bigint NOT NULL,
	"terminal_status" text NOT NULL,
	"transaction_id" text DEFAULT pg_current_xact_id()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_delivery_receipt_consumptions_revision_uq" UNIQUE("company_id","issue_id","issue_revision"),
	CONSTRAINT "code_delivery_receipt_consumptions_status_ck" CHECK ("code_delivery_receipt_consumptions"."terminal_status" in ('done', 'cancelled')),
	CONSTRAINT "code_delivery_receipt_consumptions_revision_ck" CHECK ("code_delivery_receipt_consumptions"."issue_revision" > 0),
	CONSTRAINT "code_delivery_receipt_consumptions_transaction_ck" CHECK ("code_delivery_receipt_consumptions"."transaction_id" ~ '^[0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "code_delivery_readiness_receipts" ADD CONSTRAINT "code_delivery_readiness_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_readiness_receipts" ADD CONSTRAINT "code_delivery_readiness_receipts_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_receipt_consumptions" ADD CONSTRAINT "code_delivery_receipt_consumptions_company_id_issue_id_receipt_id_code_delivery_readiness_receipts_company_id_issue_id_id_fk" FOREIGN KEY ("company_id","issue_id","receipt_id") REFERENCES "public"."code_delivery_readiness_receipts"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_delivery_readiness_receipts_issue_idx" ON "code_delivery_readiness_receipts" USING btree ("company_id","issue_id");
--> statement-breakpoint
CREATE FUNCTION code_delivery_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_revision bigint;
BEGIN
  SELECT code_delivery_revision INTO current_revision FROM issues
    WHERE id = NEW.issue_id AND company_id = NEW.company_id FOR UPDATE;
  IF current_revision IS NULL OR current_revision <> NEW.issue_revision
    OR NEW.transaction_id <> pg_current_xact_id()::text
    OR NEW.prepared_at > clock_timestamp() OR NEW.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_invalid_receipt';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_receipt_insert BEFORE INSERT ON code_delivery_readiness_receipts
  FOR EACH ROW EXECUTE FUNCTION code_delivery_receipt_insert();
--> statement-breakpoint
CREATE TRIGGER code_delivery_preserve_receipts BEFORE UPDATE OR DELETE ON code_delivery_readiness_receipts
  FOR EACH ROW EXECUTE FUNCTION code_delivery_preserve_history();
--> statement-breakpoint
CREATE TRIGGER code_delivery_preserve_consumptions BEFORE UPDATE OR DELETE ON code_delivery_receipt_consumptions
  FOR EACH ROW EXECUTE FUNCTION code_delivery_preserve_history();

--> statement-breakpoint
CREATE FUNCTION code_delivery_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_id uuid;
  requires_receipt boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('done', 'cancelled') OR NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_terminal_creation_requires_open_task';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.completed_at IS DISTINCT FROM OLD.completed_at AND NEW.completed_at IS NOT NULL AND NEW.status <> 'done')
    OR (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at AND NEW.cancelled_at IS NOT NULL AND NEW.status <> 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_terminal_timestamp_requires_status';
  END IF;
  requires_receipt := NEW.status IN ('done', 'cancelled') AND (NEW.status IS DISTINCT FROM OLD.status
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at);
  IF NOT requires_receipt THEN RETURN NEW; END IF;
  IF NEW.company_id <> OLD.company_id OR (NEW.status = 'done' AND NEW.completed_at IS NULL)
    OR (NEW.status = 'cancelled' AND NEW.cancelled_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_invalid_terminal_projection';
  END IF;
  SELECT id INTO receipt_id FROM code_delivery_readiness_receipts r
    WHERE r.company_id = OLD.company_id AND r.issue_id = OLD.id AND r.issue_revision = OLD.code_delivery_revision
      AND r.terminal_status = NEW.status AND r.transaction_id = pg_current_xact_id()::text
      AND r.prepared_at <= clock_timestamp() AND r.expires_at > clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM code_delivery_receipt_consumptions c WHERE c.receipt_id = r.id);
  IF receipt_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_preparation_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_terminal_guard BEFORE INSERT OR UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION code_delivery_terminal_guard();

--> statement-breakpoint
CREATE FUNCTION code_delivery_consume_terminal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_id uuid;
BEGIN
  IF NEW.status NOT IN ('done', 'cancelled') OR (NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at AND NEW.cancelled_at IS NOT DISTINCT FROM OLD.cancelled_at) THEN
    RETURN NEW;
  END IF;
  SELECT id INTO receipt_id FROM code_delivery_readiness_receipts
    WHERE company_id = OLD.company_id AND issue_id = OLD.id AND issue_revision = OLD.code_delivery_revision
      AND terminal_status = NEW.status AND transaction_id = pg_current_xact_id()::text;
  IF receipt_id IS NULL OR NEW.code_delivery_revision <> OLD.code_delivery_revision + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_receipt_not_consumed';
  END IF;
  INSERT INTO code_delivery_receipt_consumptions (receipt_id, company_id, issue_id, issue_revision, terminal_status)
    VALUES (receipt_id, NEW.company_id, NEW.id, NEW.code_delivery_revision, NEW.status);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_consume_terminal_receipt AFTER UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION code_delivery_consume_terminal_receipt();

--> statement-breakpoint
CREATE FUNCTION code_delivery_validate_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 OR NEW.transaction_id <> pg_current_xact_id()::text OR NOT EXISTS (
    SELECT 1 FROM code_delivery_readiness_receipts r JOIN issues i ON i.id = r.issue_id AND i.company_id = r.company_id
      WHERE r.id = NEW.receipt_id AND r.company_id = NEW.company_id AND r.issue_id = NEW.issue_id
        AND r.transaction_id = NEW.transaction_id AND r.issue_revision + 1 = NEW.issue_revision
        AND r.terminal_status = NEW.terminal_status AND i.status = NEW.terminal_status
        AND i.code_delivery_revision = NEW.issue_revision AND r.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_invalid_consumption';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_validate_consumption BEFORE INSERT ON code_delivery_receipt_consumptions
  FOR EACH ROW EXECUTE FUNCTION code_delivery_validate_consumption();

--> statement-breakpoint
CREATE FUNCTION code_delivery_receipt_settled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM code_delivery_receipt_consumptions c JOIN issues i ON i.id = c.issue_id AND i.company_id = c.company_id
      WHERE c.receipt_id = NEW.id AND c.company_id = NEW.company_id AND c.issue_id = NEW.issue_id
        AND c.transaction_id = NEW.transaction_id AND c.issue_revision = NEW.issue_revision + 1
        AND c.terminal_status = NEW.terminal_status AND i.status = c.terminal_status
        AND i.code_delivery_revision = c.issue_revision AND NEW.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_receipt_not_settled';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER code_delivery_receipt_settled AFTER INSERT ON code_delivery_readiness_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION code_delivery_receipt_settled();

--> statement-breakpoint
CREATE FUNCTION code_delivery_terminal_settled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM code_delivery_receipt_consumptions c WHERE c.company_id = NEW.company_id AND c.issue_id = NEW.id
      AND c.transaction_id = pg_current_xact_id()::text AND NOT EXISTS (
        SELECT 1 FROM issues i WHERE i.id = c.issue_id AND i.company_id = c.company_id
          AND i.code_delivery_revision = c.issue_revision AND i.status = c.terminal_status
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_receipt_not_settled';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER code_delivery_terminal_settled AFTER UPDATE ON issues
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION code_delivery_terminal_settled();
