import { and, isNull, sql } from "drizzle-orm";
import { chatConversations, chatDeliveries, chatGitHubReviews } from "@paperclipai/db";

/** Only publishing work may own, satisfy, supersede, or consume a primary gate.
 * A missing review label is not sufficient: admission authority predates it.
 * Keep this predicate independent of live endpoint configuration; disabling an
 * experiment must not promote its historical records into primary work.
 */
export function primaryGitHubReview() {
  return and(
    isNull(chatGitHubReviews.shadowLabel),
    sql`not exists (
      select 1 from ${chatConversations} capture_conversation
      where capture_conversation.company_id = ${chatGitHubReviews.companyId}
        and capture_conversation.issue_id = ${chatGitHubReviews.issueId}
        and capture_conversation.github_shadow_label is not null
    )`,
    sql`not exists (
      select 1 from ${chatDeliveries} capture_delivery
      where capture_delivery.company_id = ${chatGitHubReviews.companyId}
        and capture_delivery.id = chat_outbound_uuid(${chatGitHubReviews.deliveryId})
        and capture_delivery.github_shadow_label is not null
    )`,
  );
}

export function primaryGitHubDelivery() {
  return and(
    isNull(chatDeliveries.githubShadowLabel),
    sql`not exists (
      select 1 from ${chatConversations} capture_conversation
      where capture_conversation.company_id = ${chatDeliveries.companyId}
        and capture_conversation.id = ${chatDeliveries.conversationId}
        and capture_conversation.github_shadow_label is not null
    )`,
  );
}
