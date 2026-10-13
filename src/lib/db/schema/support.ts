import { bigint, pgEnum, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { clinics } from "./tenant";
import { users } from "./auth";

export const supportTicketStatusEnum = pgEnum("support_ticket_status", [
  "open", "in_progress", "resolved", "closed"
]);

export const supportTicketPriorityEnum = pgEnum("support_ticket_priority", [
  "low", "medium", "high", "urgent"
]);

export const supportTickets = pgTable("support_ticket", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").references(() => clinics.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  description: text("description").notNull(),
  status: supportTicketStatusEnum("status").default("open").notNull(),
  priority: supportTicketPriorityEnum("priority").default("medium").notNull(),
  createdBy: text("created_by").references(() => users.id),
  assignedTo: text("assigned_to").references(() => users.id),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { mode: "date" }),
  // Réplication (tâche 4.2) : cette table avait été OUBLIÉE de l'inventaire 4.1.
  // Décision client : tickets BIDIRECTIONNELS avec le central gagnant.
  // `rev` = version MONOTONE attribuée côté serveur, `device_id` = dernier
  // poste ayant écrit, `deleted_at` (tombstone) = suppression poussée en soft
  // delete. Curseur de pull : (clinic_id, updated_at, id) → index ci-dessous.
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
  deviceId: text("device_id"),
  rev: bigint("rev", { mode: "number" }).default(0).notNull(),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
}, (table) => [
  index("idx_support_tickets_clinic_id").on(table.clinicId),
  index("idx_support_tickets_created_by").on(table.createdBy),
  index("idx_support_tickets_assigned_to").on(table.assignedTo),
  index("idx_support_tickets_clinic_updated_id").on(table.clinicId, table.updatedAt, table.id),
]);
