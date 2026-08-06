import { pgEnum, pgTable, text, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { clinics } from "./tenant";
import { patients } from "./patients";
import { users } from "./auth";
import { treatmentPlans } from "./clinical";
export const documentSequences = pgTable("document_sequence", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    lastNumber: integer("last_number").default(0).notNull(),
}, (table) => ({
    uniqueClinicType: uniqueIndex("uq_doc_seq_clinic_type").on(table.clinicId, table.type),
}));
export const invoiceStatusEnum = pgEnum("invoice_status", [
    "draft", "sent", "paid", "partially_paid", "overdue", "cancelled"
]);
export const invoices = pgTable("invoice", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    date: timestamp("date", { mode: "date" }).defaultNow().notNull(),
    dueDate: timestamp("due_date", { mode: "date" }),
    status: invoiceStatusEnum("status").default("draft").notNull(),
    subtotal: integer("subtotal").notNull(),
    taxTotal: integer("tax_total").default(0),
    discountTotal: integer("discount_total").default(0),
    total: integer("total").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("uq_invoices_clinic_number").on(table.clinicId, table.number),
    index("idx_invoices_clinic_id").on(table.clinicId),
    index("idx_invoices_status").on(table.status),
    index("idx_invoices_patient_id").on(table.patientId),
]);
export const invoiceItems = pgTable("invoice_item", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").default(1).notNull(),
    unitPrice: integer("unit_price").notNull(),
    taxRate: integer("tax_rate").default(0),
    discount: integer("discount").default(0),
    total: integer("total").notNull(),
}, (table) => [
    index("idx_invoice_items_invoice_id").on(table.invoiceId),
]);
export const quoteStatusEnum = pgEnum("quote_status", [
    "draft", "sent", "accepted", "rejected", "expired"
]);
export const quotes = pgTable("quote", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    date: timestamp("date", { mode: "date" }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { mode: "date" }),
    status: quoteStatusEnum("status").default("draft").notNull(),
    subtotal: integer("subtotal").notNull(),
    taxTotal: integer("tax_total").default(0),
    discountTotal: integer("discount_total").default(0),
    total: integer("total").notNull(),
    notes: text("notes"),
    generatedFromTreatmentPlanId: text("generated_from_treatment_plan_id")
        .references(() => treatmentPlans.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("uq_quotes_clinic_number").on(table.clinicId, table.number),
    index("idx_quotes_clinic_id").on(table.clinicId),
    index("idx_quotes_patient_id").on(table.patientId),
    index("idx_quotes_status").on(table.status),
]);
export const quoteItems = pgTable("quote_item", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    quoteId: text("quote_id").notNull().references(() => quotes.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").default(1).notNull(),
    unitPrice: integer("unit_price").notNull(),
    taxRate: integer("tax_rate").default(0),
    discount: integer("discount").default(0),
    total: integer("total").notNull(),
}, (table) => [
    index("idx_quote_items_quote_id").on(table.quoteId),
]);
export const paymentMethodEnum = pgEnum("payment_method", [
    "cash", "check", "card", "transfer"
]);
export const payments = pgTable("payment", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    amount: integer("amount").notNull(),
    method: paymentMethodEnum("method").notNull(),
    reference: text("reference"),
    date: timestamp("date", { mode: "date" }).defaultNow().notNull(),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
    index("idx_payments_clinic_id").on(table.clinicId),
    index("idx_payments_invoice_id").on(table.invoiceId),
    index("idx_payments_patient_id").on(table.patientId),
    index("idx_payments_created_by").on(table.createdBy),
]);
