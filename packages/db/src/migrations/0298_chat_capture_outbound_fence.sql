-- Capture authority is admission-pinned, not inferred from the current model,
-- configured agent list, or the newest assessment of a shared endpoint/head.
CREATE FUNCTION chat_action_is_internal(action_kind text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT action_kind = ANY(ARRAY[
    'inbound_wakeup', 'interaction_wakeup', 'failed_run_retry',
    'github_webhook_ingress', 'github_webhook_recovery',
    'attachment_derivative', 'attachment_companion', 'board_send_rejected'
  ]::text[])
$$;
--> statement-breakpoint
-- Payload identities are not all UUIDs (provider event ids, for example).
-- Parse without throwing, and keep casts off indexed database columns.
CREATE FUNCTION chat_outbound_uuid(identity text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN identity ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN identity::uuid ELSE NULL END
$$;
--> statement-breakpoint
CREATE FUNCTION chat_outbound_uuids(identities text[]) RETURNS uuid[]
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT array_agg(chat_outbound_uuid(identity)) FROM unnest(identities) AS identity
$$;
--> statement-breakpoint
CREATE FUNCTION chat_outbound_is_capture_only(scope jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  company_key uuid := chat_outbound_uuid(scope->>'company_id');
  endpoint_key uuid := chat_outbound_uuid(scope->>'endpoint_id');
  body jsonb := coalesce(scope->'payload', '{}'::jsonb);
  issue_keys text[] := array_remove(ARRAY[scope->>'issue_id', body->>'issueId', body->'session'->>'issueId'], NULL);
  conversation_keys text[] := array_remove(ARRAY[scope->>'conversation_id', body->>'conversationId'], NULL);
  delivery_keys text[] := array_remove(ARRAY[scope->>'delivery_id', body->>'deliveryId'], NULL);
  run_key text := coalesce(body->>'runId', body->'session'->>'runId');
  event_key text := coalesce(body->>'providerEventId', CASE
    WHEN body->'event'->>'repository' IS NOT NULL AND body->'event'->>'pullNumber' IS NOT NULL
      THEN 'github:' || (body->'event'->>'repository') || ':' || (body->'event'->>'pullNumber') || ':pr-event:' || (body->'event'->>'deliveryId')
    ELSE body->'event'->>'deliveryId' END);
  bound record;
  wake_link record;
BEGIN
  -- Live legacy shadow mode is a secondary fence, never the authority source.
  IF EXISTS (
    SELECT 1 FROM chat_github_configurations c
    WHERE c.company_id = company_key AND c.endpoint_id = endpoint_key
      AND c.configuration->'shadow'->>'enabled' = 'true'
  ) THEN RETURN true; END IF;

  FOR bound IN SELECT p.issue_id, p.conversation_id FROM chat_publications p
    WHERE p.company_id = company_key AND p.id = chat_outbound_uuid(body->>'publicationId')
  LOOP
    issue_keys := array_append(issue_keys, bound.issue_id::text);
    conversation_keys := array_append(conversation_keys, bound.conversation_id::text);
  END LOOP;
  FOR bound IN SELECT c.issue_id, c.created_by_run_id FROM issue_comments c
    WHERE c.company_id = company_key AND c.id = chat_outbound_uuid(scope->>'comment_id')
  LOOP
    issue_keys := array_append(issue_keys, bound.issue_id::text);
    run_key := coalesce(run_key, bound.created_by_run_id::text);
  END LOOP;
  FOR bound IN SELECT r.issue_id, r.delivery_id, r.shadow_label FROM chat_github_reviews r
    WHERE r.company_id = company_key AND r.id = chat_outbound_uuid(body->>'reviewId')
  LOOP
    IF bound.shadow_label IS NOT NULL THEN RETURN true; END IF;
    issue_keys := array_append(issue_keys, bound.issue_id::text);
    delivery_keys := array_append(delivery_keys, bound.delivery_id);
  END LOOP;
  FOR bound IN SELECT r.context_snapshot FROM heartbeat_runs r
    WHERE r.company_id = company_key AND r.id = chat_outbound_uuid(run_key)
  LOOP
    issue_keys := array_append(issue_keys, bound.context_snapshot->>'issueId');
    FOR wake_link IN SELECT l.delivery_id, l.conversation_id FROM chat_message_links l
      WHERE l.company_id = company_key AND l.comment_id = chat_outbound_uuid(bound.context_snapshot->>'wakeCommentId')
    LOOP
      delivery_keys := array_append(delivery_keys, wake_link.delivery_id::text);
      conversation_keys := array_append(conversation_keys, wake_link.conversation_id::text);
    END LOOP;
  END LOOP;
  FOR bound IN SELECT d.id, d.conversation_id, d.github_shadow_label FROM chat_deliveries d
    WHERE d.company_id = company_key AND (
      d.id = ANY(chat_outbound_uuids(delivery_keys)) OR (
        cardinality(delivery_keys) = 0 AND d.endpoint_id = endpoint_key AND event_key IS NOT NULL AND
        d.provider_event_id = event_key
      )
    )
  LOOP
    IF bound.github_shadow_label IS NOT NULL THEN RETURN true; END IF;
    delivery_keys := array_append(delivery_keys, bound.id::text);
    conversation_keys := array_append(conversation_keys, bound.conversation_id::text);
  END LOOP;
  FOR bound IN SELECT c.issue_id, c.github_shadow_label FROM chat_conversations c
    WHERE c.company_id = company_key AND (
      c.id = ANY(chat_outbound_uuids(conversation_keys)) OR c.issue_id = ANY(chat_outbound_uuids(issue_keys))
    )
  LOOP
    IF bound.github_shadow_label IS NOT NULL THEN RETURN true; END IF;
    issue_keys := array_append(issue_keys, bound.issue_id::text);
  END LOOP;
  RETURN EXISTS (
    SELECT 1 FROM chat_github_reviews r
    WHERE r.company_id = company_key AND r.shadow_label IS NOT NULL
      AND (r.issue_id = ANY(chat_outbound_uuids(issue_keys)) OR r.run_id = chat_outbound_uuid(run_key) OR r.delivery_id = ANY(delivery_keys))
  );
END;
$$;
--> statement-breakpoint
-- BEFORE INSERT is intentional: cancellation/deletion after insertion is not
-- zero-intent enforcement. Local wakes and capture outcomes remain internal.
CREATE FUNCTION guard_chat_outbound_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_actions' THEN
    IF chat_action_is_internal(NEW.kind) THEN RETURN NEW; END IF;
  END IF;
  IF chat_outbound_is_capture_only(to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'Capture-only work cannot create an outbound intent'
      USING ERRCODE = '23514', CONSTRAINT = 'chat_outbound_capture_only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_publication_capture_only
BEFORE INSERT ON chat_publications
FOR EACH ROW EXECUTE FUNCTION guard_chat_outbound_insert();
--> statement-breakpoint
CREATE TRIGGER chat_action_capture_only
BEFORE INSERT ON chat_actions
FOR EACH ROW EXECUTE FUNCTION guard_chat_outbound_insert();
