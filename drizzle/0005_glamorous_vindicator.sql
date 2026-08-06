CREATE TABLE "odontogram_state" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "odontogram_state" ADD CONSTRAINT "odontogram_state_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_state" ADD CONSTRAINT "odontogram_state_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_odontogram_state_clinic_id" ON "odontogram_state" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "idx_odontogram_state_patient_id" ON "odontogram_state" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_odontogram_state_patient_clinic" ON "odontogram_state" USING btree ("patient_id","clinic_id");