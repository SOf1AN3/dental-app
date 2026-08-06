import { pgEnum, pgTable, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { clinics } from "./tenant";
export const auditActionEnum = pgEnum("audit_action", ["create", "update", "delete", "status_change"]);
export const auditLogs = pgTable("audit_log", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    clinicId: text("clinic_id").references(() => clinics.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    action: auditActionEnum("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    beforeState: jsonb("before_state").$type(),
    afterState: jsonb("after_state").$type(),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
}, (table) => [
    index("idx_audit_logs_clinic_id").on(table.clinicId),
    index("idx_audit_logs_actor_user_id").on(table.actorUserId),
    index("idx_audit_logs_entity").on(table.entityType, table.entityId)
]);
export const verificationTokenPurposeEnum = pgEnum("verification_token_purpose", ["password_reset", "email_verification"]);
export const accountTokens = pgTable("account_token", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    purpose: verificationTokenPurposeEnum("purpose").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
}, (table) => [
    index("idx_account_tokens_user_id").on(table.userId)
]);
export const loginAttempts = pgTable("login_attempt", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull(),
    ipAddress: text("ip_address"),
    successful: boolean("successful").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
}, (table) => [
    index("idx_login_attempts_email_ip_time").on(table.email, table.ipAddress, table.createdAt)
]);
