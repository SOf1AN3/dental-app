ALTER TABLE "user" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "clinic_membership" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_membership" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "clinic_membership" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_membership" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "clinic_schedule" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "clinic_schedule" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_schedule" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "clinic" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "waiting_room_entry" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "waiting_room_entry" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "waiting_room_entry" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waiting_room_entry" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "consultation_note" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "consultation_note" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "consultation_note" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "consultation_note" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "dental_chart" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "dental_chart" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dental_chart" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "medical_history_entry" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "medical_history_entry" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "medical_history_entry" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "medical_history_entry" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "odontogram_state" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "odontogram_state" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "odontogram_state" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "radiograph" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "radiograph" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "radiograph" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_catalog" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "treatment_catalog" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_catalog" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_plan" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "quote" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "quote" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "quote" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "stock_alert" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_alert" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "stock_alert" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_alert" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "stock_item" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "stock_item" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_item" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "prosthesis_lab" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "prosthesis_lab" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "prosthesis_lab" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prosthesis_lab" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "prosthesis_order" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "prosthesis_order" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prosthesis_order" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "drug_catalog" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "drug_catalog" ADD COLUMN "rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drug_catalog" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_users_updated_id" ON "user" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_clinic_memberships_clinic_updated_id" ON "clinic_membership" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_clinic_schedule_clinic_updated_id" ON "clinic_schedule" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_clinics_updated_id" ON "clinic" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_notifications_clinic_updated_id" ON "notification" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_patients_clinic_updated_id" ON "patient" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_appointments_clinic_updated_id" ON "appointment" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_waiting_room_entries_clinic_updated_id" ON "waiting_room_entry" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_updated_id" ON "audit_log" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_consultation_notes_clinic_updated_id" ON "consultation_note" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_dental_charts_clinic_updated_id" ON "dental_chart" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_medical_history_entries_clinic_updated_id" ON "medical_history_entry" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_odontogram_states_clinic_updated_id" ON "odontogram_state" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_radiographs_clinic_updated_id" ON "radiograph" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_treatment_catalog_clinic_updated_id" ON "treatment_catalog" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_treatment_plans_clinic_updated_id" ON "treatment_plan" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_clinical_sessions_clinic_updated_id" ON "clinical_session" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_prescriptions_clinic_updated_id" ON "prescription" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_invoices_clinic_updated_id" ON "invoice" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_payments_clinic_updated_id" ON "payment" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_quotes_clinic_updated_id" ON "quote" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_stock_alerts_clinic_updated_id" ON "stock_alert" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_stock_items_clinic_updated_id" ON "stock_item" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_prosthesis_labs_clinic_updated_id" ON "prosthesis_lab" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_prosthesis_orders_clinic_updated_id" ON "prosthesis_order" USING btree ("clinic_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "idx_drug_catalog_clinic_updated_id" ON "drug_catalog" USING btree ("clinic_id","updated_at","id");