import { bigint, pgEnum, pgTable, text, timestamp, integer, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clinics } from "./tenant";
import { patients } from "./patients";
import { appointments } from "./appointments";
import { users } from "./auth";

export const clinicalSessionStatusEnum = pgEnum("clinical_session_status", [
  "pending", "in_progress", "completed", "invoiced", "paid"
]);

export const clinicalSessions = pgTable("clinical_session", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
  dentistId: text("dentist_id").references(() => users.id, { onDelete: "set null" }),
  status: clinicalSessionStatusEnum("status").default("pending").notNull(),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2, mode: "number" }).default(0).notNull(),
  notes: text("notes"),
  startedAt: timestamp("started_at", { mode: "date" }),
  completedAt: timestamp("completed_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Réplication (tâche 4.1) : `rev` = version MONOTONE attribuée côté serveur,
  // `device_id` = dernier poste ayant écrit, `deleted_at` = tombstone.
  // Curseur de pull : (clinic_id, updated_at, id) → index ci-dessous.
  deviceId: text("device_id"),
  rev: bigint("rev", { mode: "number" }).default(0).notNull(),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
}, (table) => [
  index("idx_clinical_sessions_clinic_id").on(table.clinicId),
  index("idx_clinical_sessions_clinic_updated_id").on(table.clinicId, table.updatedAt, table.id),
  index("idx_clinical_sessions_patient_id").on(table.patientId),
  index("idx_clinical_sessions_appointment_id").on(table.appointmentId),
  index("idx_clinical_sessions_status").on(table.status),
  uniqueIndex("uq_clinical_session_active_patient_clinic")
    .on(table.patientId, table.clinicId)
    .where(sql`status = 'in_progress'`),
]);

export const clinicalSessionItems = pgTable("clinical_session_item", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull().references(() => clinicalSessions.id, { onDelete: "cascade" }),
  toothNumber: integer("tooth_number"),
  surface: text("surface"),
  procedureCode: text("procedure_code"),
  description: text("description").notNull(),
  fee: numeric("fee", { precision: 12, scale: 2, mode: "number" }).notNull(),
  quantity: integer("quantity").default(1).notNull(),
  discount: numeric("discount", { precision: 12, scale: 2, mode: "number" }).default(0),
  taxRate: integer("tax_rate").default(0),
  orderIndex: integer("order_index").default(0),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("idx_clinical_session_items_session_id").on(table.sessionId),
]);
