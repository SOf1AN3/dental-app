import { pgEnum, pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";
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
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { mode: "date" }),
});
export const clinicMemberships = pgTable("clinic_membership", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    role: membershipRoleEnum("role").default("viewer").notNull(),
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
