CREATE TYPE "public"."stock_alert_status" AS ENUM('active', 'resolved');--> statement-breakpoint
ALTER TABLE "platform_owner" ADD PRIMARY KEY ("user_id");--> statement-breakpoint
ALTER TABLE "stock_alert" ALTER COLUMN "status" SET DEFAULT 'active'::"public"."stock_alert_status";--> statement-breakpoint
ALTER TABLE "stock_alert" ALTER COLUMN "status" SET DATA TYPE "public"."stock_alert_status" USING "status"::"public"."stock_alert_status";--> statement-breakpoint
CREATE INDEX "idx_clinic_memberships_user_id" ON "clinic_membership" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_clinic_memberships_user_clinic" ON "clinic_membership" USING btree ("user_id","clinic_id");--> statement-breakpoint
CREATE INDEX "idx_platform_owners_user_id" ON "platform_owner" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_patients_clinic_id" ON "patient" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_patients_last_name_first_name" ON "patient" USING btree ("last_name","first_name");--> statement-breakpoint
CREATE INDEX "idx_patients_phone" ON "patient" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_patients_email" ON "patient" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_appointments_clinic_id" ON "appointment" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_appointments_patient_id" ON "appointment" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_appointments_start_time" ON "appointment" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "idx_waiting_room_entries_clinic_id" ON "waiting_room_entry" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_waiting_room_entries_clinic_id_status" ON "waiting_room_entry" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "idx_waiting_room_entries_appointment_id" ON "waiting_room_entry" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "idx_consultation_notes_clinic_id" ON "consultation_note" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_consultation_notes_patient_id" ON "consultation_note" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_dental_charts_clinic_id" ON "dental_chart" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_dental_charts_patient_id" ON "dental_chart" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_dental_charts_patient_id_tooth_number" ON "dental_chart" USING btree ("patient_id","tooth_number");--> statement-breakpoint
CREATE INDEX "idx_medical_history_entries_clinic_id" ON "medical_history_entry" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_medical_history_entries_patient_id" ON "medical_history_entry" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_radiographs_clinic_id" ON "radiograph" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_radiographs_patient_id" ON "radiograph" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_treatment_plan_items_plan_id" ON "treatment_plan_item" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_treatment_plans_clinic_id" ON "treatment_plan" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_treatment_plans_patient_id" ON "treatment_plan" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_prescription_items_prescription_id" ON "prescription_item" USING btree ("prescription_id");--> statement-breakpoint
CREATE INDEX "idx_prescriptions_clinic_id" ON "prescription" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_prescriptions_patient_id" ON "prescription" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_prescriptions_status" ON "prescription" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_prescriptions_dentist_id" ON "prescription" USING btree ("dentist_id");--> statement-breakpoint
CREATE INDEX "idx_invoice_items_invoice_id" ON "invoice_item" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_clinic_id" ON "invoice" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_status" ON "invoice" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_invoices_patient_id" ON "invoice" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_payments_clinic_id" ON "payment" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_payments_invoice_id" ON "payment" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_payments_patient_id" ON "payment" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_payments_created_by" ON "payment" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_quote_items_quote_id" ON "quote_item" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "idx_quotes_clinic_id" ON "quote" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_quotes_patient_id" ON "quote" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_quotes_status" ON "quote" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_stock_alerts_clinic_id" ON "stock_alert" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_stock_alerts_item_id" ON "stock_alert" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_stock_alerts_clinic_id_status" ON "stock_alert" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "idx_stock_items_clinic_id" ON "stock_item" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_stock_transactions_item_id" ON "stock_transaction" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_stock_transactions_created_by" ON "stock_transaction" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_prosthesis_labs_clinic_id" ON "prosthesis_lab" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_prosthesis_orders_clinic_id" ON "prosthesis_order" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_prosthesis_orders_patient_id" ON "prosthesis_order" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_prosthesis_orders_lab_id" ON "prosthesis_order" USING btree ("lab_id");--> statement-breakpoint
CREATE INDEX "idx_prosthesis_orders_status" ON "prosthesis_order" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_prosthesis_orders_created_by" ON "prosthesis_order" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_clinic_subscriptions_clinic_id" ON "clinic_subscription" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_clinic_subscriptions_plan_id" ON "clinic_subscription" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_clinic_id" ON "support_ticket" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_created_by" ON "support_ticket" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_assigned_to" ON "support_ticket" USING btree ("assigned_to");