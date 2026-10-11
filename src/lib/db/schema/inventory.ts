import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clinics } from "./tenant";
import { users } from "./auth";

export const stockAlertStatusEnum = pgEnum("stock_alert_status", [
  "active", "resolved"
]);

export const stockItems = pgTable("stock_item", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  description: text("description"),
  currentQty: integer("current_qty").default(0).notNull(),
  minQty: integer("min_qty").default(0).notNull(),
  unit: text("unit"),
  supplierId: text("supplier_id"),
  purchasePrice: numeric("purchase_price", { precision: 12, scale: 2, mode: "number" }),
  sellingPrice: numeric("selling_price", { precision: 12, scale: 2, mode: "number" }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_stock_items_clinic_id").on(table.clinicId),
  // Z-60 : le stock ne peut jamais devenir négatif (garde de dernier recours
  // en base, la garde applicative restant en JS).
  check("ck_stock_items_current_qty_non_negative", sql`${table.currentQty} >= 0`),
]);

export const stockTransactionTypeEnum = pgEnum("stock_transaction_type", [
  "in", "out", "adjustment"
]);

export const stockTransactions = pgTable("stock_transaction", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  itemId: text("item_id").notNull().references(() => stockItems.id, { onDelete: "restrict" }),
  type: stockTransactionTypeEnum("type").notNull(),
  qty: integer("qty").notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2, mode: "number" }),
  reference: text("reference"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("idx_stock_transactions_item_id").on(table.itemId),
  index("idx_stock_transactions_created_by").on(table.createdBy),
]);

export const stockAlerts = pgTable("stock_alert", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  itemId: text("item_id").notNull().references(() => stockItems.id, { onDelete: "cascade" }),
  threshold: integer("threshold").notNull(),
  triggeredAt: timestamp("triggered_at", { mode: "date" }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { mode: "date" }),
  status: stockAlertStatusEnum("status").default("active").notNull(),
}, (table) => [
  index("idx_stock_alerts_clinic_id").on(table.clinicId),
  index("idx_stock_alerts_item_id").on(table.itemId),
  index("idx_stock_alerts_clinic_id_status").on(table.clinicId, table.status),
  // Z-62 : une seule alerte active par article (la sélection puis l'insertion
  // en JS n'est pas atomique).
  uniqueIndex("uq_stock_alerts_item_id_active")
    .on(table.itemId)
    .where(sql`status = 'active'`),
]);
