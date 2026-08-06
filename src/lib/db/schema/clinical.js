import { pgEnum, pgTable, text, timestamp, integer, boolean, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { clinics } from "./tenant";
import { patients } from "./patients";
import { appointments } from "./appointments";
import { users } from "./auth";
export const dentalCharts = pgTable("dental_chart", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    toothNumber: integer("tooth_number").notNull(),
    quadrant: integer("quadrant"),
    surface: text("surface"),
    conditionCode: text("condition_code"),
    conditionLabel: text("condition_label"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
    index("idx_dental_charts_clinic_id").on(table.clinicId),
    index("idx_dental_charts_patient_id").on(table.patientId),
    index("idx_dental_charts_patient_id_tooth_number").on(table.patientId, table.toothNumber),
]);
export const odontogramStates = pgTable("odontogram_state", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    state: jsonb("state").notNull(),
    version: integer("version").default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
    index("idx_odontogram_state_clinic_id").on(table.clinicId),
    index("idx_odontogram_state_patient_id").on(table.patientId),
    uniqueIndex("uq_odontogram_state_patient_clinic").on(table.patientId, table.clinicId),
]);
export const treatmentPlanStatusEnum = pgEnum("treatment_plan_status", [
    "draft", "active", "completed", "cancelled"
]);
export const treatmentPlans = pgTable("treatment_plan", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: treatmentPlanStatusEnum("status").default("draft").notNull(),
    totalAmount: integer("total_amount"),
    discount: integer("discount"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
    index("idx_treatment_plans_clinic_id").on(table.clinicId),
    index("idx_treatment_plans_patient_id").on(table.patientId),
]);
export const treatmentPlanItems = pgTable("treatment_plan_item", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    planId: text("plan_id").notNull().references(() => treatmentPlans.id, { onDelete: "cascade" }),
    toothNumber: integer("tooth_number"),
    surface: text("surface"),
    procedureCode: text("procedure_code"),
    description: text("description").notNull(),
    fee: integer("fee").notNull(),
    quantity: integer("quantity").default(1).notNull(),
    discount: integer("discount"),
    taxRate: integer("tax_rate").default(0),
    orderIndex: integer("order_index").default(0),
}, (table) => [
    index("idx_treatment_plan_items_plan_id").on(table.planId),
]);
export const consultationNotes = pgTable("consultation_note", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    appointmentId: text("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    dentistId: text("dentist_id").references(() => users.id, { onDelete: "set null" }),
    diagnosis: text("diagnosis"),
    notes: text("notes").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
    index("idx_consultation_notes_clinic_id").on(table.clinicId),
    index("idx_consultation_notes_patient_id").on(table.patientId),
]);
export const medicalHistoryEntries = pgTable("medical_history_entry", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    condition: text("condition").notNull(),
    diagnosisDate: timestamp("diagnosis_date", { mode: "date" }),
    notes: text("notes"),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
    index("idx_medical_history_entries_clinic_id").on(table.clinicId),
    index("idx_medical_history_entries_patient_id").on(table.patientId),
]);
export const treatmentCatalog = pgTable("treatment_catalog", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code"),
    category: text("category"),
    price: integer("price").notNull().default(0),
    description: text("description"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
    index("idx_treatment_catalog_clinic_id").on(table.clinicId),
]);
export const radiographs = pgTable("radiograph", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    fileKey: text("file_key").notNull(),
    fileType: text("file_type"),
    toothNumber: integer("tooth_number"),
    region: text("region"),
    notes: text("notes"),
    uploadedBy: text("uploaded_by").references(() => users.id),
    takenAt: timestamp("taken_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { mode: "date" }),
}, (table) => [
    index("idx_radiographs_clinic_id").on(table.clinicId),
    index("idx_radiographs_patient_id").on(table.patientId),
]);
