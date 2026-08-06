CREATE TYPE "public"."clinical_session_status" AS ENUM('pending', 'in_progress', 'completed', 'invoiced', 'paid');--> statement-breakpoint
CREATE TABLE "clinical_session_item" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"tooth_number" integer,
	"surface" text,
	"procedure_code" text,
	"description" text NOT NULL,
	"fee" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"discount" integer DEFAULT 0,
	"tax_rate" integer DEFAULT 0,
	"order_index" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_session" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"appointment_id" text,
	"dentist_id" text,
	"status" "clinical_session_status" DEFAULT 'pending' NOT NULL,
	"total_amount" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "clinical_session_item" ADD CONSTRAINT "clinical_session_item_session_id_clinical_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD CONSTRAINT "clinical_session_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD CONSTRAINT "clinical_session_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD CONSTRAINT "clinical_session_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_session" ADD CONSTRAINT "clinical_session_dentist_id_user_id_fk" FOREIGN KEY ("dentist_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clinical_session_items_session_id" ON "clinical_session_item" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_clinical_sessions_clinic_id" ON "clinical_session" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_clinical_sessions_patient_id" ON "clinical_session" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "idx_clinical_sessions_appointment_id" ON "clinical_session" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "idx_clinical_sessions_status" ON "clinical_session" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_clinical_session_active_patient_clinic" ON "clinical_session" USING btree ("patient_id","clinic_id") WHERE status = 'in_progress';--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_session_id_clinical_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_session_id_clinical_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_prescriptions_session_id" ON "prescription" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prescriptions_session" ON "prescription" USING btree ("session_id") WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_invoices_session_id" ON "invoice" USING btree ("session_id");