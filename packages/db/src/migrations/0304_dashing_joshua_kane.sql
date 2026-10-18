ALTER TABLE "chat_github_review_candidates" DROP CONSTRAINT "chat_github_candidates_state_check";--> statement-breakpoint
ALTER TABLE "chat_github_review_enrollments" ADD COLUMN "isolation_tests" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_github_review_candidates" ADD CONSTRAINT "chat_github_candidates_state_check" CHECK ("chat_github_review_candidates"."state" in ('pending', 'materialized', 'dispatched', 'unavailable', 'voided'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_github_pair_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'isolation_tests') IS DISTINCT FROM (to_jsonb(OLD) - 'isolation_tests')
     OR jsonb_typeof(NEW.isolation_tests) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(OLD.isolation_tests) e
                WHERE NEW.isolation_tests->e.key IS DISTINCT FROM e.value) THEN
    RAISE EXCEPTION 'GitHub review enrollment and prior isolation evidence are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION protect_github_voided_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'voided' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Contaminated GitHub candidates cannot be revived' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chat_github_candidate_voided BEFORE UPDATE ON chat_github_review_candidates
FOR EACH ROW EXECUTE FUNCTION protect_github_voided_candidate();
