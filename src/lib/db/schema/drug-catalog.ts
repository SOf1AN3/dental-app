import { bigint, pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { clinics } from "./tenant";

export const drugCatalog = pgTable("drug_catalog", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  dosage: text("dosage"),
  form: text("form"),
  category: text("category"),
  frequency: text("frequency"),
  instructions: text("instructions"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
  // Réplication (tâche 4.1) : `rev` = version MONOTONE attribuée côté serveur,
  // `device_id` = dernier poste ayant écrit, `deleted_at` = tombstone.
  // Curseur de pull : (clinic_id, updated_at, id) → index ci-dessous.
  deviceId: text("device_id"),
  rev: bigint("rev", { mode: "number" }).default(0).notNull(),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
}, (table) => [
  index("idx_drug_catalog_clinic_id").on(table.clinicId),
  index("idx_drug_catalog_clinic_updated_id").on(table.clinicId, table.updatedAt, table.id),
  uniqueIndex("uq_drug_catalog_clinic_id_name").on(table.clinicId, table.name),
]);
