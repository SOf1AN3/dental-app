import { pgEnum, pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clinics } from "./tenant";
import { patients } from "./patients";
import { users } from "./auth";

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"
]);

export const appointments = pgTable("appointment", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
  dentistId: text("dentist_id").references(() => users.id),
  startTime: timestamp("start_time", { mode: "date" }).notNull(),
  endTime: timestamp("end_time", { mode: "date" }).notNull(),
  type: text("type"),
  status: appointmentStatusEnum("status").default("scheduled").notNull(),
  notes: text("notes"),
  color: text("color"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_appointments_clinic_id").on(table.clinicId),
  index("idx_appointments_patient_id").on(table.patientId),
  index("idx_appointments_start_time").on(table.startTime),
]);

export const waitingRoomStatusEnum = pgEnum("waiting_room_status", [
  "waiting", "called", "in_treatment", "completed", "no_show"
]);

export const waitingRoomEntries = pgTable("waiting_room_entry", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
  patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
  status: waitingRoomStatusEnum("status").default("waiting").notNull(),
  arrivedAt: timestamp("arrived_at", { mode: "date" }).defaultNow().notNull(),
  calledAt: timestamp("called_at", { mode: "date" }),
  notes: text("notes"),
}, (table) => [
  index("idx_waiting_room_entries_clinic_id").on(table.clinicId),
  index("idx_waiting_room_entries_clinic_id_status").on(table.clinicId, table.status),
  index("idx_waiting_room_entries_appointment_id").on(table.appointmentId),
  uniqueIndex("uq_waiting_room_active_patient_clinic")
    .on(table.patientId, table.clinicId)
    .where(sql`status IN ('waiting', 'called', 'in_treatment')`),
]);

export const appointmentReminders = pgTable("appointment_reminder", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  appointmentId: text("appointment_id").notNull().references(() => appointments.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  sentAt: timestamp("sent_at", { mode: "date" }),
  status: text("status"),
  errorMessage: text("error_message"),
});
