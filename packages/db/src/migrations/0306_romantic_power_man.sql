CREATE TABLE "chat_github_blinding_versions" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_github_blinding_versions" ADD CONSTRAINT "chat_github_blinding_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_github_candidates_visibility_version_idx" ON "chat_github_review_candidates" USING btree ("company_id","updated_at");
--> statement-breakpoint
-- Seed existing companies once, from the candidate company index. No run scan or
-- historical run rewrite is needed: native and legacy run lookup indexes exist.
INSERT INTO chat_github_blinding_versions (company_id)
SELECT DISTINCT company_id FROM chat_github_review_candidates;
--> statement-breakpoint
-- Invalidate in the same transaction as identity/alias writes, including writes
-- outside the application process. Never expire privacy history on a timer.
-- Output/status/body updates do not change the visibility set and do not fire.
CREATE FUNCTION invalidate_github_primary_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_company uuid;
  new_company uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_company := OLD.company_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_company := NEW.company_id; END IF;
  IF TG_TABLE_NAME = 'chat_github_review_candidates' AND new_company IS NOT NULL THEN
    INSERT INTO chat_github_blinding_versions (company_id, version) VALUES (new_company, 1)
    ON CONFLICT (company_id) DO UPDATE SET version = chat_github_blinding_versions.version + 1;
  ELSE
    UPDATE chat_github_blinding_versions SET version = version + 1 WHERE company_id = new_company;
  END IF;
  IF old_company IS DISTINCT FROM new_company THEN
    UPDATE chat_github_blinding_versions SET version = version + 1 WHERE company_id = old_company;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER github_candidates_visibility AFTER INSERT OR UPDATE OR DELETE ON chat_github_review_candidates
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
--> statement-breakpoint
CREATE TRIGGER github_runs_visibility AFTER INSERT OR DELETE OR UPDATE OF id, company_id, agent_id, native_issue_id, context_snapshot ON heartbeat_runs
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
--> statement-breakpoint
CREATE TRIGGER github_issues_visibility AFTER INSERT OR DELETE OR UPDATE OF id, company_id, identifier ON issues
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
--> statement-breakpoint
CREATE TRIGGER github_comments_visibility AFTER INSERT OR DELETE OR UPDATE OF id, company_id, issue_id, author_agent_id ON issue_comments
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
--> statement-breakpoint
CREATE TRIGGER github_attachments_visibility AFTER INSERT OR DELETE OR UPDATE OF id, company_id, issue_id, asset_id ON issue_attachments
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
--> statement-breakpoint
CREATE TRIGGER github_assets_visibility AFTER INSERT OR DELETE OR UPDATE OF id, company_id, created_by_agent_id ON assets
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
--> statement-breakpoint
CREATE TRIGGER github_reviews_visibility AFTER INSERT OR DELETE OR UPDATE OF id, company_id, issue_id, shadow_label ON chat_github_reviews
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
--> statement-breakpoint
CREATE TRIGGER github_documents_visibility AFTER INSERT OR DELETE OR UPDATE OF id, company_id, created_by_agent_id ON documents
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
--> statement-breakpoint
CREATE TRIGGER github_issue_documents_visibility AFTER INSERT OR DELETE OR UPDATE OF company_id, issue_id, document_id ON issue_documents
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
--> statement-breakpoint
CREATE TRIGGER github_revisions_visibility AFTER INSERT OR DELETE OR UPDATE OF id, company_id, document_id ON document_revisions
FOR EACH ROW EXECUTE FUNCTION invalidate_github_primary_visibility();
