import { pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
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
}, (table) => [
  index("idx_drug_catalog_clinic_id").on(table.clinicId),
  uniqueIndex("uq_drug_catalog_clinic_id_name").on(table.clinicId, table.name),
]);
