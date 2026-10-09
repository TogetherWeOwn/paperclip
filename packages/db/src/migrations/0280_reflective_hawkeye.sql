-- TOG-19517: persist the two host-verified chat_publications lookup definitions.
-- The host built these CONCURRENTLY outside the migration system after bounded
-- EXPLAIN ANALYZE proved repeated chat_publications scans in the chat milestone
-- reconciliation query (server/src/services/chat-run-publications.ts). Full
-- evidence and rollback live on the TOG-19457 repair document
-- (host-db-latency-repair-20261009); rollback there drops only these two names.
--
-- Fresh databases build both definitions here. Deployments where the exact host
-- definitions already exist adopt them: IF NOT EXISTS skips the build and the
-- verification block below confirms equivalence by catalog inspection. A
-- same-named definition with different columns, expressions, predicate,
-- uniqueness, or validity aborts the migration loudly instead of silently
-- accepting drift. CONCURRENTLY is unavailable because the migration runner
-- applies each file transactionally, so the one-time build holds a brief
-- share lock on chat_publications; for already-indexed deployments the skip
-- path takes no lock at all.
--
-- drizzle-orm 0.45.2 has no INCLUDE clause support, so the covering column on
-- the second definition lives in this SQL and in the schema code comment only
-- (packages/db/src/schema/chat_channels.ts). Keep the three sources aligned:
-- schema builder, this file, and the verification blocks.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. These narrow lookup definitions adopt the host-verified repair for the chat milestone reconciliation scan; already-indexed deployments skip the build entirely via IF NOT EXISTS plus catalog verification.
CREATE INDEX IF NOT EXISTS "ops_chatpub_company_issue_interaction_published_idx" ON "chat_publications" USING btree ("company_id","issue_id",(( "payload" ->> 'interactionId' ))) WHERE "chat_publications"."state" = 'published';--> statement-breakpoint
DO $$
DECLARE
  v_unique boolean;
  v_nkeyatts integer;
  v_valid boolean;
  v_ready boolean;
  v_keycols text;
  v_expr text;
  v_pred text;
BEGIN
  SELECT i.indisunique, i.indnkeyatts, i.indisvalid, i.indisready,
         (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
            FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum
           WHERE u.attnum <> 0),
         pg_get_expr(i.indexprs, i.indrelid),
         pg_get_expr(i.indpred, i.indrelid)
    INTO v_unique, v_nkeyatts, v_valid, v_ready, v_keycols, v_expr, v_pred
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname = 'ops_chatpub_company_issue_interaction_published_idx'
     AND n.nspname = 'public'
     AND i.indrelid = 'public.chat_publications'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_issue_interaction_published_idx on public.chat_publications is absent after this migration ran; the migration is incomplete, inspect the earlier statement result';
  END IF;
  IF v_unique THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_issue_interaction_published_idx must be non-unique; found a unique definition under the same name, resolve the conflict before retrying';
  END IF;
  IF NOT v_valid OR NOT v_ready THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_issue_interaction_published_idx exists but is not valid and ready (a failed concurrent build leaves this state); remove only this definition and retry';
  END IF;
  IF v_keycols IS DISTINCT FROM 'company_id,issue_id' THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_issue_interaction_published_idx key columns must be (company_id, issue_id) plus the interaction expression; found [%]', v_keycols;
  END IF;
  IF lower(regexp_replace(regexp_replace(v_expr, '\s+', '', 'g'), '::text', '', 'g')) IS DISTINCT FROM '(payload->>''interactionid'')' THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_issue_interaction_published_idx expression must be ((payload->>''interactionId'')); found [%]', v_expr;
  END IF;
  IF lower(regexp_replace(regexp_replace(v_pred, '\s+', '', 'g'), '::text', '', 'g')) IS DISTINCT FROM '(state=''published'')' THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_issue_interaction_published_idx predicate must be state=''published''; found [%]', v_pred;
  END IF;
END $$;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. This covering definition adopts the host-verified repair for the final-comment publication lookup; already-indexed deployments skip the build entirely via IF NOT EXISTS plus catalog verification.
CREATE INDEX IF NOT EXISTS "ops_chatpub_company_endpoint_conversation_idx" ON "chat_publications" USING btree ("company_id","endpoint_id","conversation_id") INCLUDE ("comment_id");--> statement-breakpoint
DO $$
DECLARE
  v_unique boolean;
  v_nkeyatts integer;
  v_valid boolean;
  v_ready boolean;
  v_keycols text;
  v_expr text;
  v_pred text;
BEGIN
  SELECT i.indisunique, i.indnkeyatts, i.indisvalid, i.indisready,
         (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
            FROM unnest(i.indkey) WITH ORDINALITY AS u(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum
           WHERE u.attnum <> 0),
         pg_get_expr(i.indexprs, i.indrelid),
         pg_get_expr(i.indpred, i.indrelid)
    INTO v_unique, v_nkeyatts, v_valid, v_ready, v_keycols, v_expr, v_pred
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname = 'ops_chatpub_company_endpoint_conversation_idx'
     AND n.nspname = 'public'
     AND i.indrelid = 'public.chat_publications'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_endpoint_conversation_idx on public.chat_publications is absent after this migration ran; the migration is incomplete, inspect the earlier statement result';
  END IF;
  IF v_unique THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_endpoint_conversation_idx must be non-unique; found a unique definition under the same name, resolve the conflict before retrying';
  END IF;
  IF NOT v_valid OR NOT v_ready THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_endpoint_conversation_idx exists but is not valid and ready (a failed concurrent build leaves this state); remove only this definition and retry';
  END IF;
  IF v_nkeyatts IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_endpoint_conversation_idx must carry exactly 3 key columns with comment_id as the covering column; found % key columns', v_nkeyatts;
  END IF;
  IF v_keycols IS DISTINCT FROM 'company_id,endpoint_id,conversation_id,comment_id' THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_endpoint_conversation_idx columns must be (company_id, endpoint_id, conversation_id) INCLUDE (comment_id); found [%]', v_keycols;
  END IF;
  IF v_expr IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_endpoint_conversation_idx must have no expression columns; found [%]', v_expr;
  END IF;
  IF v_pred IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0280 (TOG-19517): public.ops_chatpub_company_endpoint_conversation_idx must have no predicate; found [%]', v_pred;
  END IF;
END $$;--> statement-breakpoint
