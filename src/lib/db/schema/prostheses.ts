import { pgEnum, pgTable, text, timestamp, integer, numeric, index } from "drizzle-orm/pg-core";
import { clinics } from "./tenant";
import { patients } from "./patients";
import { users } from "./auth";

export const prosthesisLabs = pgTable("prosthesis_lab", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactPerson: text("contact_person"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("idx_prosthesis_labs_clinic_id").on(table.clinicId),
]);

export const prosthesisOrderStatusEnum = pgEnum("prosthesis_order_status", [
  "ordered", "in_progress", "delivered", "cancelled"
]);

export const prosthesisOrders = pgTable("prosthesis_order", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  patientId: text("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
  labId: text("lab_id").references(() => prosthesisLabs.id, { onDelete: "set null" }),
  orderNumber: text("order_number").notNull(),
  description: text("description").notNull(),
  toothNumber: integer("tooth_number"),
  material: text("material"),
  color: text("color"),
  deliveryDate: timestamp("delivery_date", { mode: "date" }),
  status: prosthesisOrderStatusEnum("status").default("ordered").notNull(),
  cost: numeric("cost", { precision: 12, scale: 2, mode: "number" }),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_prosthesis_orders_clinic_id").on(table.clinicId),
  index("idx_prosthesis_orders_patient_id").on(table.patientId),
  index("idx_prosthesis_orders_lab_id").on(table.labId),
  index("idx_prosthesis_orders_status").on(table.status),
  index("idx_prosthesis_orders_created_by").on(table.createdBy),
]);
