CREATE TABLE "code_delivery_discoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"source_work_product_id" uuid NOT NULL,
	"source_revision" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_delivery_discoveries_source_revision_uq" UNIQUE("source_work_product_id","issue_id","source_revision")
);
--> statement-breakpoint
CREATE TABLE "code_delivery_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_issue_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"source_project_id" uuid NOT NULL,
	"source_workspace_id" uuid NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"repository_id" text NOT NULL,
	"repository" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"base_ref" text NOT NULL,
	"proposed_head_sha" text NOT NULL,
	"reviewed_head_sha" text,
	"revision" bigint DEFAULT 1 NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_delivery_obligations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "code_delivery_obligations_identity_uq" UNIQUE("company_id","provider","repository_id","pull_request_number"),
	CONSTRAINT "code_delivery_obligations_provider_ck" CHECK ("code_delivery_obligations"."provider" = 'github'),
	CONSTRAINT "code_delivery_obligations_repository_ck" CHECK ("code_delivery_obligations"."repository_id" ~ '^[1-9][0-9]{0,19}$' and "code_delivery_obligations"."repository" ~ '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}$' and split_part("code_delivery_obligations"."repository", '/', 2) not in ('.', '..')),
	CONSTRAINT "code_delivery_obligations_pr_ck" CHECK ("code_delivery_obligations"."pull_request_number" > 0 and length("code_delivery_obligations"."base_ref") between 1 and 255 and "code_delivery_obligations"."base_ref" !~ '[[:space:][:cntrl:]]'),
	CONSTRAINT "code_delivery_obligations_heads_ck" CHECK ("code_delivery_obligations"."proposed_head_sha" ~ '^[a-f0-9]{40}$' and ("code_delivery_obligations"."reviewed_head_sha" is null or "code_delivery_obligations"."reviewed_head_sha" ~ '^[a-f0-9]{40}$')),
	CONSTRAINT "code_delivery_obligations_revision_ck" CHECK ("code_delivery_obligations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "code_delivery_ownership_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"from_issue_id" uuid,
	"to_issue_id" uuid NOT NULL,
	"obligation_revision" bigint NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_delivery_ownership_events_revision_uq" UNIQUE("obligation_id","obligation_revision"),
	CONSTRAINT "code_delivery_ownership_events_revision_ck" CHECK ("code_delivery_ownership_events"."obligation_revision" > 0),
	CONSTRAINT "code_delivery_ownership_events_owner_ck" CHECK ("code_delivery_ownership_events"."from_issue_id" is null or "code_delivery_ownership_events"."from_issue_id" <> "code_delivery_ownership_events"."to_issue_id")
);
--> statement-breakpoint
CREATE TABLE "issue_code_delivery_intents" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_code_delivery_intents_company_issue_uq" UNIQUE("company_id","issue_id"),
	CONSTRAINT "issue_code_delivery_intents_kind_ck" CHECK ("issue_code_delivery_intents"."intent" in ('code', 'non_code', 'ambiguous')),
	CONSTRAINT "issue_code_delivery_intents_revision_ck" CHECK ("issue_code_delivery_intents"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "code_delivery_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "code_delivery_discoveries" ADD CONSTRAINT "code_delivery_discoveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_discoveries" ADD CONSTRAINT "code_delivery_discoveries_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_obligations" ADD CONSTRAINT "code_delivery_obligations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_obligations" ADD CONSTRAINT "code_delivery_obligations_company_id_owner_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","owner_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_obligations" ADD CONSTRAINT "code_delivery_obligations_company_id_source_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","source_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_obligations" ADD CONSTRAINT "code_delivery_obligations_company_id_source_project_id_projects_company_id_id_fk" FOREIGN KEY ("company_id","source_project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspaces_company_project_id_uq" ON "project_workspaces" USING btree ("company_id","project_id","id");--> statement-breakpoint
ALTER TABLE "code_delivery_obligations" ADD CONSTRAINT "code_delivery_obligations_company_id_source_project_id_source_workspace_id_project_workspaces_company_id_project_id_id_fk" FOREIGN KEY ("company_id","source_project_id","source_workspace_id") REFERENCES "public"."project_workspaces"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_ownership_events" ADD CONSTRAINT "code_delivery_ownership_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_ownership_events" ADD CONSTRAINT "code_delivery_ownership_events_company_id_obligation_id_code_delivery_obligations_company_id_id_fk" FOREIGN KEY ("company_id","obligation_id") REFERENCES "public"."code_delivery_obligations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_ownership_events" ADD CONSTRAINT "code_delivery_ownership_events_company_id_from_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","from_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_delivery_ownership_events" ADD CONSTRAINT "code_delivery_ownership_events_company_id_to_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","to_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_code_delivery_intents" ADD CONSTRAINT "issue_code_delivery_intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_code_delivery_intents" ADD CONSTRAINT "issue_code_delivery_intents_company_id_issue_id_issues_company_id_id_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_delivery_discoveries_company_issue_idx" ON "code_delivery_discoveries" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "code_delivery_obligations_company_owner_idx" ON "code_delivery_obligations" USING btree ("company_id","owner_issue_id");--> statement-breakpoint
--> statement-breakpoint
INSERT INTO issue_code_delivery_intents (company_id, issue_id, intent, provenance)
SELECT company_id, id, 'ambiguous', jsonb_build_object('kind', 'legacy_unclassified', 'migration', '0432') FROM issues;
--> statement-breakpoint
INSERT INTO code_delivery_discoveries (company_id, issue_id, source_work_product_id, source_revision, snapshot)
SELECT company_id, issue_id, id, encode(sha256(convert_to(to_jsonb(w)::text, 'UTF8')), 'hex'), to_jsonb(w) FROM issue_work_products w
WHERE type IN ('pull_request', 'branch', 'commit') OR url ~* '^https://github[.]com/[^/]+/[^/]+/pull/[0-9]+';
--> statement-breakpoint
CREATE FUNCTION code_delivery_issue_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.code_delivery_revision := OLD.code_delivery_revision + 1;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_issue_revision BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION code_delivery_issue_revision();
--> statement-breakpoint
CREATE FUNCTION code_delivery_initialize_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO issue_code_delivery_intents (company_id, issue_id, intent, provenance)
  VALUES (NEW.company_id, NEW.id, 'ambiguous', jsonb_build_object('kind', 'unclassified'));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_initialize_intent AFTER INSERT ON issues FOR EACH ROW EXECUTE FUNCTION code_delivery_initialize_intent();
--> statement-breakpoint
CREATE FUNCTION code_delivery_preserve_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_history_is_immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_preserve_discoveries BEFORE UPDATE OR DELETE ON code_delivery_discoveries FOR EACH ROW EXECUTE FUNCTION code_delivery_preserve_history();
--> statement-breakpoint
CREATE TRIGGER code_delivery_preserve_ownership BEFORE UPDATE OR DELETE ON code_delivery_ownership_events FOR EACH ROW EXECUTE FUNCTION code_delivery_preserve_history();
--> statement-breakpoint
CREATE FUNCTION code_delivery_intent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM issues WHERE id = OLD.issue_id AND company_id = OLD.company_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_intent_is_immutable';
  END IF;
  IF OLD.intent <> 'ambiguous' OR NEW.intent NOT IN ('code', 'non_code') OR NEW.revision <> OLD.revision + 1
    OR NEW.company_id <> OLD.company_id OR NEW.issue_id <> OLD.issue_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_intent_is_immutable';
  END IF;
  PERFORM 1 FROM issues WHERE company_id = NEW.company_id AND id = NEW.issue_id FOR UPDATE;
  IF NEW.intent = 'non_code' AND (EXISTS (SELECT 1 FROM code_delivery_obligations WHERE company_id = NEW.company_id AND owner_issue_id = NEW.issue_id)
    OR EXISTS (SELECT 1 FROM code_delivery_discoveries WHERE company_id = NEW.company_id AND issue_id = NEW.issue_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_associations_require_reconciliation';
  END IF;
  UPDATE issues SET code_delivery_revision = code_delivery_revision + 1 WHERE company_id = NEW.company_id AND id = NEW.issue_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_intent_mutation BEFORE UPDATE OR DELETE ON issue_code_delivery_intents FOR EACH ROW EXECUTE FUNCTION code_delivery_intent_mutation();
--> statement-breakpoint
CREATE FUNCTION code_delivery_capture_work_product() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior jsonb;
  next_value jsonb;
  prior_code boolean := false;
  next_code boolean := false;
  target_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    prior := to_jsonb(OLD);
    prior_code := OLD.type IN ('pull_request', 'branch', 'commit') OR coalesce(OLD.url ~* '^https://github[.]com/[^/]+/[^/]+/pull/[0-9]+', false);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    next_value := to_jsonb(NEW);
    next_code := NEW.type IN ('pull_request', 'branch', 'commit') OR coalesce(NEW.url ~* '^https://github[.]com/[^/]+/[^/]+/pull/[0-9]+', false);
  END IF;
  IF NOT prior_code AND NOT next_code THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  PERFORM 1 FROM issues WHERE id IN ((prior->>'issue_id')::uuid, (next_value->>'issue_id')::uuid) ORDER BY id FOR UPDATE;
  IF next_code AND (NOT prior_code OR prior->>'issue_id' IS DISTINCT FROM next_value->>'issue_id'
    OR prior->>'url' IS DISTINCT FROM next_value->>'url' OR prior->>'external_id' IS DISTINCT FROM next_value->>'external_id') THEN
    SELECT status INTO target_status FROM issues WHERE id = NEW.issue_id AND company_id = NEW.company_id;
    IF target_status IS NULL OR target_status IN ('done', 'cancelled') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_late_association_requires_open_owner';
    END IF;
    IF EXISTS (SELECT 1 FROM issue_code_delivery_intents WHERE issue_id = NEW.issue_id AND company_id = NEW.company_id AND intent = 'non_code') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_non_code_intent_is_immutable';
    END IF;
  END IF;
  IF prior_code THEN
    INSERT INTO code_delivery_discoveries (company_id, issue_id, source_work_product_id, source_revision, snapshot)
    VALUES (OLD.company_id, OLD.issue_id, OLD.id, encode(sha256(convert_to(prior::text, 'UTF8')), 'hex'), prior) ON CONFLICT DO NOTHING;
  END IF;
  IF next_code THEN
    INSERT INTO code_delivery_discoveries (company_id, issue_id, source_work_product_id, source_revision, snapshot)
    VALUES (NEW.company_id, NEW.issue_id, NEW.id, encode(sha256(convert_to(next_value::text, 'UTF8')), 'hex'), next_value) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE issues SET code_delivery_revision = code_delivery_revision + 1
    WHERE id IN ((prior->>'issue_id')::uuid, (next_value->>'issue_id')::uuid);
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_capture_work_product BEFORE INSERT OR UPDATE OR DELETE ON issue_work_products FOR EACH ROW EXECUTE FUNCTION code_delivery_capture_work_product();
--> statement-breakpoint
CREATE FUNCTION code_delivery_obligation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_obligation_cannot_be_deleted';
  END IF;
  SELECT status INTO owner_status FROM issues WHERE id = NEW.owner_issue_id AND company_id = NEW.company_id FOR UPDATE;
  IF owner_status IS NULL OR owner_status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_requires_open_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM issue_code_delivery_intents WHERE company_id = NEW.company_id AND issue_id = NEW.owner_issue_id AND intent = 'non_code') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_non_code_intent_is_immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'proposed_head_sha' - 'reviewed_head_sha' - 'revision') IS DISTINCT FROM
       (to_jsonb(OLD) - 'proposed_head_sha' - 'reviewed_head_sha' - 'revision') OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_obligation_identity_is_immutable';
    END IF;
  ELSIF NEW.revision <> 1 OR NEW.owner_issue_id <> NEW.source_issue_id OR NEW.reviewed_head_sha IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'code_delivery_invalid_initial_obligation';
  END IF;
  UPDATE issues SET code_delivery_revision = code_delivery_revision + 1 WHERE id = NEW.owner_issue_id AND company_id = NEW.company_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_obligation_mutation BEFORE INSERT OR UPDATE OR DELETE ON code_delivery_obligations FOR EACH ROW EXECUTE FUNCTION code_delivery_obligation_mutation();
--> statement-breakpoint
CREATE FUNCTION code_delivery_initial_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO code_delivery_ownership_events (company_id, obligation_id, to_issue_id, obligation_revision, provenance)
  VALUES (NEW.company_id, NEW.id, NEW.owner_issue_id, NEW.revision, NEW.provenance);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER code_delivery_initial_ownership AFTER INSERT ON code_delivery_obligations FOR EACH ROW EXECUTE FUNCTION code_delivery_initial_ownership();
