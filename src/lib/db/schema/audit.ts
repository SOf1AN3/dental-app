import { bigint, pgEnum, pgTable, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { clinics } from "./tenant";

export const auditActionEnum = pgEnum("audit_action", ["create", "update", "delete", "status_change"]);

export const auditLogs = pgTable("audit_log", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").references(() => clinics.id, { onDelete: "set null" }),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "cascade" }),
  action: auditActionEnum("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  beforeState: jsonb("before_state").$type<Record<string, unknown>>(),
  afterState: jsonb("after_state").$type<Record<string, unknown>>(),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  // Réplication (tâche 4.1) : `rev` = version MONOTONE attribuée côté serveur,
  // `device_id` = dernier poste ayant écrit, `deleted_at` = tombstone.
  // Curseur (updated_at, id) : répliqué push-only, le curseur n'utilise pas le
  // clinic_id (nullable ici) — décision tâche 4.1.
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull().$onUpdate(() => new Date()),
  deviceId: text("device_id"),
  rev: bigint("rev", { mode: "number" }).default(0).notNull(),
  deletedAt: timestamp("deleted_at", { mode: "date" }),
}, (table) => [
  index("idx_audit_logs_clinic_id").on(table.clinicId),
  index("idx_audit_logs_updated_id").on(table.updatedAt, table.id),
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
  // Motif de refus **malgré** `successful = true` : un login dont le mot de
  // passe est valide mais refusé par la gate de confiance d'appareil est
  // journalisé tel quel (`device-trust:<raison>`), afin de rester distinguable
  // d'un vrai succès à la forensique / à l'export propriétaire. Nullable et
  // sans défaut : strictement additive, les lignes historiques restent NULL.
  deniedReason: text("denied_reason"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull()
}, (table) => [
  index("idx_login_attempts_email_ip_time").on(table.email, table.ipAddress, table.createdAt)
]);
