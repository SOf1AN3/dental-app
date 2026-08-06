import { pgEnum, pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
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
    purchasePrice: integer("purchase_price"),
    sellingPrice: integer("selling_price"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
    index("idx_stock_items_clinic_id").on(table.clinicId),
]);
export const stockTransactionTypeEnum = pgEnum("stock_transaction_type", [
    "in", "out", "adjustment"
]);
export const stockTransactions = pgTable("stock_transaction", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    itemId: text("item_id").notNull().references(() => stockItems.id, { onDelete: "restrict" }),
    type: stockTransactionTypeEnum("type").notNull(),
    qty: integer("qty").notNull(),
    unitPrice: integer("unit_price"),
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
]);
