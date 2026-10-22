import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { activityLog, chatActions, chatPublications, type Db } from "@paperclipai/db";
import { CHAT_ACTION_QUEUES, notifyChatActionWork, notifyChatPublicationWork, type ScheduledChatAction } from "./chat-work-notifications.js";

type Writer = Pick<Db, "insert" | "execute" | "transaction">;
type Publication = PgInsertValue<typeof chatPublications>;
type Action = PgInsertValue<typeof chatActions>;
type Scope = {
  companyId: string;
  endpointId: string;
  conversationId?: string | null;
  deliveryId?: string | null;
  issueId?: string | null;
  commentId?: string | null;
  payload?: object;
};

function storedScope(input: Scope) {
  return {
    company_id: input.companyId, endpoint_id: input.endpointId,
    conversation_id: input.conversationId, delivery_id: input.deliveryId,
    issue_id: input.issueId, comment_id: input.commentId, payload: input.payload,
  };
}

/** Shared with the BEFORE INSERT tripwire. Never consult an agent allowlist or
 * a head-wide newest review: those would lend one arm another arm's authority.
 * Call inside the insertion transaction. The trigger remains the last fence.
 */
export async function isCaptureOnlyChatOutput(db: Writer, scope: Scope): Promise<boolean> {
  const rows = await db.execute<{ capture: boolean }>(sql`
    select chat_outbound_is_capture_only(${JSON.stringify(storedScope(scope))}::jsonb) as capture
  `);
  return rows[0]?.capture === true;
}

export const capturedChatOutput = {
  status: "shadow_stored" as const, actionId: null, publicationId: null,
};

async function capture(db: Writer, scope: Scope, kind: string, key: string) {
  // A deterministic local audit id keeps recovery/milestone scans idempotent.
  // No outbound row, provider receipt, or send token is manufactured.
  const hex = createHash("sha256").update(JSON.stringify([
    "chat-capture-v1", scope.companyId, scope.endpointId, kind, key,
  ])).digest("hex").slice(0, 32);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  await db.insert(activityLog).values({
    id, companyId: scope.companyId, actorType: "system", actorId: "chat-capture",
    action: "chat.capture_only_output", entityType: "chat_endpoint", entityId: scope.endpointId,
    details: { kind, key, conversationId: scope.conversationId ?? null, issueId: scope.issueId ?? null,
      deliveryId: scope.deliveryId ?? null, commentId: scope.commentId ?? null },
  }).onConflictDoNothing();
}

function publicationQuery(db: Writer, values: Publication[]) {
  return db.insert(chatPublications).values(values);
}
function actionQuery(db: Writer, values: Action[]) {
  return db.insert(chatActions).values(values);
}
type PublicationOptions = {
  onConflictDoNothing?: boolean;
};
type ActionOptions = PublicationOptions & {
  onConflictDoUpdate?: Parameters<ReturnType<typeof actionQuery>["onConflictDoUpdate"]>[0];
};

/** The only publication INSERT surface. Suppression returns no rows, not a
 * cancelled intent. Returning complete rows also preserves existing callers'
 * conflict/idempotency logic without a custom query-builder proxy.
 */
export async function insertChatPublications(
  db: Writer, values: Publication | Publication[], options: PublicationOptions = {},
): Promise<Array<typeof chatPublications.$inferSelect>> {
  const items = Array.isArray(values) ? values : [values];
  if (items.length === 0) return [];
  return db.transaction(async (tx) => {
    const allowed: Publication[] = [];
    for (const value of items) {
      const scope = value as Scope;
      if (await isCaptureOnlyChatOutput(tx, scope)) {
        await capture(tx, scope, "publication", String(value.idempotencyKey));
      } else allowed.push(value);
    }
    if (allowed.length === 0) return [];
    await notifyChatPublicationWork(tx);
    const query = publicationQuery(tx, allowed);
    return options.onConflictDoNothing ? query.onConflictDoNothing().returning() : query.returning();
  });
}

/** Unknown action kinds are outbound by default. The small database-owned
 * local-only allowlist is shared by this writer and its insertion tripwire.
 */
export async function insertChatActions(
  db: Writer, values: Action | Action[], options: ActionOptions = {},
): Promise<Array<typeof chatActions.$inferSelect>> {
  const items = Array.isArray(values) ? values : [values];
  if (items.length === 0) return [];
  return db.transaction(async (tx) => {
    const allowed: Action[] = [];
    for (const value of items) {
      const scope = value as Scope;
      const rows = await tx.execute<{ internal: boolean; capture: boolean }>(sql`
        select chat_action_is_internal(${value.kind}) as internal,
          chat_outbound_is_capture_only(${JSON.stringify(storedScope(scope))}::jsonb) as capture
      `);
      if (!rows[0]?.internal && rows[0]?.capture) {
        await capture(tx, scope, String(value.kind), String(value.providerActionId));
      } else allowed.push(value);
    }
    if (allowed.length === 0) return [];
    for (const value of allowed) {
      if (typeof value.kind === "string" && Object.hasOwn(CHAT_ACTION_QUEUES, value.kind)) {
        await notifyChatActionWork(tx, value.kind as ScheduledChatAction);
      }
    }
    const query = actionQuery(tx, allowed);
    if (options.onConflictDoUpdate) return query.onConflictDoUpdate(options.onConflictDoUpdate).returning();
    return options.onConflictDoNothing ? query.onConflictDoNothing().returning() : query.returning();
  });
}
