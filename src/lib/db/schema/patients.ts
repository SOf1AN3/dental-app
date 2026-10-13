import { bigint, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { clinics } from "./tenant";

export const patients = pgTable("patient", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  dateOfBirth: timestamp("date_of_birth", { mode: "date" }),
  gender: text("gender"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  wilayaCode: text("wilaya_code"),
  emergencyContact: text("emergency_contact"),
  emergencyPhone: text("emergency_phone"),
  insuranceProvider: text("insurance_provider"),
  insuranceNumber: text("insurance_number"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
  // Réplication (tâche 4.1) : `rev` = version MONOTONE attribuée côté serveur,
  // `device_id` = dernier poste ayant écrit ; `deleted_at` (tombstone) existe
  // déjà. Curseur de pull : (clinic_id, updated_at, id) → index ci-dessous.
  deviceId: text("device_id"),
  rev: bigint("rev", { mode: "number" }).default(0).notNull(),
}, (table) => [
  index("idx_patients_clinic_id").on(table.clinicId),
  index("idx_patients_clinic_updated_id").on(table.clinicId, table.updatedAt, table.id),
  index("idx_patients_last_name_first_name").on(table.lastName, table.firstName),
  index("idx_patients_phone").on(table.phone),
  index("idx_patients_email").on(table.email),
]);
