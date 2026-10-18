-- Replace the classifier, preserving both application and BEFORE INSERT fences.
-- Do not depend on begin_review or a successful run: startup failures also emit
-- lifecycle output. Persisted native task bindings are authoritative at that point.
CREATE OR REPLACE FUNCTION chat_outbound_is_capture_only(scope jsonb) RETURNS boolean
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
  FOR bound IN SELECT r.native_issue_id, r.context_snapshot FROM heartbeat_runs r
    WHERE r.company_id = company_key AND r.id = chat_outbound_uuid(run_key)
  LOOP
    -- Consider all persisted bindings for denial. A stale or conflicting context
    -- must not erase a native capture-only task's publication restriction.
    issue_keys := array_append(issue_keys, bound.native_issue_id::text);
    issue_keys := array_append(issue_keys, bound.context_snapshot->>'issueId');
    issue_keys := array_append(issue_keys, bound.context_snapshot->>'taskId');
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
