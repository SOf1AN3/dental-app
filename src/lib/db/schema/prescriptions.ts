import { bigint, pgEnum, pgTable, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clinics } from "./tenant";
import { patients } from "./patients";
import { users } from "./auth";
import { clinicalSessions } from "./sessions";

export const prescriptionStatusEnum = pgEnum("prescription_status", [
  "active", "completed", "cancelled"
]);

export const prescriptions = pgTable("prescription", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
  dentistId: text("dentist_id").references(() => users.id),
  sessionId: text("session_id").references(() => clinicalSessions.id, { onDelete: "set null" }),
  date: timestamp("date", { mode: "date" }).defaultNow().notNull(),
  status: prescriptionStatusEnum("status").default("active").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  // Réplication (tâche 4.1) : `rev` = version MONOTONE attribuée côté serveur,
  // `device_id` = dernier poste ayant écrit, `deleted_at` = tombstone.
  // Curseur de pull : (clinic_id, updated_at, id) → index ci-dessous.
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
  deviceId: text("device_id"),
  rev: bigint("rev", { mode: "number" }).default(0).notNull(),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
}, (table) => [
  index("idx_prescriptions_clinic_id").on(table.clinicId),
  index("idx_prescriptions_clinic_updated_id").on(table.clinicId, table.updatedAt, table.id),
  index("idx_prescriptions_patient_id").on(table.patientId),
  index("idx_prescriptions_status").on(table.status),
  index("idx_prescriptions_dentist_id").on(table.dentistId),
  index("idx_prescriptions_session_id").on(table.sessionId),
  uniqueIndex("uq_prescriptions_session").on(table.sessionId).where(sql`session_id IS NOT NULL`),
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
  /**
   * Z-45 — ordre de saisie des lignes.
   *
   * ⚠️ COLONNE NON MIGRÉE : `npm run db:generate` puis `npm run db:migrate`
   * doivent être lancés par le client. Tant que la migration n'est pas
   * appliquée, `prescription.ts` détecte l'absence de la colonne et retombe
   * sur le tri alphabétique historique.
   */
  orderIndex: integer("order_index"),
}, (table) => [
  index("idx_prescription_items_prescription_id").on(table.prescriptionId),
]);
