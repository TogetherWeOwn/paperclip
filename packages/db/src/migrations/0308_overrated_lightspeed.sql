ALTER TABLE "chat_github_reviews" ADD COLUMN "admission_delivery_id" uuid;--> statement-breakpoint
-- Preserve already-admitted history, but only accept a native delivery from
-- the same company and endpoint (provider delivery strings are not authority).
UPDATE chat_github_reviews r SET admission_delivery_id = d.id
FROM chat_deliveries d
WHERE r.company_id = d.company_id AND r.endpoint_id = d.endpoint_id
  AND d.id = CASE
    WHEN coalesce(r.event->>'admissionDeliveryId',
      CASE WHEN r.delivery_id !~ '^run:' THEN r.delivery_id END,
      r.event->>'deliveryId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN coalesce(r.event->>'admissionDeliveryId',
      CASE WHEN r.delivery_id !~ '^run:' THEN r.delivery_id END,
      r.event->>'deliveryId')::uuid
    END;--> statement-breakpoint
CREATE INDEX "chat_deliveries_pair_pending_idx" ON "chat_deliveries" USING btree ("received_at","id") WHERE "chat_deliveries"."normalized_event" ? 'githubPairingPending' and not ("chat_deliveries"."normalized_event" ? 'githubPairingSeed');--> statement-breakpoint
CREATE INDEX "chat_github_reviews_admission_idx" ON "chat_github_reviews" USING btree ("endpoint_id","admission_delivery_id") WHERE "chat_github_reviews"."shadow_label" is null and "chat_github_reviews"."admission_delivery_id" is not null;