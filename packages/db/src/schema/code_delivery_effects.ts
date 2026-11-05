import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { codeDeliveryReadinessReceipts, codeDeliveryReceiptConsumptions } from "./code_delivery_receipts.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const codeDeliveryTerminalEffects = pgTable("code_delivery_terminal_effects", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  receiptId: uuid("receipt_id").notNull().references(() => codeDeliveryReceiptConsumptions.receiptId),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  effectKind: text("effect_kind").$type<"stop_run">().notNull(),
  state: text("state").$type<"pending" | "settled">().notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  receipt: foreignKey({ columns: [table.companyId, table.issueId, table.receiptId],
    foreignColumns: [codeDeliveryReadinessReceipts.companyId, codeDeliveryReadinessReceipts.issueId, codeDeliveryReadinessReceipts.id] }),
  target: unique("code_delivery_terminal_effects_target_uq").on(table.receiptId, table.runId, table.effectKind),
  pending: index("code_delivery_terminal_effects_pending_idx").on(table.state, table.nextAttemptAt, table.id),
  kind: check("code_delivery_terminal_effects_kind_ck", sql`${table.effectKind} = 'stop_run'`),
  validState: check("code_delivery_terminal_effects_state_ck", sql`${table.state} in ('pending', 'settled') and ((${table.state} = 'settled') = (${table.settledAt} is not null))`),
  validAttempts: check("code_delivery_terminal_effects_attempts_ck", sql`${table.attemptCount} >= 0`),
}));
