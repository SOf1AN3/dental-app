import { pgEnum, pgTable, text, timestamp, time, boolean, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";
import type { DocumentBranding } from "@/lib/document-branding";

export const membershipRoleEnum = pgEnum("membership_role", [
  "owner", "dentist", "assistant", "receptionist", "viewer"
]);

export const clinicStatusEnum = pgEnum("clinic_status", [
  "active", "suspended", "trial"
]);

export const clinics = pgTable("clinic", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  wilayaCode: text("wilaya_code"),
  timezone: text("timezone").default("Africa/Algiers").notNull(),
  status: clinicStatusEnum("status").default("trial").notNull(),
  logoUrl: text("logo_url"),
  headerUrl: text("header_url"),
  legalInfo: text("legal_info"),
  watermarkEnabled: boolean("watermark_enabled").default(false).notNull(),
  documentBranding: jsonb("document_branding").$type<DocumentBranding>(),
  defaultTaxRate: integer("default_tax_rate").default(19).notNull(),
  openingTime: time("opening_time").default("08:00").notNull(),
  closingTime: time("closing_time").default("19:00").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
});

export const clinicMemberships = pgTable("clinic_membership", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  role: membershipRoleEnum("role").default("viewer").notNull(),
  minGapMinutes: integer("min_gap_minutes").default(15).notNull(),
  invitedAt: timestamp("invited_at", { mode: "date" }),
  joinedAt: timestamp("joined_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("idx_clinic_memberships_user_id").on(table.userId),
  uniqueIndex("uq_clinic_memberships_user_clinic").on(table.userId, table.clinicId),
]);

export const platformOwners = pgTable("platform_owner", {
  userId: text("user_id").primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  grantedBy: text("granted_by").notNull().references(() => users.id),
  grantedAt: timestamp("granted_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("idx_platform_owners_user_id").on(table.userId),
]);

export const clinicSchedule = pgTable("clinic_schedule", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(),
  openTime: time("open_time"),
  closeTime: time("close_time"),
  isClosed: boolean("is_closed").default(false).notNull(),
  isWeekend: boolean("is_weekend").default(false).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_clinic_schedule_clinic_id").on(table.clinicId),
  uniqueIndex("uq_clinic_schedule_clinic_day").on(table.clinicId, table.dayOfWeek),
]);

export const notificationCategoryEnum = pgEnum("notification_category", [
  "broadcast", "maintenance", "subscription_reminder", "system"
]);

export const notifications = pgTable("notification", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  category: notificationCategoryEnum("category").default("broadcast").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  link: text("link"),
  refKey: text("ref_key"),
  readAt: timestamp("read_at", { mode: "date" }),
  createdBy: text("created_by").references(() => platformOwners.userId, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("idx_notifications_clinic_read").on(table.clinicId, table.readAt),
]);
