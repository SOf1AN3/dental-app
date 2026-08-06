import { pgEnum, pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { clinics } from "./tenant";
import { patients } from "./patients";
import { users } from "./auth";
export const prescriptionStatusEnum = pgEnum("prescription_status", [
    "active", "completed", "cancelled"
]);
export const prescriptions = pgTable("prescription", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    dentistId: text("dentist_id").references(() => users.id),
    date: timestamp("date", { mode: "date" }).defaultNow().notNull(),
    status: prescriptionStatusEnum("status").default("active").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
    index("idx_prescriptions_clinic_id").on(table.clinicId),
    index("idx_prescriptions_patient_id").on(table.patientId),
    index("idx_prescriptions_status").on(table.status),
    index("idx_prescriptions_dentist_id").on(table.dentistId),
]);
export const prescriptionItemTypeEnum = pgEnum("prescription_item_type", [
    "medication", "care"
]);
export const prescriptionItems = pgTable("prescription_item", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    prescriptionId: text("prescription_id").notNull().references(() => prescriptions.id, { onDelete: "cascade" }),
    type: prescriptionItemTypeEnum("type").default("medication").notNull(),
    name: text("name").notNull(),
    dosage: text("dosage"),
    form: text("form"),
    frequency: text("frequency"),
    duration: text("duration"),
    quantity: integer("quantity"),
    instructions: text("instructions"),
}, (table) => [
    index("idx_prescription_items_prescription_id").on(table.prescriptionId),
]);
