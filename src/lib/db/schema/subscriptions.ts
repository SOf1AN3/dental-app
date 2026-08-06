import { pgEnum, pgTable, text, timestamp, integer, numeric, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { clinics } from "./tenant";

export const subscriptionPlans = pgTable("subscription_plan", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  description: text("description"),
  priceMonthly: numeric("price_monthly", { precision: 12, scale: 2, mode: "number" }).notNull(),
  priceYearly: numeric("price_yearly", { precision: 12, scale: 2, mode: "number" }),
  maxStaff: integer("max_staff"),
  maxPatients: integer("max_patients"),
  features: jsonb("features").$type<Record<string, boolean>>(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
});

export const clinicSubscriptionStatusEnum = pgEnum("clinic_subscription_status", [
  "active", "cancelled", "expired", "trial"
]);

export const clinicSubscriptions = pgTable("clinic_subscription", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clinicId: text("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().references(() => subscriptionPlans.id),
  startDate: timestamp("start_date", { mode: "date" }).notNull(),
  endDate: timestamp("end_date", { mode: "date" }),
  status: clinicSubscriptionStatusEnum("status").default("trial").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
}, (table) => [
  index("idx_clinic_subscriptions_clinic_id").on(table.clinicId),
  index("idx_clinic_subscriptions_plan_id").on(table.planId),
]);
