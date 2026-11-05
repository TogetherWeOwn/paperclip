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
CREATE TRIGGER code_delivery_receipt_insert BEFORE INSERT ON code_delivery_readiness_receipts
  FOR EACH ROW EXECUTE FUNCTION code_delivery_receipt_insert();
CREATE TRIGGER code_delivery_preserve_receipts BEFORE UPDATE OR DELETE ON code_delivery_readiness_receipts
  FOR EACH ROW EXECUTE FUNCTION code_delivery_preserve_history();
CREATE TRIGGER code_delivery_preserve_consumptions BEFORE UPDATE OR DELETE ON code_delivery_receipt_consumptions
  FOR EACH ROW EXECUTE FUNCTION code_delivery_preserve_history();

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
CREATE TRIGGER code_delivery_terminal_guard BEFORE INSERT OR UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION code_delivery_terminal_guard();

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
CREATE TRIGGER code_delivery_consume_terminal_receipt AFTER UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION code_delivery_consume_terminal_receipt();

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
CREATE TRIGGER code_delivery_validate_consumption BEFORE INSERT ON code_delivery_receipt_consumptions
  FOR EACH ROW EXECUTE FUNCTION code_delivery_validate_consumption();

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
CREATE CONSTRAINT TRIGGER code_delivery_receipt_settled AFTER INSERT ON code_delivery_readiness_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION code_delivery_receipt_settled();

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
CREATE CONSTRAINT TRIGGER code_delivery_terminal_settled AFTER UPDATE ON issues
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION code_delivery_terminal_settled();
